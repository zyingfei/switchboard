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

export interface ContentSearchHit {
  readonly id: string;
  readonly sourceKind: 'page-content' | 'chat-turn';
  readonly anchorNodeId: string;
  readonly canonicalUrl?: string;
  readonly threadId?: string;
  readonly title?: string;
  readonly snippet?: string;
  readonly score: number;
  readonly capturedAt: string;
  readonly coverageState?: PageContentCoverageState;
  readonly quality?: PageContentQuality;
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

const isContentSearchHit = (value: unknown): value is ContentSearchHit =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  (value.sourceKind === 'page-content' || value.sourceKind === 'chat-turn') &&
  typeof value.anchorNodeId === 'string' &&
  typeof value.score === 'number' &&
  typeof value.capturedAt === 'string';

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

export class PageContentClient {
  private readonly baseUrl: string;

  constructor(private readonly settings: CompanionSettings) {
    this.baseUrl = `http://127.0.0.1:${String(settings.port)}/v1`;
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
    const response = await fetch(`${this.baseUrl}/page-content/extracted`, {
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
    const response = await fetch(`${this.baseUrl}/page-evidence/extracted`, {
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
    const response = await fetch(`${this.baseUrl}/page-content/coverage?${params.toString()}`, {
      headers: { 'x-bac-bridge-key': this.settings.bridgeKey },
    });
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
    const response = await fetch(`${this.baseUrl}/page-content/tombstone`, {
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

  async query(input: {
    readonly q: string;
    readonly sourceKind?: readonly ('page-content' | 'chat-turn')[];
    readonly limit?: number;
  }): Promise<readonly ContentSearchHit[]> {
    const params = new URLSearchParams({ q: input.q });
    if (input.limit !== undefined) params.set('limit', String(input.limit));
    if (input.sourceKind !== undefined) params.set('sourceKind', input.sourceKind.join(','));
    const response = await fetch(`${this.baseUrl}/content/query?${params.toString()}`, {
      headers: { 'x-bac-bridge-key': this.settings.bridgeKey },
    });
    const body = await this.parseOrThrow(response);
    const data = isRecord(body) ? body.data : undefined;
    return Array.isArray(data) ? data.filter(isContentSearchHit) : [];
  }
}

export const createPageContentClient = (settings: CompanionSettings): PageContentClient =>
  new PageContentClient(settings);
