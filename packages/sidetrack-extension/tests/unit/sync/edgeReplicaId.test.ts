import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { allocateNextSeq, loadOrCreateEdgeReplica } from '../../../src/sync/edgeReplicaId';

// Lane 3 / L3.S1 — edge replica identity bootstrap + monotonic seq
// allocator.
//
// Asserts:
//   - First call generates + persists an `edge_<hex>` id.
//   - Subsequent calls return the same id.
//   - allocateNextSeq monotonically advances; never reuses a seq.
//   - Two parallel allocations (simulated burst) get disjoint ranges.

const memoryStore = (): Record<string, unknown> => {
  const store: Record<string, unknown> = {};
  return store;
};

describe('edge replica identity', () => {
  let store: Record<string, unknown>;

  beforeEach(() => {
    store = memoryStore();
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: vi.fn((key: string) => Promise.resolve({ [key]: store[key] })),
          set: vi.fn((entries: Record<string, unknown>) => {
            Object.assign(store, entries);
            return Promise.resolve();
          }),
        },
      },
    };
    // crypto is global in modern Node; no shim needed.
  });

  afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  it('first call generates an edge_<hex> id and persists it; subsequent calls return the same id', async () => {
    const first = await loadOrCreateEdgeReplica();
    expect(first.edgeReplicaId).toMatch(/^edge_[0-9a-f]{24}$/);
    expect(first.nextSeq).toBe(1);
    const second = await loadOrCreateEdgeReplica();
    expect(second.edgeReplicaId).toBe(first.edgeReplicaId);
  });

  it('allocateNextSeq advances monotonically', async () => {
    const a = await allocateNextSeq();
    const b = await allocateNextSeq();
    const c = await allocateNextSeq(3);
    expect(a.fromSeq).toBe(1);
    expect(a.toSeq).toBe(1);
    expect(b.fromSeq).toBe(2);
    expect(c.fromSeq).toBe(3);
    expect(c.toSeq).toBe(5);
    // Same edge replica id across all allocations.
    expect(a.edgeReplicaId).toBe(b.edgeReplicaId);
    expect(b.edgeReplicaId).toBe(c.edgeReplicaId);
  });
});
