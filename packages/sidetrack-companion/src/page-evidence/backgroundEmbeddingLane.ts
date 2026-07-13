// Off-main-loop page-evidence content embedding lane.
//
// WHY THIS EXISTS
// ----------------
// The audit (2026-07-12) found dense-vector coverage stuck at ~13.6%
// because the ONLY path that produced page-evidence doc embeddings was
// `completeExtractedPageEvidenceEmbedding`, run inline on the API
// process via `setTimeout(0)` per `/v1/page-evidence/extracted` request
// (server.ts, gated behind SIDETRACK_PAGE_EVIDENCE_BACKGROUND_EMBEDDING).
// That path was:
//   - unbounded (one embed per request, no cap),
//   - main-loop CPU on the API process (the flag stayed OFF for exactly
//     this reason — see the U1-U3 CPU post-mortems),
//   - blind to the backlog: records already written as content-tier with
//     embeddingState:'missing' were never revisited.
//
// This lane replaces the per-request path with a BOUNDED BACKLOG
// PROCESSOR:
//   - Scans the page-evidence store for content-tier records whose
//     embedding is still missing (the backlog).
//   - Processes at most `batchCap` records per cycle, then yields.
//   - Pauses entirely while a connections drain is running (the drain
//     thread is sacred — never contend with it; CPU regime).
//   - Dispatches the embed through the SAME embedder the rest of the
//     companion uses (recall/embedder.js override → embedder child
//     process when useChildProcesses). So the heavy ONNX/CoreML work is
//     already off the main process; this lane only schedules it.
//   - Persists progress (a cursor + attempt bookkeeping) so a restart
//     resumes instead of re-scanning from zero, and a record that fails
//     to embed is not retried in a tight loop.
//   - Kill-switch: SIDETRACK_PAGE_EVIDENCE_BACKGROUND_EMBEDDING absent /
//     '0' disables the lane entirely (default OFF until the eval-spine
//     verdict lifts it — see ADR-0011 amendment 2026-07-12b).
//   - On each successful embedding, notifies a completion sink so the
//     connections materializer can requalify that visit for similarity
//     re-embedding on the next drain (closes the
//     "better-evidence-never-revalidates" loop).
//
// The lane owns NO worker of its own — it forks nothing. It is a
// scheduler + backlog cursor that calls the injected embed-completion
// function; that function's embedder is the process-global override the
// runtime already points at the embedder child. This keeps the lane
// unit-testable with a synchronous fake and keeps a single embedder
// child for the whole process (no second ONNX instance — see
// embedderClient.ts "Why not worker_threads").

import type { PageEvidenceRecord } from './types.js';

/** The subset of the on-disk record the lane needs to classify backlog
 *  membership. Kept structural so tests can pass minimal fixtures. */
export interface BackgroundEmbeddingCandidate {
  readonly canonicalUrl: string;
  readonly url: string;
  readonly title?: string;
  readonly evidenceTier: PageEvidenceRecord['evidenceTier'];
  readonly content?: {
    readonly embeddingState?: 'disabled' | 'missing' | 'failed' | 'ready';
    readonly docEmbeddingRef?: unknown;
  };
}

