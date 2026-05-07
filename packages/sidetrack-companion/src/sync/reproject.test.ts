import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcceptedEvent } from './causal.js';
import { createEventLog } from './eventLog.js';
import { createProjectionChangeFeed } from './projectionChanges.js';
import { PROJECTOR_VERSION, reprojectOnVersionMismatch } from './reproject.js';
import { loadOrCreateReplica } from './replicaId.js';

describe('reprojectOnVersionMismatch', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-reproject-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('runs projectors for every aggregate when no version file exists', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const projectionChanges = createProjectionChangeFeed(vaultRoot);

    const events: AcceptedEvent[] = [
      {
        clientEventId: 'e-1',
        dot: { replicaId: 'peer-A', seq: 1 },
        deps: {},
        aggregateId: 't-1',
        type: 'thread.upserted',
        payload: {
          bac_id: 't-1',
          provider: 'chatgpt',
          threadUrl: 'https://x',
          title: 'Title',
          lastSeenAt: '2026-05-06T00:00:00.000Z',
        },
        acceptedAtMs: 1,
      },
      {
        clientEventId: 'e-2',
        dot: { replicaId: 'peer-A', seq: 2 },
        deps: { 'peer-A': 1 },
        aggregateId: 'ws-1',
        type: 'workstream.upserted',
        payload: { bac_id: 'ws-1', title: 'Group' },
        acceptedAtMs: 2,
      },
    ];
    for (const event of events) {
      await eventLog.importPeerEvent(event);
    }
    const result = await reprojectOnVersionMismatch({ vaultRoot, eventLog, projectionChanges });
    expect(result.ranReproject).toBe(true);
    expect(result.priorVersion).toBeNull();
    expect(result.currentVersion).toBe(PROJECTOR_VERSION);
    expect(result.aggregateCount).toBe(2);
    // Both aggregate projection files exist.
    const threadProjection = await readFile(`${vaultRoot}/_BAC/threads/projections/t-1.json`, 'utf8');
    const workstreamProjection = await readFile(`${vaultRoot}/_BAC/workstreams/projections/ws-1.json`, 'utf8');
    expect(threadProjection.length).toBeGreaterThan(0);
    expect(workstreamProjection.length).toBeGreaterThan(0);
    // Version sentinel landed on disk.
    const sentinel = JSON.parse(
      await readFile(`${vaultRoot}/_BAC/.projector-version`, 'utf8'),
    ) as { version: number };
    expect(sentinel.version).toBe(PROJECTOR_VERSION);
  });

  it('is a no-op on the second invocation', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const projectionChanges = createProjectionChangeFeed(vaultRoot);
    const event: AcceptedEvent = {
      clientEventId: 'e-1',
      dot: { replicaId: 'peer-A', seq: 1 },
      deps: {},
      aggregateId: 't-1',
      type: 'thread.upserted',
      payload: {
        bac_id: 't-1',
        provider: 'chatgpt',
        threadUrl: 'https://x',
        title: 'Title',
        lastSeenAt: '2026-05-06T00:00:00.000Z',
      },
      acceptedAtMs: 1,
    };
    await eventLog.importPeerEvent(event);
    const first = await reprojectOnVersionMismatch({ vaultRoot, eventLog, projectionChanges });
    expect(first.ranReproject).toBe(true);
    const second = await reprojectOnVersionMismatch({ vaultRoot, eventLog, projectionChanges });
    expect(second.ranReproject).toBe(false);
    expect(second.priorVersion).toBe(PROJECTOR_VERSION);
  });

  it('re-runs projectors after a manual delete of the projection file', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const projectionChanges = createProjectionChangeFeed(vaultRoot);
    const event: AcceptedEvent = {
      clientEventId: 'e-1',
      dot: { replicaId: 'peer-A', seq: 1 },
      deps: {},
      aggregateId: 't-1',
      type: 'thread.upserted',
      payload: {
        bac_id: 't-1',
        provider: 'chatgpt',
        threadUrl: 'https://x',
        title: 'Title',
        lastSeenAt: '2026-05-06T00:00:00.000Z',
      },
      acceptedAtMs: 1,
    };
    await eventLog.importPeerEvent(event);
    await reprojectOnVersionMismatch({ vaultRoot, eventLog, projectionChanges });
    // Delete the version sentinel + the projection file to simulate
    // either a vault touched by an older companion OR a user wiping
    // the projection cache by hand.
    await unlink(`${vaultRoot}/_BAC/.projector-version`);
    await unlink(`${vaultRoot}/_BAC/threads/projections/t-1.json`);
    const result = await reprojectOnVersionMismatch({ vaultRoot, eventLog, projectionChanges });
    expect(result.ranReproject).toBe(true);
    const threadProjection = await readFile(`${vaultRoot}/_BAC/threads/projections/t-1.json`, 'utf8');
    expect(threadProjection.length).toBeGreaterThan(0);
  });
});
