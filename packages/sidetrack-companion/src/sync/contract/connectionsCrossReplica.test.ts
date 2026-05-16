import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConnectionsStore } from '../../connections/snapshot.js';
import { THREAD_UPSERTED } from '../../threads/events.js';
import { createTimelineStore } from '../../timeline/projection.js';
import { createIdempotencyStore } from '../../http/idempotency.js';
import { createCompanionHttpServer, startHttpServer } from '../../http/server.js';
import { createVaultWriter } from '../../vault/writer.js';
import type { AcceptedEvent } from '../causal.js';
import { createEventLog } from '../eventLog.js';
import { loadOrCreateReplica } from '../replicaId.js';
import { createSyncContractRunner } from './runner.js';
import { createConnectionsMaterializer } from './connectionsMaterializer.js';

// Cross-replica integration. We simulate two replicas (A and B) by
// authoring thread.upserted events under different replica ids and
// importing them into the SAME merged event log on a single
// companion — which is exactly what happens in production after the
// relay drains peer events into a companion. The connections
// materializer must:
//   1. Produce ONE node for the same logical thread.
//   2. Carry BOTH replica ids in originReplicaIds.
//   3. The companion's /v1/connections route exposes the unified
//      view honestly.

const buildEvent = (input: {
  replicaId: string;
  seq: number;
  type: string;
  payload: unknown;
  acceptedAtMs?: number;
}): AcceptedEvent => ({
  clientEventId: `${input.replicaId}:evt-${String(input.seq)}`,
  dot: { replicaId: input.replicaId, seq: input.seq },
  deps: {},
  aggregateId: 'agg',
  type: input.type,
  payload: input.payload,
  acceptedAtMs: input.acceptedAtMs ?? Date.parse('2026-05-07T10:00:00.000Z') + input.seq * 1000,
});

describe('connections — cross-replica unification', () => {
  let vaultRoot: string;
  let serverUrl: string;
  let close: (() => Promise<void>) | null = null;
  const BRIDGE = 'cross-replica-bridge';

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-connections-cross-'));
    const localReplica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, localReplica);

    // Replica A and B BOTH observe the same logical thread (same
    // bac_id) at slightly different times. A real deployment would
    // have the relay deliver these as peer events; we use
    // importPeerEvent directly.
    await eventLog.importPeerEvent(
      buildEvent({
        replicaId: 'replica-A',
        seq: 1,
        type: THREAD_UPSERTED,
        payload: {
          bac_id: 'thread_unified',
          provider: 'chatgpt',
          threadUrl: 'https://chatgpt.com/c/abc',
          title: 'Tax flow',
          lastSeenAt: '2026-05-07T10:00:00.000Z',
          tags: [],
          primaryWorkstreamId: 'ws_x',
        },
      }),
    );
    await eventLog.importPeerEvent(
      buildEvent({
        replicaId: 'replica-B',
        seq: 1,
        type: THREAD_UPSERTED,
        payload: {
          bac_id: 'thread_unified',
          provider: 'chatgpt',
          threadUrl: 'https://chatgpt.com/c/abc',
          title: 'Tax flow',
          lastSeenAt: '2026-05-07T11:00:00.000Z',
          tags: [],
          primaryWorkstreamId: 'ws_x',
        },
        acceptedAtMs: Date.parse('2026-05-07T11:00:00.000Z'),
      }),
    );

    const timelineStore = createTimelineStore(vaultRoot);
    const connectionsStore = createConnectionsStore(vaultRoot);
    const runner = createSyncContractRunner();
    runner.register(
      createConnectionsMaterializer({
        vaultRoot,
        eventLog,
        timelineStore,
        store: connectionsStore,
      }),
    );
    await runner.catchUpAll(eventLog);
    await runner.awaitIdle();

    const idempotencyStore = createIdempotencyStore(vaultRoot);
    const server = createCompanionHttpServer({
      bridgeKey: BRIDGE,
      vaultWriter: createVaultWriter(vaultRoot),
      vaultRoot,
      idempotencyStore,
      replica: localReplica,
      eventLog,
      connectionsStore,
      syncMaterializerHealth: () => runner.health(),
    });
    const started = await startHttpServer(server, 0);
    serverUrl = started.url;
    close = started.close;
  });

  afterEach(async () => {
    if (close !== null) await close();
    close = null;
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('GET /v1/connections returns ONE thread node with BOTH replica ids', async () => {
    const res = await fetch(`${serverUrl}/v1/connections`, {
      headers: { 'x-bac-bridge-key': BRIDGE },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        snapshot: {
          nodes: { id: string; originReplicaIds: string[] }[];
          edges: { kind: string }[];
        };
      };
    };
    const threadNodes = body.data.snapshot.nodes.filter((n) => n.id === 'thread:thread_unified');
    expect(threadNodes).toHaveLength(1);
    expect([...threadNodes[0]!.originReplicaIds].sort()).toEqual(['replica-A', 'replica-B']);
    // The thread_in_workstream edge should land once (deterministic
    // dedup; same edge id from both events).
    const inWsEdges = body.data.snapshot.edges.filter((e) => e.kind === 'thread_in_workstream');
    expect(inWsEdges).toHaveLength(1);
  });

  it('GET /v1/connections?originReplicaId=replica-A narrows to A-observed nodes', async () => {
    const res = await fetch(`${serverUrl}/v1/connections?originReplicaId=replica-A`, {
      headers: { 'x-bac-bridge-key': BRIDGE },
    });
    const body = (await res.json()) as {
      data: { snapshot: { nodes: { originReplicaIds: string[] }[] } };
    };
    // Every node in the result must have replica-A in its origin
    // set. (Workstream node is tagged by the same upsert event from
    // both replicas; thread node has both.)
    for (const n of body.data.snapshot.nodes) {
      expect(n.originReplicaIds).toContain('replica-A');
    }
  });
});
