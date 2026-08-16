// Prototype-lane offline generation — orchestration.
// docs/plans/2026-08-16-category-flexibility-hyde.md §3 (Phase 2 of that
// doc's phased plan; THIS file is the whole of Phase 2's generation half).
//
// WHAT THIS DOES, per workstream, on a background cadence (never per page,
// never on a request path):
//   1. Gather the workstream's own filed-visit evidence (titles + gists).
//   2. Decide DIRTY via a debounced watermark (§ below) — most ticks touch
//      zero workstreams.
//   3. Below the cold-start floor → typed-skip, no generation attempted.
//   4. Evidence corpus language: 'en' → generate m grounded example texts on
//      Apple FM (the ONLY generation engine this lane uses — see
//      appleFmEngine.ts); anything else ('zh' / 'mixed-en-zh', per this
//      codebase's own appleCanServe contract) → SKIP generation and SELECT m
//      real evidence excerpts as the prototype texts instead (ReDE-RF
//      pattern) — never a broken or English-leaking generation.
//   5. Embed every resulting text with the SAME embedder recall-v2 uses and
//      persist: one WORKSTREAM_PROTOTYPE_GENERATED event per text (durable
//      provenance) + an upsert into the recall-v2 sqlite-vec store's
//      prototype_vec table (the served copy the guess lane KNNs against).
//
// DIRTY-MARKING, NO FULL-PASS SWEEPS. `evidenceWatermark` encodes BOTH the
// evidence count and a content hash: "<count>:<sha256>". A workstream whose
// evidence set is byte-identical to its last generation's is a same-string
// compare, not a re-embed. Even when the watermark DOES change, regeneration
// only fires past a debounce (≥5 new evidence items OR ≥14 days elapsed,
// whichever first) — coarser than servedFeatureModel.ts's 120s TTL warmer
// because workstream semantics drift far slower than serve traffic (design
// doc §3). The debounce numbers are the "conservative default cadence" the
// task asked for; SIDETRACK_PROTOTYPE_GENERATION is the boolean kill switch.
//
// GENERATION ENGINE. Apple FM ONLY (per the 2026-08-16 user directive) —
// this lane deliberately does NOT fall back to Nano/WebGPU/remote the way
// enrichment's resolveReadyEngine() does. Nano/WebGPU require a live browser
// panel session (Nano is a Chrome API; WebGPU's explicit-load singleton lives
// in the extension's sidepanel), neither of which a companion background job
// has access to; Apple FM alone is reachable over loopback HTTP from any
// process on the machine (see appleFmEngine.ts's header). When Apple FM is
// unavailable, generation is SKIPPED GRACEFULLY (a typed report reason, never
// a thrown error) — prior standing prototypes are left untouched, and the
// workstream stays dirty for the next tick.

import { createHash } from 'node:crypto';

import type { ConnectionsStore } from '../connections/snapshot.js';
import { loadGistLookup } from '../enrichment/contentEnrichment.js';
import {
  APPLE_GENERATION_TIMEOUT_MS,
  appleFmStatus,
  appleFmUnavailableCopy,
  appleMaxInputChars,
  generateWithAppleFm,
} from '../enrichment/appleFmEngine.js';
import type { EventLog } from '../sync/eventLog.js';
import { getSharedEventStoreServeStale } from '../sync/eventStore.js';
import type { AcceptedEvent } from '../sync/causal.js';
import {
  isPrototypeGeneratedSnapshot,
  PROTOTYPE_GENERATED_TEXT_MAX_LENGTH,
  PROTOTYPE_SOURCE_EVIDENCE_MAX_COUNT,
  WORKSTREAM_PROTOTYPE_GENERATED,
  type PrototypeGeneratedSnapshot,
} from './events.js';
import {
  evidenceBudgetChars,
  gatherWorkstreamEvidence,
  selectEvidenceWithinBudget,
  workstreamEvidenceLanguage,
  type WorkstreamEvidenceItem,
} from './prototypeEvidence.js';

// ---- env gating ----------------------------------------------------------

export const PROTOTYPE_GENERATION_ENV = 'SIDETRACK_PROTOTYPE_GENERATION';

