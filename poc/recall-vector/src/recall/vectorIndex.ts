import { ageDaysFrom, classifyRecencyBucket, freshnessBoost } from './freshness';
import type { RecallHit, RecencyWindow, VectorRecord } from './model';

const dot = (left: Float32Array, right: Float32Array): number => {
  let sum = 0;
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    sum += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return sum;
};

export interface SearchOptions {
  window: RecencyWindow;
  topK: number;
  now?: Date;
}

export class RecallVectorIndex {
  constructor(private readonly records: VectorRecord[]) {}

  count(): number {
    return this.records.length;
  }

  search(queryEmbedding: Float32Array, options: SearchOptions): RecallHit[] {
    const now = options.now ?? new Date();
    return this.records
      .map((record) => {
        const similarity = dot(queryEmbedding, record.embedding);
        const ageDays = ageDaysFrom(record.capturedAt, now);
        const boost = freshnessBoost(options.window, ageDays);
        const score = similarity * boost;
        return {
          chunkId: record.id,
          title: record.title,
          sourcePath: record.sourcePath,
          sourceKind: record.sourceKind,
          capturedAt: record.capturedAt,
          ageDays,
          recencyBucket: classifyRecencyBucket(ageDays),
          similarity: Number(similarity.toFixed(4)),
          freshnessBoost: Number(boost.toFixed(3)),
          score: Number(score.toFixed(4)),
          snippet: record.text.length > 280 ? `${record.text.slice(0, 277)}...` : record.text,
        } satisfies RecallHit;
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, options.topK);
  }
}
