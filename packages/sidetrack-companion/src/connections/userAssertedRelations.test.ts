import { describe, expect, it } from 'vitest';

import { createEmptyTabSessionProjection } from '../tabsession/projection.js';
import type {
  TabSessionAttribution,
  TabSessionProjection,
  TabSessionRecord,
} from '../tabsession/projection.js';
import type { UrlAttribution, UrlProjection, UrlVisitRecord } from '../urls/projection.js';

import { buildTopicRevision } from './topicClusterer.js';
import {
  deriveUserAssertedRelations,
  knownCanonicalUrlsFor,
} from './userAssertedRelations.js';
import type { TopicVisit } from './topicClusterer.js';

const TIMESTAMP = '2026-05-10T10:00:00.000Z';

const userAssertion = (
  workstreamId: string | null,
  overrides: Partial<UrlAttribution> = {},
): UrlAttribution => ({
  workstreamId,
  source: 'user_asserted',
  observedAt: TIMESTAMP,
  clientEventId: 'evt-1',
  replicaId: 'rep-1',
  seq: 1,
  ...overrides,
});

const inferredAttribution = (workstreamId: string | null): UrlAttribution => ({
  workstreamId,
  source: 'inferred',
  observedAt: TIMESTAMP,
  clientEventId: 'evt-inf-1',
  replicaId: 'rep-1',
  seq: 2,
});

const urlRecord = (
  canonicalUrl: string,
  overrides: Partial<UrlVisitRecord> = {},
): UrlVisitRecord => ({
  canonicalUrl,
  firstSeenAt: TIMESTAMP,
  lastSeenAt: TIMESTAMP,
  visitCount: 1,
  tabSessionIds: [],
  attributionHistory: [],
  ...overrides,
});

const urlProjection = (records: readonly UrlVisitRecord[]): UrlProjection => ({
  schemaVersion: 1,
  byCanonicalUrl: new Map(records.map((r) => [r.canonicalUrl, r])),
});

const tabSessionUserAssertion = (
  workstreamId: string | null,
): TabSessionAttribution => ({
  workstreamId,
  source: 'user_asserted',
  observedAt: TIMESTAMP,
  clientEventId: 'evt-1',
  replicaId: 'rep-1',
  seq: 1,
});

const tabSessionRecord = (
  tabSessionId: string,
  overrides: Partial<TabSessionRecord> = {},
): TabSessionRecord => ({
  tabSessionId,
  openedAt: TIMESTAMP,
  lastActivityAt: TIMESTAMP,
  attributionHistory: [],
  ...overrides,
});

const tabSessionProjection = (
  records: readonly TabSessionRecord[],
): TabSessionProjection => ({
  schemaVersion: 1,
  bySessionId: new Map(records.map((r) => [r.tabSessionId, r])),
  openSessionsByTabId: new Map(),
});

const topicVisit = (canonicalUrl: string): TopicVisit => ({
  canonicalUrl,
  focusedWindowMs: 10_000,
  firstObservedAt: TIMESTAMP,
  lastObservedAt: TIMESTAMP,
});

