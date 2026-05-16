import type { PageContentQuality } from '../page-content/types.js';
import type { PageEvidenceSimilarityMetadata } from './types.js';

export type PageEvidenceScoringPolicyMode = 'default' | 'shadow';

export interface PageEvidenceScoringPolicy {
  readonly policyId: string;
  readonly policyMode: PageEvidenceScoringPolicyMode;
  readonly defaultEligible: boolean;
  readonly semanticFusion: 'unweighted-channel-mean';
  readonly confidenceModel: 'coverage-x-extraction-reliability';
  readonly provenance: string;
}

export const PAGE_EVIDENCE_COLD_START_SCORING_POLICY: PageEvidenceScoringPolicy = {
  policyId: 'cold_start_channel_mean_v1',
  policyMode: 'default',
  defaultEligible: true,
  semanticFusion: 'unweighted-channel-mean',
  confidenceModel: 'coverage-x-extraction-reliability',
  provenance:
    'Parameter-free cold-start policy: semantic score is the unweighted mean of available channel scores; extraction quality only affects confidence.',
};

export const PAGE_EVIDENCE_SHADOW_HANDSET_SCORING_POLICY: PageEvidenceScoringPolicy = {
  policyId: 'shadow_handset_v0',
  policyMode: 'shadow',
  defaultEligible: false,
  semanticFusion: 'unweighted-channel-mean',
  confidenceModel: 'coverage-x-extraction-reliability',
  provenance:
    'Reference bucket for quarantined hand-set scoring experiments. Not eligible for default product behavior.',
};

const clampUnit = (value: number): number => Math.min(Math.max(value, 0), 1);

const PAGE_EVIDENCE_CONFIDENCE_CHANNELS = [
  'contentVector',
  'contentTerms',
  'keyphrases',
  'entities',
  'metadata',
  'chunkSupport',
] as const satisfies readonly (keyof PageEvidenceSimilarityMetadata['channels'])[];

export const extractionReliabilityForQuality = (
  quality: PageContentQuality | undefined,
): number => {
  if (quality === 'high') return 1;
  if (quality === 'medium') return 0.75;
  if (quality === 'low') return 0.35;
  return 1;
};

export const fusePageEvidenceChannelScores = (
  channels: PageEvidenceSimilarityMetadata['channels'],
): number => {
  const values = Object.values(channels)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    .map(clampUnit);
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

export const confidenceForPageEvidencePair = (input: {
  readonly channels: PageEvidenceSimilarityMetadata['channels'];
  readonly extractionReliability: number;
}): {
  readonly confidence: number;
  readonly evidenceCoverage: number;
  readonly extractionReliability: number;
} => {
  const availableChannelCount = PAGE_EVIDENCE_CONFIDENCE_CHANNELS.filter((channel) => {
    const value = input.channels[channel];
    return typeof value === 'number' && Number.isFinite(value);
  }).length;
  const evidenceCoverage = clampUnit(
    availableChannelCount / PAGE_EVIDENCE_CONFIDENCE_CHANNELS.length,
  );
  const extractionReliability = clampUnit(input.extractionReliability);
  return {
    confidence: clampUnit(evidenceCoverage * extractionReliability),
    evidenceCoverage,
    extractionReliability,
  };
};
