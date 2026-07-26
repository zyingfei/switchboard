import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ConnectionsSnapshot } from '../connections/types.js';
import type { EventLog } from '../sync/eventLog.js';
import { autoApplyUrlAttribution } from './autoApply.js';
import { URL_PROJECTION_SCHEMA_VERSION, type SerializedUrlProjection } from './projection.js';
import { URL_ATTRIBUTION_INFERRED } from './events.js';
import { writeAttributionV1Artifact } from '../attribution-v1/artifact.js';
import { resetShadowStateMemoForTest } from '../attribution-v1/emit.js';
import { ATTRIBUTION_ARM_ENV, VOTE_ARM_AUTO_APPLY_ENV } from '../attribution-v1/serve.js';
import { ATTRIBUTION_V1_SHADOW_ENV } from '../attribution-v1/shadow.js';
import { USER_ORGANIZED_ITEM } from '../feedback/events.js';
import { BROWSER_TIMELINE_OBSERVED } from '../timeline/events.js';
import type { AcceptedEvent } from '../sync/causal.js';

const canonicalUrl = 'https://example.test/research';

const urlProjection = (): SerializedUrlProjection => ({
  schemaVersion: URL_PROJECTION_SCHEMA_VERSION,
  byCanonicalUrl: {
    [canonicalUrl]: {
      canonicalUrl,
      firstSeenAt: '2026-05-23T20:00:00.000Z',
      lastSeenAt: '2026-05-23T20:05:00.000Z',
      latestUrl: canonicalUrl,
      latestTitle: 'Research',
      provider: 'generic',
      host: 'example.test',
      visitCount: 2,
      tabSessionIds: ['tses_test'],
      attributionHistory: [],
    },
  },
});

const snapshot = (): ConnectionsSnapshot => ({
  scope: {},
  nodes: [],
  edges: [],
  updatedAt: '2026-05-23T20:05:00.000Z',
  nodeCount: 0,
  edgeCount: 0,
  snapshotRevision: 'rev-auto-apply-test',
  urlProjection: urlProjection(),
});

describe('autoApplyUrlAttribution', () => {
  it('uses supplied projection and events without rereading the full event log', async () => {
    const previous = process.env['SIDETRACK_URL_RESOLVER_AUTO_APPLY'];
    process.env['SIDETRACK_URL_RESOLVER_AUTO_APPLY'] = '0';
    const eventLog = {
      readMerged: async () => {
        throw new Error('readMerged should not be called');
      },
      appendServerObserved: async () => {
        throw new Error('appendServerObserved should not be called when disabled');
      },
    } as unknown as EventLog;

    try {
      const result = await autoApplyUrlAttribution({
        eventLog,
        snapshot: snapshot(),
        canonicalUrl,
        events: [],
        urlProjection: urlProjection(),
        useEventCandidateSimilarity: false,
      });

      expect(result.status).toBe('skipped-disabled');
      expect(result.projection.byCanonicalUrl.get(canonicalUrl)?.latestTitle).toBe('Research');
    } finally {
      if (previous === undefined) delete process.env['SIDETRACK_URL_RESOLVER_AUTO_APPLY'];
      else process.env['SIDETRACK_URL_RESOLVER_AUTO_APPLY'] = previous;
    }
  });
});

// ---- the vote arm flows through the round-guard stack (M6) -------------

