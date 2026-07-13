import { describe, expect, it } from 'vitest';

import { resolveEngagementEmission } from '../../../../src/background/state/engagementEmission';

const base = {
  tabIdDefined: true,
  shapeValid: true,
  captureEnabled: true,
  captureAllowedForUrl: true,
  final: false,
} as const;

describe('resolveEngagementEmission', () => {
  it('emits interval only for a non-final, allowed interval and persists the mirror', () => {
    const decision = resolveEngagementEmission({ ...base, final: false });
    expect(decision).toEqual({ kind: 'emit', emitAggregate: false, durableAction: 'persist' });
  });

  it('emits interval + aggregate for a final, allowed interval and clears the mirror', () => {
    const decision = resolveEngagementEmission({ ...base, final: true });
    expect(decision).toEqual({ kind: 'emit', emitAggregate: true, durableAction: 'clear' });
  });

  it('drops (nothing emitted) when the master capture switch is off, and purges the mirror', () => {
    const decision = resolveEngagementEmission({ ...base, captureEnabled: false, final: true });
    expect(decision).toEqual({ kind: 'drop', reason: 'capture-disabled', clearDurable: true });
  });

  it('drops (nothing emitted) for a blocklisted URL, and purges the mirror', () => {
    const decision = resolveEngagementEmission({
      ...base,
      captureAllowedForUrl: false,
      final: true,
    });
    expect(decision).toEqual({ kind: 'drop', reason: 'no-capture-blocklist', clearDurable: true });
  });

  it('drops a malformed message without touching durable state', () => {
    const decision = resolveEngagementEmission({ ...base, shapeValid: false });
    expect(decision).toEqual({ kind: 'drop', reason: 'shape-mismatch', clearDurable: false });
  });

  it('drops a tab-less message without touching durable state', () => {
    const decision = resolveEngagementEmission({ ...base, tabIdDefined: false });
    expect(decision).toEqual({ kind: 'drop', reason: 'no-tabId', clearDurable: false });
  });

  it('a blocked FINAL interval never emits an aggregate — the privacy invariant', () => {
    // Regression guard: even a final interval (which normally produces the
    // session.aggregated event) must be fully suppressed on a paused or
    // blocked page.
    for (const paused of [
      { captureEnabled: false },
      { captureAllowedForUrl: false },
    ] as const) {
      const decision = resolveEngagementEmission({ ...base, ...paused, final: true });
      expect(decision.kind).toBe('drop');
    }
  });
});
