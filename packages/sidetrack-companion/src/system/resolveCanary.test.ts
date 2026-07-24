import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ResolveCanaryWindow,
  createResolveCanary,
  registerResolveCanary,
  unregisterResolveCanary,
  getResolveCanary,
  resolveCanaryStatus,
  resolveCanaryThresholdMs,
  __clearResolveCanaryRegistryForTest,
  type ResolveCanaryPorts,
} from './resolveCanary.js';
import { SqliteConnectionsStore } from '../connections/snapshot.js';
import type { ConnectionNode, ConnectionsSnapshot } from '../connections/types.js';
import { resolveUrlAttribution } from '../tabsession/resolver.js';
import { buildReliabilityHealthSection, withReliabilityHealthSection } from '../http/server.js';
import type { HealthReport } from './health.js';

const sqliteIt = process.versions['bun'] === undefined ? it.skip : it;

// A deterministic clock the canary + window share so pruning / percentiles
// are stable across the test (no wall-clock flake).
const makeClock = (start = 1_000_000) => {
  let nowMs = start;
  return {
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
    set: (ms: number) => {
      nowMs = ms;
    },
  };
};

describe('ResolveCanaryWindow (pure rolling window)', () => {
  it('reports null percentiles / idle when empty', () => {
    const w = new ResolveCanaryWindow({ windowMs: 10_000, maxSamples: 100 });
    const snap = w.snapshot(0);
    expect(snap.sampleCount).toBe(0);
    expect(snap.p50Ms).toBeNull();
    expect(snap.p95Ms).toBeNull();
    expect(snap.maxMs).toBeNull();
    expect(snap.errorCount).toBe(0);
    expect(snap.hasTarget).toBe(false);
  });

  it('computes p50/p95/max + errorCount over in-window samples', () => {
    const w = new ResolveCanaryWindow({ windowMs: 100_000, maxSamples: 100 });
    // durations 10..100 at ten distinct times inside the window
    for (let i = 1; i <= 10; i += 1) {
      w.record({ atMs: i, durationMs: i * 10, ok: i !== 3 });
    }
    const snap = w.snapshot(100);
    expect(snap.sampleCount).toBe(10);
    expect(snap.maxMs).toBe(100);
    // nearest-rank p50 over [10..100] → the 5th value (50)
    expect(snap.p50Ms).toBe(50);
    // nearest-rank p95 → the 10th value (100)
    expect(snap.p95Ms).toBe(100);
    expect(snap.errorCount).toBe(1);
  });

  it('prunes samples older than the window (decay)', () => {
    const w = new ResolveCanaryWindow({ windowMs: 1_000, maxSamples: 100 });
    w.record({ atMs: 0, durationMs: 9_000, ok: true }); // old + very slow
    w.record({ atMs: 1_500, durationMs: 50, ok: true }); // fresh + fast
    // As of 2_000, the old sample (atMs 0) is outside the 1_000 window.
    const snap = w.snapshot(2_000);
    expect(snap.sampleCount).toBe(1);
    expect(snap.maxMs).toBe(50);
    expect(snap.p95Ms).toBe(50);
  });

  it('bounds retained samples to maxSamples', () => {
    const w = new ResolveCanaryWindow({ windowMs: 1_000_000, maxSamples: 5 });
    for (let i = 0; i < 50; i += 1) w.record({ atMs: i, durationMs: i, ok: true });
    expect(w.snapshot(1_000).sampleCount).toBe(5);
  });
});

