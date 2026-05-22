/**
 * Reciprocal Rank Fusion.
 *
 *   RRF_k(d) = Σ 1 / (k + rank_i(d))
 *
 * across the N input rankers `d` appears in, where `rank_i(d)` is
 * `d`'s 1-indexed position in ranker i. k=60 is the canonical default
 * (Cormack et al., SIGIR'09): close-but-not-equal-rank hits across
 * lists land within the top-K of either ranker rather than letting
 * either alone dominate.
 *
 * RRF is RANK-based, never score-based. That's the property the
 * Unified Content Search v1 contract wants — raw MiniSearch scores
 * (page-content), raw hybrid scores (chat-turn), and cosine
 * similarities (pool) are on incompatible scales; comparing them
 * directly produced quota merges and same-source crowding. RRF
 * normalizes away the scale.
 */

export const RRF_K = 60;

export interface RankedList<T> {
  readonly name: string;
  /** Items in ranker order, position 0 = best. */
  readonly items: readonly T[];
}

/**
 * Per-item fusion result: the contributing ranker names + the rank
 * the item had in each (1-indexed). Caller surfaces this as
 * `rankEvidence` on the response.
 */
export interface FusionRanks {
  readonly perRanker: ReadonlyMap<string, number>;
  readonly fusionScore: number;
  readonly k: number;
}

export interface FusedItem<T> {
  readonly item: T;
  readonly ranks: FusionRanks;
}

/**
 * Fuse N input rankers by RRF. Returns items in fusion-score-desc
 * order. Identity is by `keyOf(item)`; if the SAME key appears in
 * multiple rankers, its `1/(k+rank_i)` contributions are summed —
 * that is the whole point of RRF.
 *
 * Ties in fusion score are broken by ranker order (the input list's
 * order is preserved) — stable.
 */
export const fuseByRank = <T>(
  rankers: readonly RankedList<T>[],
  keyOf: (item: T) => string,
  options: { readonly k?: number } = {},
): FusedItem<T>[] => {
  const k = options.k ?? RRF_K;
  // Accumulate per-key: first-seen item ref + which ranker contributed
  // at what rank.
  const accumulator = new Map<string, { item: T; perRanker: Map<string, number>; order: number }>();
  let insertOrder = 0;
  for (const ranker of rankers) {
    for (let i = 0; i < ranker.items.length; i += 1) {
      const item = ranker.items[i]!;
      const key = keyOf(item);
      const existing = accumulator.get(key);
      if (existing !== undefined) {
        existing.perRanker.set(ranker.name, i + 1);
      } else {
        accumulator.set(key, {
          item,
          perRanker: new Map([[ranker.name, i + 1]]),
          order: insertOrder,
        });
        insertOrder += 1;
      }
    }
  }
  const fused: FusedItem<T>[] = [];
  for (const entry of accumulator.values()) {
    let fusionScore = 0;
    for (const rank of entry.perRanker.values()) fusionScore += 1 / (k + rank);
    fused.push({
      item: entry.item,
      ranks: { perRanker: entry.perRanker, fusionScore, k },
    });
  }
  // Stable sort: fusion score desc, then by original insertion order.
  return fused.sort((a, b) => {
    const diff = b.ranks.fusionScore - a.ranks.fusionScore;
    if (diff !== 0) return diff;
    // Stable tiebreak: keep first-seen order. accumulator preserves
    // insertion order via Map; we encoded `order` above.
    const aOrder = accumulator.get(keyOf(a.item))?.order ?? 0;
    const bOrder = accumulator.get(keyOf(b.item))?.order ?? 0;
    return aOrder - bOrder;
  });
};