/** Default ON — same kill-switch idiom as every other observe/shadow flag in
 *  this codebase (SIDETRACK_GUESS_LANES, SIDETRACK_CONTENT_LANE,
 *  SIDETRACK_LANE_PREQUENTIAL, SIDETRACK_LANE_CORROBORATION all default ON
 *  with an explicit '0'/'false' rollback). Generation itself is conservative
 *  by CADENCE (the debounce below), not by being opt-in — a fresh vault
 *  simply never crosses the floor and nothing runs. */
export const prototypeGenerationEnabled = (): boolean => {
  const raw = process.env[PROTOTYPE_GENERATION_ENV];
  return raw !== '0' && raw !== 'false';
};

export const PROTOTYPE_COUNT_ENV = 'SIDETRACK_PROTOTYPE_COUNT';
const DEFAULT_PROTOTYPE_COUNT = 4;

/** m — how many prototype texts per workstream per batch. Clamped to the
 *  design doc's stated 3-5 range regardless of what the env says, so a
 *  misconfigured value degrades to the nearest valid count rather than
 *  silently doing something the design never measured. */
export const prototypeCount = (): number => {
  const raw = Number(process.env[PROTOTYPE_COUNT_ENV]);
  if (!Number.isFinite(raw)) return DEFAULT_PROTOTYPE_COUNT;
  return Math.min(5, Math.max(3, Math.round(raw)));
};

/** Cold-start floor (design doc §6, risk 2 — "double cold-start"). Below
 *  this, generation is not attempted at all; the north-star study's P3
 *  finding (real-vector density wants ~30 members) argues for an even higher
 *  bar for confident SERVING, but this is the floor for ATTEMPTING — just
 *  above HDBSCAN_TOPIC_MIN_SAMPLES=3, matching the doc's stated number. */
export const MIN_EVIDENCE_FOR_GENERATION = 5;

/** Debounce trigger (a): regenerate once at least this many evidence items
 *  have accrued since the last generation. */
export const MIN_NEW_EVIDENCE_SINCE_LAST = 5;

/** Debounce trigger (b): regenerate at least this often regardless of growth
 *  — 14 days, design doc §3. */
export const MAX_STALE_MS = 14 * 24 * 60 * 60 * 1000;

export const PROTOTYPE_EMBEDDING_SCHEMA_VERSION = 1;

// ---- evidence watermark ---------------------------------------------------

/** "<count>:<sha256>" — a same-string compare answers BOTH "did anything
 *  change" (dirty-marking) and "how many items existed" (the debounce's
 *  growth trigger), without a second persisted field or a second read. */
export const computeEvidenceWatermark = (items: readonly WorkstreamEvidenceItem[]): string => {
  const sorted = [...items].sort((left, right) =>
    left.canonicalUrl < right.canonicalUrl ? -1 : left.canonicalUrl > right.canonicalUrl ? 1 : 0,
  );
  const hasher = createHash('sha256');
  hasher.update('sidetrack-prototype-evidence-v1\0');
  for (const item of sorted) {
    hasher.update(item.canonicalUrl);
    hasher.update('\0');
    hasher.update(item.gist ?? item.title ?? '');
    hasher.update('\0');
  }
  return `${String(items.length)}:${hasher.digest('hex').slice(0, 32)}`;
};

const parseEvidenceWatermark = (watermark: string): { count: number; hash: string } | null => {
  const at = watermark.indexOf(':');
  if (at <= 0) return null;
  const count = Number(watermark.slice(0, at));
  if (!Number.isFinite(count) || count < 0) return null;
  return { count, hash: watermark.slice(at + 1) };
};

// ---- last-generation state (folded from the event log) -------------------

export interface WorkstreamGenerationState {
  readonly workstreamId: string;
  readonly evidenceWatermark: string;
  readonly generatedAt: number;
  readonly generatorModelId: string;
  readonly method: 'generated' | 'selected';
  readonly prototypeIds: readonly string[];
}

/** Latest generation BATCH per workstream — all prototype-events sharing that
 *  workstream's most recent `generatedAt`. Pure fold, no I/O. */
