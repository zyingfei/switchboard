import { describe, expect, it } from 'vitest';

import { ENGAGEMENT_SESSION_AGGREGATED } from '../engagement/events.js';
import { NAVIGATION_COMMITTED } from '../navigation/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import type { TimelineDayProjection } from '../timeline/projection.js';
import {
  buildEngagementClassifierInputs,
  createEmptyEngagementAccumulator,
  engagementClassifierInputsFromAccumulator,
  foldEventIntoEngagementAccumulator,
  seedEngagementAccumulator,
} from './engagement-class-revision.js';

const buildEvent = (input: {
  seq: number;
  type: string;
  payload: unknown;
  replicaId?: string;
}): AcceptedEvent => ({
  clientEventId: `evt-${String(input.seq)}`,
  dot: { replicaId: input.replicaId ?? 'replica-A', seq: input.seq },
  deps: {},
  aggregateId: 'agg',
  type: input.type,
  payload: input.payload,
  acceptedAtMs: 1_700_000_000_000 + input.seq * 1000,
});

const engagementEvent = (overrides: {
  seq: number;
  visitId: string;
  sessionId: string;
  activeMs?: number;
  focusedWindowMs?: number;
}) =>
  buildEvent({
    seq: overrides.seq,
    type: ENGAGEMENT_SESSION_AGGREGATED,
    payload: {
      payloadVersion: 1,
      visitId: overrides.visitId,
      sessionId: overrides.sessionId,
      dimensions: {
        engagement: {
          activeMs: overrides.activeMs ?? 1000,
          visibleMs: overrides.activeMs ?? 1000,
          focusedWindowMs: overrides.focusedWindowMs ?? overrides.activeMs ?? 1000,
          idleMs: 0,
          foregroundBursts: 1,
          returnCount: 0,
          scrollEvents: 0,
          maxScrollRatio: 0,
          copyCount: 0,
          pasteCount: 0,
        },
      },
    },
  });

const navigationEvent = (overrides: { seq: number; visitId: string; canonicalUrl: string }) =>
  buildEvent({
    seq: overrides.seq,
    type: NAVIGATION_COMMITTED,
    payload: {
      payloadVersion: 1,
      visitId: overrides.visitId,
      canonicalUrl: overrides.canonicalUrl,
      url: overrides.canonicalUrl,
      documentId: `doc-${overrides.visitId}`,
      tabSessionIdHash: `tab-${overrides.visitId}`,
      windowSessionIdHash: `win-${overrides.visitId}`,
      parentDocumentId: null,
      openerVisitId: null,
      previousVisitId: null,
      navigationSequence: 1,
      commitTimestamp: 1_700_000_000_000 + overrides.seq * 1000,
      transitionType: 'link',
      transitionQualifiers: [],
      dimensions: {},
    },
  });

const emptyTimelineDays: readonly TimelineDayProjection[] = [];

