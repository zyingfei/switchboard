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
// WIRED INTO runtime/companion.ts via scheduleKeywordBackfillLoop (bottom of
// this file) — same split as workstreams/suggestionRecomputeLane.ts: the pure
// lane above stays DI-only and fully unit-tested without touching disk, and
// the scheduler section below owns opening this vault's real store handles,
// mirroring scheduleSuggestionRecomputeLoop's shape exactly (2026-08-16, gap
// fix — createKeywordBackfillLane had zero production callers; see this PR's
// landing note for the full wiring audit).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { createRevision } from '../domain/ids.js';
import type { EventLog } from '../sync/eventLog.js';
import type { EntityTitleEnrichedKind } from './events.js';
import { loadGistLookup, parseGistLookupKey, type GistLookup } from './contentEnrichment.js';
import { ingestGistKeywords, keywordIngestEnabled } from './keywordIngest.js';
import { createKeywordConceptStore, type KeywordConceptStore } from './keywordConceptStore.js';
import { createKeywordIndexStore, type KeywordIndexStore } from '../search-index/keywordIndexStore.js';

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
  /** Best-effort total distinct concept count, read AFTER this cycle's
   *  indexCandidate calls — folded into the audible per-cycle log line
   *  (`concepts=`). Omitted or throwing -> 0; a concept-store read failure
   *  must never fail or silence the cycle it's merely reporting on. */
  readonly conceptsTotal?: () => number;
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

// ---- flag -----------------------------------------------------------------

export const KEYWORD_BACKFILL_ENV = 'SIDETRACK_KEYWORD_BACKFILL';

/** Default ON — same kill-switch idiom as keywordIngest.ts's
 *  keywordIngestEnabled(). '0'/'false' disables: scheduleKeywordBackfillLoop
 *  opens no store handles and starts no timer at all when this is off (zero
 *  cost), not merely a no-op cycle. */
