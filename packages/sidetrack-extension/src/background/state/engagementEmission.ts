// Pure emit-decision for an incoming engagement interval.
//
// Extracted from the service worker so the capture-gate composition is
// unit-testable in isolation. Given the gate signals and the interval
// message, this decides:
//   - whether to DROP the interval entirely (and why), and
//   - when kept, which streams to emit and how to reconcile the durable
//     session mirror (persist the running session, or clear it after a
//     final aggregate is emitted).
//
// Privacy invariant (composes with the #243 capture-gate rework): a
// paused (`captureEnabled === false`) or blocked (`isCaptureAllowedForUrl`
// === false) page must produce NOTHING — no interval, no aggregate — AND
// must CLEAR any durable mirror left from before it was paused/blocked, so
// the idle-sweep can never later resurrect an aggregate for a suppressed
// page.

export type EngagementDropReason =
  | 'no-tabId'
  | 'shape-mismatch'
  | 'capture-disabled'
  | 'no-capture-blocklist';

export interface EngagementEmissionInputs {
  readonly tabIdDefined: boolean;
  readonly shapeValid: boolean;
  readonly captureEnabled: boolean;
  readonly captureAllowedForUrl: boolean;
  readonly final: boolean;
}

export type EngagementEmissionDecision =
  | {
      readonly kind: 'drop';
      readonly reason: EngagementDropReason;
      // When a paused/blocked page drops an interval, any durable mirror
      // for the tab must be cleared so the sweep cannot re-emit it.
      readonly clearDurable: boolean;
    }
  | {
      readonly kind: 'emit';
      readonly emitAggregate: boolean;
      // A non-final interval mirrors the running session for durability; a
      // final interval clears the mirror (its aggregate was just emitted).
      readonly durableAction: 'persist' | 'clear';
    };

export const resolveEngagementEmission = (
  inputs: EngagementEmissionInputs,
): EngagementEmissionDecision => {
  if (!inputs.tabIdDefined) {
    // No tab — nothing to key a durable mirror on.
    return { kind: 'drop', reason: 'no-tabId', clearDurable: false };
  }
  if (!inputs.shapeValid) {
    // Malformed message — don't touch durable state on a shape we can't trust.
    return { kind: 'drop', reason: 'shape-mismatch', clearDurable: false };
  }
  if (!inputs.captureEnabled) {
    // Master switch OFF: suppress and purge any lingering mirror.
    return { kind: 'drop', reason: 'capture-disabled', clearDurable: true };
  }
  if (!inputs.captureAllowedForUrl) {
    // Blocklisted page: suppress and purge any lingering mirror.
    return { kind: 'drop', reason: 'no-capture-blocklist', clearDurable: true };
  }
  return {
    kind: 'emit',
    emitAggregate: inputs.final,
    durableAction: inputs.final ? 'clear' : 'persist',
  };
};
