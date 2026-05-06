// HTTP client for the companion's `/v1/review-drafts/*` routes.
//
// Browsers ship `ClientEvent`s carrying the projection frontier they
// observed (`baseVector`). The companion stamps `dot`, `deps`,
// `acceptedAtMs` on accept and returns both the AcceptedEvents AND
// the recomputed projection so the browser can update its local
// cache deterministically. Idempotent retries keyed on
// `clientEventId` return the SAME AcceptedEvent (same dot, same
// acceptedAtMs).

export type ReviewDraftEventType =
  | 'review-draft.span.added'
  | 'review-draft.span.removed'
  | 'review-draft.comment.set'
  | 'review-draft.overall.set'
  | 'review-draft.verdict.set'
  | 'review-draft.discarded';

export type VersionVector = Readonly<Record<string, number>>;

export interface TargetRef {
  readonly provider?: string;
  readonly canonicalUrl?: string;
  readonly conversationId?: string;
  readonly messageId?: string;
  readonly turnOrdinal?: number;
  readonly role?: 'user' | 'assistant' | 'system';
  readonly quoteHash?: string;
  readonly anchorFingerprint?: string;
  readonly sourceSnapshotHash?: string;
}

export interface ReviewDraftClientEvent {
  readonly clientEventId: string;
  readonly type: ReviewDraftEventType;
  readonly payload?: Record<string, unknown>;
  readonly target?: TargetRef;
  readonly baseVector: VersionVector;
  readonly clientDeps?: readonly string[];
  readonly clientCreatedAtMs?: number;
}

export interface Dot {
  readonly replicaId: string;
  readonly seq: number;
}

export interface AcceptedEventDescriptor {
  readonly clientEventId: string;
  readonly dot: Dot;
  readonly deps: VersionVector;
  readonly aggregateId: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly acceptedAtMs: number;
}

export interface ReviewProjectionAnchor {
  readonly textQuote: { readonly exact: string; readonly prefix: string; readonly suffix: string };
  readonly textPosition: { readonly start: number; readonly end: number };
  readonly cssSelector: string;
}

export type RegisterProjection<T> =
  | { readonly status: 'resolved'; readonly value?: T; readonly event?: Dot }
  | {
      readonly status: 'conflict';
      readonly candidates: readonly {
        readonly value: T;
        readonly event: Dot;
        readonly replicaId: string;
        readonly acceptedAtMs: number;
      }[];
    };

export interface ReviewProjectionSpan {
  readonly spanId: string;
  readonly quote: string;
  readonly anchor: ReviewProjectionAnchor;
  readonly comment: RegisterProjection<string>;
  readonly capturedAt: string;
  readonly addDots: readonly Dot[];
  readonly removeDots: readonly Dot[];
}

export interface ReviewDraftProjection {
  readonly threadId: string;
  readonly threadUrl: string;
  readonly vector: VersionVector;
  readonly spans: readonly ReviewProjectionSpan[];
  readonly overall: RegisterProjection<string>;
  readonly verdict: RegisterProjection<string>;
  readonly tombstones: { readonly spanIds: readonly string[] };
  readonly discarded: boolean;
  readonly updatedAtMs: number;
}

export interface PostEventsResponse {
  readonly accepted: readonly AcceptedEventDescriptor[];
  readonly projection: ReviewDraftProjection;
}

export interface ReviewDraftSummary {
  readonly threadId: string;
  readonly updatedAtMs: number;
}

export interface ReviewDraftChange {
  readonly threadId: string;
  readonly vector: VersionVector;
  readonly updatedAtMs: number;
}

export interface ReviewDraftChangesResponse {
  readonly cursor: string;
  readonly changed: readonly ReviewDraftChange[];
}

export interface ReviewDraftClientConfig {
  readonly companionUrl: string;
  readonly bridgeKey: string;
  readonly fetchImpl?: typeof fetch;
}

export class ReviewDraftClientError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const buildUrl = (companionUrl: string, path: string): string =>
  `${companionUrl.replace(/\/$/, '')}${path}`;

const baseHeaders = (
  config: ReviewDraftClientConfig,
  idempotencyKey?: string,
): Record<string, string> => ({
  'content-type': 'application/json',
  'x-bac-bridge-key': config.bridgeKey,
  ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
});

