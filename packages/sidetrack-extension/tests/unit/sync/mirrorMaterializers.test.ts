import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PLUGIN_HEALTH_SNAPSHOTS,
  PLUGIN_MATERIALIZERS,
  threadsPluginMaterializer,
  workstreamsPluginMaterializer,
} from '../../../src/sync/mirrorMaterializers';

// Lane 3 follow-up — wraps mirrorRemoteX as PluginMaterializer
// instances. Verifies the registry shape, the static health
// shape, and that mirrorFromCompanion delegates to the existing
// state.ts function (round-trips data into chrome.storage).

const stubChromeStorage = (initial: Record<string, unknown> = {}): { reset: () => void } => {
  const store: Record<string, unknown> = { ...initial };
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

describe('plugin-tier mirror materializers (Class F adoption)', () => {
  let stub: ReturnType<typeof stubChromeStorage>;
  beforeEach(() => {
    stub = stubChromeStorage();
  });
  afterEach(() => {
    stub.reset();
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  it('PLUGIN_MATERIALIZERS registry contains every Class F surface', () => {
    const names = PLUGIN_MATERIALIZERS.map((m) => m.name).sort();
    expect(names).toEqual(['dispatches', 'queue', 'threads', 'timeline', 'workstreams']);
  });

  it('static health() returns a healthy shape for an empty active set', () => {
    const health = threadsPluginMaterializer.health();
    expect(health.status).toBe('healthy');
    expect(health.activeSetSize).toBe(0);
    expect(health.activeSetBudget).toBeGreaterThan(0);
  });

  it('mirrorFromCompanion(threads) round-trips a projection into chrome.storage', async () => {
    // RemoteThreadProjection shape: { bac_id, record, status, deleted }.
    // We feed a minimal one; the mirror function collapses the
    // record register and writes sidetrack.threads.
    await threadsPluginMaterializer.mirrorFromCompanion({
      bac_id: 'th-mat-1',
      record: {
        status: 'resolved',
        value: {
          bac_id: 'th-mat-1',
          provider: 'chatgpt',
          threadUrl: 'https://x',
          title: 'mat probe',
          lastSeenAt: '2026-05-07T00:00:00.000Z',
          tags: [],
        },
      } as never,
      status: { status: 'resolved', value: 'active' } as never,
      deleted: false,
    });
    const stored = (
      await (
        globalThis as unknown as {
          chrome: { storage: { local: { get: (k: string) => Promise<Record<string, unknown>> } } };
        }
      ).chrome.storage.local.get('sidetrack.threads')
    )['sidetrack.threads'];
    expect(Array.isArray(stored)).toBe(true);
    expect(stored as { bac_id: string }[]).toHaveLength(1);
    expect((stored as { bac_id: string }[])[0]?.bac_id).toBe('th-mat-1');
  });

  it('mirrorFromCompanion(workstreams) round-trips into chrome.storage', async () => {
    await workstreamsPluginMaterializer.mirrorFromCompanion({
      bac_id: 'ws-mat-1',
      record: {
        status: 'resolved',
        value: {
          bac_id: 'ws-mat-1',
          title: 'Materializer probe',
          children: [],
          tags: [],
          checklist: [],
        },
      } as never,
      deleted: false,
    });
    const stored = (
      await (
        globalThis as unknown as {
          chrome: { storage: { local: { get: (k: string) => Promise<Record<string, unknown>> } } };
        }
      ).chrome.storage.local.get('sidetrack.workstreams')
    )['sidetrack.workstreams'];
    expect(Array.isArray(stored)).toBe(true);
    expect((stored as { bac_id: string }[])[0]?.bac_id).toBe('ws-mat-1');
  });

  it('async health snapshots reflect chrome.storage counts', async () => {
    // Pre-seed three threads.
    await threadsPluginMaterializer.mirrorFromCompanion({
      bac_id: 'a',
      record: {
        status: 'resolved',
        value: {
          bac_id: 'a',
          provider: 'chatgpt',
          threadUrl: 'https://x',
          title: 'a',
          lastSeenAt: '2026-05-07T00:00:00.000Z',
          tags: [],
        },
      } as never,
      status: { status: 'resolved', value: 'active' } as never,
      deleted: false,
    });
    const [threadsSnapshot] = PLUGIN_HEALTH_SNAPSHOTS;
    expect(threadsSnapshot).toBeDefined();
    const health = await threadsSnapshot!();
    expect(health.activeSetSize).toBe(1);
  });
});
