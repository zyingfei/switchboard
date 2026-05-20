import type { VectorRef, WeightedTerm } from '../page-evidence/types.js';

export const PAGE_CONTENT_EXTRACTED = 'page.content.extracted' as const;
export const PAGE_CONTENT_TOMBSTONED = 'page.content.tombstoned' as const;

export const PAGE_CONTENT_COVERAGE_STATES = [
  'metadata_only_legacy',
  'metadata_only_policy_closed',
  'metadata_only_denied',
  'metadata_only_error',
  'indexing',
  'indexed',
  'indexed_low_quality',
  'stale_index',
  'tombstoned',
] as const;

export type PageContentCoverageState = (typeof PAGE_CONTENT_COVERAGE_STATES)[number];

export type PageContentQuality = 'high' | 'medium' | 'low';

export type PageContentExtractionStrategy = 'manual-selection' | 'reader-mode' | 'visible-dom';

export type PageContentPolicyTrigger =
  | 'manual'
  | 'workstream-policy'
  | 'save-suggestion'
  | 'allowlist'
  | 'auto-observed'
  | 'attention-gate'
  | 'bulk-open-tabs';

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
    readonly trigger: PageContentPolicyTrigger;
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
  readonly dimensions?: Record<string, unknown>;
}

export interface PageContentTombstonedPayload {
  readonly payloadVersion: 1;
  readonly canonicalUrl: string;
  readonly tombstonedAt: string;
  readonly reason: 'user-delete' | 'policy-revoked' | 'retention-expired' | 'quality-reject';
  readonly contentHash?: string;
  readonly dimensions?: Record<string, unknown>;
}

export interface PageContentRecord {
  readonly coverage: PageContentCoverage;
  readonly url: string;
  readonly title?: string;
  readonly provider?: string;
  readonly updatedAt: string;
  readonly sourceEventType: typeof PAGE_CONTENT_EXTRACTED | typeof PAGE_CONTENT_TOMBSTONED;
}

export interface PageContentChunk {
  readonly id: string;
  readonly canonicalUrl: string;
  readonly url: string;
  readonly title?: string;
  readonly contentHash: string;
  readonly chunkIndex: number;
  readonly charStart: number;
  readonly charEnd: number;
  readonly text: string;
  readonly extractedAt: string;
  readonly quality: PageContentQuality;
  readonly extractionStrategy: PageContentExtractionStrategy;
  readonly headingPath?: readonly string[];
  readonly terms?: readonly WeightedTerm[];
  readonly embeddingRef?: VectorRef;
  readonly qualityWeight?: number;
}

// Unified Content Search v1 rank evidence. Present on primary
// (page-content + chat-turn) hits to surface the RRF decomposition;
// absent on semantic-recall-pool expansion hits (those carry
// `sourceEvidence` instead — the two are mutually exclusive by design,
// matching the spec's "no raw-score sort across sources, semantic
// stays as expansion").
export interface ContentSearchHitRankEvidence {
  readonly kind: 'rrf';
  // 1-indexed rank in each ranker the hit appeared in. Rankers the
  // hit was absent from are omitted from this map.
  readonly ranksByRanker: Readonly<Partial<Record<'page-content' | 'chat-turn', number>>>;
  // RRF fused score: Σ 1/(k + rank_i).
  readonly fusionScore: number;
  readonly k: number;
}

export interface ContentSearchHit {
  readonly id: string;
  readonly sourceKind: 'page-content' | 'chat-turn' | 'semantic-recall-pool';
  // W4(b-lite) — present only on 'semantic-recall-pool' hits: marks
  // the candidate as a semantic-recall expansion (NOT topic
  // membership) with its evidence.
  readonly sourceEvidence?: {
    readonly source: 'semantic_recall_pool';
    readonly similarity: number;
    readonly via: 'cluster' | 'neighbor';
  };
  // Unified Content Search v1 — only on primary RRF-fused hits
  // (page-content + chat-turn). semantic-recall-pool hits use
  // sourceEvidence instead and never carry rankEvidence.
  readonly rankEvidence?: ContentSearchHitRankEvidence;
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
