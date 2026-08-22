// Prototype-lane offline generation — orchestration.
// docs/plans/2026-08-16-category-flexibility-hyde.md §3 (Phase 2) + §11
// ("prototype lane v2 — medoid selection + keyword profiles, generation as
// a measured expansion tier").
//
// WHAT THIS DOES, per workstream, on a background cadence (never per page,
// never on a request path):
//   1. Gather the workstream's own filed-visit evidence (titles + gists).
//   2. Decide DIRTY via a debounced watermark, ALSO checking a scoring-
//      version bump (§ below) — most ticks touch zero workstreams.
//   3. Below the cold-start floor → typed-skip, no production attempted.
//   4. MEDOID TIER (v2 default, EVERY workstream, English or not): select K
//      representative real member texts via greedy k-medoids over their
//      embeddings (prototypeMedoids.ts), excluding structural outliers (the
//      pineapple-cake guard). This is the generalized ReDE-RF path — real
//      evidence, embedded directly, never generated — and it is the ONLY
//      tier a non-English or Apple-FM-unavailable workstream ever gets.
//   5. GENERATION TIER (expansion, English-dominant evidence + Apple FM
//      available): a small number of synthetic-sibling prototypes —
//      register-matched (excerpt-style, never meta-description prose) and
//      explicitly asked to use vocabulary the saved evidence does NOT
//      already contain. Boosted (more prototypes) for sparse workstreams,
//      where interpolation value is highest; a mature workstream gets just
//      one, since its medoids already anchor most of the space. Skipping
//      this tier (engine down, zh-dominant, budget exceeded) is NEVER fatal
//      — the medoid tier still lands.
//   6. Embed every resulting text with the SAME embedder recall-v2 uses
//      (medoid texts reuse the embedding already computed for medoid
//      SELECTION — no second embed pass) and persist: one
//      WORKSTREAM_PROTOTYPE_GENERATED event per text (durable provenance,
//      angle-tagged) + an upsert into the recall-v2 sqlite-vec store's
//      prototype_vec table (the served copy the guess lane KNNs against).
//
// SELECTION ANCHORS, GENERATION EXPANDS. Medoids are real saved pages — they
// can never be "confidently wrong" about what the workstream contains, only
// possibly stale or non-diverse (mitigated by the k-medoid diversification
// + outlier guard). Generation covers what medoids structurally cannot:
// future/unseen vocabulary for the same activity. Both compete in the same
// served KNN; per-source prequential counters (tabsession/prototypeLane.ts)
// measure which one actually earns its keep, per workstream population
// regime — that measurement, not a priori judgment, is what should someday
// decide how the blend is tuned further.
//
// DIRTY-MARKING, NO FULL-PASS SWEEPS. `evidenceWatermark` encodes BOTH the
// evidence count and a content hash: "<count>:<sha256>". A workstream whose
// evidence set is byte-identical to its last generation's is a same-string
// compare, not a re-embed. Even when the watermark DOES change, regeneration
// only fires past a debounce (≥5 new evidence items OR ≥14 days elapsed,
// whichever first) — coarser than servedFeatureModel.ts's 120s TTL warmer
// because workstream semantics drift far slower than serve traffic. A
// SCORING-VERSION bump (PROTOTYPE_EMBEDDING_SCHEMA_VERSION) additionally
// forces every workstream dirty on its NEXT tick regardless of watermark —
// this is how v2's medoid/keyword-profile rescoring reaches an existing
// vault's already-generated prototypes with no manual migration, no
// full-pass sweep: the existing debounced tick loop just naturally catches
// every workstream up, one dirty tick at a time.
//
// GENERATION ENGINE. Apple FM ONLY (per the 2026-08-16 user directive) —
// this lane deliberately does NOT fall back to Nano/WebGPU/remote the way
// enrichment's resolveReadyEngine() does. Nano/WebGPU require a live browser
// panel session (Nano is a Chrome API; WebGPU's explicit-load singleton lives
// in the extension's sidepanel), neither of which a companion background job
// has access to; Apple FM alone is reachable over loopback HTTP from any
// process on the machine (see appleFmEngine.ts's header).

import { createHash } from 'node:crypto';

import type { ConnectionsStore } from '../connections/snapshot.js';
import { loadGistLookup } from '../enrichment/contentEnrichment.js';
import { readPageEvidenceMap, readPageEvidenceVectorMap } from '../page-evidence/store.js';
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
  evidenceExcerpt,
  gatherWorkstreamEvidence,
  selectEvidenceWithinBudget,
  workstreamEvidenceLanguage,
  type WorkstreamEvidenceItem,
} from './prototypeEvidence.js';
import { identifyOutliers, selectMedoids, type EmbeddedMember } from './prototypeMedoids.js';
import {
  buildKeywordProfilesForWorkstreams,
  type KeywordLookupDeps,
} from './prototypeKeywordProfileBuild.js';
import { splitIntoSentences } from './sentenceSplit.js';

// ---- env gating ----------------------------------------------------------

export const PROTOTYPE_GENERATION_ENV = 'SIDETRACK_PROTOTYPE_GENERATION';

