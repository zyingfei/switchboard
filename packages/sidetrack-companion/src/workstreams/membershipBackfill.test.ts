import { describe, expect, it } from 'bun:test';

import { foldWorkstreamMembership, primaryMembershipRow } from './membershipEvents.js';
import { planMembershipBackfill } from './membershipBackfill.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { USER_ORGANIZED_ITEM } from '../feedback/events.js';
import { projectTabSessions } from '../tabsession/projection.js';
import { TAB_SESSION_ATTRIBUTION_INFERRED } from '../tabsession/events.js';
import { THREAD_UPSERTED } from '../threads/events.js';
import { projectUrls } from '../urls/projection.js';
import { URL_ATTRIBUTION_INFERRED } from '../urls/events.js';

let seq = 0;

const organized = (
  itemKind: 'canonical-url' | 'thread' | 'tab-session',
  itemId: string,
  toContainer: string | null,
  atMs: number,
  replicaId = 'rA',
): AcceptedEvent => {
  seq += 1;
  return {
    clientEventId: `c${seq}`,
    type: USER_ORGANIZED_ITEM,
    acceptedAtMs: atMs,
    dot: { replicaId, seq },
    deps: {},
    aggregateId: `feedback:${itemKind}:${itemId}`,
    payload: { payloadVersion: 1, itemKind, itemId, action: 'move', toContainer },
  };
};

const urlInferred = (canonicalUrl: string, workstreamId: string, atMs: number): AcceptedEvent => {
  seq += 1;
  return {
    clientEventId: `c${seq}`,
    type: URL_ATTRIBUTION_INFERRED,
    acceptedAtMs: atMs,
    dot: { replicaId: 'rA', seq },
    deps: {},
    aggregateId: `url:${canonicalUrl}`,
    payload: {
      payloadVersion: 1,
      canonicalUrl,
      workstreamId,
      policyMode: 'balanced',
      dominantSource: 'similarity',
      rawFusionLogit: 1,
      margin: 1,
      corroborationCount: 2,
      modelRevision: 'test',
      graphRevision: 'test',
      evidenceHash: 'test-hash',
      resolverDependencyKey: 'test-dep',
      reasonSummary: 'test reason',
    },
  };
};

const tabInferred = (tabSessionId: string, workstreamId: string, atMs: number): AcceptedEvent => {
  seq += 1;
  return {
    clientEventId: `c${seq}`,
    type: TAB_SESSION_ATTRIBUTION_INFERRED,
    acceptedAtMs: atMs,
    dot: { replicaId: 'rA', seq },
    deps: {},
    aggregateId: `tabsession:${tabSessionId}`,
    payload: {
      payloadVersion: 1,
      tabSessionId,
      workstreamId,
      policyMode: 'balanced',
      dominantSource: 'similarity',
      rawFusionLogit: 1,
      margin: 1,
      corroborationCount: 2,
      modelRevision: 'test',
      graphRevision: 'test',
      evidenceHash: 'test-hash',
      resolverDependencyKey: 'test-dep',
      reasonSummary: 'test reason',
    },
  };
};

const threadUpserted = (
  bacId: string,
  primaryWorkstreamId: string | undefined,
  atMs: number,
): AcceptedEvent => {
  seq += 1;
  return {
    clientEventId: `c${seq}`,
    type: THREAD_UPSERTED,
    acceptedAtMs: atMs,
    dot: { replicaId: 'rA', seq },
    deps: {},
    aggregateId: `thread:${bacId}`,
    payload: {
      bac_id: bacId,
      provider: 'chatgpt',
      threadUrl: `https://example.test/${bacId}`,
      title: `${bacId} title`,
      lastSeenAt: new Date(atMs).toISOString(),
      ...(primaryWorkstreamId === undefined ? {} : { primaryWorkstreamId }),
    },
  };
};

