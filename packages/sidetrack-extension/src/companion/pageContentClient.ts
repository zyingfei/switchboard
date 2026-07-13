import type { CompanionSettings, Problem } from './model';

export type PageContentExtractionStrategy = 'manual-selection' | 'reader-mode' | 'visible-dom';
export type PageContentQuality = 'high' | 'medium' | 'low';
export type PageContentCoverageState =
  | 'metadata_only_legacy'
  | 'metadata_only_policy_closed'
  | 'metadata_only_denied'
  | 'metadata_only_error'
  | 'indexing'
  | 'indexed'
  | 'indexed_low_quality'
  | 'stale_index'
  | 'tombstoned';

export interface PageContentQualitySignals {
  readonly extractedWordCount: number;
  readonly contentToDomRatio: number;
  readonly boilerplateFraction: number;
  readonly extractionStrategy: PageContentExtractionStrategy;
  readonly headingSignatureHash?: string;
}

export interface PageContentCoverage {
  readonly canonicalUrl: string;
  readonly state: PageContentCoverageState;
  readonly quality?: PageContentQuality;
  readonly qualitySignals?: PageContentQualitySignals;
  readonly lastVisitedAt?: string;
  readonly lastIndexedAt?: string;
  readonly contentHash?: string;
  readonly extractionSource?: PageContentExtractionStrategy;
  readonly policyReason?: string;
  readonly error?: string;
  readonly chunkCount?: number;
  readonly indexedCharCount?: number;
}

export interface PageContentExtractedPayload {
  readonly payloadVersion: 1;
  readonly canonicalUrl: string;
  readonly url: string;
  readonly title?: string;
  readonly provider?: string;
  readonly extractedAt: string;
  readonly extractionSource: PageContentExtractionStrategy;
  readonly extractionPolicy: {
    readonly trigger:
      | 'manual'
      | 'workstream-policy'
      | 'save-suggestion'
      | 'allowlist'
      | 'auto-observed'
      | 'attention-gate'
      | 'bulk-open-tabs';
    readonly workstreamId?: string;
    readonly domainPolicyId?: string;
  };
  readonly quality: PageContentQuality;
  readonly qualitySignals: PageContentQualitySignals;
  readonly content: {
    readonly text: string;
    readonly markdown?: string;
    readonly contentHash: string;
    readonly charCount: number;
  };
  readonly redaction?: {
    readonly applied: boolean;
    readonly rules: readonly string[];
  };
}

export type PageEvidenceStorageMode = 'features_only' | 'indexed_chunks';