/** Default ON — same kill-switch idiom as every other observe/shadow flag in
 *  this codebase (SIDETRACK_GUESS_LANES, SIDETRACK_CONTENT_LANE,
 *  SIDETRACK_LANE_PREQUENTIAL, SIDETRACK_LANE_CORROBORATION all default ON
 *  with an explicit '0'/'false' rollback). Gates the WHOLE tick (medoid tier
 *  included) — the generation tier ALSO stays subordinate to this same flag
 *  (per the brief: "generation stays env-gated (existing flag)"), it has no
 *  separate switch. */
export const prototypeGenerationEnabled = (): boolean => {
  const raw = process.env[PROTOTYPE_GENERATION_ENV];
  return raw !== '0' && raw !== 'false';
};

export const PROTOTYPE_COUNT_ENV = 'SIDETRACK_PROTOTYPE_COUNT';
const DEFAULT_PROTOTYPE_COUNT = 4;

/** K_medoid — how many medoid prototypes per workstream per batch (v1's name
 *  survives; v2 repurposes it specifically as the MEDOID tier's count, since
 *  medoids are now the always-on default every workstream gets — see
 *  prototypeGenerationCountFor for the SEPARATE generation-tier count).
 *  Clamped to the design's stated 3-5 range regardless of what the env says. */
export const prototypeCount = (): number => {
  const raw = Number(process.env[PROTOTYPE_COUNT_ENV]);
  if (!Number.isFinite(raw)) return DEFAULT_PROTOTYPE_COUNT;
  return Math.min(5, Math.max(3, Math.round(raw)));
};

/** Sparse-workstream generation boost (§11 refinement). Below this many
 *  filed members, generation contributes MORE prototypes — interpolation
 *  value is highest where medoids have the least real material to anchor
 *  on. A judgment call, flagged for golden-set tuning like every other
 *  unspecified numeric threshold in this feature area. */
export const PROTOTYPE_GENERATION_BOOST_BELOW_ENV = 'SIDETRACK_PROTOTYPE_GENERATION_BOOST_BELOW';
const DEFAULT_PROTOTYPE_GENERATION_BOOST_BELOW = 8;

export const prototypeGenerationBoostBelow = (): number => {
  const raw = Number(process.env[PROTOTYPE_GENERATION_BOOST_BELOW_ENV]);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_PROTOTYPE_GENERATION_BOOST_BELOW;
  return Math.round(raw);
};

export const PROTOTYPE_GENERATION_COUNT_SPARSE = 3;
export const PROTOTYPE_GENERATION_COUNT_MATURE = 1;

/** K_gen — how many synthetic-sibling prototypes to generate for a
 *  workstream with `memberCount` filed pages. */
export const prototypeGenerationCountFor = (memberCount: number): number =>
  memberCount < prototypeGenerationBoostBelow()
    ? PROTOTYPE_GENERATION_COUNT_SPARSE
    : PROTOTYPE_GENERATION_COUNT_MATURE;

/** Cold-start floor (design doc §6, risk 2 — "double cold-start"). Below
 *  this, production is not attempted at all; the north-star study's P3
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

/** v2 (§11) bumped from 1 to 2 — medoid selection + the single revised
 *  synthetic-sibling prompt materially change what every existing
 *  prototype's TEXT would be even for byte-identical evidence, so a version
 *  mismatch alone (see decideDirty) forces one regeneration per workstream
 *  on its next tick, with no manual migration and no full-pass sweep. */
export const PROTOTYPE_EMBEDDING_SCHEMA_VERSION = 2;

/** Bounded-per-cycle candidate pool for medoid embedding — most-recent-
 *  first, same "cap the population, never a full sweep" idiom as
 *  unfiledEvidence.ts's SIDETRACK_UNFILED_POPULATION_CAP and
 *  keywordBackfillLane.ts's batchCap. A workstream can have far more filed
 *  members than are worth (re-)embedding on any single dirty tick. */
export const MEDOID_CANDIDATE_POOL_CAP = 40;

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
  /** Every real historical event already carries this field (v1 wrote it,
   *  hardcoded to 1, but never read it back — see decideDirty). */
  readonly embeddingSchemaVersion: number;
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
        embeddingSchemaVersion: p.embeddingSchemaVersion,
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
  | {
      readonly dirty: true;
      readonly reason: 'first-generation' | 'evidence-grew' | 'stale' | 'version-bumped';
    };

/**
 * Pure decision function — no I/O, fully unit-testable. `nowMs` is threaded
 * so the 14-day trigger is deterministic in tests.
 *
 * VERSION-BUMP CHECKED BEFORE THE WATERMARK COMPARE. A scoring-version bump
 * (PROTOTYPE_EMBEDDING_SCHEMA_VERSION) means the OUTPUT text/algorithm
 * changed even for byte-identical evidence — "unchanged watermark" must not
 * short-circuit a version mismatch, or v2's medoid rescoring would never
 * reach a workstream whose evidence happens not to have grown since v1.
 *
 * BYTE-IDENTICAL EVIDENCE (AT THE CURRENT VERSION) SHORT-CIRCUITS REGARDLESS
 * OF STALENESS. Re-generating from the exact same evidence at an unchanged
 * version would spend an engine call to produce merely DIFFERENT (LLM
 * stochasticity) text, not more grounded text — the opposite of this
 * program's cost discipline. A workstream with genuinely stale evidence
 * (nothing filed to it in months) simply keeps its last-good prototypes.
 */