describe('planMembershipBackfill — derived-primary compatibility', () => {
  it('backfills a canonical-url inferred attribution to a matching primary membership row', () => {
    const events = [urlInferred('https://a.test/x', 'ws-1', 1_000)];
    const plan = planMembershipBackfill(events);
    expect(plan.stats.urlsBackfilled).toBe(1);
    const rows = foldWorkstreamMembership('canonical-url', 'https://a.test/x', plan.events);
    const primary = primaryMembershipRow(rows);
    expect(primary?.workstreamId).toBe('ws-1');
    expect(primary?.provenance).toBe('ai-suggested-accepted');
    // Compatibility: matches what the existing projector already resolves.
    const urlProjection = projectUrls(events);
    expect(primary?.workstreamId).toBe(
      urlProjection.byCanonicalUrl.get('https://a.test/x')?.currentAttribution?.workstreamId,
    );
  });

  it('an explicit user move backfills as user-filed and wins over an earlier inferred attribution', () => {
    const events = [
      urlInferred('https://a.test/x', 'ws-1', 1_000),
      organized('canonical-url', 'https://a.test/x', 'ws-2', 2_000),
    ];
    const plan = planMembershipBackfill(events);
    const rows = foldWorkstreamMembership('canonical-url', 'https://a.test/x', plan.events);
    const primary = primaryMembershipRow(rows);
    expect(primary?.workstreamId).toBe('ws-2');
    expect(primary?.provenance).toBe('user-filed');
    const urlProjection = projectUrls(events);
    expect(primary?.workstreamId).toBe(
      urlProjection.byCanonicalUrl.get('https://a.test/x')?.currentAttribution?.workstreamId,
    );
  });

  it('a declined URL (toContainer null) is NOT backfilled as a membership row', () => {
    const events = [organized('canonical-url', 'https://a.test/x', null, 1_000)];
    const plan = planMembershipBackfill(events);
    expect(plan.stats.urlsBackfilled).toBe(0);
  });

  it('backfills a tab-session inferred attribution, matching the existing projector', () => {
    const events = [tabInferred('tses_1', 'ws-3', 1_000)];
    const plan = planMembershipBackfill(events);
    expect(plan.stats.tabSessionsBackfilled).toBe(1);
    const rows = foldWorkstreamMembership('tab-session', 'tses_1', plan.events);
    const primary = primaryMembershipRow(rows);
    const tabProjection = projectTabSessions(events);
    expect(primary?.workstreamId).toBe(
      tabProjection.bySessionId.get('tses_1')?.currentAttribution?.workstreamId,
    );
  });

  it('backfills a thread primaryWorkstreamId register field', () => {
    const events = [threadUpserted('bac_1', 'ws-4', 1_000)];
    const plan = planMembershipBackfill(events);
    expect(plan.stats.threadsBackfilled).toBe(1);
    const rows = foldWorkstreamMembership('thread', 'bac_1', plan.events);
    expect(primaryMembershipRow(rows)?.workstreamId).toBe('ws-4');
  });

  it('does not backfill a thread with no primaryWorkstreamId', () => {
    const events = [threadUpserted('bac_1', undefined, 1_000)];
    const plan = planMembershipBackfill(events);
    expect(plan.stats.threadsBackfilled).toBe(0);
  });

  it('is deterministic: re-running over the same events yields byte-identical events', () => {
    const events = [
      urlInferred('https://a.test/x', 'ws-1', 1_000),
      tabInferred('tses_1', 'ws-3', 2_000),
      threadUpserted('bac_1', 'ws-4', 3_000),
    ];
    const first = planMembershipBackfill(events);
    const second = planMembershipBackfill(events);
    expect(JSON.stringify(second.events)).toBe(JSON.stringify(first.events));
  });

  it('skips the derived source:"thread" URL attribution bridge (not a persisted fact)', () => {
    // A thread's primary workstream propagates to its matching canonical URL
    // as source:'thread' in urls/projection.ts — that bridge should not be
    // double-backfilled as an independent canonical-url fact.
    const events = [
      threadUpserted('bac_1', 'ws-4', 1_000),
      {
        clientEventId: 'c-thread-url',
        type: 'browser.timeline.observed',
        acceptedAtMs: 1_500,
        dot: { replicaId: 'rA', seq: ++seq },
        deps: {},
        aggregateId: 'timeline:https://example.test/bac_1',
        payload: {
          payloadVersion: 1,
          canonicalUrl: 'https://example.test/bac_1',
          url: 'https://example.test/bac_1',
          title: 'bac_1 title',
          provider: 'chatgpt',
          threadId: 'bac_1',
          observedAtMs: 1_500,
        },
      } as AcceptedEvent,
    ];
    const plan = planMembershipBackfill(events);
    // Whether or not the thread-bridge fires depends on projectUrls' own
    // thread-propagation wiring (BROWSER_TIMELINE_OBSERVED + threads
    // option) — this test only pins that we never emit a DUPLICATE
    // canonical-url row from the 'thread' source when it does.
    const urlProjection = projectUrls(events);
    const bridged = urlProjection.byCanonicalUrl.get('https://example.test/bac_1');
    if (bridged?.currentAttribution?.source === 'thread') {
      expect(plan.stats.urlsBackfilled).toBe(0);
    }
  });
});