export const foldLatestPrototypeGenerations = (
  events: readonly AcceptedEvent[],
): ReadonlyMap<string, WorkstreamGenerationState> => {
  const latestAt = new Map<string, number>();
  for (const event of events) {
    if (event.type !== WORKSTREAM_PROTOTYPE_GENERATED) continue;
    if (!isPrototypeGeneratedSnapshot(event.payload)) continue;
    const p = event.payload;
    const prior = latestAt.get(p.workstreamId);
    if (prior === undefined || p.generatedAt > prior) latestAt.set(p.workstreamId, p.generatedAt);
  }
  const byWorkstream = new Map<string, WorkstreamGenerationState>();
  for (const event of events) {
    if (event.type !== WORKSTREAM_PROTOTYPE_GENERATED) continue;
    if (!isPrototypeGeneratedSnapshot(event.payload)) continue;
    const p = event.payload;
    if (latestAt.get(p.workstreamId) !== p.generatedAt) continue;
    const existing = byWorkstream.get(p.workstreamId);
    if (existing === undefined) {
      byWorkstream.set(p.workstreamId, {
        workstreamId: p.workstreamId,
        evidenceWatermark: p.evidenceWatermark,
        generatedAt: p.generatedAt,
        generatorModelId: p.generatorModelId,
        method: p.method,
        prototypeIds: [p.prototypeId],
      });
    } else {
      byWorkstream.set(p.workstreamId, {
        ...existing,
        prototypeIds: [...existing.prototypeIds, p.prototypeId],
      });
    }
  }
  return byWorkstream;
};

const PROTOTYPE_FOLD_TYPES = [WORKSTREAM_PROTOTYPE_GENERATED] as const;

const readPrototypeGenerationEvents = async (
  vaultRoot: string,
  eventLog: EventLog | undefined,
): Promise<readonly AcceptedEvent[]> => {
  const store = await getSharedEventStoreServeStale(vaultRoot);
  if (store === null) {
    if (eventLog === undefined) return [];
    return (await eventLog.readMerged()).filter(
      (event) => event.type === WORKSTREAM_PROTOTYPE_GENERATED,
    );
  }
  const events: AcceptedEvent[] = [];
  await store.forEachChunkOfTypes(
    [...PROTOTYPE_FOLD_TYPES],
    (chunk) => {
      for (const event of chunk) events.push(event);
    },
    2000,
  );
  return events;
};

// ---- dirty-marking ---------------------------------------------------------

export type DirtyDecision =
  | { readonly dirty: false; readonly reason: 'below-floor' | 'unchanged' | 'debounced' }
  | { readonly dirty: true; readonly reason: 'first-generation' | 'evidence-grew' | 'stale' };

/**
 * Pure decision function — no I/O, fully unit-testable. `nowMs` is threaded
 * so the 14-day trigger is deterministic in tests.
 *
 * BYTE-IDENTICAL EVIDENCE SHORT-CIRCUITS REGARDLESS OF STALENESS. The design
 * doc's "≥5 new members OR ≥14 days elapsed" debounce describes when a
 * CHANGED workstream should regenerate; it is not a periodic-refresh policy
 * for a workstream whose evidence has not moved at all. Re-generating from
 * the exact same evidence would spend an engine call to produce merely
 * DIFFERENT (LLM stochasticity), not more grounded, text — the opposite of
 * this program's cost discipline. A workstream with genuinely stale evidence
 * (nothing filed to it in months) simply keeps its last-good prototypes.
 */
export const decideDirty = (
  evidenceCount: number,
  watermark: string,
  last: WorkstreamGenerationState | undefined,
  nowMs: number,
): DirtyDecision => {
  if (evidenceCount < MIN_EVIDENCE_FOR_GENERATION) return { dirty: false, reason: 'below-floor' };
  if (last === undefined) return { dirty: true, reason: 'first-generation' };
  if (last.evidenceWatermark === watermark) return { dirty: false, reason: 'unchanged' };
  const lastParsed = parseEvidenceWatermark(last.evidenceWatermark);
  const grew =
    lastParsed === null || evidenceCount - lastParsed.count >= MIN_NEW_EVIDENCE_SINCE_LAST;
  if (grew) return { dirty: true, reason: 'evidence-grew' };
  const stale = nowMs - last.generatedAt >= MAX_STALE_MS;
  if (stale) return { dirty: true, reason: 'stale' };
  return { dirty: false, reason: 'debounced' };
};

// ---- prompt construction (grounded — evidence only, never the workstream's
// own name/description; see prototypeEvidence.ts's header) -----------------

