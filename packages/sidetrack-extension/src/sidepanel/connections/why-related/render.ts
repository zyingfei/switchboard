import type { Reason } from './reasons';

export const renderReason = (reason: Reason): string => {
  switch (reason.code) {
    case 'SAME_THREAD':
      return `Same thread: ${reason.threadName}`;
    case 'SAME_TOPIC':
      return `Same topic (cohesion ${reason.cohesion.toFixed(2)})`;
    case 'COSINE_ABOVE_THRESHOLD':
      if (reason.matchCount !== undefined && reason.matchCount > 1) {
        return `Title similarity up to ${reason.cosine.toFixed(2)} across ${String(
          reason.matchCount,
        )} pages (threshold ${reason.threshold.toFixed(2)})`;
      }
      return `Title similarity ${reason.cosine.toFixed(2)} >= ${reason.threshold.toFixed(2)}`;
    case 'OPENER_CHAIN':
      return `Opened from another visit (${String(reason.depth)} hop${
        reason.depth === 1 ? '' : 's'
      })`;
    case 'PREVIOUS_VISIT_IN_TAB_SESSION':
      return 'Previous visit in the same tab session';
    case 'TRANSITION_TYPE':
      return `Navigation transition: ${reason.transitionType}`;
    case 'TRANSITION_QUALIFIER':
      return `Navigation qualifier: ${reason.qualifier}`;
    case 'COPIED_FROM':
      return 'Snippet copied from this page';
    case 'PASTED_INTO':
      return `Pasted into ${reason.destinationKind}`;
    case 'OBSERVED_ON_OTHER_REPLICA':
      return `Also observed on replica ${reason.replicaId}`;
    case 'RANKER_SCORE': {
      const contributions = reason.topContributions
        .slice(0, 3)
        .map(
          (contribution) =>
            `${contribution.feature} ${
              contribution.weight >= 0 ? '+' : ''
            }${contribution.weight.toFixed(2)}`,
        )
        .join(', ');
      return contributions.length === 0
        ? `Ranker score ${reason.score.toFixed(2)}`
        : `Ranker score ${reason.score.toFixed(2)}: ${contributions}`;
    }
    case 'LEXICAL_OVERLAP':
      return `Shared terms: ${reason.topTokens.slice(0, 3).join(', ')}`;
    case 'LINK_OUT_FROM':
      return 'This page links to that one';
    case 'LINK_IN_TO':
      return 'That page links to this one';
  }
};
