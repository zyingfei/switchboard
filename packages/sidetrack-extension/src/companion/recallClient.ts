import type { CompanionSettings, Problem } from './model';

export interface RecallTurnInput {
  readonly id: string;
  readonly threadId: string;
  readonly capturedAt: string;
  readonly text: string;
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

export class RecallClient {
  private readonly baseUrl: string;

  constructor(private readonly settings: CompanionSettings) {
    this.baseUrl = `http://127.0.0.1:${String(settings.port)}/v1`;
  }

  async indexTurn(item: RecallTurnInput): Promise<void> {
    const response = await fetch(`${this.baseUrl}/recall/index`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bac-bridge-key': this.settings.bridgeKey,
      },
      body: JSON.stringify({ items: [item] }),
    });
    if (!response.ok) {
      const value = (await response.json().catch(() => ({}))) as unknown;
      throw new Error(parseProblemMessage(value) ?? `Companion HTTP ${String(response.status)}`);
    }
  }

  async query(
    q: string,
    opts: { readonly limit?: number; readonly workstreamId?: string } = {},
  ): Promise<readonly RankedItem[]> {
    const params = new URLSearchParams({ q });
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts.workstreamId !== undefined) params.set('workstreamId', opts.workstreamId);
    const response = await fetch(`${this.baseUrl}/recall/query?${params.toString()}`, {
      method: 'GET',
      headers: { 'x-bac-bridge-key': this.settings.bridgeKey },
    });
    if (!response.ok) {
      const value = (await response.json().catch(() => ({}))) as unknown;
      throw new Error(parseProblemMessage(value) ?? `Companion HTTP ${String(response.status)}`);
    }
    const body = (await response.json()) as { readonly data?: unknown };
    if (!Array.isArray(body.data)) return [];
    return body.data.filter((item: unknown): item is RankedItem => isRankedItem(item));
  }
}

export interface RankedItem {
  readonly id: string;
  readonly threadId: string;
  readonly capturedAt: string;
  readonly score: number;
  readonly title?: string;
  readonly snippet?: string;
  // Canonical URL of the source thread, populated by the companion
  // from the thread JSON. Used for: dedup across stale duplicate
  // bac_ids that point at the same chat URL (common after a
  // re-capture before the bac_id-stability fix), filtering out the
  // current page in the side panel proxy, and giving "Jump" a real
  // target instead of the current page URL.
  readonly threadUrl?: string;
}

const isRankedItem = (value: unknown): value is RankedItem =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.threadId === 'string' &&
  typeof value.capturedAt === 'string' &&
  typeof value.score === 'number';

export const createRecallClient = (settings: CompanionSettings): RecallClient =>
  new RecallClient(settings);
