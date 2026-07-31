import {
  acknowledgeBodyEvidence,
  failBodyEvidence,
  isCurrentBodyEvidence,
  readBodyEvidenceDeadLetterCount,
  readPendingBodyEvidence,
  type BodyEvidenceFailureCategory,
  type BodyEvidenceQueueItem,
  type BodyEvidenceQueueSnapshot,
} from './bodyEvidenceQueue.js';
import {
  BODY_EVIDENCE_COVERAGE_TARGET,
  runBodyEvidenceWorker,
  type BodyEvidenceCoverage,
  type BodyEvidenceWorkerResult,
} from './bodyEvidenceWorker.js';

export interface BodyEvidenceLaneConfig {
  readonly batchCap: number;
  readonly queueCap: number;
  readonly cycleIntervalMs: number;
  readonly idleIntervalMs: number;
  readonly maxAttempts: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
}

export const DEFAULT_BODY_EVIDENCE_LANE_CONFIG: BodyEvidenceLaneConfig = {
  batchCap: 4,
  queueCap: 2_048,
  cycleIntervalMs: 5_000,
  idleIntervalMs: 60_000,
  maxAttempts: 3,
  retryBaseMs: 30_000,
  retryMaxMs: 15 * 60_000,
};

export interface BodyEvidenceLaneDeps {
  readonly vaultRoot: string;
  readonly readQueue?: () => Promise<BodyEvidenceQueueSnapshot>;
  readonly runWorker?: (
    items: readonly BodyEvidenceQueueItem[],
  ) => Promise<BodyEvidenceWorkerResult>;
  readonly acknowledge?: (item: BodyEvidenceQueueItem) => Promise<boolean>;
  readonly fail?: (
    item: BodyEvidenceQueueItem,
    failure: {
      readonly category: BodyEvidenceFailureCategory;
      readonly nextAttemptAtMs: number;
      readonly maxAttempts: number;
    },
  ) => Promise<'stale' | 'retry' | 'dead-letter'>;
  readonly deadLetterCount?: () => Promise<number>;
  /** Privacy/tombstone re-check immediately before off-thread work. */
  readonly isBlocked?: (item: BodyEvidenceQueueItem) => boolean | Promise<boolean>;
  /** Event/materializer notification; success is acknowledged only after this. */
  readonly onMaterialized?: (item: BodyEvidenceQueueItem) => Promise<void>;
  readonly isCurrent?: (item: BodyEvidenceQueueItem) => Promise<boolean>;
  readonly now?: () => number;
  readonly log?: (event: string, fields: Readonly<Record<string, unknown>>) => void;
}

export interface BodyEvidenceLaneCycleResult {
  readonly queueSource: 'absent' | 'present';
  readonly pendingBefore: number;
  readonly attempted: number;
  readonly succeeded: number;
  readonly retryScheduled: number;
  readonly deadLettered: number;
  readonly staleCompletions: number;
  readonly safetyDiscarded: number;
  readonly invalidItemCount: number;
  readonly pendingAfter: number;
  readonly deadLetterCount: number;
  readonly coverage: BodyEvidenceCoverage;
}

export interface BodyEvidenceLaneHealth {
  readonly enabled: true;
  readonly targetCoverage: typeof BODY_EVIDENCE_COVERAGE_TARGET;
  readonly queueSource: 'absent' | 'present';
  readonly pending: number;
  readonly queueCap: number;
  readonly backpressure: boolean;
  readonly invalidItemCount: number;
  readonly deadLetterCount: number;
  readonly succeededThisProcess: number;
  readonly retriesThisProcess: number;
  readonly safetyDiscardsThisProcess: number;
  readonly lastRunAtMs: number | null;
  readonly lastCycle:
    | 'never-run'
    | 'absent'
    | 'idle-empty'
    | 'waiting-retry'
    | 'progress'
    | 'failed';
  readonly coverage: BodyEvidenceCoverage;
}

export interface BodyEvidenceLane {
  readonly runOnce: () => Promise<BodyEvidenceLaneCycleResult>;
  readonly start: () => void;
  readonly stop: () => void;
  readonly health: () => BodyEvidenceLaneHealth;
}