describe('Stage 5.2 W2a — engagement accumulator', () => {
  it('seed produces identical inputs to the one-shot buildEngagementClassifierInputs', () => {
    const events = [
      navigationEvent({ seq: 1, visitId: 'v1', canonicalUrl: 'https://example.com/a' }),
      navigationEvent({ seq: 2, visitId: 'v2', canonicalUrl: 'https://example.com/b' }),
      engagementEvent({ seq: 3, visitId: 'v1', sessionId: 's1', activeMs: 5000 }),
      engagementEvent({ seq: 4, visitId: 'v2', sessionId: 's1', activeMs: 3000 }),
    ];

    const oneShot = buildEngagementClassifierInputs(events, emptyTimelineDays);
    const viaSeed = engagementClassifierInputsFromAccumulator(
      seedEngagementAccumulator(events, emptyTimelineDays),
    );
    expect(viaSeed).toEqual(oneShot);
  });

  it('fold one engagement event at a time yields the same inputs as one-shot', () => {
    const events = [
      navigationEvent({ seq: 1, visitId: 'v1', canonicalUrl: 'https://example.com/a' }),
      navigationEvent({ seq: 2, visitId: 'v2', canonicalUrl: 'https://example.com/b' }),
      engagementEvent({ seq: 3, visitId: 'v1', sessionId: 's1', activeMs: 5000 }),
      engagementEvent({ seq: 4, visitId: 'v2', sessionId: 's1', activeMs: 3000 }),
      engagementEvent({ seq: 5, visitId: 'v1', sessionId: 's2', activeMs: 2000 }),
    ];
    const acc = createEmptyEngagementAccumulator();
    for (const event of events) {
      foldEventIntoEngagementAccumulator(acc, event);
    }
    const streamed = engagementClassifierInputsFromAccumulator(acc);
    const oneShot = buildEngagementClassifierInputs(events, emptyTimelineDays);
    expect(streamed).toEqual(oneShot);
  });

  it('seed then incremental fold equals one-shot over the union of events', () => {
    const initial = [
      navigationEvent({ seq: 1, visitId: 'v1', canonicalUrl: 'https://example.com/a' }),
      engagementEvent({ seq: 2, visitId: 'v1', sessionId: 's1', activeMs: 1000 }),
    ];
    const extra = [
      navigationEvent({ seq: 3, visitId: 'v2', canonicalUrl: 'https://example.com/b' }),
      engagementEvent({ seq: 4, visitId: 'v2', sessionId: 's1', activeMs: 2000 }),
      engagementEvent({ seq: 5, visitId: 'v1', sessionId: 's1', activeMs: 7000 }),
    ];
    const acc = seedEngagementAccumulator(initial, emptyTimelineDays);
    for (const event of extra) foldEventIntoEngagementAccumulator(acc, event);
    const streamed = engagementClassifierInputsFromAccumulator(acc);
    const oneShot = buildEngagementClassifierInputs([...initial, ...extra], emptyTimelineDays);
    expect(streamed).toEqual(oneShot);
  });

  it('sums repeated final aggregates for the same visit even when the session id is reused', () => {
    const events = [
      engagementEvent({ seq: 1, visitId: 'v1', sessionId: 's1', activeMs: 100 }),
      engagementEvent({ seq: 2, visitId: 'v1', sessionId: 's1', activeMs: 999 }),
    ];
    const acc = createEmptyEngagementAccumulator();
    for (const event of events) foldEventIntoEngagementAccumulator(acc, event);
    const inputs = engagementClassifierInputsFromAccumulator(acc);
    expect(inputs[0]?.engagement.activeMs).toBe(1_099);
  });

  it('does not let a short later aggregate erase earlier topic-gate focus', () => {
    const events = [
      engagementEvent({
        seq: 1,
        visitId: 'visit:https://example.com/reference',
        sessionId: 'session:edge',
        activeMs: 186_770,
        focusedWindowMs: 186_770,
      }),
      engagementEvent({
        seq: 2,
        visitId: 'visit:https://example.com/reference',
        sessionId: 'session:edge',
        activeMs: 1_908,
        focusedWindowMs: 1_908,
      }),
    ];
    const acc = createEmptyEngagementAccumulator();
    for (const event of events) foldEventIntoEngagementAccumulator(acc, event);
    const inputs = engagementClassifierInputsFromAccumulator(acc);
    expect(inputs[0]?.engagement.focusedWindowMs).toBe(188_678);
  });

  it('out-of-order folds still sum accepted aggregates deterministically', () => {
    const earlier = engagementEvent({ seq: 1, visitId: 'v1', sessionId: 's1', activeMs: 100 });
    const later = engagementEvent({ seq: 2, visitId: 'v1', sessionId: 's1', activeMs: 999 });
    const acc = createEmptyEngagementAccumulator();
    // Fold the later event first, then the earlier one. Derivation
    // should not depend on event-arrival order.
    foldEventIntoEngagementAccumulator(acc, later);
    foldEventIntoEngagementAccumulator(acc, earlier);
    const inputs = engagementClassifierInputsFromAccumulator(acc);
    expect(inputs[0]?.engagement.activeMs).toBe(1_099);
  });

  it('non-engagement, non-navigation events are no-ops in fold', () => {
    const acc = createEmptyEngagementAccumulator();
    foldEventIntoEngagementAccumulator(
      acc,
      buildEvent({ seq: 1, type: 'unrelated.event', payload: {} }),
    );
    expect(acc.latestByVisitSession.size).toBe(0);
    expect(acc.canonicalUrlByVisitId.size).toBe(0);
  });

  it('fold updates canonicalUrlByVisitId from navigation events', () => {
    const acc = createEmptyEngagementAccumulator();
    foldEventIntoEngagementAccumulator(
      acc,
      navigationEvent({ seq: 1, visitId: 'v1', canonicalUrl: 'https://example.com/a' }),
    );
    expect(acc.canonicalUrlByVisitId.get('v1')).toBe('https://example.com/a');
  });
});