export const decideDirty = (
  evidenceCount: number,
  watermark: string,
  last: WorkstreamGenerationState | undefined,
  nowMs: number,
  currentVersion: number = PROTOTYPE_EMBEDDING_SCHEMA_VERSION,
): DirtyDecision => {
  if (evidenceCount < MIN_EVIDENCE_FOR_GENERATION) return { dirty: false, reason: 'below-floor' };
  if (last === undefined) return { dirty: true, reason: 'first-generation' };
  if (last.embeddingSchemaVersion !== currentVersion) return { dirty: true, reason: 'version-bumped' };
  if (last.evidenceWatermark === watermark) return { dirty: false, reason: 'unchanged' };
  const lastParsed = parseEvidenceWatermark(last.evidenceWatermark);
  const grew =
    lastParsed === null || evidenceCount - lastParsed.count >= MIN_NEW_EVIDENCE_SINCE_LAST;
  if (grew) return { dirty: true, reason: 'evidence-grew' };
  const stale = nowMs - last.generatedAt >= MAX_STALE_MS;
  if (stale) return { dirty: true, reason: 'stale' };
  return { dirty: false, reason: 'debounced' };
};

// ---- synthetic-sibling prompt (the ONLY generation angle v2 keeps) -------
//
// v1 varied FIVE prompt angles (theme-description, likely-excerpt,
// terminology, task-inference, distinctive-detail) — day-one evidence
// showed the meta-register ones (theme-description, behavioral-inference)
// render generic prose near every tech page, which is exactly what let
// three unrelated workstreams tie at ~0.82. v2 keeps only the one angle
// that behaves as a real EXCERPT (reads like a saved page's own gist+title)
// and explicitly widens vocabulary beyond what the evidence already says —
// the two properties that make this tier a genuine complement to the
// medoid tier rather than a redundant restatement of it.

const SYNTHETIC_SIBLING_PROMPT = (evidence: string): string =>
  `Below are short excerpts (titles and summaries) from web pages a person has ` +
  `saved into the same personal collection:\n\n${evidence}\n\n` +
  `Write ONE short excerpt (2-3 sentences), in the exact same style as a page ` +
  `title and summary shown above — NOT a description of the collection as a ` +
  `whole — that could plausibly be another page belonging to this same ` +
  `collection. Use related terminology and phrasings that do NOT already ` +
  `appear in the excerpts above, while staying on the exact same theme: the ` +
  `goal is a plausible NEW page in different words, not a restatement of the ` +
  `ones shown. Do not copy the excerpts above.`;

const MAX_GENERATION_OUTPUT_TOKENS = 120;

