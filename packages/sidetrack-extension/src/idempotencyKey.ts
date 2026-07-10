// Shared idempotency-key builder for companion POSTs.
//
// Extracted VERBATIM from background.ts — do not change the format.
// The companion stores this header string as the accepted event's
// clientEventId (server.ts /v1/feedback/events et al.), and the P2
// trainable-action mirror (src/sidepanel/recall/emitTrainableAction.ts)
// must reproduce the exact same string in recall.action.referencesEventId
// for the trainer's double-count dedupe
// (companion retrain-impressions.ts historicalFeedbackSpecFor) to fire.
// A single implementation is what keeps the two sides byte-identical.
export const idempotencyKey = (prefix: string, value: string): string =>
  `${prefix}-${value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 160)}`;
