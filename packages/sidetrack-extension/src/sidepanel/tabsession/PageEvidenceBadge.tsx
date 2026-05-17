import type { TabSessionPageEvidenceSummary } from './types';

const tierLabel = (tier: string): string => {
  switch (tier) {
    case 'metadata_only':
      return 'Metadata only';
    case 'content_features_only':
      return 'Features only';
    case 'indexed_chunks':
      return 'Indexed chunks';
    default:
      return tier.replaceAll('_', ' ');
  }
};

const tierClass = (tier: string): string => {
  switch (tier) {
    case 'metadata_only':
      return 'metadata-only';
    case 'content_features_only':
      return 'features-only';
    case 'indexed_chunks':
      return 'indexed-chunks';
    default:
      return 'unknown';
  }
};

const tierHelp = (tier: string): string => {
  switch (tier) {
    case 'metadata_only':
      return 'Suggestions use URL, host, path, and title metadata only.';
    case 'content_features_only':
      return 'Suggestions can use extracted terms, keyphrases, entities, and optional document vectors. Raw page text is not stored.';
    case 'indexed_chunks':
      return 'Suggestions can use extracted content, and search/snippets can use stored page chunks.';
    default:
      return 'Capture tier reported by the companion.';
  }
};

const countLabel = (label: string, value: number | undefined): string | undefined =>
  value === undefined ? undefined : `${String(value)} ${label}`;

export interface PageEvidenceBadgeProps {
  readonly pageEvidence?: TabSessionPageEvidenceSummary;
}

export function PageEvidenceBadge({ pageEvidence }: PageEvidenceBadgeProps) {
  if (pageEvidence === undefined || typeof pageEvidence.tier !== 'string') return null;
  const label = tierLabel(pageEvidence.tier);
  const details = [
    `Capture type: ${label}`,
    tierHelp(pageEvidence.tier),
    countLabel('terms', pageEvidence.termCount),
    countLabel('keyphrases', pageEvidence.keyphraseCount),
    countLabel('entities', pageEvidence.entityCount),
    pageEvidence.quality === undefined ? undefined : `quality ${pageEvidence.quality}`,
    pageEvidence.vector === undefined
      ? undefined
      : `vector ${pageEvidence.vector.modelId} ${pageEvidence.vector.dimensions}d`,
  ].filter((item): item is string => item !== undefined && item.length > 0);

  return (
    <span
      className={`tab-session-capture-badge is-${tierClass(pageEvidence.tier)}`}
      title={details.join(' | ')}
      aria-label={`Capture type: ${label}`}
      data-testid="page-evidence-capture-badge"
    >
      {label}
    </span>
  );
}
