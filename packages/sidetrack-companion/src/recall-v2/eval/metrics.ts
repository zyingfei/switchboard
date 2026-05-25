// Recall v2 — eval metrics.
//
// Pure functions; no I/O. All metrics consume a result list (ordered)
// and a set of labels (must_include / forbidden / etc.) plus K. The
// harness composes these into a per-fixture report.

import type { RecallCandidate, RecallSourceKind } from '../types.js';

/** Recall@K — fraction of must-include URLs present in the top K. */
export const recallAtK = (
  results: readonly RecallCandidate[],
  mustInclude: ReadonlySet<string>,
  k: number,
): number => {
  if (mustInclude.size === 0) return 1;
  const topUrls = new Set(
    results.slice(0, k).map((r) => r.canonicalUrl).filter((u): u is string => u !== undefined),
  );
  let hit = 0;
  for (const url of mustInclude) {
    if (topUrls.has(url)) hit += 1;
  }
  return hit / mustInclude.size;
};

/** Mean Reciprocal Rank — 1/rank of the first must-include hit, 0 if absent.
 *  Single query so MRR == RR; kept named for fixture-level rollup. */
export const mrr = (
  results: readonly RecallCandidate[],
  mustInclude: ReadonlySet<string>,
): number => {
  for (let i = 0; i < results.length; i += 1) {
    const url = results[i]!.canonicalUrl;
    if (url !== undefined && mustInclude.has(url)) {
      return 1 / (i + 1);
    }
  }
  return 0;
};

/** Discounted Cumulative Gain @ K — labels = relevance grade per URL.
 *  Default grades: must_include=3, should_include=2, else=0. */
export const dcgAtK = (
  results: readonly RecallCandidate[],
  labels: ReadonlyMap<string, number>,
  k: number,
): number => {
  let dcg = 0;
  for (let i = 0; i < Math.min(k, results.length); i += 1) {
    const url = results[i]!.canonicalUrl;
    if (url === undefined) continue;
    const gain = labels.get(url) ?? 0;
    if (gain === 0) continue;
    // Standard DCG: gain / log2(rank + 1).
    dcg += gain / Math.log2(i + 2);
  }
  return dcg;
};

/** Ideal DCG @ K — labels sorted descending, capped at K. */
const idcgAtK = (labels: ReadonlyMap<string, number>, k: number): number => {
  const sorted = [...labels.values()].filter((v) => v > 0).sort((a, b) => b - a).slice(0, k);
  let idcg = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    idcg += sorted[i]! / Math.log2(i + 2);
  }
  return idcg;
};

/** nDCG @ K — DCG / IDCG, range [0,1]. Returns 1 when labels are empty. */
export const ndcgAtK = (
  results: readonly RecallCandidate[],
  labels: ReadonlyMap<string, number>,
  k: number,
): number => {
  if (labels.size === 0) return 1;
  const idcg = idcgAtK(labels, k);
  if (idcg === 0) return 1;
  return dcgAtK(results, labels, k) / idcg;
};

/** Self-hit rate — fraction of top-K results that are current-session
 *  artifacts (active chat bac_ids). Should be 0 in steady state. */
export const selfHitRate = (
  results: readonly RecallCandidate[],
  activeChatBacIds: ReadonlySet<string>,
  k: number,
): number => {
  if (k === 0) return 0;
  const slice = results.slice(0, k);
  let hits = 0;
  for (const r of slice) {
    if (r.threadId !== undefined && activeChatBacIds.has(r.threadId)) hits += 1;
  }
  return hits / Math.max(1, slice.length);
};

/** Forbidden-hit rate — fraction of top-K that are in the forbidden set. */
export const forbiddenHitRate = (
  results: readonly RecallCandidate[],
  forbidden: ReadonlySet<string>,
  k: number,
): number => {
  if (k === 0) return 0;
  const slice = results.slice(0, k);
  let hits = 0;
  for (const r of slice) {
    if (r.canonicalUrl !== undefined && forbidden.has(r.canonicalUrl)) hits += 1;
  }
  return hits / Math.max(1, slice.length);
};

/** Duplicate-rate @ K — fraction of duplicated entityIds in the top K. */
export const duplicateRateAtK = (
  results: readonly RecallCandidate[],
  k: number,
): number => {
  if (k === 0) return 0;
  const slice = results.slice(0, k);
  const seen = new Set<string>();
  let dups = 0;
  for (const r of slice) {
    if (seen.has(r.entityId)) dups += 1;
    else seen.add(r.entityId);
  }
  return dups / Math.max(1, slice.length);
};

/** Source-diversity @ K — count of distinct sourceKinds in the top K. */
export const sourceDiversityAtK = (
  results: readonly RecallCandidate[],
  k: number,
): number => {
  const kinds = new Set<RecallSourceKind>();
  for (const r of results.slice(0, k)) kinds.add(r.sourceKind);
  return kinds.size;
};

/** Percentile of a numeric series. p ∈ [0,100]. */
export const percentile = (values: readonly number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  const frac = rank - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
};
