// F8 W3 — repair queue store lifecycle (docs/plans/2026-08-16-f8-ivm-designs.md,
// "W3"). Mirrors threadRegisterStore.test.ts's structure/skip guard.

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createRepairQueueStore } from './repairQueueStore.js';
import type { Scope } from '../sync/contract/connectionsScopes.js';

const sqliteIt = process.versions['bun'] === undefined ? it.skip : it;

describe('repairQueueStore', () => {
  let vaultRoot: string;

  afterEach(async () => {
    if (vaultRoot !== undefined) await rm(vaultRoot, { recursive: true, force: true });
  });

  const freshVault = async (): Promise<string> => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-repair-queue-'));
    await mkdir(join(vaultRoot, '_BAC', 'connections'), { recursive: true });
    return vaultRoot;
  };

  sqliteIt('enqueue + depth + takeBatch round-trips a scope', async () => {
    const root = await freshVault();
    const store = await createRepairQueueStore(root);
    try {
      expect(store.depth()).toBe(0);
      const scope: Scope = { kind: 'thread', id: 'T1' };
      store.enqueue([scope], 'thread-workstream-membership-changed');
      expect(store.depth()).toBe(1);
      const batch = store.takeBatch(10);
      expect(batch).toHaveLength(1);
      expect(batch[0]?.scope).toEqual(scope);
      expect(batch[0]?.reason).toBe('thread-workstream-membership-changed');
      expect(store.depth()).toBe(0);
    } finally {
      store.close();
    }
  });

  sqliteIt('dedupes on (scope_kind, scope_id): a re-bail refreshes reason + timestamp, not a duplicate row', async () => {
    const root = await freshVault();
    const store = await createRepairQueueStore(root);
    try {
      const scope: Scope = { kind: 'url', id: 'https://example.test/a' };
      store.enqueue([scope], 'pending-search-visit');
      store.enqueue([scope], 'missing-required-timeline-entries:1');
      expect(store.depth()).toBe(1);
      const batch = store.takeBatch(10);
      expect(batch).toHaveLength(1);
      expect(batch[0]?.reason).toBe('missing-required-timeline-entries:1');
    } finally {
      store.close();
    }
  });

  sqliteIt('takeBatch returns oldest-first and respects the batch size bound', async () => {
    const root = await freshVault();
    const store = await createRepairQueueStore(root);
    try {
      const scopes: Scope[] = [
        { kind: 'url', id: 'u1' },
        { kind: 'url', id: 'u2' },
        { kind: 'url', id: 'u3' },
      ];
      for (const scope of scopes) store.enqueue([scope], 'gate');
      expect(store.depth()).toBe(3);
      const firstBatch = store.takeBatch(2);
      expect(firstBatch.map((entry) => entry.scope.id)).toEqual(['u1', 'u2']);
      expect(store.depth()).toBe(1);
      const secondBatch = store.takeBatch(2);
      expect(secondBatch.map((entry) => entry.scope.id)).toEqual(['u3']);
      expect(store.depth()).toBe(0);
    } finally {
      store.close();
    }
  });

  sqliteIt('takeBatch(0) and an empty queue are both no-ops', async () => {
    const root = await freshVault();
    const store = await createRepairQueueStore(root);
    try {
      expect(store.takeBatch(0)).toEqual([]);
      expect(store.takeBatch(10)).toEqual([]);
    } finally {
      store.close();
    }
  });

  sqliteIt('enqueue([]) is a no-op', async () => {
    const root = await freshVault();
    const store = await createRepairQueueStore(root);
    try {
      store.enqueue([], 'gate');
      expect(store.depth()).toBe(0);
    } finally {
      store.close();
    }
  });

  sqliteIt('stats() reports depth and the oldest enqueued timestamp', async () => {
    const root = await freshVault();
    const store = await createRepairQueueStore(root);
    try {
      expect(store.stats()).toEqual({ depth: 0, oldestEnqueuedAt: null });
      store.enqueue([{ kind: 'thread', id: 'T1' }], 'gate');
      const stats = store.stats();
      expect(stats.depth).toBe(1);
      expect(stats.oldestEnqueuedAt).not.toBeNull();
    } finally {
      store.close();
    }
  });

  sqliteIt('needs-repair marker: mark / read / clear', async () => {
    const root = await freshVault();
    const store = await createRepairQueueStore(root);
    try {
      expect(store.readNeedsRepair()).toBeNull();
      store.markNeedsRepair(
        'cold-boot-non-empty-vault',
        'sidetrack-companion connections-rebuild --vault /vault',
      );
      const state = store.readNeedsRepair();
      expect(state?.reason).toBe('cold-boot-non-empty-vault');
      expect(state?.command).toBe('sidetrack-companion connections-rebuild --vault /vault');
      // A second mark overwrites the singleton row rather than erroring.
      store.markNeedsRepair('materializer-version-bump', 'sidetrack-companion connections-rebuild --vault /vault');
      expect(store.readNeedsRepair()?.reason).toBe('materializer-version-bump');
      store.clearNeedsRepair();
      expect(store.readNeedsRepair()).toBeNull();
    } finally {
      store.close();
    }
  });

  sqliteIt('state survives close + reopen (durable across process restarts)', async () => {
    const root = await freshVault();
    const store1 = await createRepairQueueStore(root);
    store1.enqueue([{ kind: 'thread', id: 'T1' }], 'gate');
    store1.markNeedsRepair('cold-boot-non-empty-vault', 'cmd');
    store1.close();

    const store2 = await createRepairQueueStore(root);
    try {
      expect(store2.depth()).toBe(1);
      expect(store2.readNeedsRepair()?.reason).toBe('cold-boot-non-empty-vault');
    } finally {
      store2.close();
    }
  });
});