export const fetchReviewDraft = async (
  config: ReviewDraftClientConfig,
  threadId: string,
): Promise<ReviewDraftProjection | null> => {
  const fetchImpl = config.fetchImpl ?? fetch;
  const response = await fetchImpl(
    buildUrl(config.companionUrl, `/v1/review-drafts/${encodeURIComponent(threadId)}`),
    { headers: baseHeaders(config) },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new ReviewDraftClientError(
      response.status,
      `GET review-draft failed: ${String(response.status)}`,
    );
  }
  const body = (await response.json()) as { readonly data?: ReviewDraftProjection };
  return body.data ?? null;
};

export const listReviewDraftSummaries = async (
  config: ReviewDraftClientConfig,
  sinceMs?: number | null,
): Promise<readonly ReviewDraftSummary[]> => {
  const fetchImpl = config.fetchImpl ?? fetch;
  const params = new URLSearchParams();
  if (sinceMs !== undefined && sinceMs !== null) params.set('since', String(sinceMs));
  const url = buildUrl(
    config.companionUrl,
    `/v1/review-drafts${params.size > 0 ? `?${params.toString()}` : ''}`,
  );
  const response = await fetchImpl(url, { headers: baseHeaders(config) });
  if (!response.ok) {
    throw new ReviewDraftClientError(
      response.status,
      `LIST review-drafts failed: ${String(response.status)}`,
    );
  }
  const body = (await response.json()) as { readonly items?: readonly ReviewDraftSummary[] };
  return body.items ?? [];
};

export const postReviewDraftEvents = async (
  config: ReviewDraftClientConfig,
  threadId: string,
  events: readonly ReviewDraftClientEvent[],
  options: { readonly threadUrl?: string; readonly idempotencyKey: string },
): Promise<PostEventsResponse> => {
  const fetchImpl = config.fetchImpl ?? fetch;
  const response = await fetchImpl(
    buildUrl(config.companionUrl, `/v1/review-drafts/${encodeURIComponent(threadId)}/events`),
    {
      method: 'POST',
      headers: baseHeaders(config, options.idempotencyKey),
      body: JSON.stringify({
        events,
        ...(options.threadUrl === undefined ? {} : { threadUrl: options.threadUrl }),
      }),
    },
  );
  if (!response.ok) {
    throw new ReviewDraftClientError(
      response.status,
      `POST review-draft events failed: ${String(response.status)}`,
    );
  }
  const body = (await response.json()) as { readonly data?: PostEventsResponse };
  if (body.data === undefined) {
    throw new ReviewDraftClientError(500, 'POST review-draft events returned empty body');
  }
  return body.data;
};

export const fetchReviewDraftChanges = async (
  config: ReviewDraftClientConfig,
  cursor?: string | null,
): Promise<ReviewDraftChangesResponse> => {
  const fetchImpl = config.fetchImpl ?? fetch;
  const params = new URLSearchParams();
  if (cursor !== undefined && cursor !== null && cursor.length > 0) {
    params.set('since', cursor);
  }
  const url = buildUrl(
    config.companionUrl,
    `/v1/review-drafts/changes${params.size > 0 ? `?${params.toString()}` : ''}`,
  );
  const response = await fetchImpl(url, { headers: baseHeaders(config) });
  if (!response.ok) {
    throw new ReviewDraftClientError(
      response.status,
      `GET review-drafts changes failed: ${String(response.status)}`,
    );
  }
  const body = (await response.json()) as Partial<ReviewDraftChangesResponse>;
  return {
    cursor: typeof body.cursor === 'string' ? body.cursor : '0',
    changed: Array.isArray(body.changed) ? body.changed : [],
  };
};

export const deleteReviewDraftRemote = async (
  config: ReviewDraftClientConfig,
  threadId: string,
): Promise<void> => {
  const fetchImpl = config.fetchImpl ?? fetch;
  const response = await fetchImpl(
    buildUrl(config.companionUrl, `/v1/review-drafts/${encodeURIComponent(threadId)}`),
    { method: 'DELETE', headers: baseHeaders(config) },
  );
  if (!response.ok && response.status !== 404) {
    throw new ReviewDraftClientError(
      response.status,
      `DELETE review-draft failed: ${String(response.status)}`,
    );
  }
};