const PROMPT_ANGLES: readonly ((evidence: string) => string)[] = [
  (evidence) =>
    `Below are short excerpts (titles and summaries) from web pages a person has ` +
    `saved into the same personal collection:\n\n${evidence}\n\n` +
    `In ONE sentence, describe the kind of activity or topic these pages have in ` +
    `common. Do not quote or restate the excerpts; write only the new description.`,
  (evidence) =>
    `Below are short excerpts (titles and summaries) from web pages a person has ` +
    `saved into the same personal collection:\n\n${evidence}\n\n` +
    `Write ONE short example excerpt (2-3 sentences), in a similar style, that ` +
    `could plausibly belong to this same collection. Do not copy the excerpts above.`,
  (evidence) =>
    `Below are short excerpts (titles and summaries) from web pages a person has ` +
    `saved into the same personal collection:\n\n${evidence}\n\n` +
    `In ONE sentence, list terminology and named entities likely to appear on ` +
    `another page belonging to this same collection.`,
  (evidence) =>
    `Below are short excerpts (titles and summaries) from web pages a person has ` +
    `saved into the same personal collection:\n\n${evidence}\n\n` +
    `In ONE sentence, describe a question or task this person is likely pursuing, ` +
    `based only on these excerpts.`,
  (evidence) =>
    `Below are short excerpts (titles and summaries) from web pages a person has ` +
    `saved into the same personal collection:\n\n${evidence}\n\n` +
    `In ONE sentence, name the single most distinctive, specific detail shared ` +
    `across these excerpts (not a generic category).`,
];

const MAX_GENERATION_OUTPUT_TOKENS = 120;

