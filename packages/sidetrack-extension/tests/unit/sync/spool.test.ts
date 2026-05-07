import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type SpoolEntry,
  readSpool,
  spoolAppend,
  spoolMetrics,
  spoolRemove,
  spoolTransition,
} from '../../../src/sync/spool';

// Lane 3 / L3.S3 — bounded spool state machine.
//
// Asserts:
//   - Append is idempotent on edgeDot (gate L3-G5: drain
//     interruption + retry is safe).
//   - State transitions update lastTransitionAt + carry the reason.
//   - Metrics aggregate counts by state for health surface.

const stubChromeStorage = (): { reset: () => void } => {
  const store: Record<string, unknown> = {};
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
  return {
    reset: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
  };
};

const entry = (seq: number, state: SpoolEntry['state'] = 'spooled'): SpoolEntry => ({
  edgeDot: { replicaId: 'edge_test', seq },
  clientEventId: `evt-${seq}`,
  surface: 'threads',
  payload: { seq },
  state,
  createdAt: '2026-05-07T00:00:00.000Z',
  lastTransitionAt: '2026-05-07T00:00:00.000Z',
});

describe('spool', () => {
  let stub: ReturnType<typeof stubChromeStorage>;

  beforeEach(() => {
    stub = stubChromeStorage();
  });

  afterEach(() => {
    stub.reset();
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  it('append is idempotent on edgeDot — re-spooling same dot is a no-op', async () => {
    const r1 = await spoolAppend('threads', entry(1));
    const r2 = await spoolAppend('threads', entry(1));
    expect(r1.added).toBe(true);
    expect(r2.added).toBe(false);
    const all = await readSpool('threads');
    expect(all).toHaveLength(1);
  });

  it('transition updates state + lastTransitionAt + carries reason', async () => {
    await spoolAppend('threads', entry(1));
    await spoolTransition('threads', entry(1).edgeDot, 'failed-explicit', 'spool-full');
    const all = await readSpool('threads');
    expect(all[0]?.state).toBe('failed-explicit');
    expect(all[0]?.reason).toBe('spool-full');
  });

  it('remove drops the entry by edgeDot', async () => {
    await spoolAppend('threads', entry(1));
    await spoolAppend('threads', entry(2));
    await spoolRemove('threads', entry(1).edgeDot);
    const all = await readSpool('threads');
    expect(all.map((e) => e.edgeDot.seq)).toEqual([2]);
  });

  it('metrics aggregates counts per state', async () => {
    await spoolAppend('threads', entry(1, 'spooled'));
    await spoolAppend('threads', entry(2, 'spooled'));
    await spoolAppend('threads', entry(3, 'failed-explicit'));
    const m = await spoolMetrics('threads');
    expect(m.total).toBe(3);
    expect(m.byState.spooled).toBe(2);
    expect(m.byState['failed-explicit']).toBe(1);
  });
});
