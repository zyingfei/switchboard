// Medoid prototype selection — prototype lane v2
// (docs/plans/2026-08-16-category-flexibility-hyde.md §11).
//
// WHAT THIS REPLACES. The v1 lane's zh/mixed-language fallback picked
// prototype excerpts by pure recency (`producePrototypeTexts`'s
// most-recent-first dedupe loop, prototypeGeneration.ts). That is a real
// ReDE-RF-style "select, don't generate" move, but "most recent" is not
// "representative" — a workstream whose last five saves happened to be one
// narrow sub-topic would prototype on exactly that sub-topic, forever, until
// the next regeneration. This module generalizes selection to genuine
// k-medoids: REPRESENTATIVE (close to the workstream's own centroid) AND
// DIVERSE (spread across the workstream's actual variance), for every
// workstream, not only non-English ones.
//
// ALGORITHM. Greedy k-medoids / farthest-point diversification — deterministic
// and cheap at these sizes (a workstream's candidate pool is bounded, see
// MEDOID_CANDIDATE_POOL_CAP in prototypeGeneration.ts), not full PAM:
//   1. Compute the candidate pool's centroid (meanNormalized — the same
//      "mean then renormalize" primitive keywordConcepts.ts's centroid folding
//      and splitSuggestionEngine.ts's cluster naming already share).
//   2. First medoid = the member CLOSEST to the centroid (the single most
//      "typical" real page — this is what the old recency-based fallback was
//      trying to approximate without ever measuring it).
//   3. Each subsequent medoid = the member that MAXIMIZES its MINIMUM cosine
//      distance to every medoid already chosen — classic farthest-point
//      sampling, so a fifth pick can never be a near-duplicate of the first
//      four (the report's "one canonical summary collapses to the corpus
//      centroid" failure, generalized to K picks instead of one).
//   4. Deterministic tie-break: lexicographic by member id — repeated calls
//      over an UNCHANGED candidate set always return the SAME K ids in the
//      SAME order, which is what makes this cheap enough to run every dirty
//      tick without a stability/hysteresis mechanism of its own.
//
// OUTLIER EXCLUSION (the pineapple-cake guard — day-one evidence: a food
// page's "Xindongyang Pineapple Cake" terminology landed in an ML
// workstream's prototype set). STRUCTURAL, not domain-based: a member whose
// embedding sits farther from the workstream's own centroid than the
// candidate pool's OWN P90 distance is excluded from medoid candidacy —
// unrelated to what the outlier's content actually IS. Below
// MIN_POOL_FOR_OUTLIER_DETECTION, a percentile over that few points is not a
// meaningful robust statistic, so nothing is excluded (every member counts
// as an inlier) rather than risk excluding a workstream's only evidence.

import { cosine, meanNormalized } from '../suggestions/centroid.js';

export interface EmbeddedMember {
  readonly id: string;
  readonly embedding: Float32Array;
}

/** A percentile needs enough samples to be a meaningful robust statistic —
 *  below this, every candidate is treated as an inlier. Matches this
 *  codebase's other "just above the smallest meaningful sample" floors
 *  (HDBSCAN_TOPIC_MIN_SAMPLES=3, MIN_EVIDENCE_FOR_GENERATION=5). */
export const MIN_POOL_FOR_OUTLIER_DETECTION = 5;

/** The percentile of centroid-distance beyond which a member is excluded —
 *  a judgment call (unspecified numerically by the brief beyond "e.g. P90"),
 *  flagged here for golden-set tuning like every other unspecified numeric
 *  threshold in this feature area. */
export const OUTLIER_DISTANCE_PERCENTILE = 0.9;

/** cosine() (suggestions/centroid.ts) is a plain dot product, valid here
 *  because every embedding this module ever receives is already
 *  L2-normalized (recall/embedder.ts's e5 output, or meanNormalized's own
 *  renormalized centroid) — same assumption prototypeLane.ts's
 *  cosineSimilarityFromL2 documents for the same embedding family. */
const centroidDistance = (embedding: Float32Array, centroid: Float32Array): number =>
  1 - cosine(embedding, centroid);

/**
 * The subset of `members` that are structural outliers relative to the
 * pool's own centroid — farther than the pool's OWN P90 centroid-distance.
 * Pure, deterministic (sorts by distance then id for the percentile-index
 * tie-break), no I/O. Returns an empty set below MIN_POOL_FOR_OUTLIER_DETECTION
 * or when every member is equidistant (nothing to call an outlier).
 */
export const identifyOutliers = (
  members: readonly EmbeddedMember[],
  percentile: number = OUTLIER_DISTANCE_PERCENTILE,
): ReadonlySet<string> => {
  if (members.length < MIN_POOL_FOR_OUTLIER_DETECTION) return new Set();
  const centroid = meanNormalized(members.map((m) => m.embedding));
  if (centroid === null) return new Set();
  const distances = members
    .map((m) => ({ id: m.id, distance: centroidDistance(m.embedding, centroid) }))
    .sort((left, right) =>
      left.distance !== right.distance ? left.distance - right.distance : left.id < right.id ? -1 : 1,
    );
  const clampedPercentile = percentile < 0 ? 0 : percentile > 1 ? 1 : percentile;
  const thresholdIndex = Math.min(
    distances.length - 1,
    Math.floor(clampedPercentile * (distances.length - 1)),
  );
  const threshold = distances[thresholdIndex]!.distance;
  const outliers = new Set<string>();
  for (const entry of distances) {
    if (entry.distance > threshold) outliers.add(entry.id);
  }
  return outliers;
};

/**
 * Greedy k-medoid / farthest-point selection over `members`, excluding any
 * id in `excluded`. Pure, deterministic — see module header for the exact
 * algorithm. Returns fewer than `k` ids only when the eligible pool itself
 * is smaller than `k`; never throws, never pads with duplicates.
 */
export const selectMedoids = (
  members: readonly EmbeddedMember[],
  k: number,
  excluded: ReadonlySet<string> = new Set(),
): readonly string[] => {
  const eligible = members.filter((m) => !excluded.has(m.id));
  if (eligible.length === 0 || k <= 0) return [];

  const centroid = meanNormalized(eligible.map((m) => m.embedding));
  if (centroid === null) return [];

  // First medoid: closest to centroid (most "typical"). Deterministic
  // tie-break by id ascending.
  const byCentroidCloseness = [...eligible].sort((left, right) => {
    const leftDist = centroidDistance(left.embedding, centroid);
    const rightDist = centroidDistance(right.embedding, centroid);
    return leftDist !== rightDist ? leftDist - rightDist : left.id < right.id ? -1 : 1;
  });
  const chosen: EmbeddedMember[] = [byCentroidCloseness[0]!];
  const chosenIds = new Set<string>([chosen[0]!.id]);

  // Remaining k-1: farthest-point / max-min diversification.
  while (chosen.length < k && chosen.length < eligible.length) {
    let best: EmbeddedMember | null = null;
    let bestMinDistance = -Infinity;
    for (const candidate of eligible) {
      if (chosenIds.has(candidate.id)) continue;
      let minDistance = Infinity;
      for (const picked of chosen) {
        const distance = 1 - cosine(candidate.embedding, picked.embedding);
        if (distance < minDistance) minDistance = distance;
      }
      if (
        best === null ||
        minDistance > bestMinDistance ||
        (minDistance === bestMinDistance && candidate.id < best.id)
      ) {
        best = candidate;
        bestMinDistance = minDistance;
      }
    }
    if (best === null) break;
    chosen.push(best);
    chosenIds.add(best.id);
  }

  return chosen.map((m) => m.id);
};