const cleanGeneratedText = (raw: string): string => {
  const trimmed = raw.trim().replace(/^["'“”]+|["'“”]+$/gu, '');
  return trimmed.length > PROTOTYPE_GENERATED_TEXT_MAX_LENGTH
    ? trimmed.slice(0, PROTOTYPE_GENERATED_TEXT_MAX_LENGTH)
    : trimmed;
};

// ---- generation result ------------------------------------------------

export interface GeneratedPrototype {
  readonly text: string;
  readonly method: 'generated' | 'selected';
}

export interface AppleFmClient {
  readonly status: typeof appleFmStatus;
  readonly generate: typeof generateWithAppleFm;
}

const REAL_APPLE_FM_CLIENT: AppleFmClient = {
  status: appleFmStatus,
  generate: generateWithAppleFm,
};

export type GenerationOutcome =
  | {
      readonly kind: 'texts';
      readonly texts: readonly GeneratedPrototype[];
      readonly generatorModelId: string;
    }
  | { readonly kind: 'engine-unavailable'; readonly reason: string };

/**
 * Produce m prototype texts for one workstream's evidence — generation on
 * Apple FM for English-dominant evidence, selection (real excerpts, no LLM
 * call) for zh/mixed evidence. Never throws; engine failures degrade to
 * 'engine-unavailable'.
 */
export const producePrototypeTexts = async (
  items: readonly WorkstreamEvidenceItem[],
  count: number,
  client: AppleFmClient = REAL_APPLE_FM_CLIENT,
): Promise<GenerationOutcome> => {
  const language = workstreamEvidenceLanguage(items);
  if (language !== 'en') {
    // ReDE-RF selection — real evidence excerpts embedded directly, never
    // generated. Distinct excerpts, most-recent-first, capped at `count`.
    const seen = new Set<string>();
    const texts: GeneratedPrototype[] = [];
    const sorted = [...items].sort((left, right) => right.firstSeenAtMs - left.firstSeenAtMs);
    for (const item of sorted) {
      const excerpt = item.gist ?? item.title;
      if (excerpt === null || excerpt === undefined || excerpt.length === 0) continue;
      if (seen.has(excerpt)) continue;
      seen.add(excerpt);
      texts.push({ text: cleanGeneratedText(excerpt), method: 'selected' });
      if (texts.length >= count) break;
    }
    return {
      kind: 'texts',
      texts,
      generatorModelId: `evidence-selection#reason=${language}`,
    };
  }

  const status = await client.status();
  if (!status.available) {
    return { kind: 'engine-unavailable', reason: appleFmUnavailableCopy(status.reason) };
  }
  const budgetChars = evidenceBudgetChars(appleMaxInputChars(status.contextTokens));
  const { text: evidenceText } = selectEvidenceWithinBudget(items, budgetChars);
  if (evidenceText.length === 0) {
    return { kind: 'engine-unavailable', reason: 'no evidence text to generate from' };
  }
  const texts: GeneratedPrototype[] = [];
  const angles = PROMPT_ANGLES.slice(0, count);
  for (const angle of angles) {
    const raw = await client.generate({
      prompt: angle(evidenceText),
      maxOutputTokens: MAX_GENERATION_OUTPUT_TOKENS,
      timeoutMs: APPLE_GENERATION_TIMEOUT_MS,
    });
    if (raw === null) continue;
    const cleaned = cleanGeneratedText(raw);
    if (cleaned.length === 0) continue;
    texts.push({ text: cleaned, method: 'generated' });
  }
  if (texts.length === 0) {
    return {
      kind: 'engine-unavailable',
      reason: 'the local Apple AI service answered, but every generation failed',
    };
  }
  return { kind: 'texts', texts, generatorModelId: `apple-fm#reason=ok` };
};

// ---- store write side (structural subset — see recall-v2/store/sqlite.ts) --

export interface PrototypeStore {
  readonly vectorBackendAvailable: boolean;
  upsertPrototype(
    row: {
      readonly prototypeId: string;
      readonly workstreamId: string;
      readonly generatedText: string;
      readonly generatorModelId: string;
      readonly method: 'generated' | 'selected';
      readonly generatedAt: number;
      readonly evidenceWatermark: string;
    },
    vec: Float32Array,
  ): void;
  deletePrototypesForWorkstream(workstreamId: string): void;
  listPrototypesForWorkstream(workstreamId: string): readonly {
    readonly prototypeId: string;
    readonly generatedText: string;
    readonly generatorModelId: string;
    readonly method: 'generated' | 'selected';
    readonly generatedAt: number;
    readonly evidenceWatermark: string;
  }[];
  allPrototypeWorkstreamIds(): ReadonlySet<string>;
  queryPrototypeVector(opts: { readonly vec: Float32Array; readonly limit: number }): readonly {
    readonly prototypeId: string;
    readonly workstreamId: string;
    readonly cosineDistance: number;
  }[];
}

export type EmbedFn = (texts: readonly string[]) => Promise<readonly Float32Array[]>;

// ---- one workstream's generation pass --------------------------------------

export interface WorkstreamGenerationResult {
  readonly workstreamId: string;
  readonly outcome:
    | 'below-floor'
    | 'unchanged'
    | 'debounced'
    | 'engine-unavailable'
    | 'embedder-unavailable'
    | 'regenerated';
  readonly detail?: string;
  readonly prototypeCount?: number;
  readonly method?: 'generated' | 'selected';
}

/**
 * Idempotent append — a batch that already landed (same clientEventId, which
 * is a pure function of workstreamId + watermark + index) is a no-op on
 * retry, so a tick interrupted mid-batch never double-writes on the next.
 */
const prototypeClientEventId = (prototypeId: string): string =>
  `prototype:${createHash('sha256').update(prototypeId).digest('hex').slice(0, 32)}`;

export const generatePrototypesForWorkstream = async (
  input: {
    readonly workstreamId: string;
    readonly items: readonly WorkstreamEvidenceItem[];
    readonly last: WorkstreamGenerationState | undefined;
    readonly nowMs: number;
    readonly count: number;
  },
  deps: {
    readonly eventLog: Pick<EventLog, 'appendServerObserved' | 'findByClientEventId'>;
    readonly embed: EmbedFn;
    readonly store: PrototypeStore;
    readonly client?: AppleFmClient;
  },
): Promise<WorkstreamGenerationResult> => {
  const watermark = computeEvidenceWatermark(input.items);
  const decision = decideDirty(input.items.length, watermark, input.last, input.nowMs);
  if (!decision.dirty) {
    return { workstreamId: input.workstreamId, outcome: decision.reason };
  }

  const outcome = await producePrototypeTexts(input.items, input.count, deps.client);
  if (outcome.kind === 'engine-unavailable') {
    return {
      workstreamId: input.workstreamId,
      outcome: 'engine-unavailable',
      detail: outcome.reason,
    };
  }

  let vectors: readonly Float32Array[];
  try {
    vectors = await deps.embed(outcome.texts.map((t) => t.text));
  } catch {
    vectors = [];
  }
  if (vectors.length !== outcome.texts.length) {
    return {
      workstreamId: input.workstreamId,
      outcome: 'embedder-unavailable',
      detail: 'embedder returned no (or a mismatched number of) vectors',
    };
  }

  const sourceEvidenceIds = [...new Set(input.items.map((item) => item.canonicalUrl))].slice(
    0,
    PROTOTYPE_SOURCE_EVIDENCE_MAX_COUNT,
  );

  const rows: {
    readonly prototypeId: string;
    readonly text: string;
    readonly method: 'generated' | 'selected';
  }[] = outcome.texts.map((t, index) => ({
    prototypeId: `${input.workstreamId}:${watermark}:${String(index)}`,
    text: t.text,
    method: t.method,
  }));

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    const payload: PrototypeGeneratedSnapshot = {
      payloadVersion: 1,
      prototypeId: row.prototypeId,
      workstreamId: input.workstreamId,
      generatedText: row.text,
      embeddingSchemaVersion: PROTOTYPE_EMBEDDING_SCHEMA_VERSION,
      sourceEvidenceIds,
      generatorModelId: outcome.generatorModelId,
      generatedAt: input.nowMs,
      method: row.method,
      evidenceWatermark: watermark,
    };
    const clientEventId = prototypeClientEventId(row.prototypeId);
    const existing = await deps.eventLog.findByClientEventId(clientEventId).catch(() => null);
    if (existing === null) {
      await deps.eventLog
        .appendServerObserved({
          clientEventId,
          aggregateId: `workstream-prototype:${input.workstreamId}`,
          type: WORKSTREAM_PROTOTYPE_GENERATED,
          payload: { ...payload },
        })
        .catch(() => undefined);
    }
  }

  // Replace the workstream's ENTIRE standing set with this batch — the
  // served copy is always exactly the latest generation, never a mix of
  // watermarks (see sqlite.ts's deletePrototypesForWorkstream doc comment).
  deps.store.deletePrototypesForWorkstream(input.workstreamId);
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    const vec = vectors[i];
    if (vec === undefined) continue;
    deps.store.upsertPrototype(
      {
        prototypeId: row.prototypeId,
        workstreamId: input.workstreamId,
        generatedText: row.text,
        generatorModelId: outcome.generatorModelId,
        method: row.method,
        generatedAt: input.nowMs,
        evidenceWatermark: watermark,
      },
      vec,
    );
  }

  const firstMethod = rows[0]?.method;
  return {
    workstreamId: input.workstreamId,
    outcome: 'regenerated',
    prototypeCount: rows.length,
    ...(firstMethod === undefined ? {} : { method: firstMethod }),
  };
};

