import { describe, expect, it } from 'vitest';

import {
  TemporalSilhouetteTracker,
  computeRevisionSilhouette,
  type SilhouetteSimilarityEdge,
  type SilhouetteTopic,
} from './temporalSilhouette.js';

// Assert-non-null without a `!` (the repo lint forbids non-null
// assertions, including in tests).
const notNull = (value: number | null): number => {
  expect(value).not.toBeNull();
  return value ?? Number.NaN;
};

// Build a fully-connected edge set within each topic at `intra`
// cosine, and between every cross-topic pair at `inter` cosine.
const syntheticEdges = (
  topics: readonly SilhouetteTopic[],
  intra: number,
  inter: number,
): SilhouetteSimilarityEdge[] => {
  const edges: SilhouetteSimilarityEdge[] = [];
  topics.forEach((topic, ti) => {
    const members = topic.memberCanonicalUrls;
    members.forEach((from, i) => {
      members.slice(i + 1).forEach((to) => {
        edges.push({ fromVisitKey: from, toVisitKey: to, cosine: intra });
      });
    });
    topics.slice(ti + 1).forEach((otherTopic) => {
      for (const a of members) {
        for (const b of otherTopic.memberCanonicalUrls) {
          edges.push({ fromVisitKey: a, toVisitKey: b, cosine: inter });
        }
      }
    });
  });
  return edges;
};

const twoTopics: readonly SilhouetteTopic[] = [
  { topicId: 't1', memberCanonicalUrls: ['a1', 'a2', 'a3'] },
  { topicId: 't2', memberCanonicalUrls: ['b1', 'b2', 'b3'] },
];

describe('computeRevisionSilhouette', () => {
  it('returns null silhouette when there are fewer than two topics', () => {
    const result = computeRevisionSilhouette(
      'r1',
      [{ topicId: 't', memberCanonicalUrls: ['x', 'y'] }],
      [{ fromVisitKey: 'x', toVisitKey: 'y', cosine: 0.9 }],
    );
    expect(result.silhouette).toBeNull();
    expect(result.topicCount).toBe(1);
  });

  it('scores well-separated, cohesive topics near +1', () => {
    const edges = syntheticEdges(twoTopics, 0.98, -0.9);
    const result = computeRevisionSilhouette('r1', twoTopics, edges);
    expect(notNull(result.silhouette)).toBeGreaterThan(0.8);
    expect(result.meanCohesion).toBeGreaterThan(0.9);
    expect(result.meanSeparation).toBeGreaterThan(0.8);
  });

  it('is MONOTONIC: clearer separation never lowers the silhouette', () => {
    // Sweep inter-topic similarity from "almost same as intra" (bad
    // separation) down to "very dissimilar" (good separation). The
    // silhouette must be non-decreasing as separation improves.
    const intra = 0.95;
    const inters = [0.94, 0.8, 0.5, 0.0, -0.5, -0.95];
    let previous = Number.NEGATIVE_INFINITY;
    for (const inter of inters) {
      const edges = syntheticEdges(twoTopics, intra, inter);
      const s = notNull(computeRevisionSilhouette('r', twoTopics, edges).silhouette);
      expect(s).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = s;
    }
  });

  it('is MONOTONIC: tighter cohesion never lowers the silhouette', () => {
    const inter = -0.5;
    const intras = [0.0, 0.3, 0.6, 0.9, 0.99];
    let previous = Number.NEGATIVE_INFINITY;
    for (const intra of intras) {
      const edges = syntheticEdges(twoTopics, intra, inter);
      const s = notNull(computeRevisionSilhouette('r', twoTopics, edges).silhouette);
      expect(s).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = s;
    }
  });

  it('scores overlapping topics low (near 0 or negative)', () => {
    // Intra similarity LOWER than inter similarity → members are
    // closer to the other topic than their own: bad clustering.
    const edges = syntheticEdges(twoTopics, 0.2, 0.95);
    const s = notNull(computeRevisionSilhouette('r', twoTopics, edges).silhouette);
    expect(s).toBeLessThan(0.1);
  });
});

describe('TemporalSilhouetteTracker', () => {
  it('reports the delta vs the previous distinct revision', () => {
    const tracker = new TemporalSilhouetteTracker();
    const r1 = computeRevisionSilhouette('r1', twoTopics, syntheticEdges(twoTopics, 0.95, -0.9));
    const o1 = tracker.record(r1);
    expect(o1.previousSilhouette).toBeNull();
    expect(o1.delta).toBeNull();

    const r2 = computeRevisionSilhouette('r2', twoTopics, syntheticEdges(twoTopics, 0.5, 0.4));
    const o2 = tracker.record(r2);
    const r1Sil = notNull(r1.silhouette);
    const r2Sil = notNull(r2.silhouette);
    expect(o2.previousSilhouette).toBeCloseTo(r1Sil, 6);
    expect(notNull(o2.delta)).toBeLessThan(0); // quality dropped
    expect(notNull(o2.delta)).toBeCloseTo(r2Sil - r1Sil, 6);
  });

  it('is idempotent when the same revision id is recorded twice', () => {
    const tracker = new TemporalSilhouetteTracker();
    const r1 = computeRevisionSilhouette('r1', twoTopics, syntheticEdges(twoTopics, 0.95, -0.9));
    const r2 = computeRevisionSilhouette('r2', twoTopics, syntheticEdges(twoTopics, 0.5, 0.4));
    tracker.record(r1);
    const first = tracker.record(r2);
    const repeat = tracker.record(r2);
    expect(repeat.delta).toEqual(first.delta);
    expect(repeat.previousSilhouette).toEqual(first.previousSilhouette);
    // State did not grow on the repeat.
    expect(tracker.toState().revisionIds).toEqual(['r1', 'r2']);
  });

  it('bounds retained history', () => {
    const tracker = new TemporalSilhouetteTracker({ history: 3 });
    for (let i = 0; i < 10; i += 1) {
      tracker.record(
        computeRevisionSilhouette(`r${String(i)}`, twoTopics, syntheticEdges(twoTopics, 0.9, -0.5)),
      );
    }
    expect(tracker.toState().revisionIds).toEqual(['r7', 'r8', 'r9']);
  });

  it('round-trips state', () => {
    const tracker = new TemporalSilhouetteTracker();
    tracker.record(
      computeRevisionSilhouette('r1', twoTopics, syntheticEdges(twoTopics, 0.9, -0.5)),
    );
    tracker.record(
      computeRevisionSilhouette('r2', twoTopics, syntheticEdges(twoTopics, 0.8, -0.2)),
    );
    const restored = TemporalSilhouetteTracker.fromState(
      JSON.parse(JSON.stringify(tracker.toState())),
    );
    const next = computeRevisionSilhouette('r3', twoTopics, syntheticEdges(twoTopics, 0.7, 0.0));
    const a = tracker.record(next);
    const b = restored.record(next);
    expect(b).toEqual(a);
  });

  it('falls back to empty state on a corrupt blob', () => {
    expect(TemporalSilhouetteTracker.fromState(null).toState().revisionIds).toEqual([]);
    expect(
      TemporalSilhouetteTracker.fromState({ revisionIds: [1], silhouettes: [0.1] }).toState()
        .revisionIds,
    ).toEqual([]);
  });

  it('rejects an invalid history option', () => {
    expect(() => new TemporalSilhouetteTracker({ history: 1 })).toThrow(RangeError);
  });
});
