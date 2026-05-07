import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcceptedEvent } from './causal.js';
import { createEventLog } from './eventLog.js';
import { createProjectionChangeFeed } from './projectionChanges.js';
import { loadOrCreateReplica } from './replicaId.js';
import { startAntiEntropyTask } from './antiEntropy.js';

describe('startAntiEntropyTask', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-antientropy-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('scanNow re-projects every aggregate and rewrites missing projection files', async () => {
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
    const handle = startAntiEntropyTask({
      vaultRoot,
      eventLog,
      projectionChanges,
      intervalMs: 60_000_000, // never auto-fire
    });
    try {
      // Initial scan writes the projection.
      const count = await handle.scanNow();
      expect(count).toBe(1);
      const before = await readFile(`${vaultRoot}/_BAC/threads/t-1.json`, 'utf8');
      expect(before.length).toBeGreaterThan(0);
      // Simulate drift: delete the projection file.
      await unlink(`${vaultRoot}/_BAC/threads/t-1.json`);
      // Anti-entropy rewrites it.
      await handle.scanNow();
      const after = await readFile(`${vaultRoot}/_BAC/threads/t-1.json`, 'utf8');
      expect(after).toBe(before);
    } finally {
      handle.stop();
    }
  });

  it('reports the aggregate count via onScanComplete', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
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
          title: 'A',
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
    const counts: number[] = [];
    const handle = startAntiEntropyTask({
      vaultRoot,
      eventLog,
      intervalMs: 60_000_000,
      onScanComplete: (count) => counts.push(count),
    });
    try {
      await handle.scanNow();
      expect(counts).toEqual([2]);
    } finally {
      handle.stop();
    }
  });

  it('stop() prevents further scans from doing work', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const handle = startAntiEntropyTask({ vaultRoot, eventLog, intervalMs: 60_000_000 });
    handle.stop();
    const count = await handle.scanNow();
    expect(count).toBe(0);
  });
});
