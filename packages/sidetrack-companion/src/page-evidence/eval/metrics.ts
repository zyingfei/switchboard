export interface SimilarityGoldPair {
  readonly fromCanonicalUrl: string;
  readonly toCanonicalUrl: string;
  readonly label: 'related' | 'unrelated';
  readonly group?: string;
  readonly rationale?: string;
}

export interface SimilarityResult {
  readonly fromCanonicalUrl: string;
  readonly toCanonicalUrl: string;
  readonly score: number;
}

const pairKey = (left: string, right: string): string =>
  left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;

const positiveGoldBySource = (
  gold: readonly SimilarityGoldPair[],
): ReadonlyMap<string, ReadonlySet<string>> => {
  const out = new Map<string, Set<string>>();
  for (const row of gold) {
    if (row.label !== 'related') continue;
    const left = out.get(row.fromCanonicalUrl) ?? new Set<string>();
    left.add(row.toCanonicalUrl);
    out.set(row.fromCanonicalUrl, left);
    const right = out.get(row.toCanonicalUrl) ?? new Set<string>();
    right.add(row.fromCanonicalUrl);
    out.set(row.toCanonicalUrl, right);
  }
  return out;
};

const rankedBySource = (
  results: readonly SimilarityResult[],
): ReadonlyMap<string, readonly string[]> => {
  const out = new Map<string, SimilarityResult[]>();
  for (const result of results) {
    const left = out.get(result.fromCanonicalUrl) ?? [];
    left.push(result);
    out.set(result.fromCanonicalUrl, left);
    const right = out.get(result.toCanonicalUrl) ?? [];
    right.push({
      fromCanonicalUrl: result.toCanonicalUrl,
      toCanonicalUrl: result.fromCanonicalUrl,
      score: result.score,
    });
    out.set(result.toCanonicalUrl, right);
  }
  const mapped = new Map<string, readonly string[]>();
  for (const [source, rows] of out) {
    mapped.set(
      source,
      rows
        .sort(
          (left, right) =>
            right.score - left.score || left.toCanonicalUrl.localeCompare(right.toCanonicalUrl),
        )
        .map((row) => row.toCanonicalUrl),
    );
  }
  return mapped;
};

export const recallAtK = (
  results: readonly SimilarityResult[],
  gold: readonly SimilarityGoldPair[],
  k: number,
): number => {
  const positives = positiveGoldBySource(gold);
  const ranked = rankedBySource(results);
  let hit = 0;
  let total = 0;
  for (const [source, targets] of positives) {
    total += targets.size;
    const top = new Set((ranked.get(source) ?? []).slice(0, k));
    for (const target of targets) {
      if (top.has(target)) hit += 1;
    }
  }
  return total === 0 ? 0 : hit / total;
};

export const precisionAtK = (
  results: readonly SimilarityResult[],
  gold: readonly SimilarityGoldPair[],
  k: number,
): number => {
  const positivePairs = new Set(
    gold
      .filter((row) => row.label === 'related')
      .map((row) => pairKey(row.fromCanonicalUrl, row.toCanonicalUrl)),
  );
  const ranked = rankedBySource(results);
  let hit = 0;
  let total = 0;
  for (const [source, targets] of ranked) {
    for (const target of targets.slice(0, k)) {
      total += 1;
      if (positivePairs.has(pairKey(source, target))) hit += 1;
    }
  }
  return total === 0 ? 0 : hit / total;
};

export const mrr = (
  results: readonly SimilarityResult[],
  gold: readonly SimilarityGoldPair[],
): number => {
  const positives = positiveGoldBySource(gold);
  const ranked = rankedBySource(results);
  let total = 0;
  let score = 0;
  for (const [source, targets] of positives) {
    total += 1;
    const rows = ranked.get(source) ?? [];
    const firstIndex = rows.findIndex((target) => targets.has(target));
    if (firstIndex >= 0) score += 1 / (firstIndex + 1);
  }
  return total === 0 ? 0 : score / total;
};

export const noiseRateAtThreshold = (
  results: readonly SimilarityResult[],
  gold: readonly SimilarityGoldPair[],
  threshold: number,
): number => {
  const knownUnrelated = new Set(
    gold
      .filter((row) => row.label === 'unrelated')
      .map((row) => pairKey(row.fromCanonicalUrl, row.toCanonicalUrl)),
  );
  const emitted = results.filter((row) => row.score >= threshold);
  if (emitted.length === 0) return 0;
  const falsePositive = emitted.filter((row) =>
    knownUnrelated.has(pairKey(row.fromCanonicalUrl, row.toCanonicalUrl)),
  ).length;
  return falsePositive / emitted.length;
};