// ---- one full tick over every workstream with evidence ---------------------

export interface PrototypeGenerationTickReport {
  readonly ranAt: number;
  readonly enabled: boolean;
  readonly workstreamsWithEvidence: number;
  readonly regenerated: number;
  readonly unchanged: number;
  readonly debounced: number;
  readonly belowFloor: number;
  readonly engineUnavailable: number;
  readonly embedderUnavailable: number;
  readonly engineUnavailableReason: string | null;
  readonly results: readonly WorkstreamGenerationResult[];
}

const EMPTY_REPORT = (nowMs: number, enabled: boolean): PrototypeGenerationTickReport => ({
  ranAt: nowMs,
  enabled,
  workstreamsWithEvidence: 0,
  regenerated: 0,
  unchanged: 0,
  debounced: 0,
  belowFloor: 0,
  engineUnavailable: 0,
  embedderUnavailable: 0,
  engineUnavailableReason: null,
  results: [],
});

/**
 * One generation pass over every workstream that currently has filed
 * evidence. Pure orchestration over injected deps — fully unit-testable with
 * a fake AppleFmClient/embedder/store, never calling the real engine in
 * tests (see prototypeGeneration.test.ts).
 */
export const runPrototypeGenerationTick = async (
  vaultRoot: string,
  connectionsStore: ConnectionsStore,
  eventLog: EventLog,
  deps: {
    readonly embed: EmbedFn;
    readonly store: PrototypeStore;
    readonly client?: AppleFmClient;
  },
  nowMs: number = Date.now(),
): Promise<PrototypeGenerationTickReport> => {
  if (!prototypeGenerationEnabled()) return EMPTY_REPORT(nowMs, false);

  const gistLookup = await loadGistLookup(vaultRoot, eventLog).catch(() => null);
  const evidenceByWorkstream = await gatherWorkstreamEvidence(connectionsStore, gistLookup).catch(
    () => new Map<string, readonly WorkstreamEvidenceItem[]>(),
  );
  if (evidenceByWorkstream.size === 0) return EMPTY_REPORT(nowMs, true);

  const priorEvents = await readPrototypeGenerationEvents(vaultRoot, eventLog).catch(
    () => [] as readonly AcceptedEvent[],
  );
  const lastByWorkstream = foldLatestPrototypeGenerations(priorEvents);
  const count = prototypeCount();

  const results: WorkstreamGenerationResult[] = [];
  let regenerated = 0;
  let unchanged = 0;
  let debounced = 0;
  let belowFloor = 0;
  let engineUnavailable = 0;
  let embedderUnavailable = 0;
  let engineUnavailableReason: string | null = null;

  for (const [workstreamId, items] of evidenceByWorkstream) {
    const result = await generatePrototypesForWorkstream(
      {
        workstreamId,
        items,
        last: lastByWorkstream.get(workstreamId),
        nowMs,
        count,
      },
      { eventLog, ...deps },
    );
    results.push(result);
    switch (result.outcome) {
      case 'regenerated':
        regenerated += 1;
        break;
      case 'unchanged':
        unchanged += 1;
        break;
      case 'debounced':
        debounced += 1;
        break;
      case 'below-floor':
        belowFloor += 1;
        break;
      case 'engine-unavailable':
        engineUnavailable += 1;
        engineUnavailableReason ??= result.detail ?? null;
        break;
      case 'embedder-unavailable':
        embedderUnavailable += 1;
        break;
    }
  }

  return {
    ranAt: nowMs,
    enabled: true,
    workstreamsWithEvidence: evidenceByWorkstream.size,
    regenerated,
    unchanged,
    debounced,
    belowFloor,
    engineUnavailable,
    embedderUnavailable,
    engineUnavailableReason,
    results,
  };
};

