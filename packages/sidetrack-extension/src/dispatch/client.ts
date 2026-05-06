import type { CompanionSettings, Problem } from '../companion/model';
import type { DispatchEventInput, DispatchEventRecord, DispatchSubmitResult } from './types';

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

const parseRedactionSummary = (value: unknown): DispatchSubmitResult['redactionSummary'] => {
  if (!isRecord(value)) {
    return undefined;
  }
  const matched = value.matched;
  const categories = value.categories;
  if (
    typeof matched === 'number' &&
    Array.isArray(categories) &&
    categories.every((c) => typeof c === 'string')
  ) {
    return { matched, categories };
  }
  return undefined;
};

const parseSubmitResult = (value: unknown): DispatchSubmitResult => {
  if (!isRecord(value)) {
    throw new Error('Dispatch response was not an object.');
  }
  const envelope = value as { readonly data?: unknown; readonly warnings?: unknown };
  if (!isRecord(envelope.data)) {
    throw new Error('Dispatch response missing data envelope.');
  }
  const data = envelope.data as {
    readonly bac_id?: unknown;
    readonly status?: unknown;
    readonly tokenEstimate?: unknown;
    readonly redactionSummary?: unknown;
  };
  if (typeof data.bac_id !== 'string') {
    throw new Error('Dispatch response missing bac_id.');
  }
  if (data.status !== 'recorded') {
    throw new Error('Dispatch response status was not "recorded".');
  }
  const redaction = parseRedactionSummary(data.redactionSummary);
  const warnings = envelope.warnings;
  return {
    bac_id: data.bac_id,
    status: 'recorded',
    ...(Array.isArray(warnings) && warnings.every((w) => typeof w === 'string')
      ? { warnings }
      : {}),
    ...(typeof data.tokenEstimate === 'number' ? { tokenEstimate: data.tokenEstimate } : {}),
    ...(redaction !== undefined ? { redactionSummary: redaction } : {}),
  };
};

const parseListResponse = (value: unknown): readonly DispatchEventRecord[] => {
  if (!isRecord(value)) {
    throw new Error('Dispatch list response was not an object.');
  }
  const envelope = value as { readonly data?: unknown };
  if (!Array.isArray(envelope.data)) {
    throw new Error('Dispatch list response missing data array.');
  }
  return envelope.data as readonly DispatchEventRecord[];
};

export interface DispatchClient {
  readonly submit: (
    event: DispatchEventInput,
    idempotencyKey: string,
  ) => Promise<DispatchSubmitResult>;
  readonly listRecent: (options?: {
    readonly limit?: number;
    readonly since?: string;
  }) => Promise<readonly DispatchEventRecord[]>;
  readonly linkDispatchToThread: (
    dispatchId: string,
    threadId: string,
  ) => Promise<void>;
}

export class HttpDispatchClient implements DispatchClient {
  private readonly baseUrl: string;

  constructor(private readonly settings: CompanionSettings) {
    this.baseUrl = `http://127.0.0.1:${String(settings.port)}/v1`;
  }

  async submit(event: DispatchEventInput, idempotencyKey: string): Promise<DispatchSubmitResult> {
    return parseSubmitResult(
      await this.request('/dispatches', {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey },
        body: JSON.stringify(event),
      }),
    );
  }

  async listRecent(options?: {
    readonly limit?: number;
    readonly since?: string;
  }): Promise<readonly DispatchEventRecord[]> {
    const params = new URLSearchParams();
    if (options?.limit !== undefined) {
      params.set('limit', String(options.limit));
    }
    if (options?.since !== undefined) {
      params.set('since', options.since);
    }
    const query = params.toString();
    const path = query.length > 0 ? `/dispatches?${query}` : '/dispatches';
    return parseListResponse(await this.request(path, { method: 'GET' }));
  }

  // Phase 3: forward the local match into the companion's link table.
  // Idempotent on (dispatchId, threadId); a second call with the same
  // pair is a no-op. Failures are non-fatal — the local chrome.storage
  // map still renders the dispatch as Linked even if this round-trips
  // fails (companion is authoritative on read but the extension
  // writes both stores).
  async linkDispatchToThread(dispatchId: string, threadId: string): Promise<void> {
    await this.request(`/dispatches/${encodeURIComponent(dispatchId)}/link`, {
      method: 'POST',
      body: JSON.stringify({ threadId }),
    });
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

export const createDispatchClient = (settings: CompanionSettings): DispatchClient =>
  new HttpDispatchClient(settings);
