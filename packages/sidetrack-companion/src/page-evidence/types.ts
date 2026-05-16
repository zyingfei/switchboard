import type {
  PageContentExtractionStrategy,
  PageContentPolicyTrigger,
  PageContentQuality,
  PageContentQualitySignals,
} from '../page-content/types.js';

export const PAGE_EVIDENCE_SCHEMA_VERSION = 1;
export const PAGE_EVIDENCE_EXTRACTION_CODE_VERSION = 'page-evidence-extract-v1';
export const PAGE_EVIDENCE_TOKENIZER_VERSION = 'page-evidence-tokenizer-v5';
export const PAGE_EVIDENCE_FEATURE_SCHEMA_VERSION = 1;

export type PageEvidenceTier = 'metadata_only' | 'content_features_only' | 'indexed_chunks';

export type PageEvidenceSource =
  | 'timeline'
  | 'page-content'
  | 'manual-selection'
  | 'indexed-chunks';

export type WeightedTermSource = 'title' | 'heading' | 'body' | 'url_path' | 'host' | 'anchor';

export interface VersionStamp {
  readonly extractionCodeVersion: string;
  readonly tokenizerVersion: string;
  readonly embeddingModelId?: string;
  readonly embeddingModelVersion?: string;
  readonly embeddingDimensions?: number;
  readonly featureSchemaVersion: number;
}

export interface VectorRef {
  readonly vectorId: string;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly dimensions: number;
}

export interface WeightedTerm {
  readonly term: string;
  readonly normalized: string;
  readonly weight: number;
  readonly df?: number;
  readonly idf?: number;
  readonly source: WeightedTermSource;
}

export interface WeightedEntity {
  readonly text: string;
  readonly normalized: string;
  readonly kind:
    | 'org'
    | 'product'
    | 'library'
    | 'protocol'
    | 'standard'
    | 'acronym'
    | 'repo'
    | 'unknown';
  readonly weight: number;
  readonly source: Exclude<WeightedTermSource, 'anchor'>;
}

export interface PageEvidenceRecord {
  readonly schemaVersion: typeof PAGE_EVIDENCE_SCHEMA_VERSION;
  readonly canonicalUrl: string;
  readonly semanticFeatureRevision: string;
  readonly behaviorMetadataRevision: string;
  readonly evidenceRevision: string;
  readonly updatedAt: string;
  readonly evidenceTier: PageEvidenceTier;
  readonly versions: VersionStamp;
  readonly metadata: {
    readonly title?: string;
    readonly host: string;
    readonly pathTokens: readonly string[];
    readonly titleTokens: readonly string[];
    readonly provider?: string;
    readonly firstSeenAt?: string;
    readonly lastSeenAt?: string;
    readonly visitCount?: number;
    readonly focusedWindowMs?: number;
  };
  readonly content?: {
    readonly contentHash: string;
    readonly extractionSource: PageContentExtractionStrategy;
    readonly quality: PageContentQuality;
    readonly qualitySignals: PageContentQualitySignals;
    readonly language?: string;
    readonly terms: readonly WeightedTerm[];
    readonly keyphrases: readonly WeightedTerm[];
    readonly entities: readonly WeightedEntity[];
    readonly docEmbeddingRef?: VectorRef;
    readonly embeddingState?: 'disabled' | 'missing' | 'failed' | 'ready';
    readonly simhash?: string;
    readonly minhash?: readonly number[];
  };
  readonly indexed?: {
    readonly chunkCount: number;
    readonly indexedCharCount: number;
    readonly chunkManifestRef: string;
    readonly chunkEmbeddingRevision?: string;
  };
  readonly provenance: {
    readonly sources: readonly PageEvidenceSource[];
    readonly sourceEventIds?: readonly string[];
    readonly modelRevision?: string;
  };
}

export type PageEvidenceStorageMode = 'features_only' | 'indexed_chunks';

export interface PageEvidenceExtractedRequest {
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
  readonly storageMode: PageEvidenceStorageMode;
}

export interface PageEvidenceMetadataInput {
  readonly canonicalUrl: string;
  readonly url?: string;
  readonly title?: string;
  readonly provider?: string;
  readonly firstSeenAt?: string;
  readonly lastSeenAt?: string;
  readonly visitCount?: number;
  readonly focusedWindowMs?: number;
}

export interface ReadPageEvidenceResult {
  readonly record: PageEvidenceRecord | null;
  readonly stale: boolean;
  readonly staleReason?: 'version' | 'vector';
}

export interface PageEvidenceSimilarityMetadata {
  readonly producer: 'content-enriched' | 'metadata-only';
  readonly policyId: string;
  readonly policyMode: 'default' | 'shadow';
  readonly defaultEligible: boolean;
  readonly score: number;
  readonly semanticScore?: number;
  readonly confidence: number;
  readonly confidenceSignals?: {
    readonly evidenceCoverage: number;
    readonly extractionReliability: number;
    readonly vectorCompatible: boolean;
  };
  readonly evidenceTierFrom: PageEvidenceTier;
  readonly evidenceTierTo: PageEvidenceTier;
  readonly channels: {
    readonly contentVector?: number;
    readonly contentTerms?: number;
    readonly keyphrases?: number;
    readonly entities?: number;
    readonly metadata?: number;
    readonly behavior?: number;
    readonly chunkSupport?: number;
  };
  readonly matchedTerms?: readonly string[];
  readonly matchedKeyphrases?: readonly string[];
  readonly matchedEntities?: readonly string[];
  readonly chunkSupportCount?: number;
  readonly maxChunkPairScore?: number;
  readonly featureSchemaVersion: number;
}

export interface PageEvidenceExtractedEventPayload {
  readonly payloadVersion: 1;
  readonly canonicalUrl: string;
  readonly evidenceRevision: string;
  readonly semanticFeatureRevision: string;
  readonly behaviorMetadataRevision: string;
  readonly evidenceTier: PageEvidenceTier;
  readonly contentHash?: string;
  readonly storageMode: PageEvidenceStorageMode;
  readonly versions: VersionStamp;
  readonly quality?: PageContentQuality;
  readonly termCount: number;
  readonly keyphraseCount: number;
  readonly entityCount: number;
  readonly vectorRef?: {
    readonly modelId: string;
    readonly modelVersion: string;
    readonly dimensions: number;
  };
  readonly embeddingState?: 'disabled' | 'missing' | 'failed' | 'ready';
  readonly trigger: PageContentPolicyTrigger;
  readonly sourceEventId?: string;
}

export const currentPageEvidenceVersions = (docEmbeddingRef?: VectorRef): VersionStamp => ({
  extractionCodeVersion: PAGE_EVIDENCE_EXTRACTION_CODE_VERSION,
  tokenizerVersion: PAGE_EVIDENCE_TOKENIZER_VERSION,
  ...(docEmbeddingRef === undefined
    ? {}
    : {
        embeddingModelId: docEmbeddingRef.modelId,
        embeddingModelVersion: docEmbeddingRef.modelVersion,
        embeddingDimensions: docEmbeddingRef.dimensions,
      }),
  featureSchemaVersion: PAGE_EVIDENCE_FEATURE_SCHEMA_VERSION,
});
