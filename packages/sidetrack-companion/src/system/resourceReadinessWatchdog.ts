// Cheap, in-process resource/readiness watchdogs for the authenticated health
// surface. The collector intentionally owns no timer: RSS is sampled only when
// health is read, while boot phases are recorded once by the composition root.
// This keeps the watchdog non-blocking and prevents observability from becoming
// another background producer.

export const RSS_WARN_BYTES = 2 * 1024 * 1024 * 1024;
export const BOOT_TO_SERVING_BUDGET_MS = 10_000;

export type WatchdogStatus = 'ok' | 'warning' | 'stale';
export type WatchdogTransition = 'initialized' | 'warning' | 'stale' | 'recovered';

export interface BootPhaseTiming {
  readonly name: string;
  readonly durationMs: number;
}

export interface RssWatchdogRow {
  readonly status: WatchdogStatus;
  readonly warnAtBytes: number;
  readonly currentBytes: number | null;
  readonly lastObservedBytes: number | null;
  readonly baselineBytes: number | null;
  readonly growthBytes: number | null;
  readonly peakBytes: number | null;
  readonly sampledAt: string | null;
  readonly checkedAt: string;
  readonly lastTransition: WatchdogTransition;
  readonly lastTransitionAt: string;
}

export interface BootToServingWatchdogRow {
  readonly status: WatchdogStatus;
  readonly budgetMs: number;
  readonly elapsedMs: number;
  readonly startedAt: string;
  readonly servingAt: string | null;
  readonly phases: readonly BootPhaseTiming[];
  readonly slowestPhase: string | null;
  readonly lastTransition: WatchdogTransition;
  readonly lastTransitionAt: string;
}

export interface ResourceReadinessWatchdogs {
  readonly rss: RssWatchdogRow;
  readonly bootToServing: BootToServingWatchdogRow;
}

export interface ResourceReadinessWatchdog {
  /** Close the current boot phase and start timing the next one. */
  readonly recordBootPhase: (name: string) => void;
  /** Close the final phase and freeze the boot-to-serving measurement. */
  readonly markServing: (phaseName?: string) => void;
  /** Synchronous, O(1) read used by the health contributor. */
  readonly snapshot: () => ResourceReadinessWatchdogs;
}

interface TransitionState {
  readonly status: WatchdogStatus;
  readonly transition: WatchdogTransition;
  readonly atMs: number;
}

export interface ResourceReadinessWatchdogOptions {
  readonly bootStartedAtMs?: number;
  readonly nowMs?: () => number;
  readonly readRssBytes?: () => number;
  readonly rssWarnBytes?: number;
  readonly bootBudgetMs?: number;
}

const toIso = (atMs: number): string => new Date(atMs).toISOString();

const finiteNonNegative = (value: number): number | null =>
  Number.isFinite(value) && value >= 0 ? value : null;

const nextTransition = (
  previous: TransitionState | undefined,
  status: WatchdogStatus,
  atMs: number,
): TransitionState => {
  if (previous === undefined) {
    return { status, transition: 'initialized', atMs };
  }
  if (previous.status === status) return previous;
  return {
    status,
    transition: status === 'ok' ? 'recovered' : status,
    atMs,
  };
};

export const createResourceReadinessWatchdog = (
  options: ResourceReadinessWatchdogOptions = {},
): ResourceReadinessWatchdog => {
  const nowMs = options.nowMs ?? Date.now;
  const readRssBytes = options.readRssBytes ?? (() => process.memoryUsage().rss);
  const rssWarnBytes = options.rssWarnBytes ?? RSS_WARN_BYTES;
  const bootBudgetMs = options.bootBudgetMs ?? BOOT_TO_SERVING_BUDGET_MS;
  const bootStartedAtMs = options.bootStartedAtMs ?? nowMs();

  const readRssSafely = (): number | null => {
    try {
      return finiteNonNegative(readRssBytes());
    } catch {
      return null;
    }
  };

  const baselineBytes = readRssSafely();
  let lastObservedBytes = baselineBytes;
  let peakBytes = baselineBytes;
  let sampledAtMs: number | null = baselineBytes === null ? null : bootStartedAtMs;
  let rssTransition: TransitionState | undefined;

  const phases: BootPhaseTiming[] = [];
  let phaseStartedAtMs = bootStartedAtMs;
  let servingAtMs: number | null = null;
  let bootTransition: TransitionState | undefined;

  const recordBootPhase = (name: string): void => {
    if (servingAtMs !== null) return;
    const atMs = nowMs();
    phases.push({ name, durationMs: Math.max(0, atMs - phaseStartedAtMs) });
    phaseStartedAtMs = atMs;
  };

  const markServing = (phaseName: string = 'http-listen'): void => {
    if (servingAtMs !== null) return;
    recordBootPhase(phaseName);
    servingAtMs = phaseStartedAtMs;
  };

  const snapshot = (): ResourceReadinessWatchdogs => {
    const checkedAtMs = nowMs();
    const currentBytes = readRssSafely();
    const rssStatus: WatchdogStatus =
      currentBytes === null ? 'stale' : currentBytes >= rssWarnBytes ? 'warning' : 'ok';
    if (currentBytes !== null) {
      lastObservedBytes = currentBytes;
      peakBytes = peakBytes === null ? currentBytes : Math.max(peakBytes, currentBytes);
      sampledAtMs = checkedAtMs;
    }
    rssTransition = nextTransition(rssTransition, rssStatus, checkedAtMs);

    const bootElapsedMs = Math.max(
      0,
      (servingAtMs === null ? checkedAtMs : servingAtMs) - bootStartedAtMs,
    );
    const bootStatus: WatchdogStatus =
      servingAtMs === null ? 'stale' : bootElapsedMs < bootBudgetMs ? 'ok' : 'warning';
    bootTransition = nextTransition(bootTransition, bootStatus, checkedAtMs);
    const slowestPhase = phases.reduce<BootPhaseTiming | null>(
      (slowest, phase) =>
        slowest === null || phase.durationMs > slowest.durationMs ? phase : slowest,
      null,
    );

    return {
      rss: {
        status: rssStatus,
        warnAtBytes: rssWarnBytes,
        currentBytes,
        lastObservedBytes,
        baselineBytes,
        growthBytes:
          currentBytes === null || baselineBytes === null ? null : currentBytes - baselineBytes,
        peakBytes,
        sampledAt: sampledAtMs === null ? null : toIso(sampledAtMs),
        checkedAt: toIso(checkedAtMs),
        lastTransition: rssTransition.transition,
        lastTransitionAt: toIso(rssTransition.atMs),
      },
      bootToServing: {
        status: bootStatus,
        budgetMs: bootBudgetMs,
        elapsedMs: bootElapsedMs,
        startedAt: toIso(bootStartedAtMs),
        servingAt: servingAtMs === null ? null : toIso(servingAtMs),
        phases: phases.map((phase) => ({ ...phase })),
        slowestPhase: slowestPhase?.name ?? null,
        lastTransition: bootTransition.transition,
        lastTransitionAt: toIso(bootTransition.atMs),
      },
    };
  };

  return { recordBootPhase, markServing, snapshot };
};
