import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type SpoolEntry,
  spoolAppend,
  spoolMetrics,
  spoolTransition,
} from '../../../src/sync/spool';
import { drainSpoolToCompanion } from '../../../src/sync/spoolDrainer';

// Lane 3 / L3-G3 — spool drain on reconnect.
//
// Asserts:
//   - When companion accepts every event, drainer uploads all
//     spooled entries; spool empties.
//   - On companion-unreachable, spooled entries stay; next pass
//     can retry without duplicates (gate L3-G5 idempotent retry
//     overlap).
//   - Mixed ok/fail responses partition cleanly: ok → uploaded +
//     removed; fail → spooled with error reason.

const stubChromeStorage = (): { reset: () => void } => {
  const store: Record<string, unknown> = {};
  const get = (req: unknown): Promise<Record<string, unknown>> => {
    if (typeof req === 'string') return Promise.resolve({ [req]: store[req] });
    if (Array.isArray(req)) {
      const out: Record<string, unknown> = {};
      for (const k of req) out[k] = store[k];
      return Promise.resolve(out);
    }
    if (typeof req === 'object' && req !== null) {
      const out: Record<string, unknown> = {};
      for (const [k, fb] of Object.entries(req)) out[k] = k in store ? store[k] : fb;
      return Promise.resolve(out);
    }
    return Promise.resolve({});
  };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: vi.fn(get),
        set: vi.fn((entries: Record<string, unknown>) => {
          Object.assign(store, entries);
          return Promise.resolve();
        }),
      },
    },
  };
  return {
    reset: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
  };
};

const entry = (seq: number): SpoolEntry => ({
  edgeDot: { replicaId: 'edge_test', seq },
  clientEventId: `evt-${seq}`,
  surface: 'threads',
  payload: { seq },
  state: 'spooled',
  createdAt: '2026-05-07T00:00:00.000Z',
  lastTransitionAt: '2026-05-07T00:00:00.000Z',
});

describe('drainSpoolToCompanion', () => {
  let stub: ReturnType<typeof stubChromeStorage>;
  beforeEach(() => {
    stub = stubChromeStorage();
  });
  afterEach(() => {
    stub.reset();
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  it('uploads every spooled entry and empties the spool when companion accepts all', async () => {
    for (let s = 1; s <= 5; s += 1) {
      await spoolAppend('threads', entry(s));
    }
    const port = {
      importEvent: vi.fn(async () => ({ ok: true })),
    };
    const result = await drainSpoolToCompanion('threads', port);
    expect(result.uploaded).toBe(5);
    expect(result.remaining).toBe(0);
    expect(result.errors).toBe(0);
    expect(port.importEvent).toHaveBeenCalledTimes(5);
    const m = await spoolMetrics('threads');
    expect(m.total).toBe(0);
  });

  it('keeps entries spooled when companion is unreachable; idempotent on retry', async () => {
    for (let s = 1; s <= 3; s += 1) {
      await spoolAppend('threads', entry(s));
    }
    let calls = 0;
    const port = {
      importEvent: vi.fn(async () => {
        calls += 1;
        throw new Error('companion-unreachable');
      }),
    };
    const result = await drainSpoolToCompanion('threads', port);
    expect(result.uploaded).toBe(0);
    expect(result.errors).toBe(3);
    expect(result.remaining).toBe(3);
    expect(calls).toBe(3);
    // Retry pass; no companion change → still spooled. Idempotent —
    // the same edgeDots are passed to the port, no spool growth.
    const result2 = await drainSpoolToCompanion('threads', port);
    expect(result2.remaining).toBe(3);
    const m = await spoolMetrics('threads');
    expect(m.total).toBe(3);
    expect(m.byState.spooled).toBe(3);
  });

  it('partitions ok vs fail responses cleanly', async () => {
    await spoolAppend('threads', entry(1));
    await spoolAppend('threads', entry(2));
    await spoolAppend('threads', entry(3));
    const port = {
      importEvent: vi.fn(async (e: SpoolEntry) => {
        if (e.edgeDot.seq === 2) return { ok: false, reason: 'rejected-by-bucket-trust' };
        return { ok: true };
      }),
    };
    const result = await drainSpoolToCompanion('threads', port);
    expect(result.uploaded).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.remaining).toBe(1);
    const m = await spoolMetrics('threads');
    expect(m.byState.spooled).toBe(1);
  });

  it('skips entries already in terminal states (companion-imported, failed-explicit)', async () => {
    await spoolAppend('threads', entry(1));
    await spoolAppend('threads', entry(2));
    await spoolTransition('threads', entry(1).edgeDot, 'companion-imported');
    await spoolTransition('threads', entry(2).edgeDot, 'failed-explicit', 'spool-full');
    const port = {
      importEvent: vi.fn(async () => ({ ok: true })),
    };
    const result = await drainSpoolToCompanion('threads', port);
    expect(result.uploaded).toBe(0);
    expect(port.importEvent).not.toHaveBeenCalled();
  });
});
