import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ActiveTimelineObservation,
  BrowserTimelineObservedPayload,
} from '../../../src/timeline/events';
import {
  observationFromPayload,
  resetTimelineMaterializerStateForTests,
  setCompanionReachableForTimeline,
  setTimelineDrainHook,
  timelineHealthSnapshot,
  timelinePluginMaterializer,
} from '../../../src/timeline/materializer';
import { readSpool, spoolTransition } from '../../../src/sync/spool';

// Plugin-tier timeline materializer tests:
//   - admitLocal active → spool transition.
//   - passive overflow → dropped-passive-by-policy + counter.
//   - drain idempotency on edge dot.
//   - drain partial-success rolls remaining entries back to spooled.
//   - health surface reflects active/spool sizes.

const SPOOL_KEY = 'sidetrack.sync.spool.timeline';
const EDGE_KEY = 'sidetrack.sync.edgeReplicaId';

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

const buildPayload = (
  overrides: Partial<BrowserTimelineObservedPayload> = {},
): BrowserTimelineObservedPayload => ({
  eventId: overrides.eventId ?? `evt-${Math.random()}`,
  observedAt: overrides.observedAt ?? '2026-05-07T10:00:00.000Z',
  url: overrides.url ?? 'https://x/a',
  transition: overrides.transition ?? 'activated',
  ...(overrides.canonicalUrl === undefined ? {} : { canonicalUrl: overrides.canonicalUrl }),
  ...(overrides.title === undefined ? {} : { title: overrides.title }),
  ...(overrides.provider === undefined ? {} : { provider: overrides.provider }),
  ...(overrides.tabIdHash === undefined ? {} : { tabIdHash: overrides.tabIdHash }),
  ...(overrides.windowIdHash === undefined ? {} : { windowIdHash: overrides.windowIdHash }),
});

