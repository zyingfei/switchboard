// Recall V3 chunk metadata. Stored as a length-prefixed UTF-8 JSON
// blob per entry on disk so the ranker + query response can return
// rich per-chunk context (heading breadcrumb, source thread,
// snippet) without re-reading the source event log.
export interface ChunkMetadata {
  readonly sourceBacId: string;
  readonly provider?: string;
  readonly threadUrl?: string;
  readonly title?: string;
  readonly role?: 'user' | 'assistant' | 'system' | 'unknown';
  readonly turnOrdinal: number;
  readonly modelName?: string;
  readonly headingPath: readonly string[];
  readonly paragraphIndex: number;
  readonly charStart: number;
  readonly charEnd: number;
  readonly textHash: string;
  readonly text: string;
}

export interface IndexEntry {
  readonly id: string;
  readonly threadId: string;
  readonly capturedAt: string;
  readonly embedding: Float32Array;
  // CRDT-extension fields. Populated by the V2 writer with sensible
  // defaults when the caller omits them; ignored by the single-replica
  // reader path today (kept on-disk so a future multi-replica reader
  // can merge two index files via OR-Set semantics).
  //
  //   replicaId — identifies which companion wrote this entry.
  //               Single-vault deployments always see 'local'.
  //               Multi-device replicas use a stable per-machine id.
  //   lamport   — monotonic logical clock per replica. When two
  //               entries share the same id, the one with the higher
  //               (lamport, replicaId) wins on read.
  //   tombstoned — soft-delete flag for OR-Set semantics. The
  //               single-replica reader filters tombstoned entries
  //               out of query results today; the multi-replica
  //               reader will continue to honor them across merges
  //               so a delete on replica A propagates to replica B.
  readonly replicaId?: string;
  readonly lamport?: number;
  readonly tombstoned?: boolean;
  // Recall V3: per-chunk metadata. Optional on the type so legacy
  // callers / V2 fixtures keep compiling; the V3 writer always
  // persists a populated ChunkMetadata so query results can carry
  // headingPath, title, etc. without an extra event-log read.
  readonly metadata?: ChunkMetadata;
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
    // OR-Set tombstone filter — single-replica reader treats a
    // tombstoned entry as deleted. The future multi-replica reader
    // will resolve tombstones at merge time before this point.
    .filter((item) => item.tombstoned !== true)
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
