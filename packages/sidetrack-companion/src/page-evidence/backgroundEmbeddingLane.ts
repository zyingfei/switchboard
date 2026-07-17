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
  /**
   * True once the embedder child has warmed (ONNX model loaded) and can
   * actually produce vectors. WHY THIS EXISTS: the embedder child is
   * spawned in parallel with the lane and takes seconds to warm. Before
   * this gate, the lane's first cycles fired embeds against a cold child;
   * every one returned no vector → counted as 'failed' → after
   * maxAttemptsPerRecord the record was PERMANENTLY quarantined. In the
   * production soak that quarantined 12 real, embeddable records at the
   * exact `maxAttemptsPerRecord` count and the lane went inert for 90 min
   * (embeddedTotal frozen at 2). When this returns false the lane does NO
   * embed work and does NOT burn attempts — it yields like a drain-pause
   * and retries once the child is ready. Optional; defaults to
   * "always ready" so existing tests and the in-process embedder path are
   * unaffected. */
  readonly isEmbedderReady?: () => boolean;
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
  /** Max ATTEMPTS per cycle (embeds + failures). Hard cap; the CPU regime
   *  forbids unbounded batches. WHY ATTEMPTS not successes: the original
   *  cap counted only successful embeds, so a cycle of pure failures/skips
   *  never consumed the cap and the loop spun the whole backlog each tick
   *  without making forward progress (stall-not-progress). Counting
   *  attempts bounds the work per cycle regardless of outcome. */
  readonly batchCap: number;
  /** Idle delay between cycles when the backlog is non-empty. */
  readonly cycleIntervalMs: number;
  /** Longer delay between cycles when the backlog is empty (poll for
   *  new arrivals without spinning). */
  readonly idleIntervalMs: number;
  /** After this many consecutive failed attempts a record enters a
   *  quarantine COOLDOWN (skipped) so a permanently-unembeddable record
   *  cannot starve the rest of the backlog. The quarantine is NOT
   *  permanent — see quarantineCooldownMs. */
  readonly maxAttemptsPerRecord: number;
  /** How long a quarantined record stays skipped before its attempt
   *  counter decays and it is eligible again. WHY: a quarantine that
   *  never lifts turns a transient failure (embedder warming, a
   *  temporarily-missing payload) into permanent inertness — the exact
   *  failure mode of the production soak. After the cooldown the record
   *  gets one more shot; if it keeps failing it re-quarantines, so a
   *  genuinely-broken record still can't spin. Set to 0 to disable
   *  cooldown (permanent quarantine — legacy behaviour). */
  readonly quarantineCooldownMs: number;
}

export const DEFAULT_BACKGROUND_EMBEDDING_CONFIG: BackgroundEmbeddingLaneConfig = {
  batchCap: 8,
  cycleIntervalMs: 4_000,
  idleIntervalMs: 60_000,
  maxAttemptsPerRecord: 3,
  // 30 min: long enough that a genuinely-broken record isn't retried in a
  // tight loop, short enough that a warmup-race victim recovers within a
  // session instead of staying dead for 90 min.
  quarantineCooldownMs: 30 * 60_000,
};

export interface BackgroundEmbeddingProgress {
  readonly schemaVersion: 1;
  /** canonicalUrl -> consecutive failed attempts. Cleared on success. */
  readonly attemptsByCanonicalUrl: Record<string, number>;
  /** canonicalUrl -> ms timestamp when the record was quarantined (hit
   *  maxAttempts). Absent until quarantined. Cleared on success. Drives
   *  the cooldown decay so a quarantine is never permanent. */
  readonly quarantinedAtMsByCanonicalUrl?: Record<string, number>;
  readonly embeddedTotal: number;
  readonly lastRunAtMs: number | null;
  /** ms timestamp of the last cycle that embedded ≥1 record. Null until
   *  the first success. Surfaces "is this lane actually doing anything?"
   *  so a silently-inert lane is visible instead of a 90-min mystery. */
  readonly lastSuccessAtMs?: number | null;
}