describe('timeline plugin materializer (Class F)', () => {
  let stub: ReturnType<typeof stubChromeStorage>;
  beforeEach(() => {
    stub = stubChromeStorage();
    resetTimelineMaterializerStateForTests();
    setTimelineDrainHook(null);
  });
  afterEach(() => {
    stub.reset();
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  it('admitLocal returns ok with tier=active for a fresh observation', async () => {
    const result = await timelinePluginMaterializer.admitLocal(
      observationFromPayload(buildPayload()),
      'passive',
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tier).toBe('active');
    const spool = await readSpool('timeline');
    expect(spool).toHaveLength(1);
    expect(spool[0]?.state).toBe('active');
  });

  it('passive overflow returns dropped-passive-by-policy and increments counter', async () => {
    // Force active + spool to full by repeatedly admitting until rejected.
    // The default budget is large; for the test we monkey-patch the
    // existing entries directly.
    const cap = 200;
    const passiveCap = 800;
    const total = cap + passiveCap;
    // Pre-populate spool storage to simulate a full plugin.
    const fullEntries = Array.from({ length: total }, (_, i) => ({
      edgeDot: { replicaId: 'edge_test', seq: i + 1 },
      clientEventId: `pre-${String(i)}`,
      surface: 'timeline',
      payload: buildPayload({
        eventId: `pre-${String(i)}`,
        observedAt: `2026-05-07T${String(i % 24).padStart(2, '0')}:00:00.000Z`,
      }),
      state: i < cap ? 'active' : 'spooled',
      createdAt: '2026-05-07T00:00:00.000Z',
      lastTransitionAt: '2026-05-07T00:00:00.000Z',
    }));
    await (
      globalThis as unknown as {
        chrome: { storage: { local: { set: (e: Record<string, unknown>) => Promise<void> } } };
      }
    ).chrome.storage.local.set({ [SPOOL_KEY]: fullEntries });

    const result = await timelinePluginMaterializer.admitLocal(
      observationFromPayload(buildPayload({ eventId: 'overflow' })),
      'passive',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('spool-full-passive-policy-drop');
    const health = timelinePluginMaterializer.health();
    expect(health.droppedPassiveCount).toBeGreaterThanOrEqual(1);
  });

  it('drain pushes spooled entries through the hook and removes them after ack', async () => {
    // Seed an edge replica id so allocateNextSeq doesn't generate one.
    await (
      globalThis as unknown as {
        chrome: { storage: { local: { set: (e: Record<string, unknown>) => Promise<void> } } };
      }
    ).chrome.storage.local.set({
      [EDGE_KEY]: { edgeReplicaId: 'edge_test', nextSeq: 1 },
    });
    // Admit two observations.
    await timelinePluginMaterializer.admitLocal(
      observationFromPayload(buildPayload({ eventId: 'a' })),
      'passive',
    );
    await timelinePluginMaterializer.admitLocal(
      observationFromPayload(buildPayload({ eventId: 'b' })),
      'passive',
    );
    let spool = await readSpool('timeline');
    expect(spool).toHaveLength(2);

    // Inject a drain hook that acks every dot.
    setTimelineDrainHook(async (entries) => ({
      uploaded: entries.map((e) => e.edgeDot),
    }));
    const result = await timelinePluginMaterializer.drainSpoolToCompanion();
    expect(result.uploaded).toBe(2);
    spool = await readSpool('timeline');
    expect(spool).toHaveLength(0);
  });

  it('drain failure rolls remaining entries back to spooled for retry', async () => {
    await (
      globalThis as unknown as {
        chrome: { storage: { local: { set: (e: Record<string, unknown>) => Promise<void> } } };
      }
    ).chrome.storage.local.set({
      [EDGE_KEY]: { edgeReplicaId: 'edge_test', nextSeq: 1 },
    });
    await timelinePluginMaterializer.admitLocal(
      observationFromPayload(buildPayload({ eventId: 'a' })),
      'passive',
    );

    setTimelineDrainHook(async () => {
      throw new Error('network down');
    });
    const result = await timelinePluginMaterializer.drainSpoolToCompanion();
    expect(result.uploaded).toBe(0);
    const spool = await readSpool('timeline');
    expect(spool).toHaveLength(1);
    expect(spool[0]?.state).toBe('spooled');
    expect(timelinePluginMaterializer.health().lastError).toContain('network down');
  });

  it('drain partial-success rolls un-acked entries back to spooled (self-review fix)', async () => {
    await (
      globalThis as unknown as {
        chrome: { storage: { local: { set: (e: Record<string, unknown>) => Promise<void> } } };
      }
    ).chrome.storage.local.set({
      [EDGE_KEY]: { edgeReplicaId: 'edge_test', nextSeq: 1 },
    });
    await timelinePluginMaterializer.admitLocal(
      observationFromPayload(buildPayload({ eventId: 'a' })),
      'passive',
    );
    await timelinePluginMaterializer.admitLocal(
      observationFromPayload(buildPayload({ eventId: 'b' })),
      'passive',
    );
    // Companion acks the FIRST dot but not the second — partial
    // upload (e.g., server interrupted between events).
    setTimelineDrainHook(async (entries) => ({
      uploaded: entries.length > 0 && entries[0] !== undefined ? [entries[0].edgeDot] : [],
    }));
    const result = await timelinePluginMaterializer.drainSpoolToCompanion();
    expect(result.uploaded).toBe(1);
    const spool = await readSpool('timeline');
    // Acked entry is gone; un-acked entry returned to 'spooled'
    // (NOT stuck in 'pending-send' forever).
    expect(spool).toHaveLength(1);
    expect(spool[0]?.state).toBe('spooled');
  });

  it('drain retries entries orphaned in pending-send by a prior crashed drain', async () => {
    // Observed in the wild: SW killed mid-drain (or rollback loop
    // missed an entry on a readSpool race) leaves entries in
    // 'pending-send' indefinitely. Without this fix the drain
    // filter only included 'active' | 'spooled', so every subsequent
    // drain reported drainableCount=0 even though pending-send
    // entries existed — they were orphaned forever.
    await (
      globalThis as unknown as {
        chrome: { storage: { local: { set: (e: Record<string, unknown>) => Promise<void> } } };
      }
    ).chrome.storage.local.set({
      [EDGE_KEY]: { edgeReplicaId: 'edge_test', nextSeq: 1 },
    });
    await timelinePluginMaterializer.admitLocal(
      observationFromPayload(buildPayload({ eventId: 'a' })),
      'passive',
    );
    // Simulate the orphan: directly transition to pending-send without
    // running the drain that would normally roll it back to spooled.
    const initialSpool = await readSpool('timeline');
    expect(initialSpool).toHaveLength(1);
    const orphanedDot = initialSpool[0]!.edgeDot;
    await spoolTransition('timeline', orphanedDot, 'pending-send');
    expect((await readSpool('timeline'))[0]?.state).toBe('pending-send');

    // Companion confirms it had already imported the entry (the
    // common cause: the prior POST succeeded but the SW died before
    // running the ack handler).
    setTimelineDrainHook(async (entries) => ({
      uploaded: entries.map((e) => e.edgeDot),
    }));
    const result = await timelinePluginMaterializer.drainSpoolToCompanion();
    expect(result.uploaded).toBe(1);
    expect(result.remaining).toBe(0);
    expect(await readSpool('timeline')).toHaveLength(0);
  });

  it('drain idempotency: second drain over the same entries is a no-op once acked', async () => {
    await (
      globalThis as unknown as {
        chrome: { storage: { local: { set: (e: Record<string, unknown>) => Promise<void> } } };
      }
    ).chrome.storage.local.set({
      [EDGE_KEY]: { edgeReplicaId: 'edge_test', nextSeq: 1 },
    });
    await timelinePluginMaterializer.admitLocal(
      observationFromPayload(buildPayload({ eventId: 'a' })),
      'passive',
    );
    setTimelineDrainHook(async (entries) => ({
      uploaded: entries.map((e) => e.edgeDot),
    }));
    const r1 = await timelinePluginMaterializer.drainSpoolToCompanion();
    expect(r1.uploaded).toBe(1);
    const r2 = await timelinePluginMaterializer.drainSpoolToCompanion();
    expect(r2.uploaded).toBe(0);
    expect(r2.remaining).toBe(0);
  });

  it('healthSnapshot reflects active + spool sizes', async () => {
    await (
      globalThis as unknown as {
        chrome: { storage: { local: { set: (e: Record<string, unknown>) => Promise<void> } } };
      }
    ).chrome.storage.local.set({
      [EDGE_KEY]: { edgeReplicaId: 'edge_test', nextSeq: 1 },
    });
    await timelinePluginMaterializer.admitLocal(
      observationFromPayload(buildPayload({ eventId: 'a' })),
      'passive',
    );
    const health = await timelineHealthSnapshot();
    expect(health.activeSetSize).toBeGreaterThanOrEqual(1);
    expect(health.activeSetBudget).toBeGreaterThan(0);
  });

  it('companionReachable flag flows through to health', async () => {
    setCompanionReachableForTimeline(true);
    expect(timelinePluginMaterializer.health().companionReachable).toBe(true);
    setCompanionReachableForTimeline(false);
    expect(timelinePluginMaterializer.health().companionReachable).toBe(false);
  });
});