const cleanGeneratedText = (raw: string): string => {
  const trimmed = raw.trim().replace(/^["'“”]+|["'“”]+$/gu, '');
  return trimmed.length > PROTOTYPE_GENERATED_TEXT_MAX_LENGTH
    ? trimmed.slice(0, PROTOTYPE_GENERATED_TEXT_MAX_LENGTH)
    : trimmed;
};

// ---- shared engine client ---------------------------------------------

export interface AppleFmClient {
  readonly status: typeof appleFmStatus;
  readonly generate: typeof generateWithAppleFm;
}

const REAL_APPLE_FM_CLIENT: AppleFmClient = {
  status: appleFmStatus,
  generate: generateWithAppleFm,
};

export type EmbedFn = (texts: readonly string[]) => Promise<readonly Float32Array[]>;

// ---- medoid tier (v2 default, every workstream) ----------------------------

interface MedoidCandidate {
  readonly canonicalUrl: string;
  readonly text: string;
  readonly embedding: Float32Array;
}

/** Bounded-per-cycle, most-recent-first, only items with a real excerpt —
 *  mirrors prototypeEvidence.ts's own most-recent-first convention. */
const boundedCandidatePool = (
  items: readonly WorkstreamEvidenceItem[],
): readonly WorkstreamEvidenceItem[] => {
  const withExcerpt = items.filter((item) => evidenceExcerpt(item) !== null);
  return [...withExcerpt]
    .sort((left, right) => right.firstSeenAtMs - left.firstSeenAtMs)
    .slice(0, MEDOID_CANDIDATE_POOL_CAP);
};

/**
 * Read-only lookup of already-cached page-evidence doc vectors for the
 * candidate pool's canonicalUrls — the SAME accessors ranker/retrain.ts and
 * connectionsMaterializer.ts already use to consult the shared embed cache
 * (page-evidence/store.ts's readPageEvidenceMap + readPageEvidenceVectorMap,
 * backed by recall/embeddingCache.ts, keyed by the page's own content hash
 * via docEmbeddingRef.vectorId). Never writes — a page only gets a
 * docEmbeddingRef via the page-evidence extraction pipeline, never from
 * here — so a miss just means "not opportunistically indexed yet", not an
 * error. Best-effort: any lookup failure degrades to zero hits (every
 * candidate falls through to embedCandidatePool's normal embed path).
 */
const readCachedCandidateVectors = async (
  vaultRoot: string,
  pool: readonly WorkstreamEvidenceItem[],
): Promise<ReadonlyMap<string, Float32Array>> => {
  if (pool.length === 0) return new Map();
  try {
    const recordsByCanonicalUrl = await readPageEvidenceMap(
      vaultRoot,
      pool.map((item) => item.canonicalUrl),
    );
    if (recordsByCanonicalUrl.size === 0) return new Map();
    const vectorsByVectorId = await readPageEvidenceVectorMap(
      vaultRoot,
      recordsByCanonicalUrl.values(),
    );
    const out = new Map<string, Float32Array>();
    for (const [canonicalUrl, record] of recordsByCanonicalUrl) {
      const ref = record.content?.docEmbeddingRef;
      if (ref === undefined) continue;
      const vector = vectorsByVectorId.get(ref.vectorId);
      if (vector !== undefined) out.set(canonicalUrl, vector);
    }
    return out;
  } catch {
    return new Map();
  }
};

/**
 * Embed the bounded candidate pool — the SAME embed call medoid selection
 * needs, and the resulting vectors are reused DIRECTLY as the chosen
 * medoids' prototype vectors (a medoid's text IS the member's own excerpt
 * verbatim, so it never needs a second embed pass). Never throws; a failed
 * or dimension-mismatched batch degrades to [] (the caller treats that as
 * embedder-unavailable, the one fatal failure mode in this tier).
 *
 * REUSE (post-#389): when `vaultRoot` is supplied, a candidate whose
 * canonicalUrl already has a cached page-evidence doc vector
 * (readCachedCandidateVectors, read-only) reuses that vector instead of
 * being sent to `embed()` — only cache MISSES are embedded, in one batched
 * call across just the misses (never one embed call per candidate). A
 * fully-cached pool costs zero embed calls. NOTE (kept from the original
 * scope-cut this replaces): the cached vector is the page's own
 * quality-weighted BODY vector, not a re-embedding of the excerpt
 * (gist/title) text used for members that miss — both live in the same
 * embedding model's vector space, but a cache hit and a fresh embed are not
 * guaranteed byte-identical for the same URL. `vaultRoot` omitted (e.g. in
 * unit tests with no vault) preserves the pre-#389-fix behaviour: embed
 * every candidate, no lookup attempted.
 */
const embedCandidatePool = async (
  pool: readonly WorkstreamEvidenceItem[],
  embed: EmbedFn,
  vaultRoot?: string,
): Promise<readonly MedoidCandidate[]> => {
  const texts = pool.map((item) => evidenceExcerpt(item)!);
  if (texts.length === 0) return [];
  const cachedVectorByCanonicalUrl =
    vaultRoot === undefined ? new Map<string, Float32Array>() : await readCachedCandidateVectors(vaultRoot, pool);
  const misses: { readonly index: number; readonly text: string }[] = [];
  const vectors: (Float32Array | undefined)[] = pool.map((item, index) => {
    const cached = cachedVectorByCanonicalUrl.get(item.canonicalUrl);
    if (cached !== undefined) return cached;
    misses.push({ index, text: texts[index]! });
    return undefined;
  });
  if (cachedVectorByCanonicalUrl.size > 0) {
    // Audible: fires at most once per workstream per generation tick
    // (hours-scale) — the reuse ratio is the acceptance signal for this
    // branch, and a silent cache would be indistinguishable from the
    // always-re-embed behaviour it replaces.
    // eslint-disable-next-line no-console -- structured lane evidence
    console.info(
      `[prototype-gen] medoid embed reuse hits=${String(pool.length - misses.length)} misses=${String(misses.length)} pool=${String(pool.length)}`,
    );
  }
  if (misses.length > 0) {
    let embedded: readonly Float32Array[];
    try {
      embedded = await embed(misses.map((miss) => miss.text));
    } catch {
      return [];
    }
    if (embedded.length !== misses.length) return [];
    misses.forEach((miss, missIndex) => {
      vectors[miss.index] = embedded[missIndex]!;
    });
  }
  return pool.map((item, index) => ({
    canonicalUrl: item.canonicalUrl,
    text: texts[index]!,
    embedding: vectors[index]!,
  }));
};

interface MedoidSelectionResult {
  readonly picks: readonly MedoidCandidate[];
  readonly outlierUrls: ReadonlySet<string>;
}

/** Pure wrapper over prototypeMedoids.ts's generic id/embedding primitives,
 *  typed to this module's MedoidCandidate shape — see prototypeMedoids.ts
 *  for the algorithm (greedy k-medoids + P90 centroid-distance outlier
 *  exclusion, the pineapple-cake guard). */
const selectMedoidPrototypes = (
  candidates: readonly MedoidCandidate[],
  k: number,
): MedoidSelectionResult => {
  const asMembers: readonly EmbeddedMember[] = candidates.map((c) => ({
    id: c.canonicalUrl,
    embedding: c.embedding,
  }));
  const outlierUrls = identifyOutliers(asMembers);
  const medoidUrls = selectMedoids(asMembers, k, outlierUrls);
  const byUrl = new Map(candidates.map((c) => [c.canonicalUrl, c]));
  const picks = medoidUrls.flatMap((url) => {
    const candidate = byUrl.get(url);
    return candidate === undefined ? [] : [candidate];
  });
  return { picks, outlierUrls };
};

// ---- combined production (medoid tier + generation tier) ------------------

export interface ProducedPrototype {
  readonly text: string;
  readonly method: 'generated' | 'selected';
  readonly angle: 'medoid' | 'synthetic-sibling';
  /** Present only for angle='medoid' — the exact member this text was drawn
   *  from (the brief's "provenance: member url, evidence watermark"; the
   *  watermark half is already on every event via `evidenceWatermark`). */
  readonly sourceMemberUrl?: string;
  /** Already embedded — medoid vectors are reused from candidate-pool
   *  embedding, generated vectors from the post-generation embed batch. No
   *  second embed pass anywhere in this module. */
  readonly vec: Float32Array;
}

export type ProductionOutcome =
  | {
      readonly kind: 'produced';
      readonly prototypes: readonly ProducedPrototype[];
      readonly medoidGeneratorModelId: string;
      readonly generatedGeneratorModelId: string | null;
      /** Non-null whenever the generation (expansion) tier contributed
       *  nothing THIS tick — never fatal on its own; the medoid tier still
       *  lands. null only when generation actually ran and produced
       *  something. */
      readonly generationSkippedReason: string | null;
    }
  | { readonly kind: 'embedder-unavailable'; readonly reason: string };

/**
 * Produce ALL prototypes for one workstream's evidence: the medoid tier
 * (always attempted) plus, when eligible, the generation/expansion tier.
 * Never throws. Only a total medoid-embedding failure is treated as fatal
 * — Apple FM being unavailable, or the evidence being non-English, degrades
 * the OUTCOME to "medoids only", never blocks the batch.
 */
export const produceWorkstreamPrototypes = async (
  items: readonly WorkstreamEvidenceItem[],
  medoidCount: number,
  deps: {
    readonly embed: EmbedFn;
    readonly client?: AppleFmClient;
    /** Enables the cached-doc-vector reuse lookup in embedCandidatePool
     *  (see its doc comment). Omitted in most unit tests — embeds every
     *  candidate, matching pre-reuse behaviour. */
    readonly vaultRoot?: string;
  },
): Promise<ProductionOutcome> => {
  const pool = boundedCandidatePool(items);
  const candidates = await embedCandidatePool(pool, deps.embed, deps.vaultRoot);
  if (candidates.length === 0) {
    return {
      kind: 'embedder-unavailable',
      reason: 'embedder returned no (or a mismatched number of) vectors',
    };
  }

  const { picks, outlierUrls } = selectMedoidPrototypes(candidates, medoidCount);
  const medoidGeneratorModelId = 'medoid-selection#v2';
  const medoidPrototypes: ProducedPrototype[] = picks.map((p) => ({
    text: p.text,
    method: 'selected',
    angle: 'medoid',
    sourceMemberUrl: p.canonicalUrl,
    vec: p.embedding,
  }));

  const language = workstreamEvidenceLanguage(items);
  let generatedPrototypes: readonly ProducedPrototype[] = [];
  let generatedGeneratorModelId: string | null = null;
  let generationSkippedReason: string | null = null;

  if (language !== 'en') {
    generationSkippedReason = `evidence language is ${language} — Apple FM generation is english-only, medoid tier only`;
  } else {
    const client = deps.client ?? REAL_APPLE_FM_CLIENT;
    const status = await client.status();
    if (!status.available) {
      generationSkippedReason = appleFmUnavailableCopy(status.reason);
    } else {
      const kGen = prototypeGenerationCountFor(items.length);
      const budgetChars = evidenceBudgetChars(appleMaxInputChars(status.contextTokens));
      // The outlier guard applies here too — a structurally-excluded member
      // must not leak into the generation prompt either.
      const evidenceForGeneration = items.filter((item) => !outlierUrls.has(item.canonicalUrl));
      const { text: evidenceText } = selectEvidenceWithinBudget(evidenceForGeneration, budgetChars);
      if (evidenceText.length === 0) {
        generationSkippedReason = 'no evidence text to generate from';
      } else {
        const rawTexts: string[] = [];
        for (let i = 0; i < kGen; i += 1) {
          const raw = await client.generate({
            prompt: SYNTHETIC_SIBLING_PROMPT(evidenceText),
            maxOutputTokens: MAX_GENERATION_OUTPUT_TOKENS,
            timeoutMs: APPLE_GENERATION_TIMEOUT_MS,
          });
          if (raw === null) continue;
          const cleaned = cleanGeneratedText(raw);
          if (cleaned.length === 0) continue;
          rawTexts.push(cleaned);
        }
        if (rawTexts.length === 0) {
          generationSkippedReason = 'the local Apple AI service answered, but every generation failed';
        } else {
          let vectors: readonly Float32Array[];
          try {
            vectors = await deps.embed(rawTexts);
          } catch {
            vectors = [];
          }
          if (vectors.length === rawTexts.length) {
            generatedGeneratorModelId = 'apple-fm#reason=ok';
            generatedPrototypes = rawTexts.map((text, index) => ({
              text,
              method: 'generated' as const,
              angle: 'synthetic-sibling' as const,
              vec: vectors[index]!,
            }));
          } else {
            generationSkippedReason = 'generated text embedding failed';
          }
        }
      }
    }
  }

  return {
    kind: 'produced',
    prototypes: [...medoidPrototypes, ...generatedPrototypes],
    medoidGeneratorModelId,
    generatedGeneratorModelId,
    generationSkippedReason,
  };
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
      readonly angle?: 'medoid' | 'synthetic-sibling';
      readonly sourceMemberUrl?: string;
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
    readonly angle?: 'medoid' | 'synthetic-sibling';
    readonly sourceMemberUrl?: string;
  }[];
  allPrototypeWorkstreamIds(): ReadonlySet<string>;
  queryPrototypeVector(opts: { readonly vec: Float32Array; readonly limit: number }): readonly {
    readonly prototypeId: string;
    readonly workstreamId: string;
    readonly cosineDistance: number;
    readonly angle?: 'medoid' | 'synthetic-sibling';
  }[];
  /** Sentence vectors (§12) — optional, same "fixture predating this phase
   *  still satisfies the interface, real store always implements it"
   *  contract as replacePrototypeKeywordProfiles below. Absent -> this
   *  module simply never persists prototype sentence vectors, and every
   *  downstream reader (tabsession/prototypeLane.ts) degrades to its
   *  documented single-vector fallback. */
  replaceSentenceVectors?(
    ownerKind: 'page' | 'prototype',
    ownerId: string,
    sentences: readonly {
      readonly sentenceIndex: number;
      readonly source: string;
      readonly text: string;
      readonly embedding: Float32Array;
    }[],
  ): void;
  /** v2 keyword-profile signal (§11) — optional on the interface so a
   *  fixture/store that predates it still satisfies PrototypeStore; the
   *  real recall-v2 SqliteRecallStore always implements it. */
  replacePrototypeKeywordProfiles?(
    idf: ReadonlyMap<string, number>,
    profiles: ReadonlyMap<
      string,
      {
        readonly weights: ReadonlyMap<string, number>;
        readonly displayKeyword: ReadonlyMap<string, string>;
      }
    >,
  ): void;
}

// ---- one workstream's generation pass --------------------------------------

export interface WorkstreamGenerationResult {
  readonly workstreamId: string;
  readonly outcome:
    | 'below-floor'
    | 'unchanged'
    | 'debounced'
    | 'embedder-unavailable'
    | 'regenerated';
  readonly detail?: string;
  readonly prototypeCount?: number;
  readonly medoidCount?: number;
  readonly generatedCount?: number;
  /** Present whenever the generation/expansion tier contributed nothing
   *  this tick — NOT fatal; `outcome` can still be 'regenerated' from the
   *  medoid tier alone. */
  readonly generationSkippedReason?: string;
}

/**
 * Idempotent append — a batch that already landed (same clientEventId, which
 * is a pure function of workstreamId + watermark + index) is a no-op on
 * retry, so a tick interrupted mid-batch never double-writes on the next.
 */
const prototypeClientEventId = (prototypeId: string): string =>
  `prototype:${createHash('sha256').update(prototypeId).digest('hex').slice(0, 32)}`;

// ---- sentence vectors (§12) — prototype-text side ---------------------
//
// Prototype text (a medoid's excerpt or a generated sibling) has no
// separate "title" the way a page does — SYNTHETIC_SIBLING_PROMPT already
// asks for a short excerpt-register text, so it is split with the plain
// sentence splitter (no title composition) into up to
// resolveSentenceSplitMax() sentences.

interface PrototypeSentenceRow {
  readonly prototypeId: string;
  readonly text: string;
  readonly angle: 'medoid' | 'synthetic-sibling';
}

const embedAndPersistPrototypeSentences = async (
  rows: readonly PrototypeSentenceRow[],
  embed: EmbedFn,
  store: PrototypeStore,
): Promise<void> => {
  if (store.replaceSentenceVectors === undefined || rows.length === 0) return;
  const flat: { readonly prototypeId: string; readonly sentenceIndex: number; readonly text: string; readonly angle: 'medoid' | 'synthetic-sibling' }[] = [];
  for (const row of rows) {
    splitIntoSentences(row.text).forEach((text, sentenceIndex) => {
      flat.push({ prototypeId: row.prototypeId, sentenceIndex, text, angle: row.angle });
    });
  }
  if (flat.length === 0) {
    // Every row's text produced zero sentences (below the min-length floor)
    // — still clear any STALE sentence rows a prior generation may have
    // left for these exact prototypeIds (a fresh prototypeId per
    // regeneration makes this a rare edge, but a re-run against an
    // unchanged id — e.g. a retried tick — must not leave orphaned data).
    for (const row of rows) store.replaceSentenceVectors('prototype', row.prototypeId, []);
    return;
  }
  let vectors: readonly Float32Array[];
  try {
    vectors = await embed(flat.map((item) => item.text));
  } catch {
    return; // best-effort — never blocks prototype generation itself
  }
  if (vectors.length !== flat.length) return;

  const byPrototypeId = new Map<
    string,
    { readonly sentenceIndex: number; readonly source: string; readonly text: string; readonly embedding: Float32Array }[]
  >();
  flat.forEach((item, index) => {
    const list = byPrototypeId.get(item.prototypeId) ?? [];
    list.push({
      sentenceIndex: item.sentenceIndex,
      source: item.angle,
      text: item.text,
      embedding: vectors[index]!,
    });
    byPrototypeId.set(item.prototypeId, list);
  });
  for (const row of rows) {
    store.replaceSentenceVectors('prototype', row.prototypeId, byPrototypeId.get(row.prototypeId) ?? []);
  }
};

export const generatePrototypesForWorkstream = async (
  input: {
    readonly workstreamId: string;
    readonly items: readonly WorkstreamEvidenceItem[];
    readonly last: WorkstreamGenerationState | undefined;
    readonly nowMs: number;
    /** K_medoid — the generation/expansion tier's own count is derived
     *  separately per workstream (prototypeGenerationCountFor). */
    readonly count: number;
  },
  deps: {
    readonly eventLog: Pick<EventLog, 'appendServerObserved' | 'findByClientEventId'>;
    readonly embed: EmbedFn;
    readonly store: PrototypeStore;
    readonly client?: AppleFmClient;
    /** See produceWorkstreamPrototypes — threaded through for the cached
     *  doc-vector reuse lookup. */
    readonly vaultRoot?: string;
  },
): Promise<WorkstreamGenerationResult> => {
  const watermark = computeEvidenceWatermark(input.items);
  const decision = decideDirty(input.items.length, watermark, input.last, input.nowMs);
  if (!decision.dirty) {
    return { workstreamId: input.workstreamId, outcome: decision.reason };
  }

  const outcome = await produceWorkstreamPrototypes(input.items, input.count, {
    embed: deps.embed,
    ...(deps.client === undefined ? {} : { client: deps.client }),
    ...(deps.vaultRoot === undefined ? {} : { vaultRoot: deps.vaultRoot }),
  });
  if (outcome.kind === 'embedder-unavailable') {
    return {
      workstreamId: input.workstreamId,
      outcome: 'embedder-unavailable',
      detail: outcome.reason,
    };
  }
  if (outcome.prototypes.length === 0) {
    return {
      workstreamId: input.workstreamId,
      outcome: 'embedder-unavailable',
      detail: outcome.generationSkippedReason ?? 'no prototypes produced',
    };
  }

  const sourceEvidenceIds = [...new Set(input.items.map((item) => item.canonicalUrl))].slice(
    0,
    PROTOTYPE_SOURCE_EVIDENCE_MAX_COUNT,
  );

  const rows = outcome.prototypes.map((p, index) => ({
    prototypeId: `${input.workstreamId}:${watermark}:${String(index)}`,
    text: p.text,
    method: p.method,
    angle: p.angle,
    sourceMemberUrl: p.sourceMemberUrl,
    vec: p.vec,
    generatorModelId:
      p.angle === 'medoid' ? outcome.medoidGeneratorModelId : outcome.generatedGeneratorModelId ?? 'unknown',
  }));

  for (const row of rows) {
    const payload: PrototypeGeneratedSnapshot = {
      payloadVersion: 1,
      prototypeId: row.prototypeId,
      workstreamId: input.workstreamId,
      generatedText: row.text,
      embeddingSchemaVersion: PROTOTYPE_EMBEDDING_SCHEMA_VERSION,
      sourceEvidenceIds,
      generatorModelId: row.generatorModelId,
      generatedAt: input.nowMs,
      method: row.method,
      evidenceWatermark: watermark,
      angle: row.angle,
      ...(row.sourceMemberUrl === undefined ? {} : { sourceMemberUrl: row.sourceMemberUrl }),
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
  // This ALSO clears every stale sentence-vector row for the workstream's
  // PRIOR prototype ids (see sqlite.ts's deletePrototypesForWorkstream —
  // prototypeId embeds the watermark, so old ids would otherwise leak).
  deps.store.deletePrototypesForWorkstream(input.workstreamId);
  for (const row of rows) {
    deps.store.upsertPrototype(
      {
        prototypeId: row.prototypeId,
        workstreamId: input.workstreamId,
        generatedText: row.text,
        generatorModelId: row.generatorModelId,
        method: row.method,
        generatedAt: input.nowMs,
        evidenceWatermark: watermark,
        angle: row.angle,
        ...(row.sourceMemberUrl === undefined ? {} : { sourceMemberUrl: row.sourceMemberUrl }),
      },
      row.vec,
    );
  }

  // Sentence vectors (§12) — split + embed every produced prototype's TEXT
  // at generation time (same cadence as the whole-vector embed above, which
  // only fires past this tick's dirty-marking debounce, so this stays
  // bounded per the same discipline). ONE batched embed call across every
  // row in this batch (cost discipline — not one embed call per prototype),
  // mirroring embedCandidatePool's own "embed once, reuse" shape. Best-
  // effort: a store that predates §12 (replaceSentenceVectors undefined) or
  // an embed failure never blocks prototype generation itself — the medoid/
  // generation tiers above have already landed by this point regardless.
  if (deps.store.replaceSentenceVectors !== undefined) {
    await embedAndPersistPrototypeSentences(rows, deps.embed, deps.store);
  }

  const medoidCount = rows.filter((r) => r.angle === 'medoid').length;
  const generatedCount = rows.filter((r) => r.angle === 'synthetic-sibling').length;

  return {
    workstreamId: input.workstreamId,
    outcome: 'regenerated',
    prototypeCount: rows.length,
    medoidCount,
    generatedCount,
    ...(outcome.generationSkippedReason === null
      ? {}
      : { generationSkippedReason: outcome.generationSkippedReason }),
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
  /** Ticks where the GENERATION (expansion) tier was skipped for ANY
   *  reason — the medoid tier may well have still succeeded; this is an
   *  observability counter, not a failure counter (see
   *  WorkstreamGenerationResult.generationSkippedReason). */
  readonly engineUnavailable: number;
  /** Ticks where NOTHING was produced (medoid embedding itself failed) —
   *  the one truly fatal outcome in this tier. */
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
 * One production pass over every workstream that currently has filed
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
    /** v2 keyword-profile signal (§11) — optional; when absent, the
     *  keyword-profile store is simply left at its last-built state (or
     *  empty) and the lane's keyword blend degrades to pure vector scoring
     *  for every candidate, same "vectors only" fallback contract as
     *  splitSuggestionEngine.ts's hybridSimilarity. */
    readonly keywordLookup?: KeywordLookupDeps;
  },
  nowMs: number = Date.now(),
): Promise<PrototypeGenerationTickReport> => {
  if (!prototypeGenerationEnabled()) return EMPTY_REPORT(nowMs, false);

  const gistLookup = await loadGistLookup(vaultRoot, eventLog).catch(() => null);
  const evidenceByWorkstream = await gatherWorkstreamEvidence(connectionsStore, gistLookup).catch(
    () => new Map<string, readonly WorkstreamEvidenceItem[]>(),
  );
  if (evidenceByWorkstream.size === 0) return EMPTY_REPORT(nowMs, true);

  // Keyword-profile refresh — same cadence as prototype regeneration, but
  // NOT gated by per-workstream dirty-marking: it is a cheap full-replace
  // over a small vocabulary (see sqlite.ts's replacePrototypeKeywordProfiles
  // doc comment), so there is no correctness reason to debounce it
  // separately, and doing so would mean the keyword signal can silently lag
  // a workstream whose PROTOTYPES didn't need regenerating but whose
  // MEMBERSHIP (and therefore keyword profile) still grew.
  if (deps.keywordLookup !== undefined && deps.store.replacePrototypeKeywordProfiles !== undefined) {
    try {
      const { profiles, idf } = buildKeywordProfilesForWorkstreams(
        evidenceByWorkstream,
        deps.keywordLookup,
      );
      deps.store.replacePrototypeKeywordProfiles(idf, profiles);
    } catch {
      // Best-effort — a failed keyword-profile refresh must never block
      // prototype generation itself.
    }
  }

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
      { eventLog, vaultRoot, ...deps },
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
      case 'embedder-unavailable':
        embedderUnavailable += 1;
        break;
    }
    if (result.generationSkippedReason !== undefined) {
      engineUnavailable += 1;
      engineUnavailableReason ??= result.generationSkippedReason;
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
    // Short-lived per-tick handles (this runs on an hours-scale interval —
    // opening/closing a small SQLite handle per tick is cheap and avoids
    // holding a keyword-store connection open for the companion's whole
    // lifetime for a feature that only reads it once every few hours).
    const closers: (() => void)[] = [];
    try {
      const { peekRecallV2Store, warmRecallV2Store } = await import('../recall-v2/pipeline.js');
      warmRecallV2Store(vaultRoot);
      const store = (await peekRecallV2Store(vaultRoot)) as PrototypeStore | undefined;
      if (store === undefined) return;
      const { embed } = await import('../recall/embedder.js');

      let keywordLookup: KeywordLookupDeps | undefined;
      try {
        const { createKeywordIndexStore } = await import('../search-index/keywordIndexStore.js');
        const { createKeywordConceptStore } = await import('../enrichment/keywordConceptStore.js');
        const indexStore = await createKeywordIndexStore(vaultRoot);
        closers.push(() => indexStore.close());
        const conceptStore = await createKeywordConceptStore(vaultRoot);
        closers.push(() => conceptStore.close());
        keywordLookup = {
          keywordsForPage: (pageKey) => indexStore.keywordsForPage(pageKey),
          conceptForKeyword: (keyword) => conceptStore.conceptForKeyword(keyword),
        };
      } catch {
        // Keyword layer unavailable this tick — the lane's keyword blend
        // degrades to pure vector scoring; never blocks prototype generation.
        keywordLookup = undefined;
      }

      const report = await runPrototypeGenerationTick(vaultRoot, connectionsStore, eventLog, {
        embed,
        store,
        ...(keywordLookup === undefined ? {} : { keywordLookup }),
      });
      hygieneStatus.lastPrototypeGenerationAt = new Date(report.ranAt).toISOString();
      hygieneStatus.lastPrototypeGenerationRegenerated = report.regenerated;
      hygieneStatus.lastPrototypeGenerationChecked = report.workstreamsWithEvidence;
      hygieneStatus.lastPrototypeGenerationEngineUnavailableReason = report.engineUnavailableReason;
    } catch {
      // Best-effort — a failed generation tick must never crash the companion.
    } finally {
      for (const close of closers) close();
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