const emptyProgress = (): BackgroundEmbeddingProgress => ({
  schemaVersion: 1,
  attemptsByCanonicalUrl: {},
  quarantinedAtMsByCanonicalUrl: {},
  embeddedTotal: 0,
  lastRunAtMs: null,
  lastSuccessAtMs: null,
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
  /** True when the cycle did no embed work because the embedder child was
   *  not yet warm. Distinct from pausedForDrain so operators can tell a
   *  warmup wait from a drain yield. */
  readonly pausedForWarmup: boolean;
}

/** Operator-facing lane health. Surfaced on /v1/status so a silently
 *  inert lane (the 90-min soak failure) is VISIBLE instead of a mystery.
 *  Purely a snapshot of in-memory counters — synchronous, no I/O. */
export interface BackgroundEmbeddingLaneHealth {
  readonly enabled: true;
  /** Total records embedded across the lane's lifetime (durable). */
  readonly embeddedTotal: number;
  /** Records embedded since this process started (resets on restart). */
  readonly embeddedThisProcess: number;
  /** How many records are currently quarantined (in cooldown). */
  readonly quarantinedCount: number;
  /** Backlog size observed on the most recent cycle. */
  readonly lastBacklog: number;
  /** Wall-clock ms of the last cycle that ran (any outcome). */
  readonly lastRunAtMs: number | null;
  /** Wall-clock ms of the last cycle that embedded ≥1 record. Null until
   *  the first success — a persistently-null value under a non-empty
   *  backlog is the inert-lane signal. */
  readonly lastSuccessAtMs: number | null;
  /** Outcome tag of the last completed cycle. */
  readonly lastCycle:
    | 'never-run'
    | 'embedded'
    | 'idle-empty'
    | 'all-skipped'
    | 'all-failed'
    | 'paused-drain'
    | 'paused-warmup';
  /** True when the lane has run ≥1 cycle but never embedded anything AND
   *  the backlog is non-empty — the exact inertness the soak exposed.
   *  A health surface should flag this loudly. */
  readonly inert: boolean;
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
  /** Synchronous operator-facing health snapshot for /v1/status. */
  readonly health: () => BackgroundEmbeddingLaneHealth;
}

export const createBackgroundEmbeddingLane = (
  deps: BackgroundEmbeddingLaneDeps,
  config: BackgroundEmbeddingLaneConfig = DEFAULT_BACKGROUND_EMBEDDING_CONFIG,
): BackgroundEmbeddingLane => {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const isTombstoned = deps.isTombstoned ?? (() => false);
  const isEmbedderReady = deps.isEmbedderReady ?? (() => true);
  const batchCap = Math.max(1, Math.floor(config.batchCap));
  const maxAttempts = Math.max(1, Math.floor(config.maxAttemptsPerRecord));
  const quarantineCooldownMs = Math.max(0, Math.floor(config.quarantineCooldownMs));

  let progress: BackgroundEmbeddingProgress = emptyProgress();
  let progressLoaded = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let stopped = false;

  // Health tracking (process-local, cheap). Surfaced synchronously via
  // health() so /v1/status can flag an inert lane.
  let embeddedThisProcess = 0;
  let lastRunAtMs: number | null = null;
  let lastBacklog = 0;
  let lastQuarantinedCount = 0;
  let hasRun = false;
  let lastCycle: BackgroundEmbeddingLaneHealth['lastCycle'] = 'never-run';

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

  const recordHealth = (
    result: BackgroundEmbeddingCycleResult,
    cycle: BackgroundEmbeddingLaneHealth['lastCycle'],
  ): BackgroundEmbeddingCycleResult => {
    hasRun = true;
    lastRunAtMs = now();
    lastBacklog = result.backlog;
    lastQuarantinedCount = result.quarantined;
    lastCycle = cycle;
    return result;
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
      pausedForWarmup: false,
    };
    // Pause hard while a drain runs — the drain thread must never
    // contend with embedding CPU (existential CPU regime).
    if (deps.isDrainActive()) {
      return recordHealth({ ...base, pausedForDrain: true }, 'paused-drain');
    }
    // Pause (do NO embed work, burn NO attempts) until the embedder child
    // is warm. WHY: firing embeds against a cold child returns no vector →
    // 'failed' → quarantine. The production soak permanently quarantined
    // 12 embeddable records this exact way, then went inert for 90 min.
    // We yield like a drain-pause and retry once the child reports ready.
    if (!isEmbedderReady()) {
      return recordHealth({ ...base, pausedForWarmup: true }, 'paused-warmup');
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
      return recordHealth(base, lastCycle === 'never-run' ? 'idle-empty' : lastCycle);
    }
    const nowMs = now();
    const attempts = { ...progress.attemptsByCanonicalUrl };
    const quarantinedAt = { ...(progress.quarantinedAtMsByCanonicalUrl ?? {}) };
    let quarantined = 0;
    const backlog = candidates.filter((candidate) => {
      if (!isBackgroundEmbeddingBacklog(candidate)) return false;
      if (isTombstoned({ url: candidate.url, ...(candidate.title === undefined ? {} : { title: candidate.title }) })) {
        return false;
      }
      const url = candidate.canonicalUrl;
      if ((attempts[url] ?? 0) >= maxAttempts) {
        // Quarantined. Decay the quarantine after the cooldown so a
        // transient failure (warmup race, a temporarily-missing payload)
        // is not permanent — the fix for the 90-min inertness.
        const since = quarantinedAt[url];
        if (
          quarantineCooldownMs > 0 &&
          since !== undefined &&
          nowMs - since >= quarantineCooldownMs
        ) {
          delete attempts[url];
          delete quarantinedAt[url];
          return true; // eligible again for one more shot
        }
        quarantined += 1;
        return false;
      }
      return true;
    });

    let embedded = 0;
    let skipped = 0;
    let failed = 0;
    for (const candidate of backlog) {
      // ATTEMPT-counted cap: successes + failures both consume the cap so
      // a cycle of pure failures can't spin the whole backlog (the
      // stall-not-progress bug). Skips do NOT consume the cap — they're
      // not real work and not a failure of the record.
      if (embedded + failed >= batchCap) break;
      // Re-check the drain gate between records: a drain that starts
      // mid-cycle must stop us on the very next record, not at cycle end.
      if (deps.isDrainActive()) {
        const partial: BackgroundEmbeddingCycleResult = {
          scanned: candidates.length,
          backlog: backlog.length,
          embedded,
          skipped,
          failed,
          quarantined,
          pausedForDrain: true,
          pausedForWarmup: false,
        };
        progress = {
          schemaVersion: 1,
          attemptsByCanonicalUrl: attempts,
          quarantinedAtMsByCanonicalUrl: quarantinedAt,
          embeddedTotal: progress.embeddedTotal + embedded,
          lastRunAtMs: nowMs,
          lastSuccessAtMs: embedded > 0 ? nowMs : (progress.lastSuccessAtMs ?? null),
        };
        embeddedThisProcess += embedded;
        await persistProgress();
        return recordHealth(partial, embedded > 0 ? 'embedded' : 'paused-drain');
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
        delete quarantinedAt[candidate.canonicalUrl];
        try {
          deps.onEmbedded?.(candidate.canonicalUrl);
        } catch {
          // Requalify notification is best-effort.
        }
      } else if (outcome === 'failed') {
        failed += 1;
        const nextAttempts = (attempts[candidate.canonicalUrl] ?? 0) + 1;
        attempts[candidate.canonicalUrl] = nextAttempts;
        if (nextAttempts >= maxAttempts && quarantinedAt[candidate.canonicalUrl] === undefined) {
          // Stamp the quarantine time so the cooldown can decay it later.
          quarantinedAt[candidate.canonicalUrl] = nowMs;
        }
      } else {
        // 'skipped' — no content payload available yet. Do not burn an
        // attempt (this is not a failure of the record, just of timing).
        skipped += 1;
      }
    }

    embeddedThisProcess += embedded;
    progress = {
      schemaVersion: 1,
      attemptsByCanonicalUrl: attempts,
      quarantinedAtMsByCanonicalUrl: quarantinedAt,
      embeddedTotal: progress.embeddedTotal + embedded,
      lastRunAtMs: nowMs,
      lastSuccessAtMs: embedded > 0 ? nowMs : (progress.lastSuccessAtMs ?? null),
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
    const cycleTag: BackgroundEmbeddingLaneHealth['lastCycle'] =
      embedded > 0
        ? 'embedded'
        : backlog.length === 0
          ? 'idle-empty'
          : failed > 0 && skipped === 0
            ? 'all-failed'
            : 'all-skipped';
    return recordHealth(
      {
        scanned: candidates.length,
        backlog: backlog.length,
        embedded,
        skipped,
        failed,
        quarantined,
        pausedForDrain: false,
        pausedForWarmup: false,
      },
      cycleTag,
    );
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
      if (result.pausedForDrain || result.pausedForWarmup) {
        // Come back soon — the drain will finish / the embedder will warm
        // and we want to resume promptly, but not spin. The warmup wait
        // uses the SAME short cadence so an inert lane recovers within
        // seconds of the child reporting ready (not the 60 s idle poll).
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

  const health = (): BackgroundEmbeddingLaneHealth => {
    const quarantinedCount = Object.values(progress.attemptsByCanonicalUrl).filter(
      (count) => count >= maxAttempts,
    ).length;
    const lastSuccessAtMs = progress.lastSuccessAtMs ?? null;
    return {
      enabled: true,
      embeddedTotal: progress.embeddedTotal,
      embeddedThisProcess,
      quarantinedCount: Math.max(quarantinedCount, lastQuarantinedCount),
      lastBacklog,
      lastRunAtMs,
      lastSuccessAtMs,
      lastCycle,
      // Inert = ran cycles, never embedded anything, and backlog is
      // non-empty. This is precisely the 90-min soak failure; a health
      // surface flags it so the operator sees it in minutes not hours.
      inert: hasRun && progress.embeddedTotal === 0 && lastBacklog > 0,
    };
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
    health,
  };
};
