export const REASON_CODES = [
  'SAME_THREAD',
  'SAME_TOPIC',
  'COSINE_ABOVE_THRESHOLD',
  'OPENER_CHAIN',
  'PREVIOUS_VISIT_IN_TAB_SESSION',
  'TRANSITION_TYPE',
  'TRANSITION_QUALIFIER',
  'COPIED_FROM',
  'PASTED_INTO',
  'OBSERVED_ON_OTHER_REPLICA',
  'LEXICAL_OVERLAP',
  'LINK_OUT_FROM',
  'LINK_IN_TO',
] as const;

export type Reason =
  | { readonly code: 'SAME_THREAD'; readonly threadId: string; readonly threadName: string }
  | { readonly code: 'SAME_TOPIC'; readonly topicId: string; readonly cohesion: number }
  | {
      readonly code: 'COSINE_ABOVE_THRESHOLD';
      readonly cosine: number;
      readonly threshold: number;
    }
  | {
      readonly code: 'OPENER_CHAIN';
      readonly depth: number;
      readonly viaTabSessionIdHash: string;
    }
  | {
      readonly code: 'PREVIOUS_VISIT_IN_TAB_SESSION';
      readonly tabSessionIdHash: string;
    }
  | { readonly code: 'TRANSITION_TYPE'; readonly transitionType: string }
  | { readonly code: 'TRANSITION_QUALIFIER'; readonly qualifier: string }
  | { readonly code: 'COPIED_FROM'; readonly snippetId: string }
  | {
      readonly code: 'PASTED_INTO';
      readonly snippetId: string;
      readonly destinationKind: string;
    }
  | { readonly code: 'OBSERVED_ON_OTHER_REPLICA'; readonly replicaId: string }
  | { readonly code: 'LEXICAL_OVERLAP'; readonly topTokens: readonly string[] }
  | { readonly code: 'LINK_OUT_FROM'; readonly otherVisitId: string }
  | { readonly code: 'LINK_IN_TO'; readonly otherVisitId: string };

export type ReasonCode = Reason['code'];

export type ReasonConfidence = 'asserted' | 'observed' | 'inferred';

export const reasonConfidence = (reason: Reason): ReasonConfidence => {
  switch (reason.code) {
    case 'SAME_THREAD':
    case 'COPIED_FROM':
    case 'PASTED_INTO':
      return 'asserted';
    case 'OPENER_CHAIN':
    case 'PREVIOUS_VISIT_IN_TAB_SESSION':
    case 'TRANSITION_TYPE':
    case 'TRANSITION_QUALIFIER':
    case 'OBSERVED_ON_OTHER_REPLICA':
    case 'LINK_OUT_FROM':
    case 'LINK_IN_TO':
      return 'observed';
    case 'SAME_TOPIC':
    case 'COSINE_ABOVE_THRESHOLD':
    case 'LEXICAL_OVERLAP':
      return 'inferred';
  }
};
