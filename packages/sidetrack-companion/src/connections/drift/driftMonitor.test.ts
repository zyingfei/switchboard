import { describe, expect, it } from 'vitest';

import {
  DriftMonitor,
  extractDriftSamples,
  loadDriftMonitor,
  persistDriftMonitor,
  type DriftMonitorObservation,
} from './driftMonitor.js';
import type { DriftPersistedState, DriftStateStore } from './driftStateStore.js';
import type { SilhouetteSimilarityEdge, SilhouetteTopic } from './temporalSilhouette.js';

const lcg = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
};

const topics: readonly SilhouetteTopic[] = [
  { topicId: 't1', memberCanonicalUrls: ['a1', 'a2', 'a3'] },
  { topicId: 't2', memberCanonicalUrls: ['b1', 'b2', 'b3'] },
];

const edges = (intra: number, inter: number): SilhouetteSimilarityEdge[] => {
  const out: SilhouetteSimilarityEdge[] = [];
  for (const t of topics) {
    const m = t.memberCanonicalUrls;
    m.forEach((from, i) => {
      m.slice(i + 1).forEach((to) => {
        out.push({ fromVisitKey: from, toVisitKey: to, cosine: intra });
      });
    });
  }
  const [first, second] = topics;
  if (first !== undefined && second !== undefined) {
    for (const a of first.memberCanonicalUrls) {
      for (const b of second.memberCanonicalUrls) {
        out.push({ fromVisitKey: a, toVisitKey: b, cosine: inter });
      }
    }
  }
  return out;
};

const obs = (
  rev: string,
  samples: { readonly name: string; readonly value: number }[],
  intra = 0.95,
  inter = -0.8,
): DriftMonitorObservation => ({
  samples,
  revisionId: rev,
  topics,
  similarityEdges: edges(intra, inter),
});

// In-memory store double mirroring the DriftStateStore contract.
const memoryStore = (): DriftStateStore & { current: () => DriftPersistedState | null } => {
  let saved: DriftPersistedState | null = null;
  return {
    read: (): Promise<DriftPersistedState | null> => Promise.resolve(saved),
    write: (state: DriftPersistedState): Promise<void> => {
      saved = structuredClone(state);
      return Promise.resolve();
    },
    current: (): DriftPersistedState | null => saved,
  };
};

describe('extractDriftSamples', () => {
  it('always emits the four base signals', () => {
    const s = extractDriftSamples({
      similarityEdgeCount: 5,
      topicCount: 2,
      topicMemberCount: 6,
      snapshotEdgeCount: 10,
    });
    expect(s.map((x) => x.name).sort()).toEqual(
      ['similarityEdgeCount', 'snapshotEdgeCount', 'topicCount', 'topicMemberCount'].sort(),
    );
  });

  it('adds shadow signals when the shadow block is present', () => {
    const s = extractDriftSamples({
      similarityEdgeCount: 5,
      topicCount: 2,
      topicMemberCount: 6,
      snapshotEdgeCount: 10,
      shadow: {
        perVisitChurn: 0.1,
        noiseShare: 0.2,
        edgeCountBeforePruning: 100,
        edgeCountAfterPruning: 40,
        maxTopicSizeDelta: -3,
      },
    });
    expect(s.map((x) => x.name)).toContain('perVisitChurn');
    expect(s.map((x) => x.name)).toContain('noiseShare');
    expect(s).toHaveLength(9);
  });
});

