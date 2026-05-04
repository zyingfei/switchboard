export interface HealthReport {
  readonly uptimeSec: number;
  readonly vault: { readonly root: string; readonly writable: boolean; readonly sizeBytes: number | null };
  readonly capture: {
    readonly lastByProvider: Record<string, string | null>;
    readonly queueDepthHint: number | null;
    readonly droppedHint: number | null;
  };
  readonly recall: {
    readonly indexExists: boolean;
    readonly entryCount: number | null;
    readonly modelId: string | null;
    readonly sizeBytes: number | null;
  };
  readonly service: { readonly installed: boolean; readonly running: boolean };
}

export interface HealthDeps {
  readonly startedAt: Date;
  readonly now?: () => Date;
  readonly vaultRoot: string;
  readonly vaultWritable: () => Promise<boolean>;
  readonly vaultSizeBytes: () => Promise<number | null>;
  readonly captureSummary: () => Promise<HealthReport['capture']>;
  readonly recallSummary: () => Promise<HealthReport['recall']>;
  readonly serviceStatus: () => Promise<HealthReport['service']>;
}

const withBudget = async <T>(operation: () => Promise<T>, fallback: T): Promise<T> =>
  await Promise.race([
    operation(),
    new Promise<T>((resolve) => {
      setTimeout(() => {
        resolve(fallback);
      }, 250);
    }),
  ]);

export const collectHealth = async (deps: HealthDeps): Promise<HealthReport> => {
  const now = deps.now?.() ?? new Date();
  const [writable, sizeBytes, capture, recall, service] = await Promise.all([
    withBudget(deps.vaultWritable, false),
    withBudget(deps.vaultSizeBytes, null),
    withBudget(deps.captureSummary, {
      lastByProvider: {},
      queueDepthHint: null,
      droppedHint: null,
    }),
    withBudget(deps.recallSummary, {
      indexExists: false,
      entryCount: null,
      modelId: null,
      sizeBytes: null,
    }),
    withBudget(deps.serviceStatus, { installed: false, running: false }),
  ]);
  return {
    uptimeSec: Math.max(0, Math.floor((now.getTime() - deps.startedAt.getTime()) / 1000)),
    vault: { root: deps.vaultRoot, writable, sizeBytes },
    capture,
    recall,
    service,
  };
};
