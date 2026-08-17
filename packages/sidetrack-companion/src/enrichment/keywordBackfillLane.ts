// Keyword backfill lane — bounded, incremental backfill of the keyword
// index (search-index/keywordIndexStore.ts) over gists that predate the
// keyword layer (or predate the "Keywords:" prompt line — see
// keywordExtract.ts's header on why backfill and "the zh path" are the same
// code path).
//
// SAME IDIOM AS page-evidence/backgroundEmbeddingLane.ts, DELIBERATELY —
// self-scheduling cycle (fast poll while backlog remains, slow poll once
// empty), a bounded batch per cycle, persisted progress, never a boot
// full-pass. Simpler than that module in one load-bearing respect: "is this
// page done" has a TRIVIAL, exact answer here (keywordIndexStore.hasPage) —
// unlike an embedding's multi-state lifecycle (missing/failed/ready), a
// page's keyword-index row either exists or it doesn't, so this lane does
// NOT need its own resumption cursor for correctness (hasIndexed alone is
// idempotent and resumable across restarts); progress is still persisted for
// OBSERVABILITY and a small per-page attempt cap (a gist that keeps
// throwing must not be retried every single cycle forever).
//
// NO LLM, EVER. `indexCandidate` (injected) is expected to be
// keywordIngest.ts's `ingestGistKeywords` — for a gist with no "Keywords:"
// line (every gist saved before this feature shipped, or a zh/mixed one),
// keywordExtract.ts's `extractKeywords` already falls through to the
// DETERMINISTIC path on its own. This lane never calls an LLM and never asks
// its caller to; the ONLY model call `ingestGistKeywords` makes is the
// embedder (for concept assignment), which is not a generative call.
//
// NOT WIRED INTO runtime/companion.ts. That file is a concurrent sibling's
// active area (see the module list in the PR description) — this lane is a
// standalone, fully-tested factory function, ready to splice into the boot
// sequence once that file is free, mirroring exactly how the sibling
// category-multi-membership PR left its own recall-v2 evidence wiring as a
// tested pure function rather than reaching into a file it didn't own.

import type { EntityTitleEnrichedKind } from './events.js';
import { parseGistLookupKey, type GistLookup } from './contentEnrichment.js';

export interface KeywordBackfillCandidate {
  readonly pageKey: string;
  readonly kind: EntityTitleEnrichedKind;
  readonly id: string;
  readonly gist: string;
}

