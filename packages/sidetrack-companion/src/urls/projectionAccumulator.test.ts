// Stage 5.2 W2b — URL projection accumulator parity tests.
// Validates that seed + fold produces the same result as the legacy
// sorted-fold projectUrls path, and that the fold is order-independent
// (any permutation of the same event stream produces the same byte
// output once derived).

import { describe, expect, it } from 'vitest';

import { USER_ORGANIZED_ITEM, type UserOrganizedItemPayload } from '../feedback/events.js';
import { BROWSER_TIMELINE_OBSERVED } from '../timeline/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { URL_ATTRIBUTION_INFERRED } from './events.js';
import {
  createEmptyUrlProjectionAccumulator,
  foldEventIntoUrlProjectionAccumulator,
  projectUrls,
  seedUrlProjectionAccumulator,
  urlProjectionFromAccumulator,
} from './projection.js';

const observation = (overrides: {
  seq: number;
  canonicalUrl: string;
  url?: string;
  title?: string;
  provider?: string;
  tabSessionId?: string;
  observedAt?: string;
  acceptedAtMsOffset?: number;
}): AcceptedEvent => ({
  clientEventId: `obs-${String(overrides.seq)}`,
  dot: { replicaId: 'replica-A', seq: overrides.seq },
  deps: {},
  aggregateId: 'agg',
  type: BROWSER_TIMELINE_OBSERVED,
  payload: {
    eventId: `evt-${String(overrides.seq)}`,
    observedAt: overrides.observedAt ?? `2026-05-12T10:00:0${String(overrides.seq)}.000Z`,
    url: overrides.url ?? overrides.canonicalUrl,
    canonicalUrl: overrides.canonicalUrl,
    ...(overrides.title === undefined ? {} : { title: overrides.title }),
    ...(overrides.provider === undefined ? {} : { provider: overrides.provider }),
    ...(overrides.tabSessionId === undefined ? {} : { tabSessionId: overrides.tabSessionId }),
    transition: 'activated',
    payloadVersion: 1,
    dimensions: {},
  },
  acceptedAtMs: 1_700_000_000_000 + (overrides.acceptedAtMsOffset ?? overrides.seq * 1000),
});

const organize = (overrides: {
  seq: number;
  canonicalUrl: string;
  workstreamId: string | null;
}): AcceptedEvent => {
  const payload: UserOrganizedItemPayload = {
    payloadVersion: 1,
    itemKind: 'canonical-url',
    itemId: overrides.canonicalUrl,
    action: 'move',
    toContainer: overrides.workstreamId,
  };
  return {
    clientEventId: `org-${String(overrides.seq)}`,
    dot: { replicaId: 'replica-A', seq: overrides.seq },
    deps: {},
    aggregateId: 'agg',
    type: USER_ORGANIZED_ITEM,
    payload,
    acceptedAtMs: 1_700_000_000_000 + overrides.seq * 1000,
  };
};

const infer = (overrides: {
  seq: number;
  canonicalUrl: string;
  workstreamId: string;
}): AcceptedEvent => ({
  clientEventId: `inf-${String(overrides.seq)}`,
  dot: { replicaId: 'replica-A', seq: overrides.seq },
  deps: {},
  aggregateId: 'agg',
  type: URL_ATTRIBUTION_INFERRED,
  payload: {
    payloadVersion: 1,
    canonicalUrl: overrides.canonicalUrl,
    workstreamId: overrides.workstreamId,
    confidence: 'inferred' as const,
    evidence: [],
  },
  acceptedAtMs: 1_700_000_000_000 + overrides.seq * 1000,
});

const serializeProjection = (projection: ReturnType<typeof projectUrls>): string =>
  JSON.stringify({
    schemaVersion: projection.schemaVersion,
    byCanonicalUrl: [...projection.byCanonicalUrl.entries()].map(([k, v]) => [
      k,
      { ...v, tabSessionIds: [...v.tabSessionIds] },
    ]),
  });

