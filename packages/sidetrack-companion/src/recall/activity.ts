export type RecallActivityKind =
  | 'incremental-index'
  | 'rebuild-started'
  | 'rebuild-finished'
  | 'rebuild-failed'
  | 'query'
  | 'suggestion';

export interface RecallActivityEvent {
  readonly kind: RecallActivityKind;
  readonly at: string;
  readonly count?: number;
  readonly threadIds?: readonly string[];
  readonly queryLength?: number;
  readonly resultCount?: number;
  readonly threadId?: string;
  readonly reason?: 'startup' | 'manual' | 'reconnect' | 'drift';
  readonly error?: string;
}

export interface RecallActivityReport {
  readonly lastIndexedAt: string | null;
  readonly lastIndexedCount: number | null;
  readonly lastIndexedThreadIds: readonly string[];
  readonly lastRecallQueryAt: string | null;
  readonly lastRecallQueryResultCount: number | null;
  readonly lastSuggestionAt: string | null;
  readonly lastSuggestionThreadId: string | null;
  readonly recent: readonly RecallActivityEvent[];
}

export interface RecallActivityTracker {
  readonly recordIncrementalIndex: (input: {
    readonly count: number;
    readonly threadIds: readonly string[];
  }) => void;
  readonly recordRebuildStarted: (reason: 'startup' | 'manual' | 'reconnect' | 'drift') => void;
  readonly recordRebuildFinished: (count: number) => void;
  readonly recordRebuildFailed: (error: string) => void;
  readonly recordQuery: (input: {
    readonly queryLength: number;
    readonly resultCount: number;
  }) => void;
  readonly recordSuggestion: (input: {
    readonly threadId: string;
    readonly resultCount: number;
  }) => void;
  readonly report: () => RecallActivityReport;
}

const MAX_RECENT_EVENTS = 20;
const MAX_THREAD_IDS = 5;

const uniqueLimited = (values: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= MAX_THREAD_IDS) break;
  }
  return out;
};

export const createRecallActivityTracker = (
  now: () => Date = () => new Date(),
): RecallActivityTracker => {
  let lastIndexedAt: string | null = null;
  let lastIndexedCount: number | null = null;
  let lastIndexedThreadIds: readonly string[] = [];
  let lastRecallQueryAt: string | null = null;
  let lastRecallQueryResultCount: number | null = null;
  let lastSuggestionAt: string | null = null;
  let lastSuggestionThreadId: string | null = null;
  let recent: RecallActivityEvent[] = [];

  const push = (event: Omit<RecallActivityEvent, 'at'>): void => {
    const withTime: RecallActivityEvent = { ...event, at: now().toISOString() };
    recent = [withTime, ...recent].slice(0, MAX_RECENT_EVENTS);
  };

  return {
    recordIncrementalIndex(input) {
      lastIndexedAt = now().toISOString();
      lastIndexedCount = input.count;
      lastIndexedThreadIds = uniqueLimited(input.threadIds);
      const event: RecallActivityEvent = {
        kind: 'incremental-index',
        at: lastIndexedAt,
        count: input.count,
        threadIds: lastIndexedThreadIds,
      };
      recent = [event, ...recent].slice(0, MAX_RECENT_EVENTS);
    },
    recordRebuildStarted(reason) {
      push({ kind: 'rebuild-started', reason });
    },
    recordRebuildFinished(count) {
      lastIndexedAt = now().toISOString();
      lastIndexedCount = count;
      lastIndexedThreadIds = [];
      const event: RecallActivityEvent = { kind: 'rebuild-finished', at: lastIndexedAt, count };
      recent = [event, ...recent].slice(0, MAX_RECENT_EVENTS);
    },
    recordRebuildFailed(error) {
      push({ kind: 'rebuild-failed', error });
    },
    recordQuery(input) {
      lastRecallQueryAt = now().toISOString();
      lastRecallQueryResultCount = input.resultCount;
      const event: RecallActivityEvent = {
        kind: 'query',
        at: lastRecallQueryAt,
        queryLength: input.queryLength,
        resultCount: input.resultCount,
      };
      recent = [event, ...recent].slice(0, MAX_RECENT_EVENTS);
    },
    recordSuggestion(input) {
      lastSuggestionAt = now().toISOString();
      lastSuggestionThreadId = input.threadId;
      const event: RecallActivityEvent = {
        kind: 'suggestion',
        at: lastSuggestionAt,
        threadId: input.threadId,
        resultCount: input.resultCount,
      };
      recent = [event, ...recent].slice(0, MAX_RECENT_EVENTS);
    },
    report() {
      return {
        lastIndexedAt,
        lastIndexedCount,
        lastIndexedThreadIds,
        lastRecallQueryAt,
        lastRecallQueryResultCount,
        lastSuggestionAt,
        lastSuggestionThreadId,
        recent,
      };
    },
  };
};