describe('deriveUserAssertedRelations', () => {
  it('emits pairwise in_workstream relations for user-asserted canonical-URL attributions', () => {
    const projection = urlProjection([
      urlRecord('https://example.test/a', { currentAttribution: userAssertion('ws-1') }),
      urlRecord('https://example.test/b', { currentAttribution: userAssertion('ws-1') }),
      urlRecord('https://example.test/c', { currentAttribution: userAssertion('ws-2') }),
    ]);
    const relations = deriveUserAssertedRelations({
      urlProjection: projection,
      tabSessionProjection: createEmptyTabSessionProjection(),
      knownCanonicalUrls: new Set([
        'https://example.test/a',
        'https://example.test/b',
        'https://example.test/c',
      ]),
    });
    // ws-1 contributes 1 pair (a,b); ws-2 has only one URL so no pairs.
    expect(relations).toEqual([
      {
        kind: 'in_workstream',
        fromVisitKey: 'https://example.test/a',
        toVisitKey: 'https://example.test/b',
      },
    ]);
  });

  it('emits Cartesian in_workstream pairs for 3+ URLs in the same workstream', () => {
    const projection = urlProjection([
      urlRecord('https://example.test/a', { currentAttribution: userAssertion('ws-1') }),
      urlRecord('https://example.test/b', { currentAttribution: userAssertion('ws-1') }),
      urlRecord('https://example.test/c', { currentAttribution: userAssertion('ws-1') }),
    ]);
    const relations = deriveUserAssertedRelations({
      urlProjection: projection,
      tabSessionProjection: createEmptyTabSessionProjection(),
      knownCanonicalUrls: new Set([
        'https://example.test/a',
        'https://example.test/b',
        'https://example.test/c',
      ]),
    });
    // 3 URLs → 3 pairs.
    expect(relations).toHaveLength(3);
    expect(new Set(relations.map((r) => `${r.fromVisitKey}|${r.toVisitKey}`))).toEqual(
      new Set([
        'https://example.test/a|https://example.test/b',
        'https://example.test/a|https://example.test/c',
        'https://example.test/b|https://example.test/c',
      ]),
    );
  });

  it('drops inferred attributions, keeping only user_asserted', () => {
    const projection = urlProjection([
      urlRecord('https://example.test/a', { currentAttribution: userAssertion('ws-1') }),
      urlRecord('https://example.test/b', { currentAttribution: inferredAttribution('ws-1') }),
    ]);
    const relations = deriveUserAssertedRelations({
      urlProjection: projection,
      tabSessionProjection: createEmptyTabSessionProjection(),
      knownCanonicalUrls: new Set([
        'https://example.test/a',
        'https://example.test/b',
      ]),
    });
    // Only one user-asserted URL in ws-1 → no pairs.
    expect(relations).toEqual([]);
  });

  it('drops URLs absent from the known canonical-URL set', () => {
    const projection = urlProjection([
      urlRecord('https://example.test/a', { currentAttribution: userAssertion('ws-1') }),
      urlRecord('https://example.test/b', { currentAttribution: userAssertion('ws-1') }),
      urlRecord('https://example.test/c', { currentAttribution: userAssertion('ws-1') }),
    ]);
    const relations = deriveUserAssertedRelations({
      urlProjection: projection,
      tabSessionProjection: createEmptyTabSessionProjection(),
      // Only 'a' and 'b' show up in the timeline projection this run.
      knownCanonicalUrls: new Set(['https://example.test/a', 'https://example.test/b']),
    });
    expect(relations).toHaveLength(1);
    expect(relations[0]).toMatchObject({
      fromVisitKey: 'https://example.test/a',
      toVisitKey: 'https://example.test/b',
    });
  });

  it('merges URLs from user-asserted tab sessions into the same workstream group', () => {
    const projection = urlProjection([
      urlRecord('https://example.test/page-a', {
        tabSessionIds: ['tses-1'],
      }),
      urlRecord('https://example.test/page-b', {
        tabSessionIds: ['tses-1'],
      }),
      urlRecord('https://example.test/explicit-c', {
        currentAttribution: userAssertion('ws-1'),
      }),
    ]);
    const tabSessions = tabSessionProjection([
      tabSessionRecord('tses-1', {
        currentAttribution: tabSessionUserAssertion('ws-1'),
      }),
    ]);
    const relations = deriveUserAssertedRelations({
      urlProjection: projection,
      tabSessionProjection: tabSessions,
      knownCanonicalUrls: new Set([
        'https://example.test/page-a',
        'https://example.test/page-b',
        'https://example.test/explicit-c',
      ]),
    });
    // All 3 URLs end up in ws-1 → 3 pairs.
    expect(relations).toHaveLength(3);
  });

  it('drops inferred tab-session attributions', () => {
    const projection = urlProjection([
      urlRecord('https://example.test/x', { tabSessionIds: ['tses-inf'] }),
      urlRecord('https://example.test/y', { tabSessionIds: ['tses-inf'] }),
    ]);
    const tabSessions = tabSessionProjection([
      tabSessionRecord('tses-inf', {
        currentAttribution: {
          ...tabSessionUserAssertion('ws-2'),
          source: 'inferred',
        },
      }),
    ]);
    const relations = deriveUserAssertedRelations({
      urlProjection: projection,
      tabSessionProjection: tabSessions,
      knownCanonicalUrls: new Set([
        'https://example.test/x',
        'https://example.test/y',
      ]),
    });
    expect(relations).toEqual([]);
  });

  it('produces empty output when no user assertions exist', () => {
    const projection = urlProjection([
      urlRecord('https://example.test/a', { currentAttribution: inferredAttribution('ws-1') }),
      urlRecord('https://example.test/b'),
    ]);
    const relations = deriveUserAssertedRelations({
      urlProjection: projection,
      tabSessionProjection: createEmptyTabSessionProjection(),
      knownCanonicalUrls: new Set(['https://example.test/a', 'https://example.test/b']),
    });
    expect(relations).toEqual([]);
  });
});

describe('topic clusterer + user-asserted relations', () => {
  it('forms topics from user assertions alone when similarity is empty', async () => {
    const visits: readonly TopicVisit[] = [
      topicVisit('https://example.test/a'),
      topicVisit('https://example.test/b'),
      topicVisit('https://example.test/c'),
      topicVisit('https://example.test/d'),
    ];
    const projection = urlProjection([
      urlRecord('https://example.test/a', { currentAttribution: userAssertion('ws-1') }),
      urlRecord('https://example.test/b', { currentAttribution: userAssertion('ws-1') }),
      urlRecord('https://example.test/c', { currentAttribution: userAssertion('ws-1') }),
      // d is unattributed
      urlRecord('https://example.test/d'),
    ]);
    const userAssertedRelations = deriveUserAssertedRelations({
      urlProjection: projection,
      tabSessionProjection: createEmptyTabSessionProjection(),
      knownCanonicalUrls: knownCanonicalUrlsFor(visits),
    });
    const revision = await buildTopicRevision({
      visits,
      visitSimilarity: {
        revisionId: 'sim-empty',
        edges: [],
      },
      userAssertedRelations,
    });
    expect(revision.topics).toHaveLength(1);
    expect(revision.topics[0]?.memberCanonicalUrls).toEqual([
      'https://example.test/a',
      'https://example.test/b',
      'https://example.test/c',
    ]);
  });
});