export interface KeywordBackfillLaneDeps {
  /** List candidate pages that MIGHT need backfilling — most-recent-first,
   *  bounded by the caller (see keywordBackfillCandidatesFromGistLookup's
   *  own `limit`). Called once per cycle; the lane does NOT re-bound this
   *  list beyond filtering already-indexed pages and applying batchCap. */
  readonly listCandidates: () => Promise<readonly KeywordBackfillCandidate[]>;
  readonly hasIndexed: (pageKey: string) => Promise<boolean>;
  /** Index one candidate (extract + upsert + concept-assign). A throw is
   *  caught by the lane and counted as a failure — never an inline crash. */
  readonly indexCandidate: (candidate: KeywordBackfillCandidate) => Promise<void>;
  readonly readProgress?: () => Promise<KeywordBackfillProgress | null>;
  /** Persist the progress cursor. Best-effort; a throw is swallowed. */
  readonly writeProgress?: (progress: KeywordBackfillProgress) => Promise<void>;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

export interface KeywordBackfillLaneConfig {
  /** Max candidates INDEXED per cycle. Hard cap — a backfill must never
   *  become an unbounded pass no matter how large the candidate list is. */
  readonly batchCap: number;
  readonly cycleIntervalMs: number;
  readonly idleIntervalMs: number;
  /** After this many consecutive failed attempts a page is quarantined
   *  (skipped) — permanently, for this lane's lifetime (no cooldown decay,
   *  unlike backgroundEmbeddingLane.ts: a gist's TEXT never changes on its
   *  own, so a page that fails deterministic extraction three times in a
   *  row will fail it forever, and retrying it is pure waste — this is
   *  unlike an embedder warm-up race, which is exactly the transient
   *  failure class that module's cooldown exists for). */
  readonly maxAttemptsPerPage: number;
}

export const DEFAULT_KEYWORD_BACKFILL_CONFIG: KeywordBackfillLaneConfig = {
  batchCap: 20,
  cycleIntervalMs: 2_000,
  idleIntervalMs: 60_000,
  maxAttemptsPerPage: 3,
};

export interface KeywordBackfillProgress {
  readonly schemaVersion: 1;
  readonly processedTotal: number;
  readonly lastRunAtMs: number | null;
  readonly attemptsByPageKey: Record<string, number>;
}

const emptyProgress = (): KeywordBackfillProgress => ({
  schemaVersion: 1,
  processedTotal: 0,
  lastRunAtMs: null,
  attemptsByPageKey: {},
});

export interface KeywordBackfillCycleResult {
  readonly scanned: number;
  readonly backlog: number;
  readonly indexed: number;
  readonly failed: number;
  readonly quarantined: number;
}

export interface KeywordBackfillLaneHealth {
  readonly processedTotal: number;
  readonly lastBacklog: number;
  readonly lastRunAtMs: number | null;
  readonly quarantinedCount: number;
}

export interface KeywordBackfillLane {
  /** Run exactly one bounded cycle. Exposed for tests + the scheduler.
   *  Never throws — every per-candidate error is contained. */
  readonly runOnce: () => Promise<KeywordBackfillCycleResult>;
  /** Start the self-scheduling timer loop. Idempotent. */
  readonly start: () => void;
  /** Stop the timer loop. Idempotent; safe to call in teardown. */
  readonly stop: () => void;
  readonly progress: () => KeywordBackfillProgress;
  readonly health: () => KeywordBackfillLaneHealth;
}

export const createKeywordBackfillLane = (
  deps: KeywordBackfillLaneDeps,
  config: KeywordBackfillLaneConfig = DEFAULT_KEYWORD_BACKFILL_CONFIG,
): KeywordBackfillLane => {
  let progressState: KeywordBackfillProgress = emptyProgress();
  let lastBacklog = 0;
  let loaded = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((): void => undefined);

  const ensureLoaded = async (): Promise<void> => {
    if (loaded) return;
    loaded = true;
    try {
      const stored = await deps.readProgress?.();
      if (stored !== null && stored !== undefined) progressState = stored;
    } catch {
      // Best-effort — start from empty progress on a read failure.
    }
  };

  const persist = async (): Promise<void> => {
    try {
      await deps.writeProgress?.(progressState);
    } catch {
      // Best-effort — a progress-write failure must not stop the lane.
    }
  };

  const runOnce = async (): Promise<KeywordBackfillCycleResult> => {
    await ensureLoaded();
    let candidates: readonly KeywordBackfillCandidate[];
    try {
      candidates = await deps.listCandidates();
    } catch {
      candidates = [];
    }

    const backlog: KeywordBackfillCandidate[] = [];
    for (const candidate of candidates) {
      const attempts = progressState.attemptsByPageKey[candidate.pageKey] ?? 0;
      if (attempts >= config.maxAttemptsPerPage) continue; // quarantined — never retried
      let already: boolean;
      try {
        already = await deps.hasIndexed(candidate.pageKey);
      } catch {
        already = false;
      }
      if (!already) backlog.push(candidate);
    }
    lastBacklog = backlog.length;

    const batch = backlog.slice(0, Math.max(0, config.batchCap));
    let indexed = 0;
    let failed = 0;
    const attemptsByPageKey = { ...progressState.attemptsByPageKey };
    for (const candidate of batch) {
      try {
        await deps.indexCandidate(candidate);
        indexed += 1;
        delete attemptsByPageKey[candidate.pageKey];
      } catch (error) {
        failed += 1;
        attemptsByPageKey[candidate.pageKey] = (attemptsByPageKey[candidate.pageKey] ?? 0) + 1;
        log(`keywordBackfillLane: failed to index ${candidate.pageKey}: ${String(error)}`);
      }
    }

    const quarantined = Object.values(attemptsByPageKey).filter(
      (attempts) => attempts >= config.maxAttemptsPerPage,
    ).length;

    progressState = {
      schemaVersion: 1,
      processedTotal: progressState.processedTotal + indexed,
      lastRunAtMs: now(),
      attemptsByPageKey,
    };
    await persist();

    return { scanned: candidates.length, backlog: backlog.length, indexed, failed, quarantined };
  };

  const scheduleNext = (delayMs: number): void => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void runOnce()
        .then((result) => {
          const remaining = result.backlog - result.indexed;
          scheduleNext(remaining > 0 ? config.cycleIntervalMs : config.idleIntervalMs);
        })
        .catch(() => {
          scheduleNext(config.idleIntervalMs);
        });
    }, delayMs);
    // Never holds the process open — same discipline
    // schedulePrototypeGenerationLoop's timers use.
    timer.unref?.();
  };

  return {
    runOnce,
    start: () => {
      scheduleNext(0);
    },
    stop: () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    progress: () => progressState,
    health: () => ({
      processedTotal: progressState.processedTotal,
      lastBacklog,
      lastRunAtMs: progressState.lastRunAtMs,
      quarantinedCount: Object.values(progressState.attemptsByPageKey).filter(
        (attempts) => attempts >= config.maxAttemptsPerPage,
      ).length,
    }),
  };
};

// ---------------------------------------------------------------------------
// GistLookup adapter — turns the already-folded, retraction-aware gist
// lookup (contentEnrichment.ts) into a bounded, most-recent-first candidate
// list. This is the "env-capped most-recent-first population" idiom
// prototypeEvidence.ts's selectEvidenceWithinBudget already established,
// applied here to bound how much of a large vault's gist history the
// backfill lane's listCandidates() call even considers per cycle.
// ---------------------------------------------------------------------------

export const KEYWORD_BACKFILL_POPULATION_CAP_ENV = 'SIDETRACK_KEYWORD_BACKFILL_POPULATION_CAP';
export const DEFAULT_KEYWORD_BACKFILL_POPULATION_CAP = 2_000;

export const resolveKeywordBackfillPopulationCap = (): number => {
  const raw = process.env[KEYWORD_BACKFILL_POPULATION_CAP_ENV];
  if (raw === undefined || raw === '') return DEFAULT_KEYWORD_BACKFILL_POPULATION_CAP;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_KEYWORD_BACKFILL_POPULATION_CAP;
  return parsed;
};

export const keywordBackfillCandidatesFromGistLookup = (
  lookup: GistLookup,
  limit: number = resolveKeywordBackfillPopulationCap(),
): readonly KeywordBackfillCandidate[] => {
  const all: (KeywordBackfillCandidate & { readonly generatedAt: string })[] = [];
  for (const [key, entry] of lookup) {
    const parsed = parseGistLookupKey(key);
    if (parsed === null) continue;
    all.push({
      pageKey: key,
      kind: parsed.kind,
      id: parsed.id,
      gist: entry.gist,
      generatedAt: entry.generatedAt,
    });
  }
  all.sort((left, right) => right.generatedAt.localeCompare(left.generatedAt));
  return all.slice(0, Math.max(0, limit)).map(({ pageKey, kind, id, gist }) => ({
    pageKey,
    kind,
    id,
    gist,
  }));
};