describe('resolveCanaryStatus + threshold', () => {
  it('idle window is ok (absence of signal is not a failure)', () => {
    const w = new ResolveCanaryWindow({ windowMs: 1_000, maxSamples: 10 });
    expect(resolveCanaryStatus(w.snapshot(0), 5000)).toBe('ok');
  });

  it('fast samples under threshold are ok', () => {
    const w = new ResolveCanaryWindow({ windowMs: 100_000, maxSamples: 10 });
    w.record({ atMs: 1, durationMs: 20, ok: true });
    expect(resolveCanaryStatus(w.snapshot(2), 5000)).toBe('ok');
  });

  it('p95 above threshold is degraded', () => {
    const w = new ResolveCanaryWindow({ windowMs: 100_000, maxSamples: 10 });
    w.record({ atMs: 1, durationMs: 9_000, ok: true });
    expect(resolveCanaryStatus(w.snapshot(2), 5000)).toBe('degraded');
  });

  it('any in-window error is degraded regardless of latency', () => {
    const w = new ResolveCanaryWindow({ windowMs: 100_000, maxSamples: 10 });
    w.record({ atMs: 1, durationMs: 10, ok: false });
    expect(resolveCanaryStatus(w.snapshot(2), 5000)).toBe('degraded');
  });

  it('threshold is env-tunable with a 5000ms default', () => {
    expect(resolveCanaryThresholdMs({})).toBe(5000);
    expect(resolveCanaryThresholdMs({ SIDETRACK_RESOLVE_CANARY_P95_THRESHOLD_MS: '250' })).toBe(
      250,
    );
    expect(resolveCanaryThresholdMs({ SIDETRACK_RESOLVE_CANARY_P95_THRESHOLD_MS: 'nope' })).toBe(
      5000,
    );
  });
});

describe('createResolveCanary (timer-free via injected tick)', () => {
  it('stays idle on an empty vault (pickUrl → null) and never records a sample', async () => {
    const clock = makeClock();
    const ports: ResolveCanaryPorts = {
      pickUrl: async () => null,
      resolveOnce: async () => {
        throw new Error('resolveOnce must not be called when there is no target');
      },
    };
    const canary = createResolveCanary({ ports, now: clock.now, windowMs: 100_000 });
    await canary.tick();
    const snap = canary.snapshot();
    expect(snap.sampleCount).toBe(0);
    expect(snap.hasTarget).toBe(false);
    expect(canary.pinnedUrl()).toBeNull();
  });

  it('records a timed sample through the resolve port and pins the URL', async () => {
    const clock = makeClock();
    let picks = 0;
    const ports: ResolveCanaryPorts = {
      pickUrl: async () => {
        picks += 1;
        return 'https://example.test/page';
      },
      resolveOnce: async () => {
        clock.advance(42); // simulate a 42ms resolve
      },
    };
    const canary = createResolveCanary({ ports, now: clock.now, windowMs: 100_000 });
    await canary.tick();
    await canary.tick();
    const snap = canary.snapshot();
    expect(snap.sampleCount).toBe(2);
    expect(snap.maxMs).toBe(42);
    expect(snap.errorCount).toBe(0);
    expect(canary.pinnedUrl()).toBe('https://example.test/page');
    // URL is pinned after the first success — picked once, reused after.
    expect(picks).toBe(1);
  });

  it('records an errored probe as errorCount, not silence', async () => {
    const clock = makeClock();
    const ports: ResolveCanaryPorts = {
      pickUrl: async () => 'https://example.test/page',
      resolveOnce: async () => {
        clock.advance(5);
        throw new Error('CONNECTIONS_SNAPSHOT_MISSING');
      },
    };
    const canary = createResolveCanary({ ports, now: clock.now, windowMs: 100_000 });
    await canary.tick();
    const snap = canary.snapshot();
    expect(snap.sampleCount).toBe(1);
    expect(snap.errorCount).toBe(1);
    expect(resolveCanaryStatus(snap, 5000)).toBe('degraded');
  });

  it('a slow spike trips degraded, then decays back to ok as fresh fast samples age it out', async () => {
    const clock = makeClock();
    let resolveMs = 9_000; // start slow
    const ports: ResolveCanaryPorts = {
      pickUrl: async () => 'https://example.test/page',
      resolveOnce: async () => {
        clock.advance(resolveMs);
      },
    };
    const canary = createResolveCanary({ ports, now: clock.now, windowMs: 1_000, maxSamples: 100 });
    // One slow sample → degraded.
    await canary.tick();
    expect(resolveCanaryStatus(canary.snapshot(), 5000)).toBe('degraded');
    // Time passes beyond the window; the slow sample ages out.
    resolveMs = 20; // now fast
    clock.advance(2_000);
    await canary.tick(); // fresh fast sample; slow one is pruned
    const snap = canary.snapshot();
    expect(snap.sampleCount).toBe(1);
    expect(snap.maxMs).toBe(20);
    expect(resolveCanaryStatus(snap, 5000)).toBe('ok');
  });

  it('is single-flight: a second tick while one is in flight is a no-op', async () => {
    const clock = makeClock();
    let concurrent = false;
    let inResolve = false;
    let gateResolve: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      gateResolve = resolve;
    });
    let resolveEntered: (() => void) | null = null;
    const entered = new Promise<void>((resolve) => {
      resolveEntered = resolve;
    });
    const ports: ResolveCanaryPorts = {
      pickUrl: async () => 'https://example.test/page',
      resolveOnce: async () => {
        if (inResolve) concurrent = true;
        inResolve = true;
        resolveEntered?.(); // signal the first tick reached resolveOnce
        await gate; // hold the first tick open
        inResolve = false;
      },
    };
    const canary = createResolveCanary({ ports, now: clock.now, windowMs: 100_000 });
    const first = canary.tick();
    await entered; // ensure the first tick is genuinely mid-resolve
    await canary.tick(); // must short-circuit (in flight) → resolves immediately
    gateResolve?.();
    await first;
    expect(concurrent).toBe(false);
    // Only the first tick produced a sample.
    expect(canary.snapshot().sampleCount).toBe(1);
  });
});

