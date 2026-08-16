import { describe, expect, it } from 'vitest';

import { NAVIGATION_COMMITTED } from '../navigation/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { BROWSER_TIMELINE_OBSERVED } from '../timeline/events.js';
import { aggregatorObservationsFromEvents } from './learnedAggregatorStatsEvents.js';

const BASE_TIME = Date.parse('2026-05-07T10:00:00.000Z');

const event = (input: {
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
  readonly acceptedAtMs?: number;
}): AcceptedEvent => ({
  clientEventId: `evt-${String(input.seq)}`,
  dot: { replicaId: 'replica-a', seq: input.seq },
  deps: {},
  aggregateId: `agg-${String(input.seq)}`,
  type: input.type,
  payload: input.payload,
  acceptedAtMs: input.acceptedAtMs ?? BASE_TIME + input.seq * 1_000,
});

const navigationPayload = (input: {
  readonly visitId: string;
  readonly canonicalUrl: string;
  readonly openerVisitId?: string | null;
  readonly previousVisitId?: string | null;
  readonly commitTimestamp?: number;
}): unknown => ({
  payloadVersion: 1,
  visitId: input.visitId,
  url: input.canonicalUrl,
  canonicalUrl: input.canonicalUrl,
  documentId: `doc-${input.visitId}`,
  parentDocumentId: null,
  tabSessionIdHash: 'tab-a',
  windowSessionIdHash: 'window-a',
  openerVisitId: input.openerVisitId ?? null,
  previousVisitId: input.previousVisitId ?? null,
  navigationSequence: 1,
  transitionType: 'link',
  transitionQualifiers: [],
  commitTimestamp: input.commitTimestamp ?? BASE_TIME + 3_000,
});

const timelinePayload = (input: {
  readonly url: string;
  readonly title?: string;
  readonly observedAt?: string;
}): unknown => ({
  eventId: `timeline-${input.url}`,
  observedAt: input.observedAt ?? '2026-05-07T10:00:03.000Z',
  url: input.url,
  canonicalUrl: input.url,
  ...(input.title === undefined ? {} : { title: input.title }),
  provider: 'generic',
  transition: 'activated',
  payloadVersion: 1,
});

describe('aggregatorObservationsFromEvents', () => {
  it('resolves an opener visitId to the opener canonical URL when the opener commit precedes it', () => {
    const events: AcceptedEvent[] = [
      event({
        seq: 1,
        type: NAVIGATION_COMMITTED,
        payload: navigationPayload({
          visitId: 'visit-hub',
          canonicalUrl: 'https://hub.test/feed-hub-1',
          commitTimestamp: BASE_TIME,
        }),
      }),
      event({
        seq: 2,
        type: NAVIGATION_COMMITTED,
        payload: navigationPayload({
          visitId: 'visit-leaf',
          canonicalUrl: 'https://hub.test/item-leaf-0',
          openerVisitId: 'visit-hub',
          commitTimestamp: BASE_TIME + 1_000,
        }),
      }),
    ];

    const observations = aggregatorObservationsFromEvents(events);
    expect(observations).toHaveLength(2);
    expect(observations[0]).toMatchObject({
      canonicalUrl: 'https://hub.test/feed-hub-1',
      observedAtMs: BASE_TIME,
    });
    expect(observations[1]).toMatchObject({
      canonicalUrl: 'https://hub.test/item-leaf-0',
      observedAtMs: BASE_TIME + 1_000,
      openerCanonicalUrl: 'https://hub.test/feed-hub-1',
    });
  });

  it('resolves previousVisitId the same way as openerVisitId (navigation-chain edge)', () => {
    const events: AcceptedEvent[] = [
      event({
        seq: 1,
        type: NAVIGATION_COMMITTED,
        payload: navigationPayload({
          visitId: 'visit-a',
          canonicalUrl: 'https://hub.test/a',
          commitTimestamp: BASE_TIME,
        }),
      }),
      event({
        seq: 2,
        type: NAVIGATION_COMMITTED,
        payload: navigationPayload({
          visitId: 'visit-b',
          canonicalUrl: 'https://hub.test/b',
          previousVisitId: 'visit-a',
          commitTimestamp: BASE_TIME + 1_000,
        }),
      }),
    ];

    const observations = aggregatorObservationsFromEvents(events);
    expect(observations[1]).toMatchObject({
      canonicalUrl: 'https://hub.test/b',
      previousCanonicalUrl: 'https://hub.test/a',
    });
  });

  it('yields an edge-less observation (safe under-count, never a false hub signal) when the opener commit is missing from the batch', () => {
    const events: AcceptedEvent[] = [
      event({
        seq: 1,
        type: NAVIGATION_COMMITTED,
        payload: navigationPayload({
          visitId: 'visit-leaf',
          canonicalUrl: 'https://hub.test/item-leaf-0',
          openerVisitId: 'visit-hub-not-in-batch',
          commitTimestamp: BASE_TIME,
        }),
      }),
    ];

    const observations = aggregatorObservationsFromEvents(events);
    expect(observations).toHaveLength(1);
    expect(observations[0]?.openerCanonicalUrl).toBeUndefined();
  });

  it('carries a title from BROWSER_TIMELINE_OBSERVED without an opener/previous edge', () => {
    const events: AcceptedEvent[] = [
      event({
        seq: 1,
        type: BROWSER_TIMELINE_OBSERVED,
        payload: timelinePayload({ url: 'https://hub.test/feed-hub-1', title: 'Front page' }),
      }),
    ];

    const observations = aggregatorObservationsFromEvents(events);
    expect(observations).toEqual([
      { canonicalUrl: 'https://hub.test/feed-hub-1', observedAtMs: Date.parse('2026-05-07T10:00:03.000Z'), title: 'Front page' },
    ]);
  });

  it('normalizes a trailing slash and fragment so the same page folds into one URL key', () => {
    const events: AcceptedEvent[] = [
      event({
        seq: 1,
        type: BROWSER_TIMELINE_OBSERVED,
        payload: timelinePayload({ url: 'https://hub.test/item-leaf-0/#comments', title: 'A' }),
      }),
    ];
    const observations = aggregatorObservationsFromEvents(events);
    expect(observations[0]?.canonicalUrl).toBe('https://hub.test/item-leaf-0');
  });

  it('ignores events of other types and malformed payloads', () => {
    const events: AcceptedEvent[] = [
      event({ seq: 1, type: 'some.other.event', payload: { foo: 'bar' } }),
      event({ seq: 2, type: NAVIGATION_COMMITTED, payload: { not: 'valid' } }),
      event({ seq: 3, type: BROWSER_TIMELINE_OBSERVED, payload: { not: 'valid' } }),
    ];
    expect(aggregatorObservationsFromEvents(events)).toEqual([]);
  });

  it('skips a BROWSER_TIMELINE_OBSERVED with no title (edge-only NAVIGATION_COMMITTED observations still carry no title field)', () => {
    const events: AcceptedEvent[] = [
      event({
        seq: 1,
        type: BROWSER_TIMELINE_OBSERVED,
        payload: timelinePayload({ url: 'https://hub.test/feed-hub-1' }),
      }),
    ];
    const observations = aggregatorObservationsFromEvents(events);
    expect(observations).toHaveLength(1);
    expect(observations[0]?.title).toBeUndefined();
  });
});