describe('autoApplyUrlAttribution — vote arm (SIDETRACK_ATTRIBUTION_ARM=vote3)', () => {
  const hubUrl = 'https://news.ycombinator.com/item?id=fresh';
  const rustUrl = 'https://blog.rust-lang.org/announcing';

  let seq = 0;
  const organize = (url: string, ws: string, atMs: number): AcceptedEvent => {
    seq += 1;
    return {
      clientEventId: `org-${seq}`,
      dot: { replicaId: 'r1', seq },
      deps: {},
      aggregateId: `canonical-url:${url}`,
      type: USER_ORGANIZED_ITEM,
      payload: { payloadVersion: 1, itemKind: 'canonical-url', itemId: url, action: 'move', toContainer: ws },
      acceptedAtMs: atMs,
    };
  };
  const tl = (url: string, title: string, atMs: number): AcceptedEvent => {
    seq += 1;
    return {
      clientEventId: `tl-${seq}`,
      dot: { replicaId: 'r1', seq },
      deps: {},
      aggregateId: `timeline-visit:${url}`,
      type: BROWSER_TIMELINE_OBSERVED,
      payload: {
        eventId: `evt-${seq}`,
        observedAt: new Date(atMs).toISOString(),
        url,
        canonicalUrl: url,
        title,
        transition: 'activated',
      },
      acceptedAtMs: atMs,
    };
  };

  const stateEvents = (): readonly AcceptedEvent[] => {
    seq = 0;
    return [
      tl('https://blog.rust-lang.org/a', 'distributed consensus raft protocol', 1),
      tl('https://blog.rust-lang.org/b', 'distributed consensus raft log', 2),
      organize('https://blog.rust-lang.org/a', 'wsRust', 10),
      organize('https://blog.rust-lang.org/b', 'wsRust', 11),
    ];
  };

  const snapshotForVoteArm = (url: string, title: string): ConnectionsSnapshot => ({
    scope: {},
    nodes: [
      {
        id: `timeline-visit:${url}`,
        kind: 'timeline-visit',
        label: title,
        originReplicaIds: [],
        metadata: { canonicalUrl: url, title },
      },
    ],
    edges: [],
    updatedAt: '2026-07-26T20:05:00.000Z',
    nodeCount: 1,
    edgeCount: 0,
    snapshotRevision: 'rev-vote-arm-test',
  });

  const revisitProjection = (url: string): SerializedUrlProjection => ({
    schemaVersion: URL_PROJECTION_SCHEMA_VERSION,
    byCanonicalUrl: {
      [url]: {
        canonicalUrl: url,
        firstSeenAt: '2026-07-26T20:00:00.000Z',
        lastSeenAt: '2026-07-26T20:05:00.000Z',
        latestUrl: url,
        latestTitle: 'Fresh',
        provider: 'generic',
        host: new URL(url).host,
        // visitCount >= 2 so the grace-window guard does NOT skip (a revisit).
        visitCount: 2,
        tabSessionIds: ['tses_test'],
        attributionHistory: [],
      },
    },
  });

  let vaultRoot: string;
  const prevArm = process.env[ATTRIBUTION_ARM_ENV];
  const prevShadow = process.env[ATTRIBUTION_V1_SHADOW_ENV];
  const prevAutoApply = process.env[VOTE_ARM_AUTO_APPLY_ENV];

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'autoapply-vote-'));
    resetShadowStateMemoForTest();
    process.env[ATTRIBUTION_ARM_ENV] = 'vote3';
    // Auto-apply OFF by default (rule 2b) — the tests that need it flip it on.
    delete process.env[VOTE_ARM_AUTO_APPLY_ENV];
    // Turn the reverse shadow OFF so the incumbent PPR isn't computed in-test.
    process.env[ATTRIBUTION_V1_SHADOW_ENV] = '0';
    await writeAttributionV1Artifact({
      vaultRoot,
      eventLog: { readMerged: async () => stateEvents() } as unknown as EventLog,
    });
  });

  afterEach(async () => {
    if (prevArm === undefined) delete process.env[ATTRIBUTION_ARM_ENV];
    else process.env[ATTRIBUTION_ARM_ENV] = prevArm;
    if (prevShadow === undefined) delete process.env[ATTRIBUTION_V1_SHADOW_ENV];
    else process.env[ATTRIBUTION_V1_SHADOW_ENV] = prevShadow;
    if (prevAutoApply === undefined) delete process.env[VOTE_ARM_AUTO_APPLY_ENV];
    else process.env[VOTE_ARM_AUTO_APPLY_ENV] = prevAutoApply;
    resetShadowStateMemoForTest();
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('auto-applies the vote arm decision through the round-guard stack (unanimous 3-vote, flag ON)', async () => {
    // Title (raft) + domain (single-workstream rust-lang ⇒ gate passes) +
    // recency (wsRust) all vote wsRust ⇒ 3 votes, title participates. Auto-apply
    // is now flag-gated (rule 2b: SIDETRACK_VOTE_ARM_AUTO_APPLY default OFF), so
    // this exercises the commit path with the flag explicitly ON — the round
    // guards (revisit, not-ignored, no existing attribution) then let it commit an
    // inferred URL-attribution event.
    process.env[VOTE_ARM_AUTO_APPLY_ENV] = '1';
    const appended: AcceptedEvent[] = [];
    const eventLog = {
      readMerged: async () => [],
      appendServerObserved: async (input: {
        readonly clientEventId: string;
        readonly aggregateId: string;
        readonly type: string;
        readonly payload: Record<string, unknown>;
      }) => {
        const accepted: AcceptedEvent = {
          clientEventId: input.clientEventId,
          dot: { replicaId: 'server', seq: appended.length + 1 },
          deps: {},
          aggregateId: input.aggregateId,
          type: input.type,
          payload: input.payload,
          acceptedAtMs: 100 + appended.length,
        };
        appended.push(accepted);
        return accepted;
      },
    } as unknown as EventLog;

    const result = await autoApplyUrlAttribution({
      eventLog,
      snapshot: snapshotForVoteArm(rustUrl, 'distributed consensus raft protocol'),
      canonicalUrl: rustUrl,
      events: [],
      urlProjection: revisitProjection(rustUrl),
      vaultRoot,
    });

    expect(result.resolution.decision.action).toBe('auto-apply');
    expect(result.resolution.decision.workstreamId).toBe('wsRust');
    expect(result.status).toBe('applied');
    expect(appended).toHaveLength(1);
    expect(appended[0]!.type).toBe(URL_ATTRIBUTION_INFERRED);
    expect((appended[0]!.payload as { workstreamId: string }).workstreamId).toBe('wsRust');
  });

  it('the aggregator false-friend hub is NOT auto-applied (skipped-policy)', async () => {
    // A fresh HN hub visit with no title overlap: the domain vote is gated OFF
    // (below-neutral hub), and the title vote is null, so only the recency vote
    // stands (1 vote). The vote arm therefore never reaches the >= 3-vote
    // auto-apply tier for the hub — the round-guard stack sees a non-auto-apply
    // resolution and skips (skipped-policy). The hub page is never AUTO-filed.
    // (The lone recency vote is an honest "last-filed" fallback at suggest level,
    // NOT a hub mis-attribution — the domain channel the aggregator false-friend
    // rode is closed.)
    const eventLog = {
      readMerged: async () => [],
      appendServerObserved: async () => {
        throw new Error('the aggregator hub must not be auto-applied');
      },
    } as unknown as EventLog;

    const result = await autoApplyUrlAttribution({
      eventLog,
      snapshot: snapshotForVoteArm(hubUrl, 'brand new headline nobody filed'),
      canonicalUrl: hubUrl,
      events: [],
      urlProjection: revisitProjection(hubUrl),
      vaultRoot,
    });

    // The hub never reaches auto-apply (the >= 3-vote tier) — the domain channel
    // is gated off, so at most the lone recency vote fires (suggest).
    expect(result.resolution.decision.action).not.toBe('auto-apply');
    expect(result.status).toBe('skipped-policy');
  });
});