// ---- companion background scheduler ---------------------------------------
//
// Same factory shape as scheduleSqliteVacuumGc / the eventSeal loop in
// runtime/companion.ts — an interval + a startup kickoff, returning a single
// disposer for teardown[]. Deliberately hours-scale (workstream semantics
// drift slowly; see the debounce above) and best-effort: a failed tick must
// never crash the companion, matching every other background sweep in this
// file's neighborhood.

export interface PrototypeGenerationHygiene {
  lastPrototypeGenerationAt?: string;
  lastPrototypeGenerationRegenerated?: number;
  lastPrototypeGenerationChecked?: number;
  lastPrototypeGenerationEngineUnavailableReason?: string | null;
}

export const PROTOTYPE_GENERATION_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const PROTOTYPE_GENERATION_STARTUP_DELAY_MS = 10 * 60 * 1000;

export const schedulePrototypeGenerationLoop = (
  connectionsStore: ConnectionsStore,
  eventLog: EventLog,
  vaultRoot: string,
  hygieneStatus: PrototypeGenerationHygiene,
  options: { readonly everyMs?: number; readonly startupDelayMs?: number } = {},
): (() => void) => {
  const runTick = async (): Promise<void> => {
    if (!prototypeGenerationEnabled()) return;
    try {
      const { peekRecallV2Store, warmRecallV2Store } = await import('../recall-v2/pipeline.js');
      warmRecallV2Store(vaultRoot);
      const store = (await peekRecallV2Store(vaultRoot)) as PrototypeStore | undefined;
      if (store === undefined) return;
      const { embed } = await import('../recall/embedder.js');
      const report = await runPrototypeGenerationTick(vaultRoot, connectionsStore, eventLog, {
        embed,
        store,
      });
      hygieneStatus.lastPrototypeGenerationAt = new Date(report.ranAt).toISOString();
      hygieneStatus.lastPrototypeGenerationRegenerated = report.regenerated;
      hygieneStatus.lastPrototypeGenerationChecked = report.workstreamsWithEvidence;
      hygieneStatus.lastPrototypeGenerationEngineUnavailableReason = report.engineUnavailableReason;
    } catch {
      // Best-effort — a failed generation tick must never crash the companion.
    }
  };
  const interval = setInterval(() => {
    void runTick();
  }, options.everyMs ?? PROTOTYPE_GENERATION_INTERVAL_MS);
  interval.unref?.();
  const kickoff = setTimeout(() => {
    void runTick();
  }, options.startupDelayMs ?? PROTOTYPE_GENERATION_STARTUP_DELAY_MS);
  kickoff.unref?.();
  return () => {
    clearInterval(interval);
    clearTimeout(kickoff);
  };
};