describe('DriftMonitor', () => {
  it('stays stable on a stationary stream and emits a status every drain', () => {
    const monitor = new DriftMonitor(null);
    const rand = lcg(5);
    let driftDrains = 0;
    let warningDrains = 0;
    for (let i = 0; i < 300; i += 1) {
      const r = monitor.observe(
        obs(`r${String(i)}`, [
          { name: 'similarityEdgeCount', value: 100 + 3 * rand() },
          { name: 'topicCount', value: 8 + rand() },
          { name: 'topicMemberCount', value: 50 + 2 * rand() },
          { name: 'snapshotEdgeCount', value: 200 + 4 * rand() },
        ]),
      );
      expect(['stable', 'warning', 'drift']).toContain(r.status);
      expect(r.signals).toHaveLength(4);
      if (r.status === 'drift') driftDrains += 1;
      if (r.status === 'warning') warningDrains += 1;
    }
    // Hard guarantee: a stationary stream NEVER produces a confirmed
    // drift (the false-positive contract — the monitor's default
    // KSWIN alpha is tuned for exactly this). Soft KSWIN warnings near
    // the band are statistically expected over 1200 detector updates
    // and only need to stay rare.
    expect(driftDrains).toBe(0);
    expect(warningDrains).toBeLessThanOrEqual(10);
  });

  it('reports drift and the tripped signal on an abrupt shift', () => {
    const monitor = new DriftMonitor(null);
    for (let i = 0; i < 200; i += 1) {
      monitor.observe(obs(`r${String(i)}`, [{ name: 'noiseShare', value: 0.05 }]));
    }
    let drifted = false;
    let tripped: readonly string[] = [];
    for (let i = 200; i < 360; i += 1) {
      const r = monitor.observe(obs(`r${String(i)}`, [{ name: 'noiseShare', value: 0.85 }]));
      if (r.status === 'drift') {
        drifted = true;
        tripped = r.trippedSignals;
        break;
      }
    }
    expect(drifted).toBe(true);
    expect(tripped).toContain('noiseShare');
  });

  it('flags a warning when the silhouette drops sharply even with stable counters', () => {
    const monitor = new DriftMonitor(null);
    // Good clustering first.
    monitor.observe(obs('r1', [{ name: 'topicCount', value: 5 }], 0.97, -0.9));
    // Sharp collapse in cluster quality next; counters unchanged.
    const r = monitor.observe(obs('r2', [{ name: 'topicCount', value: 5 }], 0.2, 0.9));
    expect(r.silhouette.delta).not.toBeNull();
    expect(r.silhouette.delta ?? 0).toBeLessThan(0);
    expect(r.status).toBe('warning');
  });

  it('processes samples in a deterministic order regardless of input order', () => {
    const a = new DriftMonitor(null);
    const b = new DriftMonitor(null);
    const ra = a.observe(
      obs('r1', [
        { name: 'topicCount', value: 3 },
        { name: 'noiseShare', value: 0.1 },
      ]),
    );
    const rb = b.observe(
      obs('r1', [
        { name: 'noiseShare', value: 0.1 },
        { name: 'topicCount', value: 3 },
      ]),
    );
    expect(rb.signals).toEqual(ra.signals);
  });

  it('round-trips through the state store and resumes detection', async () => {
    const store = memoryStore();
    const m1 = await loadDriftMonitor(store);
    for (let i = 0; i < 150; i += 1) {
      m1.observe(obs(`r${String(i)}`, [{ name: 'noiseShare', value: 0.05 }]));
    }
    const persisted = await persistDriftMonitor(store, m1, '2026-05-15T00:00:00.000Z');
    expect(persisted.persisted).toBe(true);
    expect(store.current()).not.toBeNull();

    // Fresh monitor restored from disk should detect the shift the
    // same as the original continuing in memory.
    const restored = await loadDriftMonitor(store);
    let restoredDrift = -1;
    let originalDrift = -1;
    for (let i = 150; i < 320; i += 1) {
      const ro = m1.observe(obs(`r${String(i)}`, [{ name: 'noiseShare', value: 0.9 }]));
      const rr = restored.observe(obs(`r${String(i)}`, [{ name: 'noiseShare', value: 0.9 }]));
      if (ro.status === 'drift' && originalDrift === -1) originalDrift = i;
      if (rr.status === 'drift' && restoredDrift === -1) restoredDrift = i;
    }
    expect(restoredDrift).toBeGreaterThanOrEqual(0);
    expect(restoredDrift).toBe(originalDrift);
  });

  it('starts fresh when the store read throws (never propagates)', async () => {
    const throwingStore: DriftStateStore = {
      read: (): Promise<DriftPersistedState | null> => Promise.reject(new Error('disk gone')),
      write: (): Promise<void> => Promise.reject(new Error('disk gone')),
    };
    const monitor = await loadDriftMonitor(throwingStore);
    expect(() => monitor.observe(obs('r1', [{ name: 'topicCount', value: 1 }]))).not.toThrow();
    const persisted = await persistDriftMonitor(throwingStore, monitor, 'now');
    expect(persisted.persisted).toBe(false);
    expect(persisted.error).toBe('disk gone');
  });

  it('lazily starts detectors for signals that appear mid-stream', () => {
    const monitor = new DriftMonitor(null);
    monitor.observe(obs('r1', [{ name: 'topicCount', value: 3 }]));
    // Shadow signal appears later (operator enabled the candidate).
    const r = monitor.observe(
      obs('r2', [
        { name: 'topicCount', value: 3 },
        { name: 'perVisitChurn', value: 0.2 },
      ]),
    );
    expect(r.signals.map((s) => s.name).sort()).toEqual(['perVisitChurn', 'topicCount']);
    expect(r.status).toBe('stable');
  });
});
