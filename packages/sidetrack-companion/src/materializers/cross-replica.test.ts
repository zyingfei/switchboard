import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { edgeIdFor, nodeIdFor } from '../connections/types.js';
import { NAVIGATION_COMMITTED, type NavigationCommittedPayload } from '../navigation/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { buildCrossReplicaEdges } from './cross-replica.js';

interface FixtureObservation {
  readonly replicaId: string;
  readonly seq: number;
  readonly canonicalUrl: string;
  readonly commitAt: string;
}

interface CrossReplicaFixture {
  readonly navigationCommitted: readonly FixtureObservation[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFixtureObservation = (value: unknown): value is FixtureObservation => {
  if (!isRecord(value)) return false;
  return (
    typeof value['replicaId'] === 'string' &&
    value['replicaId'].length > 0 &&
    typeof value['seq'] === 'number' &&
    Number.isInteger(value['seq']) &&
    value['seq'] > 0 &&
    typeof value['canonicalUrl'] === 'string' &&
    value['canonicalUrl'].length > 0 &&
    typeof value['commitAt'] === 'string' &&
    Number.isFinite(Date.parse(value['commitAt']))
  );
};

const isCrossReplicaFixture = (value: unknown): value is CrossReplicaFixture => {
  if (!isRecord(value)) return false;
  const observations = value['navigationCommitted'];
  return Array.isArray(observations) && observations.every(isFixtureObservation);
};

const readFixture = async (): Promise<CrossReplicaFixture> => {
  const raw = await readFile(
    new URL('./__fixtures__/cross-replica-basic.json', import.meta.url),
    'utf8',
  );
  const parsed: unknown = JSON.parse(raw);
  if (!isCrossReplicaFixture(parsed)) {
    throw new Error('cross-replica fixture failed validation');
  }
  return parsed;
};

const timestampMs = (iso: string): number => {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) throw new Error(`invalid test timestamp: ${iso}`);
  return parsed;
};

const navigationPayload = (input: {
  readonly replicaId: string;
  readonly seq: number;
  readonly canonicalUrl: string;
  readonly commitAt: string;
}): NavigationCommittedPayload => {
  const commitTimestamp = timestampMs(input.commitAt);
  return {
    payloadVersion: 1,
    visitId: `visit-${input.replicaId}-${String(input.seq)}`,
    url: input.canonicalUrl,
    canonicalUrl: input.canonicalUrl,
    documentId: `doc-${input.replicaId}-${String(input.seq)}`,
    parentDocumentId: null,
    tabSessionIdHash: `tab-${input.replicaId}`,
    windowSessionIdHash: `window-${input.replicaId}`,
    openerVisitId: null,
    previousVisitId: null,
    navigationSequence: input.seq,
    transitionType: 'link',
    transitionQualifiers: [],
    commitTimestamp,
    dimensions: { provenance: { source: 'test' } },
  };
};

const navigationEvent = (input: {
  readonly replicaId: string;
  readonly seq: number;
  readonly canonicalUrl: string;
  readonly commitAt: string;
}): AcceptedEvent => ({
  clientEventId: `${input.replicaId}:nav-${String(input.seq)}`,
  dot: { replicaId: input.replicaId, seq: input.seq },
  deps: {},
  aggregateId: `navigation:${input.canonicalUrl}`,
  type: NAVIGATION_COMMITTED,
  payload: navigationPayload(input),
  acceptedAtMs: timestampMs(input.commitAt) + input.seq,
});

const eventsFromFixture = (fixture: CrossReplicaFixture): readonly AcceptedEvent[] =>
  fixture.navigationCommitted.map(navigationEvent);

const edgeKey = (edge: {
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly observedAt: string;
}): string => `${edge.fromNodeId}->${edge.toNodeId}@${edge.observedAt}`;

describe('cross-replica materializer', () => {
  it('single replica emits no visit_observed_on_replica edges', () => {
    const edges = buildCrossReplicaEdges([
      navigationEvent({
        replicaId: 'replica-A',
        seq: 1,
        canonicalUrl: 'https://example.com/a',
        commitAt: '2026-05-07T10:00:00.000Z',
      }),
      navigationEvent({
        replicaId: 'replica-A',
        seq: 2,
        canonicalUrl: 'https://example.com/b',
        commitAt: '2026-05-07T10:05:00.000Z',
      }),
    ]);

    expect(edges).toEqual([]);
  });

  it('two replicas observing the same URL emit one observed edge per replica', () => {
    const url = 'https://example.com/x';
    const edges = buildCrossReplicaEdges([
      navigationEvent({
        replicaId: 'replica-A',
        seq: 1,
        canonicalUrl: url,
        commitAt: '2026-05-07T10:00:00.000Z',
      }),
      navigationEvent({
        replicaId: 'replica-B',
        seq: 1,
        canonicalUrl: url,
        commitAt: '2026-05-07T10:10:00.000Z',
      }),
    ]);

    const fromNodeId = nodeIdFor('timeline-visit', url);
    expect(edges).toEqual([
      {
        id: edgeIdFor('visit_observed_on_replica', fromNodeId, nodeIdFor('replica', 'replica-A')),
        kind: 'visit_observed_on_replica',
        fromNodeId,
        toNodeId: nodeIdFor('replica', 'replica-A'),
        observedAt: '2026-05-07T10:00:00.000Z',
        producedBy: { source: 'cross-replica' },
        confidence: 'observed',
      },
      {
        id: edgeIdFor('visit_observed_on_replica', fromNodeId, nodeIdFor('replica', 'replica-B')),
        kind: 'visit_observed_on_replica',
        fromNodeId,
        toNodeId: nodeIdFor('replica', 'replica-B'),
        observedAt: '2026-05-07T10:10:00.000Z',
        producedBy: { source: 'cross-replica' },
        confidence: 'observed',
      },
    ]);
  });

  it('many observations by the same replica collapse to that replica first timestamp', () => {
    const url = 'https://example.com/revisited';
    const edges = buildCrossReplicaEdges([
      navigationEvent({
        replicaId: 'replica-A',
        seq: 3,
        canonicalUrl: url,
        commitAt: '2026-05-07T10:20:00.000Z',
      }),
      navigationEvent({
        replicaId: 'replica-A',
        seq: 1,
        canonicalUrl: url,
        commitAt: '2026-05-07T10:00:00.000Z',
      }),
      navigationEvent({
        replicaId: 'replica-A',
        seq: 2,
        canonicalUrl: url,
        commitAt: '2026-05-07T10:10:00.000Z',
      }),
      navigationEvent({
        replicaId: 'replica-B',
        seq: 1,
        canonicalUrl: url,
        commitAt: '2026-05-07T10:30:00.000Z',
      }),
    ]);

    const replicaAEdge = edges.find((edge) => edge.toNodeId === nodeIdFor('replica', 'replica-A'));
    expect(edges).toHaveLength(2);
    expect(replicaAEdge?.observedAt).toBe('2026-05-07T10:00:00.000Z');
  });

  it('three replicas with partially overlapping URLs emit only shared URL edges', () => {
    const url1 = 'https://example.com/url-1';
    const url2 = 'https://example.com/url-2';
    const url3 = 'https://example.com/url-3';
    const edges = buildCrossReplicaEdges([
      navigationEvent({
        replicaId: 'replica-A',
        seq: 1,
        canonicalUrl: url1,
        commitAt: '2026-05-07T10:00:00.000Z',
      }),
      navigationEvent({
        replicaId: 'replica-A',
        seq: 2,
        canonicalUrl: url2,
        commitAt: '2026-05-07T10:05:00.000Z',
      }),
      navigationEvent({
        replicaId: 'replica-B',
        seq: 1,
        canonicalUrl: url1,
        commitAt: '2026-05-07T10:10:00.000Z',
      }),
      navigationEvent({
        replicaId: 'replica-B',
        seq: 2,
        canonicalUrl: url3,
        commitAt: '2026-05-07T10:15:00.000Z',
      }),
      navigationEvent({
        replicaId: 'replica-C',
        seq: 1,
        canonicalUrl: url2,
        commitAt: '2026-05-07T10:20:00.000Z',
      }),
      navigationEvent({
        replicaId: 'replica-C',
        seq: 2,
        canonicalUrl: url3,
        commitAt: '2026-05-07T10:25:00.000Z',
      }),
    ]);

    expect(edges.map(edgeKey)).toEqual([
      `${nodeIdFor('timeline-visit', url1)}->${nodeIdFor('replica', 'replica-A')}@2026-05-07T10:00:00.000Z`,
      `${nodeIdFor('timeline-visit', url1)}->${nodeIdFor('replica', 'replica-B')}@2026-05-07T10:10:00.000Z`,
      `${nodeIdFor('timeline-visit', url2)}->${nodeIdFor('replica', 'replica-A')}@2026-05-07T10:05:00.000Z`,
      `${nodeIdFor('timeline-visit', url2)}->${nodeIdFor('replica', 'replica-C')}@2026-05-07T10:20:00.000Z`,
      `${nodeIdFor('timeline-visit', url3)}->${nodeIdFor('replica', 'replica-B')}@2026-05-07T10:15:00.000Z`,
      `${nodeIdFor('timeline-visit', url3)}->${nodeIdFor('replica', 'replica-C')}@2026-05-07T10:25:00.000Z`,
    ]);
  });

  it('fixture emits two-replica shared URL evidence and skips unshared URLs', async () => {
    const fixture = await readFixture();
    const edges = buildCrossReplicaEdges(eventsFromFixture(fixture));

    expect(edges).toHaveLength(6);
    expect(edges.every((edge) => edge.kind === 'visit_observed_on_replica')).toBe(true);
    expect(edges.every((edge) => edge.producedBy.source === 'cross-replica')).toBe(true);
    expect(edges.every((edge) => edge.confidence === 'observed')).toBe(true);
    expect(edges.some((edge) => edge.fromNodeId.includes('only-a'))).toBe(false);
    expect(edges.some((edge) => edge.fromNodeId.includes('only-b'))).toBe(false);
  });

  it('is deterministic for repeated and reordered builds', async () => {
    const fixture = await readFixture();
    const events = eventsFromFixture(fixture);
    const first = JSON.stringify(buildCrossReplicaEdges(events));
    const second = JSON.stringify(buildCrossReplicaEdges(events));
    const reversed = JSON.stringify(buildCrossReplicaEdges([...events].reverse()));
    const shuffled = JSON.stringify(
      buildCrossReplicaEdges([
        events[3]!,
        events[0]!,
        events[7]!,
        events[2]!,
        events[1]!,
        events[6]!,
        events[5]!,
        events[4]!,
      ]),
    );

    expect(second).toBe(first);
    expect(reversed).toBe(first);
    expect(shuffled).toBe(first);
  });
});
