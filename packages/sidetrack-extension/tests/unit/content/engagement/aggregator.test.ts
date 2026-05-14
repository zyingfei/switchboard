import { describe, expect, it } from 'vitest';

import {
  createEngagementAggregator,
  emptyEngagementTotals,
  mergeEngagementTotals,
} from '../../../../src/content/engagement/aggregator';

describe('engagement aggregator', () => {
  it('merges running totals additively while keeping maxScrollRatio monotone', () => {
    const merged = mergeEngagementTotals(
      { ...emptyEngagementTotals(), activeMs: 100, maxScrollRatio: 0.7, copyCount: 1 },
      { ...emptyEngagementTotals(), activeMs: 50, maxScrollRatio: 0.2, pasteCount: 2 },
    );
    expect(merged.activeMs).toBe(150);
    expect(merged.maxScrollRatio).toBe(0.7);
    expect(merged.copyCount).toBe(1);
    expect(merged.pasteCount).toBe(2);
  });

  it('tracks visible, focused, idle, scroll, copy, and paste counters without text', () => {
    let now = 1_000;
    const aggregator = createEngagementAggregator({
      visitId: 'visit:one',
      now: () => now,
      visible: true,
      focused: true,
    });
    now = 2_000;
    aggregator.setIdle(true);
    now = 3_000;
    aggregator.setIdle(false);
    aggregator.recordScroll(0.5);
    aggregator.recordCopy();
    aggregator.recordPaste();
    now = 4_000;
    aggregator.setVisible(false);

    const message = aggregator.snapshot(true, 4_500);
    expect(message.visitId).toBe('visit:one');
    expect(message.final).toBe(true);
    expect(message.dimensions.engagement.activeMs).toBe(2_000);
    expect(message.dimensions.engagement.visibleMs).toBe(3_000);
    // Stage 5 follow-up — focusedWindowMs now requires
    // `visible && focused` to accrue, so the 0.5s after setVisible(false)
    // at t=4000 doesn't count toward this tab's focused time. Previously
    // accrued 3500 (the window was focused for that span even though the
    // tab was hidden); 3000 is the corrected value.
    expect(message.dimensions.engagement.focusedWindowMs).toBe(3_000);
    expect(message.dimensions.engagement.idleMs).toBe(1_000);
    expect(message.dimensions.engagement.scrollEvents).toBe(1);
    expect(message.dimensions.engagement.maxScrollRatio).toBe(0.5);
    expect(message.dimensions.engagement.copyCount).toBe(1);
    expect(message.dimensions.engagement.pasteCount).toBe(1);
  });

  it('does not over-count focusedWindowMs while the tab is in the background', () => {
    let now = 0;
    const aggregator = createEngagementAggregator({
      visitId: 'visit:bg',
      now: () => now,
      visible: false,
      focused: true,
    });
    // 5s elapse — window has OS focus the whole time, but THIS tab is
    // not the selected one. Old behavior would accrue 5_000ms here.
    now = 5_000;
    const message = aggregator.snapshot(true, 5_000);
    expect(message.dimensions.engagement.focusedWindowMs).toBe(0);
    expect(message.dimensions.engagement.activeMs).toBe(0);
    expect(message.dimensions.engagement.visibleMs).toBe(0);
  });
});