describe('Stage 5.2 W2b — URL projection accumulator', () => {
  it('seed → derive matches one-shot projectUrls for the basic flow', () => {
    const events = [
      observation({ seq: 1, canonicalUrl: 'https://example.com/a', title: 'A' }),
      observation({
        seq: 2,
        canonicalUrl: 'https://example.com/a',
        title: 'A',
        tabSessionId: 'tses_x',
      }),
      organize({ seq: 3, canonicalUrl: 'https://example.com/a', workstreamId: 'ws_x' }),
      observation({ seq: 4, canonicalUrl: 'https://example.com/b', title: 'B' }),
      infer({ seq: 5, canonicalUrl: 'https://example.com/b', workstreamId: 'ws_y' }),
    ];
    const oneShot = projectUrls(events);
    const viaAcc = urlProjectionFromAccumulator(seedUrlProjectionAccumulator(events));
    expect(serializeProjection(viaAcc)).toBe(serializeProjection(oneShot));
  });

  it('per-event fold is order-independent for observation events', () => {
    const observations = [
      observation({
        seq: 1,
        canonicalUrl: 'https://example.com/a',
        url: 'https://example.com/a?v=1',
        title: 'Title-1',
        provider: 'chatgpt',
      }),
      observation({
        seq: 2,
        canonicalUrl: 'https://example.com/a',
        url: 'https://example.com/a?v=2',
        title: 'Title-2',
      }),
      observation({
        seq: 3,
        canonicalUrl: 'https://example.com/a',
        url: 'https://example.com/a?v=3',
      }),
    ];

    const forwardAcc = createEmptyUrlProjectionAccumulator();
    for (const event of observations) foldEventIntoUrlProjectionAccumulator(forwardAcc, event);
    const reverseAcc = createEmptyUrlProjectionAccumulator();
    for (const event of [...observations].reverse())
      foldEventIntoUrlProjectionAccumulator(reverseAcc, event);

    const forward = urlProjectionFromAccumulator(forwardAcc);
    const reverse = urlProjectionFromAccumulator(reverseAcc);
    expect(serializeProjection(reverse)).toBe(serializeProjection(forward));

    const record = forward.byCanonicalUrl.get('https://example.com/a');
    // visitCount = 3, latest event (seq=3) wins for latestUrl; older
    // events backfill provider (only seq=1 had it).
    expect(record?.visitCount).toBe(3);
    expect(record?.latestUrl).toBe('https://example.com/a?v=3');
    expect(record?.latestTitle).toBe('Title-2'); // seq=3 had no title → seq=2 wins
    expect(record?.provider).toBe('chatgpt');
  });

  it('out-of-order fold preserves user_asserted > inferred precedence', () => {
    const inferEvt = infer({
      seq: 1,
      canonicalUrl: 'https://example.com/a',
      workstreamId: 'ws_inferred',
    });
    const organizeEvt = organize({
      seq: 2,
      canonicalUrl: 'https://example.com/a',
      workstreamId: 'ws_user',
    });

    const acc = createEmptyUrlProjectionAccumulator();
    // Fold the user-asserted event FIRST, then the inferred one.
    // The current attribution must still be the user-asserted one
    // because compareAttribution prefers user_asserted regardless of order.
    foldEventIntoUrlProjectionAccumulator(acc, organizeEvt);
    foldEventIntoUrlProjectionAccumulator(acc, inferEvt);
    const record = urlProjectionFromAccumulator(acc).byCanonicalUrl.get('https://example.com/a');
    expect(record?.currentAttribution?.source).toBe('user_asserted');
    expect(record?.currentAttribution?.workstreamId).toBe('ws_user');
  });

  it('multiple tab-session ids accumulate into the sorted tabSessionIds list', () => {
    const events = [
      observation({
        seq: 1,
        canonicalUrl: 'https://example.com/a',
        tabSessionId: 'tses_b',
      }),
      observation({
        seq: 2,
        canonicalUrl: 'https://example.com/a',
        tabSessionId: 'tses_a',
      }),
      observation({
        seq: 3,
        canonicalUrl: 'https://example.com/a',
        tabSessionId: 'tses_b', // dedupe
      }),
    ];
    const record = projectUrls(events).byCanonicalUrl.get('https://example.com/a');
    expect(record?.tabSessionIds).toEqual(['tses_a', 'tses_b']);
  });

  it('non-URL events are no-ops in fold', () => {
    const acc = createEmptyUrlProjectionAccumulator();
    foldEventIntoUrlProjectionAccumulator(acc, {
      clientEventId: 'unrelated-1',
      dot: { replicaId: 'replica-A', seq: 1 },
      deps: {},
      aggregateId: 'agg',
      type: 'unrelated.event',
      payload: {},
      acceptedAtMs: 1_700_000_000_000,
    });
    expect(acc.records.size).toBe(0);
    expect(acc.observationCursors.size).toBe(0);
  });
});
