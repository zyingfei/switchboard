import { describe, expect, it } from 'vitest';

import { createEngagementCache } from '../../../../src/background/state/engagementCache';
import { emptyEngagementTotals } from '../../../../src/content/engagement/aggregator';

const message = (input: {
  readonly start: number;
  readonly end: number;
  readonly activeMs: number;
  readonly final?: boolean;
}) => ({
  type: 'sidetrack.engagement.interval' as const,
  version: 1 as const,
  visitId: 'visit:one',
  intervalStart: input.start,
  intervalEnd: input.end,
  final: input.final ?? false,
  dimensions: {
    engagement: {
      ...emptyEngagementTotals(),
      activeMs: input.activeMs,
      visibleMs: input.activeMs,
      focusedWindowMs: input.activeMs,
    },
  },
});

describe('engagement cache', () => {
  it('merges per-tab intervals into a session aggregate', () => {
    const cache = createEngagementCache({ sessionId: 'session:edge' });
    cache.mergeInterval(10, message({ start: 1_000, end: 2_000, activeMs: 1_000 }));
    const merged = cache.mergeInterval(
      10,
      message({ start: 2_000, end: 3_000, activeMs: 500, final: true }),
    );
    expect(merged.interval.dimensions.engagement.activeMs).toBe(500);
    expect(merged.aggregate.sessionId).toBe('session:edge');
    expect(merged.aggregate.dimensions.engagement.activeMs).toBe(1_500);
  });

  it('survives a content-script crash by finalizing cached totals on tab removal', () => {
    const cache = createEngagementCache({ sessionId: 'session:edge' });
    cache.mergeInterval(10, message({ start: 1_000, end: 2_000, activeMs: 900 }));
    const finalized = cache.finalizeTab(10, 4_000);
    expect(finalized?.interval.intervalEnd).toBe(4_000);
    expect(finalized?.aggregate.dimensions.engagement.activeMs).toBe(900);
    expect(cache.finalizeTab(10, 5_000)).toBeNull();
  });
});
