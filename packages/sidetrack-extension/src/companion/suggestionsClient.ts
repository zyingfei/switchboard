import type { CompanionSettings, Problem } from './model';

export interface WorkstreamSuggestion {
  readonly workstreamId: string;
  readonly score: number;
  readonly breakdown?: Readonly<Record<string, number>>;
}

// Recurring-thread self-nomination block (companion
// threads/selfNomination.ts). Present on /v1/suggestions/thread
// responses. `eligible` is true only when the thread is a home-less,
// un-suggested recurring thread; the panel then offers to start a
// workstream from it, pre-filled with `suggestedTitle`.
export interface ThreadSelfNomination {
  readonly eligible: boolean;
  readonly visitCount: number;
  readonly distinctDays: number;
  readonly suggestedTitle?: string;
}

export interface ThreadSuggestionsResult {
  readonly suggestions: readonly WorkstreamSuggestion[];
  readonly selfNomination?: ThreadSelfNomination;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const parseProblemMessage = (value: unknown): string | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const problem = value as Partial<Problem>;
  return typeof problem.detail === 'string'
    ? problem.detail
    : typeof problem.title === 'string'
      ? problem.title
      : undefined;
};

const isWorkstreamSuggestion = (value: unknown): value is WorkstreamSuggestion => {
  if (!isRecord(value)) return false;
  if (typeof value.workstreamId !== 'string' || typeof value.score !== 'number') {
    return false;
  }
  if (value.breakdown === undefined) {
    return true;
  }
  return (
    isRecord(value.breakdown) &&
    Object.values(value.breakdown).every((item) => typeof item === 'number')
  );
};

const readSuggestionItems = (value: unknown): readonly unknown[] => {
  if (!isRecord(value) || !('data' in value)) {
    return [];
  }
  const data = value.data;
  if (Array.isArray(data)) {
    return data;
  }
  if (isRecord(data) && Array.isArray(data.items)) {
    return data.items;
  }
  return [];
};

const readSelfNomination = (value: unknown): ThreadSelfNomination | undefined => {
  if (!isRecord(value)) return undefined;
  const raw = value['selfNomination'];
  if (!isRecord(raw)) return undefined;
  if (typeof raw['eligible'] !== 'boolean') return undefined;
  const visitCount = typeof raw['visitCount'] === 'number' ? raw['visitCount'] : 0;
  const distinctDays = typeof raw['distinctDays'] === 'number' ? raw['distinctDays'] : 0;
  const suggestedTitle =
    typeof raw['suggestedTitle'] === 'string' ? raw['suggestedTitle'] : undefined;
  return {
    eligible: raw['eligible'],
    visitCount,
    distinctDays,
    ...(suggestedTitle === undefined ? {} : { suggestedTitle }),
  };
};

export class SuggestionsClient {
  private readonly baseUrl: string;

  constructor(private readonly settings: CompanionSettings) {
    this.baseUrl = `http://127.0.0.1:${String(settings.port)}/v1`;
  }

  // Ranked workstream suggestions only (compose scope picker). Kept for
  // callers that don't need the self-nomination block.
  async forThread(
    threadId: string,
    opts: { readonly limit?: number } = {},
  ): Promise<readonly WorkstreamSuggestion[]> {
    return (await this.forThreadWithNomination(threadId, opts)).suggestions;
  }

  // Suggestions + the recurring-thread self-nomination block. One fetch;
  // the thread card uses `selfNomination` to offer "start a workstream
  // from this thread" when the resolver abstained.
  async forThreadWithNomination(
    threadId: string,
    opts: { readonly limit?: number } = {},
  ): Promise<ThreadSuggestionsResult> {
    const params = new URLSearchParams();
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    const response = await fetch(
      `${this.baseUrl}/suggestions/thread/${encodeURIComponent(threadId)}${suffix}`,
      {
        method: 'GET',
        headers: { 'x-bac-bridge-key': this.settings.bridgeKey },
      },
    );
    if (!response.ok) {
      const value = (await response.json().catch(() => ({}))) as unknown;
      throw new Error(parseProblemMessage(value) ?? `Companion HTTP ${String(response.status)}`);
    }
    const body = (await response.json()) as unknown;
    const selfNomination = readSelfNomination(body);
    return {
      suggestions: readSuggestionItems(body).filter(isWorkstreamSuggestion),
      ...(selfNomination === undefined ? {} : { selfNomination }),
    };
  }
}

export const createSuggestionsClient = (settings: CompanionSettings): SuggestionsClient =>
  new SuggestionsClient(settings);