export interface BackgroundEmbeddingLaneDeps {
  /** List every page-evidence record. Read-only; called once per cycle
   *  (the lane bounds the WORK per cycle, not the scan — the scan is a
   *  cheap directory read that the store already parallelizes). */
  readonly listCandidates: () => Promise<readonly BackgroundEmbeddingCandidate[]>;
  /**
   * Embed + persist the doc vector for one canonical URL. Returns:
   *   - 'embedded' — a vector was written (backlog shrank by one),
   *   - 'skipped'  — no content payload available to embed (leave for a
   *                  later cycle; do not count as a failure),
   *   - 'failed'   — the embed threw (record it so we back off).
   * MUST be resilient: a throw is caught by the lane and treated as
   * 'failed' (worker-failure -> skip, never inline crash).
   */
  readonly embedCanonicalUrl: (canonicalUrl: string) => Promise<'embedded' | 'skipped' | 'failed'>;
  /** True while a connections drain is running. The lane pauses (does
   *  no embed work) whenever this returns true. */
  readonly isDrainActive: () => boolean;
  /** Optional privacy gate — a page whose domain is tombstoned must
   *  never be embedded. Defaults to "never tombstoned" for tests. */
  readonly isTombstoned?: (page: { url: string; title?: string }) => boolean;
  /** Called once per successfully-embedded canonical URL so downstream
   *  (the connections materializer) can requalify the visit for
   *  similarity re-embedding on the next drain. Best-effort; a throw is
   *  swallowed (observability must never break the lane). */
  readonly onEmbedded?: (canonicalUrl: string) => void;
  /** Read the persisted progress cursor (attempt bookkeeping). */
  readonly readProgress?: () => Promise<BackgroundEmbeddingProgress | null>;
  /** Persist the progress cursor. Best-effort; a throw is swallowed. */
  readonly writeProgress?: (progress: BackgroundEmbeddingProgress) => Promise<void>;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

export interface BackgroundEmbeddingLaneConfig {
  /** Max records embedded per cycle. Hard cap; the CPU regime forbids
   *  unbounded batches. */
  readonly batchCap: number;
  /** Idle delay between cycles when the backlog is non-empty. */
  readonly cycleIntervalMs: number;
  /** Longer delay between cycles when the backlog is empty (poll for
   *  new arrivals without spinning). */
  readonly idleIntervalMs: number;
  /** After this many consecutive failed attempts a record is quarantined
   *  (skipped) so a permanently-unembeddable record cannot starve the
   *  rest of the backlog. */
  readonly maxAttemptsPerRecord: number;
}

export const DEFAULT_BACKGROUND_EMBEDDING_CONFIG: BackgroundEmbeddingLaneConfig = {
  batchCap: 8,
  cycleIntervalMs: 4_000,
  idleIntervalMs: 60_000,
  maxAttemptsPerRecord: 3,
};

export interface BackgroundEmbeddingProgress {
  readonly schemaVersion: 1;
  /** canonicalUrl -> consecutive failed attempts. Cleared on success. */
  readonly attemptsByCanonicalUrl: Record<string, number>;
  readonly embeddedTotal: number;
  readonly lastRunAtMs: number | null;
}

const emptyProgress = (): BackgroundEmbeddingProgress => ({
  schemaVersion: 1,
  attemptsByCanonicalUrl: {},
  embeddedTotal: 0,
  lastRunAtMs: null,
});

/** A record is backlog IFF it carries content but has no ready vector.
 *  `content_features_only` and `indexed_chunks` both carry a `content`
 *  block; `metadata_only` never does. A 'disabled' record opted out
 *  (SIDETRACK_PAGE_EVIDENCE_DOC_EMBEDDINGS=0 at write time) — leave it.
 *  A 'ready' record already has its vector. */
export const isBackgroundEmbeddingBacklog = (
  candidate: BackgroundEmbeddingCandidate,
): boolean => {
  if (candidate.evidenceTier === 'metadata_only') return false;
  const content = candidate.content;
  if (content === undefined) return false;
  if (content.docEmbeddingRef !== undefined) return false;
  const state = content.embeddingState;
  return state === 'missing' || state === undefined;
};

export interface BackgroundEmbeddingCycleResult {
  readonly scanned: number;
  readonly backlog: number;
  readonly embedded: number;
  readonly skipped: number;
  readonly failed: number;
  readonly quarantined: number;
  readonly pausedForDrain: boolean;
}

export interface BackgroundEmbeddingLane {
  /** Run exactly one bounded cycle. Exposed for tests + the scheduler.
   *  Never throws — every per-record error is contained. */
  readonly runOnce: () => Promise<BackgroundEmbeddingCycleResult>;
  /** Start the self-scheduling timer loop. Idempotent. */
  readonly start: () => void;
  /** Stop the timer loop. Idempotent; safe to call in teardown. */
  readonly stop: () => void;
  /** Current in-memory progress snapshot (post-load). */
  readonly progress: () => BackgroundEmbeddingProgress;
}

export const createBackgroundEmbeddingLane = (
  deps: BackgroundEmbeddingLaneDeps,
  config: BackgroundEmbeddingLaneConfig = DEFAULT_BACKGROUND_EMBEDDING_CONFIG,
): BackgroundEmbeddingLane => {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const isTombstoned = deps.isTombstoned ?? (() => false);
  const batchCap = Math.max(1, Math.floor(config.batchCap));
  const maxAttempts = Math.max(1, Math.floor(config.maxAttemptsPerRecord));

  let progress: BackgroundEmbeddingProgress = emptyProgress();
  let progressLoaded = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let stopped = false;

  const loadProgressOnce = async (): Promise<void> => {
    if (progressLoaded) return;
    progressLoaded = true;
    if (deps.readProgress === undefined) return;
    try {
      const loaded = await deps.readProgress();
      if (loaded !== null && loaded.schemaVersion === 1) progress = loaded;
    } catch {
      // Corrupt / missing progress → start clean.
    }
  };

  const persistProgress = async (): Promise<void> => {
    if (deps.writeProgress === undefined) return;
    try {
      await deps.writeProgress(progress);
    } catch {
      // Progress persistence is best-effort; a failure only costs a
      // re-scan on restart, never correctness.
    }
  };

  const runOnce = async (): Promise<BackgroundEmbeddingCycleResult> => {
    await loadProgressOnce();
    const base: BackgroundEmbeddingCycleResult = {
      scanned: 0,
      backlog: 0,
      embedded: 0,
      skipped: 0,
      failed: 0,
      quarantined: 0,
      pausedForDrain: false,
    };
    // Pause hard while a drain runs — the drain thread must never
    // contend with embedding CPU (existential CPU regime).
    if (deps.isDrainActive()) {
      return { ...base, pausedForDrain: true };
    }
    let candidates: readonly BackgroundEmbeddingCandidate[];
    try {
      candidates = await deps.listCandidates();
    } catch (error) {
      log(
        `[page-evidence.embed-lane] listCandidates failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return base;
    }
    const attempts = { ...progress.attemptsByCanonicalUrl };
    let quarantined = 0;
    const backlog = candidates.filter((candidate) => {
      if (!isBackgroundEmbeddingBacklog(candidate)) return false;
      if (isTombstoned({ url: candidate.url, ...(candidate.title === undefined ? {} : { title: candidate.title }) })) {
        return false;
      }
      if ((attempts[candidate.canonicalUrl] ?? 0) >= maxAttempts) {
        quarantined += 1;
        return false;
      }
      return true;
    });

    let embedded = 0;
    let skipped = 0;
    let failed = 0;
    for (const candidate of backlog) {
      if (embedded >= batchCap) break;
      // Re-check the drain gate between records: a drain that starts
      // mid-cycle must stop us on the very next record, not at cycle end.
      if (deps.isDrainActive()) {
        return {
          scanned: candidates.length,
          backlog: backlog.length,
          embedded,
          skipped,
          failed,
          quarantined,
          pausedForDrain: true,
        };
      }
      let outcome: 'embedded' | 'skipped' | 'failed';
      try {
        outcome = await deps.embedCanonicalUrl(candidate.canonicalUrl);
      } catch (error) {
        outcome = 'failed';
        log(
          `[page-evidence.embed-lane] embed threw for ${candidate.canonicalUrl}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (outcome === 'embedded') {
        embedded += 1;
        delete attempts[candidate.canonicalUrl];
        try {
          deps.onEmbedded?.(candidate.canonicalUrl);
        } catch {
          // Requalify notification is best-effort.
        }
      } else if (outcome === 'failed') {
        failed += 1;
        attempts[candidate.canonicalUrl] = (attempts[candidate.canonicalUrl] ?? 0) + 1;
      } else {
        // 'skipped' — no content payload available yet. Do not burn an
        // attempt (this is not a failure of the record, just of timing).
        skipped += 1;
      }
    }

    progress = {
      schemaVersion: 1,
      attemptsByCanonicalUrl: attempts,
      embeddedTotal: progress.embeddedTotal + embedded,
      lastRunAtMs: now(),
    };
    await persistProgress();
    if (embedded > 0 || failed > 0) {
      log(
        `[page-evidence.embed-lane] cycle embedded=${String(embedded)} failed=${String(
          failed,
        )} skipped=${String(skipped)} backlog=${String(backlog.length)} quarantined=${String(
          quarantined,
        )}`,
      );
    }
    return {
      scanned: candidates.length,
      backlog: backlog.length,
      embedded,
      skipped,
      failed,
      quarantined,
      pausedForDrain: false,
    };
  };

  const scheduleNext = (delayMs: number): void => {
    if (stopped || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, delayMs);
    // A pending cycle must never hold the process open.
    timer.unref();
  };

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    let nextDelayMs = config.idleIntervalMs;
    try {
      const result = await runOnce();
      if (result.pausedForDrain) {
        // Come back soon — the drain will finish and we want to resume
        // promptly, but not spin.
        nextDelayMs = config.cycleIntervalMs;
      } else if (result.backlog > result.embedded) {
        // More backlog remains — keep the shorter cadence.
        nextDelayMs = config.cycleIntervalMs;
      } else {
        nextDelayMs = config.idleIntervalMs;
      }
    } catch (error) {
      // runOnce is designed never to throw, but belt-and-braces: a throw
      // here must not kill the loop.
      log(
        `[page-evidence.embed-lane] cycle threw: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      nextDelayMs = config.idleIntervalMs;
    } finally {
      running = false;
      scheduleNext(nextDelayMs);
    }
  };

  return {
    runOnce,
    start: (): void => {
      if (stopped) return;
      scheduleNext(config.cycleIntervalMs);
    },
    stop: (): void => {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    progress: () => progress,
  };
};