export const keywordBackfillEnabled = (): boolean => {
  const raw = process.env[KEYWORD_BACKFILL_ENV];
  return raw !== '0' && raw !== 'false';
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

    // Audible per-cycle mark — UNCONDITIONAL, including a fully-idle cycle
    // (processed=0 remaining=0). Silence is how this lane shipped with zero
    // production callers for hours undetected: an operator staring at logs
    // could not tell "not wired" apart from "wired, quietly caught up" until
    // this line existed. Best-effort concepts read (deps.conceptsTotal) — a
    // failure there must not suppress the mark itself.
    let conceptsTotal = 0;
    try {
      conceptsTotal = deps.conceptsTotal?.() ?? 0;
    } catch {
      conceptsTotal = 0;
    }
    log(
      `[keyword-backfill] cycle processed=${String(indexed)} remaining=${String(
        Math.max(0, backlog.length - indexed),
      )} concepts=${String(conceptsTotal)}`,
    );

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

// ---------------------------------------------------------------------------
// Persisted progress artifact — small standalone JSON file, SAME atomic
// write shape as page-evidence/store.ts's readBackgroundEmbeddingProgress /
// writeBackgroundEmbeddingProgress (mkdir + tmp-file + rename; no shared
// cross-module util exists in this codebase, each lane owns its own tiny
// copy). Lives beside the two SQLite stores this lane fills
// (_BAC/connections/keyword-index.db, keyword-concepts.db) — observability
// only; hasIndexed alone is already sufficient + resumable for correctness
// (see this file's header), so a corrupt/missing progress file just means a
// cold processedTotal counter and a clean re-attempt budget, never lost work.
// ---------------------------------------------------------------------------

const keywordBackfillProgressPath = (vaultRoot: string): string =>
  join(vaultRoot, '_BAC', 'connections', 'keyword-backfill-progress.json');

const atomicWriteJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = join(dirname(path), `.${basename(path)}.${createRevision()}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempPath, path);
};

const readJsonFile = async <T>(path: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
};

export const readKeywordBackfillProgress = async (
  vaultRoot: string,
): Promise<KeywordBackfillProgress | null> => {
  const parsed = await readJsonFile<KeywordBackfillProgress>(
    keywordBackfillProgressPath(vaultRoot),
  );
  if (parsed === null || parsed.schemaVersion !== 1) return null;
  return parsed;
};

export const writeKeywordBackfillProgress = async (
  vaultRoot: string,
  progress: KeywordBackfillProgress,
): Promise<void> => {
  await atomicWriteJson(keywordBackfillProgressPath(vaultRoot), progress);
};

// ---------------------------------------------------------------------------
// Companion background scheduler — the ACTUAL production wiring
// (2026-08-16 gap fix). Same factory shape as
// workstreams/suggestionRecomputeLane.ts's scheduleSuggestionRecomputeLoop:
// the lane above is ALREADY self-scheduling (backlog-aware fast/idle cadence
// baked into createKeywordBackfillLane's own start()/stop()), so this
// wrapper's only job is opening THIS vault's own keyword-index/concept-store
// handles (the same "no shared singleton" idiom keywordIngest.ts established
// — see suggestionRecomputeLane.ts's header for why each production caller
// keeps its own handle pair rather than reaching into another module's
// private singleton), building the real deps, and starting/stopping the
// lane.
//
// indexCandidate delegates to keywordIngest.ts's `ingestGistKeywords` — the
// SAME function http/routes/enrichmentRoutes.ts's live-ingest hook calls for
// a freshly-accepted gist — so a backfilled page goes through the identical
// extract+upsert+concept-assign path, never a second implementation that
// could drift from it.
//
// listCandidates SKIPS ENTIRELY (returns []) whenever keywordIngestEnabled()
// is false, rather than letting indexCandidate throw for every candidate.
// This is load-bearing: maxAttemptsPerPage quarantine has NO cooldown decay
// (see KeywordBackfillLaneConfig's header — "fails it forever"). If an
// operator flips SIDETRACK_KEYWORD_INGEST=0 for any reason (e.g. embedder
// maintenance), treating that as a per-candidate FAILURE would permanently
// quarantine the entire population-capped backlog within
// maxAttemptsPerPage cycles — as little as ~6s apart at the default
// cycleIntervalMs, far too fast a window for an operator to react to.
// Skipping the listing instead means the lane goes idle and resumes
// cleanly, with zero quarantine debt, the moment ingest is re-enabled.
// ---------------------------------------------------------------------------

/** Modest, NOT the hours-scale prototypeGeneration/suggestionRecompute
 *  delay: this lane exists because the live keyword-index/concept-store
 *  were found completely EMPTY (zero production caller — see this PR's
 *  landing note), so backfill should begin promptly rather than wait
 *  minutes. Still non-zero so it never competes with boot-critical work
 *  (recall lock, HTTP listen) in the first moments. Overridable per-process
 *  via SIDETRACK_KEYWORD_BACKFILL_STARTUP_DELAY_MS (tests use this to avoid
 *  a real 30s wait). */
export const KEYWORD_BACKFILL_STARTUP_DELAY_MS = 30_000;

const resolveKeywordBackfillStartupDelayMs = (): number => {
  const raw = process.env['SIDETRACK_KEYWORD_BACKFILL_STARTUP_DELAY_MS'];
  if (raw === undefined || raw === '') return KEYWORD_BACKFILL_STARTUP_DELAY_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : KEYWORD_BACKFILL_STARTUP_DELAY_MS;
};

export interface KeywordBackfillSchedulerHandles {
  readonly keywordIndex: KeywordIndexStore;
  readonly concepts: KeywordConceptStore;
}

const buildKeywordBackfillDeps = (
  vaultRoot: string,
  eventLog: EventLog,
  handles: KeywordBackfillSchedulerHandles,
  log: (message: string) => void,
): KeywordBackfillLaneDeps => ({
  listCandidates: async () => {
    if (!keywordIngestEnabled()) return [];
    const lookup = await loadGistLookup(vaultRoot, eventLog).catch(() => null);
    if (lookup === null) return [];
    return keywordBackfillCandidatesFromGistLookup(lookup);
  },
  hasIndexed: async (pageKey) => handles.keywordIndex.hasPage(pageKey),
  indexCandidate: async (candidate) => {
    const result = await ingestGistKeywords(vaultRoot, candidate.kind, candidate.id, candidate.gist);
    if (!result.ingested) {
      throw new Error(`keyword backfill: ingestGistKeywords did not ingest ${candidate.pageKey}`);
    }
  },
  readProgress: () => readKeywordBackfillProgress(vaultRoot),
  writeProgress: (progress) => writeKeywordBackfillProgress(vaultRoot, progress),
  conceptsTotal: () => handles.concepts.stats().distinctConcepts,
  log,
});

/**
 * Start the production keyword-backfill scheduler for one vault. Env-gated
 * (keywordBackfillEnabled — SIDETRACK_KEYWORD_BACKFILL, default ON): when
 * off, emits the one boot line and returns a no-op disposer WITHOUT opening
 * any store handle or starting any timer. When on, opens its own
 * keyword-index/concept-store handles after a startup delay (never blocks
 * companion boot — same non-blocking shape as
 * scheduleSuggestionRecomputeLoop), builds the real deps, and starts the
 * lane's own self-scheduling loop.
 *
 * Returns ONE disposer for BOTH: (a) teardown[] (startup-failure rollback),
 * and (b) the explicit pre-drain "stopping-lanes" stop set in
 * runtime/companion.ts's close() — the #374 lane-stop discipline this PR
 * adds this lane to (it is not an event-log-appending lane like
 * body-evidence/background-embedding, so it cannot itself cause the
 * SIGTERM-hang awaitIdle() never-converges failure mode #374 fixed, but a
 * lane left ticking past close() is still a live timer + live SQLite
 * handles outliving the process that's supposedly shutting down, so it is
 * stopped explicitly rather than left to the "unref'd timer dies with the
 * process" assumption alone).
 */
export const scheduleKeywordBackfillLoop = (
  eventLog: EventLog,
  vaultRoot: string,
  options?: {
    readonly startupDelayMs?: number;
    readonly config?: KeywordBackfillLaneConfig;
    readonly log?: (message: string) => void;
  },
): (() => void) => {
  const log =
    options?.log ??
    ((message: string): void => {
      process.stdout.write(`${message}\n`);
    });

  if (!keywordBackfillEnabled()) {
    log(`[keyword-backfill] disabled via ${KEYWORD_BACKFILL_ENV}=0`);
    return () => undefined;
  }
  log('[keyword-backfill] enabled');

  let lane: KeywordBackfillLane | null = null;
  let handles: KeywordBackfillSchedulerHandles | null = null;
  let disposed = false;

  const startupTimer = setTimeout(() => {
    void (async (): Promise<void> => {
      try {
        // Self-sufficient — do NOT depend on some OTHER companion.ts
        // component (connectionsStore, the vault writer, …) having already
        // created _BAC/connections by the time this fires. bun:sqlite's
        // `new Database(path, {create:true})` only creates the missing
        // FILE, never a missing PARENT directory, and this scheduler's
        // startup delay is deliberately short (see
        // KEYWORD_BACKFILL_STARTUP_DELAY_MS's header) — short enough that
        // it is not safe to assume boot-order coincidence has created this
        // directory first.
        await mkdir(join(vaultRoot, '_BAC', 'connections'), { recursive: true });
        const [keywordIndex, concepts] = await Promise.all([
          createKeywordIndexStore(vaultRoot),
          createKeywordConceptStore(vaultRoot),
        ]);
        if (disposed) {
          // Disposed while the handles were opening — close them
          // immediately rather than leaking, and never start the lane.
          keywordIndex.close();
          concepts.close();
          return;
        }
        handles = { keywordIndex, concepts };
        const deps = buildKeywordBackfillDeps(vaultRoot, eventLog, handles, log);
        lane = createKeywordBackfillLane(deps, options?.config);
        lane.start();
      } catch (error) {
        log(`[keyword-backfill] scheduler failed to start: ${String(error)}`);
      }
    })();
  }, options?.startupDelayMs ?? resolveKeywordBackfillStartupDelayMs());
  startupTimer.unref?.();

  return () => {
    disposed = true;
    clearTimeout(startupTimer);
    lane?.stop();
    handles?.keywordIndex.close();
    handles?.concepts.close();
  };
};