export interface PageEvidenceRecord {
  readonly schemaVersion: 1;
  readonly canonicalUrl: string;
  readonly evidenceRevision: string;
  readonly updatedAt: string;
  readonly evidenceTier: 'metadata_only' | 'content_features_only' | 'indexed_chunks';
  readonly metadata: {
    readonly title?: string;
    readonly host: string;
    readonly pathTokens: readonly string[];
    readonly titleTokens: readonly string[];
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const parseProblemMessage = (value: unknown): string | undefined => {
  if (!isRecord(value)) return undefined;
  const problem = value as Partial<Problem>;
  return typeof problem.detail === 'string'
    ? problem.detail
    : typeof problem.title === 'string'
      ? problem.title
      : undefined;
};

const isCoverage = (value: unknown): value is PageContentCoverage =>
  isRecord(value) && typeof value.canonicalUrl === 'string' && typeof value.state === 'string';

const isPageEvidenceRecord = (value: unknown): value is PageEvidenceRecord =>
  isRecord(value) &&
  value.schemaVersion === 1 &&
  typeof value.canonicalUrl === 'string' &&
  typeof value.evidenceRevision === 'string' &&
  typeof value.updatedAt === 'string' &&
  typeof value.evidenceTier === 'string' &&
  isRecord(value.metadata);

const sha256Hex = async (value: string): Promise<string> => {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const contentWriteIdempotencyKey = async (
  prefix: 'page-content' | 'page-evidence',
  payload: PageContentExtractedPayload,
  storageMode?: PageEvidenceStorageMode,
): Promise<string> => {
  const fingerprint = await sha256Hex(
    JSON.stringify({
      payloadVersion: payload.payloadVersion,
      canonicalUrl: payload.canonicalUrl,
      contentHash: payload.content.contentHash,
      charCount: payload.content.charCount,
      extractedAt: payload.extractedAt,
      extractionSource: payload.extractionSource,
      storageMode,
    }),
  );
  return `${prefix}-${fingerprint.slice(0, 40)}`;
};

// Default per-request budget for the page-content bridge calls. Chosen
// to match the companion client's write/list default (client.ts) so a
// busy companion (mid-drain, ~100% CPU) can't hang an in-flight request
// forever. Without this, a stalled fetch never settles → the SW's
// handleRequest promise never resolves → sendResponse is never called →
// the side panel's sendMessage callback never fires → the panel's busy
// state (e.g. "Delete text") is stuck ON with no error surfaced. Bounding
// the fetch guarantees the SW handler ALWAYS returns within the budget,
// either with the parsed body or a thrown timeout error the caller turns
// into a visible inline message.
const DEFAULT_PAGE_CONTENT_TIMEOUT_MS = 15_000;

export class PageContentClient {
  private readonly baseUrl: string;

  constructor(private readonly settings: CompanionSettings) {
    this.baseUrl = `http://127.0.0.1:${String(settings.port)}/v1`;
  }

  // Every page-content fetch routes through here so NONE can hang
  // unboundedly. On timeout (AbortError) we throw a plain, user-facing
  // message the background handler propagates as `{ ok: false, error }`;
  // the panel then clears busy and shows the error rather than spinning
  // forever. A transport failure (nothing listening on the port) throws
  // its native message, which is equally actionable.
  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number = DEFAULT_PAGE_CONTENT_TIMEOUT_MS,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(
          `Companion did not respond within ${String(
            Math.round(timeoutMs / 1000),
          )}s — it may be busy. Try again.`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async parseOrThrow(response: Response): Promise<unknown> {
    const body = (await response.json().catch(() => ({}))) as unknown;
    if (!response.ok) {
      throw new Error(parseProblemMessage(body) ?? `Companion HTTP ${String(response.status)}`);
    }
    return body;
  }

  async index(payload: PageContentExtractedPayload): Promise<PageContentCoverage> {
    const idempotencyKey = await contentWriteIdempotencyKey('page-content', payload);
    const response = await this.fetchWithTimeout(`${this.baseUrl}/page-content/extracted`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bac-bridge-key': this.settings.bridgeKey,
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify(payload),
    });
    const body = await this.parseOrThrow(response);
    const data = isRecord(body) && isRecord(body.data) ? body.data['coverage'] : undefined;
    if (!isCoverage(data)) throw new Error('Companion returned an invalid coverage payload.');
    return data;
  }

  async evidence(
    payload: PageContentExtractedPayload,
    storageMode: PageEvidenceStorageMode = 'features_only',
  ): Promise<PageEvidenceRecord> {
    const idempotencyKey = await contentWriteIdempotencyKey('page-evidence', payload, storageMode);
    const response = await this.fetchWithTimeout(`${this.baseUrl}/page-evidence/extracted`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bac-bridge-key': this.settings.bridgeKey,
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify({ ...payload, storageMode }),
    });
    const body = await this.parseOrThrow(response);
    const data = isRecord(body) && isRecord(body.data) ? body.data['evidence'] : undefined;
    if (!isPageEvidenceRecord(data))
      throw new Error('Companion returned an invalid evidence payload.');
    return data;
  }

  async coverage(canonicalUrl: string): Promise<PageContentCoverage> {
    const params = new URLSearchParams({ canonicalUrl });
    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/page-content/coverage?${params.toString()}`,
      {
        headers: { 'x-bac-bridge-key': this.settings.bridgeKey },
      },
    );
    const body = await this.parseOrThrow(response);
    const data = isRecord(body) ? body.data : undefined;
    if (!isCoverage(data)) throw new Error('Companion returned an invalid coverage payload.');
    return data;
  }

  async delete(canonicalUrl: string): Promise<PageContentCoverage> {
    const payload = {
      payloadVersion: 1,
      canonicalUrl,
      tombstonedAt: new Date().toISOString(),
      reason: 'user-delete',
    };
    const response = await this.fetchWithTimeout(`${this.baseUrl}/page-content/tombstone`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bac-bridge-key': this.settings.bridgeKey,
        'idempotency-key': `page-content-delete-${String(Date.now())}`,
      },
      body: JSON.stringify(payload),
    });
    const body = await this.parseOrThrow(response);
    const data = isRecord(body) && isRecord(body.data) ? body.data['coverage'] : undefined;
    if (!isCoverage(data)) throw new Error('Companion returned an invalid coverage payload.');
    return data;
  }

  // Recall v2 — POST /v2/recall. Single unified endpoint, server-
  // owned fusion/dedupe/suppression. Returns the RecallResponse with
  // evidence-rich candidates. Replaces the multi-call /v1/content/query
  // pattern; that endpoint stays for legacy callers but Déjà-vu now
  // uses v2.
  async recallV2(req: unknown): Promise<{
    readonly results: readonly {
      readonly entityId: string;
      readonly sourceKind: string;
      readonly canonicalUrl?: string;
      readonly title?: string;
      readonly snippet?: string;
      readonly threadId?: string;
      readonly fusedScore: number;
      readonly evidence: readonly {
        readonly retriever: string;
        readonly sourceKind: string;
        readonly rawScore?: number;
        readonly rank?: number;
        readonly vectorDistance?: number;
      }[];
    }[];
    readonly meta: Record<string, unknown>;
  }> {
    // baseUrl is "http://127.0.0.1:port/v1" — swap the prefix to /v2.
    const v2Base = this.baseUrl.replace(/\/v1$/, '/v2');
    // Recall can legitimately run longer than a write (fusion + rerank on
    // a cold companion), so give it a wider budget than the default. Still
    // bounded so a wedged companion surfaces an error instead of hanging.
    const response = await this.fetchWithTimeout(
      `${v2Base}/recall`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-bac-bridge-key': this.settings.bridgeKey,
        },
        body: JSON.stringify(req),
      },
      45_000,
    );
    const body = await this.parseOrThrow(response);
    const data = isRecord(body) ? body.data : undefined;
    if (!isRecord(data)) throw new Error('Companion /v2/recall returned no data field.');
    return data as never;
  }

  /** Phase 0 — POST /v1/recall/action. The companion appends a
   *  `recall.action` event tied to the parent `recall.served` by
   *  `servedContextId`. Idempotent: duplicate clicks with the same
   *  (servedContextId, entityId, actionKind) collapse server-side;
   *  actions mirroring a feedback event additionally carry
   *  referencesEventId in the fingerprint so REPEAT gestures on the
   *  same served candidate (each a distinct feedback event) are not
   *  collapsed as replays. */
  async recallAction(payload: {
    readonly payloadVersion: 1;
    readonly servedContextId: string;
    readonly entityId: string;
    readonly actionKind: string;
    readonly actionAt: string;
    readonly referencesEventId?: string;
  }): Promise<void> {
    // When referencesEventId is absent (engagement clicks) the
    // fingerprint input stays byte-for-byte the legacy string so
    // existing keys don't change.
    const fingerprint = await sha256Hex(
      payload.referencesEventId === undefined
        ? `${payload.servedContextId}:${payload.entityId}:${payload.actionKind}`
        : `${payload.servedContextId}:${payload.entityId}:${payload.actionKind}:${payload.referencesEventId}`,
    );
    const idempotencyKey = `recall-action-${fingerprint.slice(0, 40)}`;
    const response = await this.fetchWithTimeout(`${this.baseUrl}/recall/action`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bac-bridge-key': this.settings.bridgeKey,
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify(payload),
    });
    await this.parseOrThrow(response);
  }

}

export const createPageContentClient = (settings: CompanionSettings): PageContentClient =>
  new PageContentClient(settings);
