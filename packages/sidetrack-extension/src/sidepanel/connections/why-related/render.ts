import type { Reason } from './reasons';

export const renderReason = (reason: Reason): string => {
  switch (reason.code) {
    case 'SAME_THREAD':
      return `Same thread: ${reason.threadName}`;
    case 'SAME_TOPIC':
      return `Same topic (cohesion ${reason.cohesion.toFixed(2)})`;
    case 'COSINE_ABOVE_THRESHOLD':
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
    case 'LEXICAL_OVERLAP':
      return `Shared terms: ${reason.topTokens.slice(0, 3).join(', ')}`;
    case 'LINK_OUT_FROM':
      return 'This page links to that one';
    case 'LINK_IN_TO':
      return 'That page links to this one';
  }
};
