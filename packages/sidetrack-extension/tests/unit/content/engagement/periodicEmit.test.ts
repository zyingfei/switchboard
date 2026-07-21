import { describe, expect, it } from 'vitest';

import { emptyEngagementTotals, type EngagementTotals } from '../../../../src/content/engagement/aggregator';
import { shouldEmitPeriodicSnapshot } from '../../../../src/content/engagement/periodicEmit';

const totals = (overrides: Partial<EngagementTotals>): EngagementTotals => ({
  ...emptyEngagementTotals(),
  ...overrides,
});

describe('shouldEmitPeriodicSnapshot', () => {
  it('always emits the first snapshot (no prior sent snapshot)', () => {
    expect(shouldEmitPeriodicSnapshot(undefined, totals({ idleMs: 0 }))).toBe(true);
  });

  it('suppresses a snapshot where only idleMs changed', () => {
    const last = totals({ activeMs: 5_000, idleMs: 1_000 });
    const next = totals({ activeMs: 5_000, idleMs: 31_000 });
    expect(shouldEmitPeriodicSnapshot(last, next)).toBe(false);
  });

  it('suppresses when nothing at all changed', () => {
    const same = totals({ activeMs: 5_000, focusedWindowMs: 5_000 });
    expect(shouldEmitPeriodicSnapshot(same, { ...same })).toBe(false);
  });

  it.each<readonly [keyof EngagementTotals, number]>([
    ['activeMs', 1_000],
    ['visibleMs', 1_000],
    ['focusedWindowMs', 1_000],
    ['foregroundBursts', 1],
    ['returnCount', 1],
    ['scrollEvents', 1],
    ['maxScrollRatio', 0.5],
    ['copyCount', 1],
    ['pasteCount', 1],
  ])('emits when the attention dimension %s changes', (dimension, delta) => {
    const last = totals({ activeMs: 100 });
    const next = totals({ activeMs: 100, [dimension]: delta });
    expect(shouldEmitPeriodicSnapshot(last, next)).toBe(true);
  });
});
