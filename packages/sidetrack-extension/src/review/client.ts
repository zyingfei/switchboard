import type { CompanionSettings, Problem } from '../companion/model';
import type { ReviewEventInput, ReviewEventRecord, ReviewSubmitResult } from './types';

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

const parseSubmitResult = (value: unknown): ReviewSubmitResult => {
  if (!isRecord(value)) {
    throw new Error('Review response was not an object.');
  }
  const envelope = value as { readonly data?: unknown };
  if (!isRecord(envelope.data)) {
    throw new Error('Review response missing data envelope.');
  }
  const data = envelope.data as { readonly bac_id?: unknown; readonly status?: unknown };
  if (typeof data.bac_id !== 'string') {
    throw new Error('Review response missing bac_id.');
  }
  if (data.status !== 'recorded') {
    throw new Error('Review response status was not "recorded".');
  }
  return { bac_id: data.bac_id, status: 'recorded' };
};

const parseListResponse = (value: unknown): readonly ReviewEventRecord[] => {
  if (!isRecord(value)) {
    throw new Error('Review list response was not an object.');
  }
  const envelope = value as { readonly data?: unknown };
  if (!Array.isArray(envelope.data)) {
    throw new Error('Review list response missing data array.');
  }
  return envelope.data as readonly ReviewEventRecord[];
};

export interface ReviewClient {
  readonly submit: (event: ReviewEventInput, idempotencyKey: string) => Promise<ReviewSubmitResult>;
  readonly listRecent: (options?: {
    readonly limit?: number;
    readonly since?: string;
    readonly threadId?: string;
  }) => Promise<readonly ReviewEventRecord[]>;
}

export class HttpReviewClient implements ReviewClient {
  private readonly baseUrl: string;

  constructor(private readonly settings: CompanionSettings) {
    this.baseUrl = `http://127.0.0.1:${String(settings.port)}/v1`;
  }

  async submit(event: ReviewEventInput, idempotencyKey: string): Promise<ReviewSubmitResult> {
    return parseSubmitResult(
      await this.request('/reviews', {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey },
        body: JSON.stringify(event),
      }),
    );
  }

  async listRecent(options?: {
    readonly limit?: number;
    readonly since?: string;
    readonly threadId?: string;
  }): Promise<readonly ReviewEventRecord[]> {
    const params = new URLSearchParams();
    if (options?.limit !== undefined) {
      params.set('limit', String(options.limit));
    }
    if (options?.since !== undefined) {
      params.set('since', options.since);
    }
    if (options?.threadId !== undefined) {
      params.set('threadId', options.threadId);
    }
    const query = params.toString();
    const path = query.length > 0 ? `/reviews?${query}` : '/reviews';
    return parseListResponse(await this.request(path, { method: 'GET' }));
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set('content-type', 'application/json');
    headers.set('x-bac-bridge-key', this.settings.bridgeKey);

    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    const value = (await response.json()) as unknown;
    if (!response.ok) {
      throw new Error(parseProblemMessage(value) ?? `Companion HTTP ${String(response.status)}`);
    }
    return value;
  }
}

export const createReviewClient = (settings: CompanionSettings): ReviewClient =>
  new HttpReviewClient(settings);