// --- Acceptance: real resolve core + health read-back (doctrine rule 10) ----
//
// These drive the SAME resolve core the panel uses (SqliteConnectionsStore
// resolver subgraph + resolveUrlAttribution) and read the section back from
// the /v1/system/health assembly helper, not from an intermediate layer.

const visitNode = (canonicalUrl: string, visitCount: number): ConnectionNode => ({
  id: `timeline-visit:${canonicalUrl}`,
  kind: 'timeline-visit',
  label: canonicalUrl,
  originReplicaIds: [],
  metadata: { canonicalUrl, visitCount },
});

const workstreamNode = (id: string): ConnectionNode => ({
  id: `workstream:${id}`,
  kind: 'workstream',
  label: id,
  originReplicaIds: [],
  metadata: {},
});

const snapshotWithVisits = (): ConnectionsSnapshot => {
  const nodes: ConnectionNode[] = [
    visitNode('https://example.test/most', 42),
    visitNode('https://example.test/other', 3),
    workstreamNode('main'),
  ];
  return {
    scope: {},
    nodes,
    edges: [],
    updatedAt: '2026-07-21T00:00:00.000Z',
    nodeCount: nodes.length,
    edgeCount: 0,
    snapshotRevision: 'rev-canary-accept',
  };
};

describe('resolve canary acceptance — real core + health read-back', () => {
  let vaultRoot = '';

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-canary-'));
    __clearResolveCanaryRegistryForTest();
  });

  afterEach(async () => {
    __clearResolveCanaryRegistryForTest();
    if (vaultRoot.length > 0) await rm(vaultRoot, { recursive: true, force: true });
  });

  sqliteIt('canary records through the real resolve core and health reflects it', async () => {
    const store = new SqliteConnectionsStore(vaultRoot, { databasePath: ':memory:' });
    await store.putCurrent(snapshotWithVisits());

    const clock = makeClock();
    // Ports mirror companion.ts wiring: pick most-visited URL, run the real
    // single-URL resolver subgraph + resolveUrlAttribution.
    const ports: ResolveCanaryPorts = {
      pickUrl: async () => {
        const snapshot = await store.readCurrent();
        if (snapshot === null) return null;
        let best: { url: string; visits: number } | null = null;
        for (const node of snapshot.nodes) {
          if (node.kind !== 'timeline-visit') continue;
          const url = node.metadata.canonicalUrl;
          if (typeof url !== 'string') continue;
          const visits =
            typeof node.metadata.visitCount === 'number' ? node.metadata.visitCount : 0;
          if (best === null || visits > best.visits) best = { url, visits };
        }
        return best?.url ?? null;
      },
      resolveOnce: async (canonicalUrl) => {
        const subgraph = await store.readResolverSubgraphForUrl(canonicalUrl);
        if (subgraph === null) throw new Error('CONNECTIONS_SNAPSHOT_MISSING');
        clock.advance(15); // measured resolve duration
        return resolveUrlAttribution({
          canonicalUrl,
          snapshot: subgraph,
          events: [],
          useEventCandidateSimilarity: false,
        });
      },
    };
    const canary = createResolveCanary({ ports, now: clock.now, windowMs: 100_000 });
    registerResolveCanary(vaultRoot, canary);

    // Drive one real probe cycle.
    await canary.tick();
    expect(canary.pinnedUrl()).toBe('https://example.test/most');

    // Read the section back through the health-assembly helper (rule 1:
    // verify at the artifact the surface reads).
    const section = await buildReliabilityHealthSection(vaultRoot);
    expect(section.resolveCanary.sampleCount).toBe(1);
    expect(section.resolveCanary.hasTarget).toBe(true);
    expect(section.resolveCanary.p95Ms).toBe(15);
    expect(section.resolveCanary.errorCount).toBe(0);
    expect(section.resolveCanary.status).toBe('ok');
    expect(section.availability).toBe('ok');
    // No WAL for an in-memory DB / fresh temp vault → null, not an error.
    expect(section.walBytes).toBeNull();

    // And the folded health report exposes it + stays ok.
    const baseReport = baseHealthReport();
    const folded = withReliabilityHealthSection(baseReport, section);
    expect(folded.reliability.resolveCanary.sampleCount).toBe(1);
    expect(folded.observability?.sections['reliability']).toBe('ok');
    expect(folded.observability?.status).toBe('ok');

    store.close();
    unregisterResolveCanary(vaultRoot);
  });

  sqliteIt(
    'an induced slow resolve trips the health section non-ok, then decays back',
    async () => {
      const store = new SqliteConnectionsStore(vaultRoot, { databasePath: ':memory:' });
      await store.putCurrent(snapshotWithVisits());

      const clock = makeClock();
      let resolveMs = 8_000; // slow: above the 5000ms default threshold
      const ports: ResolveCanaryPorts = {
        pickUrl: async () => 'https://example.test/most',
        resolveOnce: async (canonicalUrl) => {
          const subgraph = await store.readResolverSubgraphForUrl(canonicalUrl);
          if (subgraph === null) throw new Error('CONNECTIONS_SNAPSHOT_MISSING');
          clock.advance(resolveMs);
          return resolveUrlAttribution({
            canonicalUrl,
            snapshot: subgraph,
            events: [],
            useEventCandidateSimilarity: false,
          });
        },
      };
      const canary = createResolveCanary({
        ports,
        now: clock.now,
        windowMs: 1_000,
        maxSamples: 100,
      });
      registerResolveCanary(vaultRoot, canary);

      // Slow probe → section non-ok, top-level health downgraded.
      await canary.tick();
      const slow = await buildReliabilityHealthSection(vaultRoot);
      expect(slow.resolveCanary.status).toBe('degraded');
      expect(slow.availability).toBe('stale');
      const foldedSlow = withReliabilityHealthSection(baseHealthReport(), slow);
      expect(foldedSlow.observability?.sections['reliability']).toBe('stale');
      expect(foldedSlow.observability?.status).toBe('degraded');

      // Fast resolves arrive; the slow sample ages past the 1s window.
      resolveMs = 20;
      clock.advance(2_000);
      await canary.tick();
      const recovered = await buildReliabilityHealthSection(vaultRoot);
      expect(recovered.resolveCanary.sampleCount).toBe(1);
      expect(recovered.resolveCanary.status).toBe('ok');
      expect(recovered.availability).toBe('ok');
      const foldedOk = withReliabilityHealthSection(baseHealthReport(), recovered);
      expect(foldedOk.observability?.sections['reliability']).toBe('ok');
      expect(foldedOk.observability?.status).toBe('ok');

      store.close();
      unregisterResolveCanary(vaultRoot);
    },
  );

  it('health section is idle (not broken) when no canary is registered', async () => {
    expect(getResolveCanary(vaultRoot)).toBeUndefined();
    const section = await buildReliabilityHealthSection(vaultRoot);
    expect(section.resolveCanary.status).toBe('idle');
    expect(section.resolveCanary.sampleCount).toBe(0);
    expect(section.availability).toBe('ok');
  });
});

// Minimal valid HealthReport to fold the reliability section onto. Only the
// fields withReliabilityHealthSection touches (observability) matter here.
const baseHealthReport = (): HealthReport => ({
  uptimeSec: 1,
  vault: { root: '/tmp', writable: true, sizeBytes: 0 },
  capture: { lastByProvider: {}, queueDepthHint: null, droppedHint: null },
  recall: { indexExists: true, entryCount: 0, modelId: null, sizeBytes: null, status: 'ready' },
  service: { installed: true, running: true },
  observability: { asOf: new Date().toISOString(), status: 'ok', sections: {} },
});
