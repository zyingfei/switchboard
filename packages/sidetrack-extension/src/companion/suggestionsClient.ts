import type { CompanionSettings, Problem } from './model';

export interface WorkstreamSuggestion {
  readonly workstreamId: string;
  readonly score: number;
  readonly breakdown?: Readonly<Record<string, number>>;
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

export class SuggestionsClient {
  private readonly baseUrl: string;

  constructor(private readonly settings: CompanionSettings) {
    this.baseUrl = `http://127.0.0.1:${String(settings.port)}/v1`;
  }

  async forThread(
    threadId: string,
    opts: { readonly limit?: number } = {},
  ): Promise<readonly WorkstreamSuggestion[]> {
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
    return readSuggestionItems(body).filter(isWorkstreamSuggestion);
  }
}

export const createSuggestionsClient = (settings: CompanionSettings): SuggestionsClient =>
  new SuggestionsClient(settings);
