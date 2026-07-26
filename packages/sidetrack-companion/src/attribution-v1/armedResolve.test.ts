import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveUrlAttributionArmed } from './armedResolve.js';
import { ATTRIBUTION_ARM_ENV } from './serve.js';
import { ATTRIBUTION_V1_SHADOW_ENV } from './shadow.js';
import { armShadowSnapshot, resetArmShadowForTest } from './armShadow.js';
import { resetShadowStateMemoForTest } from './emit.js';
import { writeAttributionV1Artifact } from './artifact.js';
import type { ConnectionsSnapshot } from '../connections/types.js';
import type { EventLog } from '../sync/eventLog.js';
import { USER_ORGANIZED_ITEM } from '../feedback/events.js';
import { BROWSER_TIMELINE_OBSERVED } from '../timeline/events.js';
import type { AcceptedEvent } from '../sync/causal.js';

// A minimal connections snapshot carrying the title for the probe url + a
// workstream-tied neighbor so the INCUMBENT resolver returns a workstream (for
// the reverse-shadow agreement comparison).
const snapshot = (probeUrl: string, title: string): ConnectionsSnapshot => ({
  scope: {},
  nodes: [
    {
      id: `timeline-visit:${probeUrl}`,
      kind: 'timeline-visit',
      label: title,
      originReplicaIds: [],
      metadata: { canonicalUrl: probeUrl, title },
    },
  ],
  edges: [],
  updatedAt: '2026-07-26T10:00:00.000Z',
  nodeCount: 1,
  edgeCount: 0,
});

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
const timeline = (url: string, title: string, atMs: number): AcceptedEvent => {
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

// A tiny in-memory EventLog stub — writeAttributionV1Artifact only needs
// readMerged (the store path is unused for a bare vault root).
const stubEventLog = (events: readonly AcceptedEvent[]): EventLog =>
  ({ readMerged: async () => events }) as unknown as EventLog;

describe('resolveUrlAttributionArmed', () => {
  let vaultRoot: string;
  const prevArm = process.env[ATTRIBUTION_ARM_ENV];
  const prevShadow = process.env[ATTRIBUTION_V1_SHADOW_ENV];

  const stateEvents: readonly AcceptedEvent[] = (() => {
    seq = 0;
    return [
      timeline('https://blog.rust-lang.org/a', 'rust release notes', 1),
      timeline('https://blog.rust-lang.org/b', 'rust async update', 2),
      organize('https://blog.rust-lang.org/a', 'wsRust', 10),
      organize('https://blog.rust-lang.org/b', 'wsRust', 11),
    ];
  })();

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'armed-resolve-'));
    resetArmShadowForTest();
    resetShadowStateMemoForTest();
    // Materialize a fresh v1 state artifact the vote arm can read.
    await writeAttributionV1Artifact({ vaultRoot, eventLog: stubEventLog(stateEvents) });
  });

  afterEach(async () => {
    if (prevArm === undefined) delete process.env[ATTRIBUTION_ARM_ENV];
    else process.env[ATTRIBUTION_ARM_ENV] = prevArm;
    if (prevShadow === undefined) delete process.env[ATTRIBUTION_V1_SHADOW_ENV];
    else process.env[ATTRIBUTION_V1_SHADOW_ENV] = prevShadow;
    resetShadowStateMemoForTest();
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('serves the vote arm (default) and returns a vote3 decision', async () => {
    delete process.env[ATTRIBUTION_ARM_ENV]; // default = vote arm
    const probeUrl = 'https://blog.rust-lang.org/c';
    const result = await resolveUrlAttributionArmed({
      vaultRoot,
      canonicalUrl: probeUrl,
      snapshot: snapshot(probeUrl, 'unrelated headline words'),
      events: [],
    });
    // Domain (wsRust, single-workstream) + recency (wsRust) ⇒ 2 votes ⇒ suggest.
    expect(result.decision.action).toBe('suggest');
    expect(result.decision.workstreamId).toBe('wsRust');
    expect(result.reasons.modelRevision).toBe('attribution-vote3-v1');
  });

  it('records the reverse arm-shadow (incumbent vs served vote3) when serving the vote arm', async () => {
    process.env[ATTRIBUTION_ARM_ENV] = 'vote3';
    process.env[ATTRIBUTION_V1_SHADOW_ENV] = '1'; // shadow ON
    const probeUrl = 'https://blog.rust-lang.org/c';
    await resolveUrlAttributionArmed({
      vaultRoot,
      canonicalUrl: probeUrl,
      snapshot: snapshot(probeUrl, 'unrelated headline words'),
      events: [],
    });
    const snap = armShadowSnapshot();
    expect(snap.requests).toBe(1);
    // The incumbent (empty snapshot edges ⇒ inbox/null) DISAGREES with the vote
    // arm's wsRust suggestion — the expected divergence the reverse shadow exists
    // to surface (incumbent abstains where the vote arm suggests).
    expect(snap.agreeRate).toBe(0);
  });

  it('does not record the arm-shadow when the shadow flag is off', async () => {
    process.env[ATTRIBUTION_ARM_ENV] = 'vote3';
    process.env[ATTRIBUTION_V1_SHADOW_ENV] = '0'; // shadow OFF
    const probeUrl = 'https://blog.rust-lang.org/c';
    await resolveUrlAttributionArmed({
      vaultRoot,
      canonicalUrl: probeUrl,
      snapshot: snapshot(probeUrl, 'unrelated headline words'),
      events: [],
    });
    expect(armShadowSnapshot().requests).toBe(0);
  });

  it('serves the incumbent unchanged when the arm is v1', async () => {
    process.env[ATTRIBUTION_ARM_ENV] = 'v1';
    const probeUrl = 'https://blog.rust-lang.org/c';
    const result = await resolveUrlAttributionArmed({
      vaultRoot,
      canonicalUrl: probeUrl,
      snapshot: snapshot(probeUrl, 'unrelated headline words'),
      events: [],
    });
    // The incumbent graph-resolver on an edgeless snapshot abstains (inbox), and
    // its result carries the incumbent model revision — NOT the vote arm's.
    expect(result.reasons.modelRevision).not.toBe('attribution-vote3-v1');
    expect(result.decision.action).toBe('inbox');
    // No arm-shadow recorded on the incumbent path.
    expect(armShadowSnapshot().requests).toBe(0);
  });

  it('fails safe to the incumbent when there is no fresh state artifact', async () => {
    process.env[ATTRIBUTION_ARM_ENV] = 'vote3';
    resetShadowStateMemoForTest();
    const bareVault = await mkdtemp(join(tmpdir(), 'armed-bare-'));
    try {
      const probeUrl = 'https://blog.rust-lang.org/c';
      const result = await resolveUrlAttributionArmed({
        vaultRoot: bareVault,
        canonicalUrl: probeUrl,
        snapshot: snapshot(probeUrl, 'unrelated headline words'),
        events: [],
      });
      // No artifact ⇒ incumbent result (not the vote arm's model revision).
      expect(result.reasons.modelRevision).not.toBe('attribution-vote3-v1');
    } finally {
      await rm(bareVault, { recursive: true, force: true });
    }
  });

  it('serves the incumbent when no vaultRoot is supplied', async () => {
    process.env[ATTRIBUTION_ARM_ENV] = 'vote3';
    const probeUrl = 'https://blog.rust-lang.org/c';
    const result = await resolveUrlAttributionArmed({
      canonicalUrl: probeUrl,
      snapshot: snapshot(probeUrl, 'unrelated headline words'),
      events: [],
    });
    expect(result.reasons.modelRevision).not.toBe('attribution-vote3-v1');
  });

  it('honors the domain-tombstone gate: a purged URL is not attributed (F1)', async () => {
    // The vote arm SUGGESTS blog.rust-lang.org/c ungated (domain + recency). A
    // rust-lang.org tombstone threaded through the arm switch must flip it to
    // inbox — the new serve boundary honors the same HIDE gate the incumbent
    // gets for free.
    process.env[ATTRIBUTION_ARM_ENV] = 'vote3';
    const probeUrl = 'https://blog.rust-lang.org/c';
    const rustTombstone = {
      matchesPage: (page: { url?: string }): boolean =>
        page.url !== undefined && page.url.includes('rust-lang.org'),
      matchesDomain: (domain: string): boolean => domain.includes('rust-lang.org'),
    };
    const result = await resolveUrlAttributionArmed({
      vaultRoot,
      canonicalUrl: probeUrl,
      snapshot: snapshot(probeUrl, 'unrelated headline words'),
      events: [],
      tombstones: rustTombstone,
    });
    expect(result.decision.action).toBe('inbox');
    expect(result.decision.workstreamId).toBeUndefined();
  });
});
