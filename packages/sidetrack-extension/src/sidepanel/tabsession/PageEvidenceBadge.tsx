import type { TabSessionPageEvidenceSummary } from './types';

// Page-evidence and chat-turn capture are SEPARATE pipelines. The
// badge used to read only `pageEvidence.tier`, so a tracked chat
// with turns already ingested still rendered as "Metadata only" when
// auto page-text extract was off (the default) — the user's "(b)
// metadata only conflicts with actual turn details captured" bug.
// `chatThreadCaptured` lets the caller surface the parallel signal:
//   - when true and pageEvidence.tier === metadata_only ⇒ "Chat
//     captured" (chat content is in the index even if page-text
//     isn't);
//   - when true and tier is content_features_only / indexed_chunks
//     ⇒ "Chat + features" / "Chat + indexed";
//   - when true and pageEvidence is undefined (no page-text capture
//     at all) ⇒ "Chat captured" so the badge still surfaces SOME
//     truth instead of rendering nothing for a captured chat.

const tierLabel = (tier: string, chatCaptured: boolean): string => {
  switch (tier) {
    case 'metadata_only':
      return chatCaptured ? 'Chat captured' : 'Metadata only';
    case 'content_features_only':
      return chatCaptured ? 'Chat + features' : 'Features only';
    case 'indexed_chunks':
      return chatCaptured ? 'Chat + indexed' : 'Indexed chunks';
    default:
      return tier.replaceAll('_', ' ');
  }
};

const tierClass = (tier: string, chatCaptured: boolean): string => {
  // Visually promote chat-captured rows from the "metadata-only"
  // muted state to the "features-only" tone — the user has REAL
  // captured signal for this URL even when page-text extract is off.
  if (chatCaptured && tier === 'metadata_only') return 'features-only';
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

const tierHelp = (tier: string, chatCaptured: boolean): string => {
  switch (tier) {
    case 'metadata_only':
      return chatCaptured
        ? 'Chat turns for this conversation are in the index. Page text is not separately extracted (auto page-text extract is off).'
        : 'Suggestions use URL, host, path, and title metadata only.';
    case 'content_features_only':
      return chatCaptured
        ? 'Chat turns are in the index AND page text is extracted into features, keyphrases, and entities. Raw page text is not stored.'
        : 'Suggestions can use extracted terms, keyphrases, entities, and optional document vectors. Raw page text is not stored.';
    case 'indexed_chunks':
      return chatCaptured
        ? 'Chat turns are in the index AND page text is stored as searchable chunks.'
        : 'Suggestions can use extracted content, and search/snippets can use stored page chunks.';
    default:
      return 'Capture tier reported by the companion.';
  }
};

const countLabel = (label: string, value: number | undefined): string | undefined =>
  value === undefined ? undefined : `${String(value)} ${label}`;

export interface PageEvidenceBadgeProps {
  readonly pageEvidence?: TabSessionPageEvidenceSummary;
  /** True when a tracked chat thread exists for this URL — chat-turn
   * pipeline has produced content for it. Computed by the caller from
   * state.threads + the row's threadUrl/canonicalUrl. Composed with
   * page-evidence tier so the badge tells the truth about both
   * pipelines instead of just the page-text one. */
  readonly chatThreadCaptured?: boolean;
}

export function PageEvidenceBadge({
  pageEvidence,
  chatThreadCaptured = false,
}: PageEvidenceBadgeProps) {
  // No page-evidence AND no chat capture ⇒ nothing to surface
  // (preserves the existing "render nothing" behaviour for
  // genuinely-unindexed rows).
  if (pageEvidence === undefined || typeof pageEvidence.tier !== 'string') {
    if (!chatThreadCaptured) return null;
    // Chat captured but no page-evidence summary — render a minimal
    // honest badge so the user sees the chat IS captured.
    return (
      <span
        className="tab-session-capture-badge is-features-only"
        title={
          'Capture type: Chat captured | Chat turns for this conversation are in the index. ' +
          'Page text is not separately extracted (auto page-text extract is off).'
        }
        aria-label="Capture type: Chat captured"
        data-testid="page-evidence-capture-badge"
      >
        Chat captured
      </span>
    );
  }
  const label = tierLabel(pageEvidence.tier, chatThreadCaptured);
  const details = [
    `Capture type: ${label}`,
    tierHelp(pageEvidence.tier, chatThreadCaptured),
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
      className={`tab-session-capture-badge is-${tierClass(pageEvidence.tier, chatThreadCaptured)}`}
      title={details.join(' | ')}
      aria-label={`Capture type: ${label}`}
      data-testid="page-evidence-capture-badge"
    >
      {label}
    </span>
  );
}
