export interface IndexEntry {
  readonly id: string;
  readonly threadId: string;
  readonly capturedAt: string;
  readonly embedding: Float32Array;
}

export interface RankedItem {
  readonly id: string;
  readonly threadId: string;
  readonly capturedAt: string;
  readonly score: number;
  readonly similarity: number;
  readonly freshness: number;
}

const clampLimit = (limit: number | undefined): number => Math.min(Math.max(limit ?? 10, 1), 50);

const cosine = (left: Float32Array, right: Float32Array): number => {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  for (let index = 0; index < length; index += 1) {
    dot += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return dot;
};

export const freshnessDecay = (capturedAt: string, now: Date): number => {
  const ageMs = now.getTime() - Date.parse(capturedAt);
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  if (ageDays <= 3) {
    return 1;
  }
  if (ageDays <= 21) {
    return 0.85;
  }
  if (ageDays <= 92) {
    return 0.7;
  }
  if (ageDays <= 1096) {
    return 0.5;
  }
  return 0.3;
};

export const rank = (
  queryEmbedding: Float32Array,
  items: readonly IndexEntry[],
  now: Date,
  opts: {
    readonly limit?: number;
    readonly workstreamMembership?: (threadId: string) => boolean;
  } = {},
): readonly RankedItem[] =>
  items
    .filter((item) => opts.workstreamMembership?.(item.threadId) ?? true)
    .map((item) => {
      const similarity = cosine(queryEmbedding, item.embedding);
      const freshness = freshnessDecay(item.capturedAt, now);
      return {
        id: item.id,
        threadId: item.threadId,
        capturedAt: item.capturedAt,
        similarity,
        freshness,
        score: similarity * freshness,
      };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, clampLimit(opts.limit));
