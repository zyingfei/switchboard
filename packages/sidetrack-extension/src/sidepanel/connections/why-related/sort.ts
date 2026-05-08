import type { Reason, ReasonCode } from './reasons';

export const REASON_PRIORITY: Record<ReasonCode, number> = {
  SAME_THREAD: 1,
  COPIED_FROM: 2,
  PASTED_INTO: 2,
  OPENER_CHAIN: 3,
  PREVIOUS_VISIT_IN_TAB_SESSION: 3,
  TRANSITION_TYPE: 4,
  TRANSITION_QUALIFIER: 4,
  OBSERVED_ON_OTHER_REPLICA: 5,
  SAME_TOPIC: 6,
  COSINE_ABOVE_THRESHOLD: 7,
  LINK_OUT_FROM: 8,
  LINK_IN_TO: 8,
  LEXICAL_OVERLAP: 9,
};

const stablePayload = (reason: Reason): string => JSON.stringify(reason);

export const sortReasons = (reasons: readonly Reason[]): readonly Reason[] =>
  [...reasons].sort((left, right) => {
    const priority = REASON_PRIORITY[left.code] - REASON_PRIORITY[right.code];
    if (priority !== 0) return priority;
    const leftPayload = stablePayload(left);
    const rightPayload = stablePayload(right);
    return leftPayload < rightPayload ? -1 : leftPayload > rightPayload ? 1 : 0;
  });