const absentCoverage = (): BodyEvidenceCoverage => ({
  state: 'absent',
  target: BODY_EVIDENCE_COVERAGE_TARGET,
  bodyEligibleCount: null,
  bodyMaterializedCount: null,
  bodyCoverageRatio: null,
  vectorEligibleCount: null,
  vectorReadyCount: null,
  vectorCoverageRatio: null,
  atOrAboveBodyTarget: null,
  atOrAboveVectorTarget: null,
});

export const createBodyEvidenceLane = (
  deps: BodyEvidenceLaneDeps,
  config: BodyEvidenceLaneConfig = DEFAULT_BODY_EVIDENCE_LANE_CONFIG,
): BodyEvidenceLane => {
  const batchCap = Math.max(1, Math.floor(config.batchCap));
  const queueCap = Math.max(1, Math.floor(config.queueCap));
  const maxAttempts = Math.max(1, Math.floor(config.maxAttempts));
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const readQueue = deps.readQueue ?? (() => readPendingBodyEvidence(deps.vaultRoot));
  const runWorker =
    deps.runWorker ??
    (async (items) =>
      await runBodyEvidenceWorker({
        vaultRoot: deps.vaultRoot,
        items: items.map((item) => ({ jobId: item.jobId, payload: item.payload })),
      }));
  const acknowledge =
    deps.acknowledge ?? (async (item) => await acknowledgeBodyEvidence(deps.vaultRoot, item));
  const isCurrent =
    deps.isCurrent ?? (async (item) => await isCurrentBodyEvidence(deps.vaultRoot, item));
  const fail =
    deps.fail ?? (async (item, failure) => await failBodyEvidence(deps.vaultRoot, item, failure));
  const deadLetterCount =
    deps.deadLetterCount ?? (() => readBodyEvidenceDeadLetterCount(deps.vaultRoot));

  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let stopped = false;
  let queueSource: 'absent' | 'present' = 'absent';
  let pending = 0;
  let invalidItemCount = 0;
  let deadLetters = 0;
  let succeededThisProcess = 0;
  let retriesThisProcess = 0;
  let safetyDiscardsThisProcess = 0;
  let lastRunAtMs: number | null = null;
  let lastCycle: BodyEvidenceLaneHealth['lastCycle'] = 'never-run';
  let coverage = absentCoverage();

  const retryAt = (item: BodyEvidenceQueueItem, atMs: number): number => {
    const exponent = Math.min(20, item.attempts);
    const delay = Math.min(config.retryMaxMs, config.retryBaseMs * 2 ** exponent);
    return atMs + Math.max(1, delay);
  };

  const runOnce = async (): Promise<BodyEvidenceLaneCycleResult> => {
    const startedAtMs = now();
    const before = await readQueue();
    queueSource = before.source;
    invalidItemCount = before.invalidItemCount;
    const pendingBefore = before.items.length;
    let attempted = 0;
    let succeeded = 0;
    let retryScheduled = 0;
    let deadLettered = 0;
    let staleCompletions = 0;
    let safetyDiscarded = 0;

    const eligible: BodyEvidenceQueueItem[] = [];
    for (const item of before.items) {
      if (eligible.length >= batchCap) break;
      if (item.nextAttemptAtMs > startedAtMs) continue;
      if ((await deps.isBlocked?.(item)) === true) {
        if (await acknowledge(item)) safetyDiscarded += 1;
        else staleCompletions += 1;
        continue;
      }
      eligible.push(item);
    }

    let workerResult: BodyEvidenceWorkerResult | null = null;
    try {
      // Empty batches still run an off-thread read-back coverage pass. This
      // distinguishes absent from initialized-empty without adding status-route
      // latency or parsing the page-evidence corpus on the serving thread.
      workerResult = await runWorker(eligible);
      coverage = workerResult.coverage;
    } catch {
      workerResult = null;
    }

    const resultByJobId = new Map(
      (workerResult?.results ?? []).map((result) => [result.jobId, result] as const),
    );
    for (const item of eligible) {
      attempted += 1;
      const result = resultByJobId.get(item.jobId);
      let failureCategory: BodyEvidenceFailureCategory | null = null;
      if (result?.superseded === true) {
        // The worker checked queue identity while holding the shared per-URL
        // write lock and performed no write. The superseding capture/delete is
        // already authoritative; this is neither a retry nor a failure.
        staleCompletions += 1;
      } else if (result?.ok === true) {
        try {
          // A tombstone or newer capture may have removed/replaced this job
          // after the worker released the shared write lock. That superseding
          // operation itself wrote the newer/tombstoned state under the same
          // lock, so never overwrite it with a late compensation.
          if (!(await isCurrent(item))) {
            staleCompletions += 1;
            continue;
          }
          await deps.onMaterialized?.(item);
          if (await acknowledge(item)) succeeded += 1;
          else staleCompletions += 1;
        } catch {
          failureCategory = 'notification_failed';
        }
      } else if (result?.failureCategory === 'readback_failed') {
        failureCategory = 'readback_failed';
      } else if (result?.failureCategory === 'materialization_failed') {
        failureCategory = 'materialization_failed';
      } else {
        failureCategory = 'worker_unavailable';
      }
      if (failureCategory !== null) {
        const outcome = await fail(item, {
          category: failureCategory,
          nextAttemptAtMs: retryAt(item, startedAtMs),
          maxAttempts,
        });
        if (outcome === 'retry') retryScheduled += 1;
        else if (outcome === 'dead-letter') deadLettered += 1;
        else staleCompletions += 1;
      }
    }

    const after = await readQueue();
    queueSource = after.source;
    pending = after.items.length;
    invalidItemCount = after.invalidItemCount;
    deadLetters = await deadLetterCount();
    succeededThisProcess += succeeded;
    retriesThisProcess += retryScheduled;
    safetyDiscardsThisProcess += safetyDiscarded;
    lastRunAtMs = startedAtMs;
    if (before.source === 'absent') lastCycle = 'absent';
    else if (pendingBefore === 0) lastCycle = 'idle-empty';
    else if (succeeded > 0 || safetyDiscarded > 0) lastCycle = 'progress';
    else if (attempted === 0) lastCycle = 'waiting-retry';
    else lastCycle = 'failed';

    const cycle: BodyEvidenceLaneCycleResult = {
      queueSource: before.source,
      pendingBefore,
      attempted,
      succeeded,
      retryScheduled,
      deadLettered,
      staleCompletions,
      safetyDiscarded,
      invalidItemCount,
      pendingAfter: pending,
      deadLetterCount: deadLetters,
      coverage,
    };
    log('page_evidence.body_lane.cycle', {
      queue_source: cycle.queueSource,
      pending_before: cycle.pendingBefore,
      attempted: cycle.attempted,
      succeeded: cycle.succeeded,
      retry_scheduled: cycle.retryScheduled,
      dead_lettered: cycle.deadLettered,
      safety_discarded: cycle.safetyDiscarded,
      invalid_items: cycle.invalidItemCount,
      pending_after: cycle.pendingAfter,
      body_coverage_ratio: cycle.coverage.bodyCoverageRatio,
      vector_coverage_ratio: cycle.coverage.vectorCoverageRatio,
      target_coverage: BODY_EVIDENCE_COVERAGE_TARGET,
    });
    return cycle;
  };

  const schedule = (delayMs: number): void => {
    if (stopped || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, delayMs);
    timer.unref();
  };

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    let delay = config.idleIntervalMs;
    try {
      const cycle = await runOnce();
      if (cycle.pendingAfter > 0) delay = config.cycleIntervalMs;
    } catch {
      lastCycle = 'failed';
    } finally {
      running = false;
      schedule(delay);
    }
  };

  return {
    runOnce,
    start: () => schedule(0),
    stop: () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    health: () => ({
      enabled: true,
      targetCoverage: BODY_EVIDENCE_COVERAGE_TARGET,
      queueSource,
      pending,
      queueCap,
      backpressure: pending >= queueCap,
      invalidItemCount,
      deadLetterCount: deadLetters,
      succeededThisProcess,
      retriesThisProcess,
      safetyDiscardsThisProcess,
      lastRunAtMs,
      lastCycle,
      coverage,
    }),
  };
};
