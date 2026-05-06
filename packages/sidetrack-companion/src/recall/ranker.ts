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
  // Hybrid-mode extras (only populated when rankHybrid is used).
  // Existing callers reading the back-compat shape ignore them.
  readonly vector?: { readonly rank: number; readonly similarity: number };
  readonly lexical?: { readonly rank: number; readonly score: number };
  readonly metadata?: ChunkMetadata;
  readonly snippet?: string;
  readonly why?: readonly string[];
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

// ───────────────────── Hybrid lexical + vector fusion ─────────────────────
//
// The vector ranker above scores by `cosine × freshness`. That works
// well for paraphrased semantic search ("how does the companion
// reconnect") but loses on verbatim identifiers ("sidetrack.threads
// .move") and multilingual queries where the embedding pulls in a
// near-translation but misses the literal token.
//
// rankHybrid combines a vector top-K with a lexical top-K via
// Reciprocal Rank Fusion (RRF). Each ranker contributes an
// independent ranking; RRF treats the two as votes and rewards
// chunks that appear high in EITHER list. Freshness becomes a small
// additive boost, not the dominant signal.
//
// minisearch is the lexical backend: it's small, ESM-friendly, has
// no native deps, and supports field weights so chunk text + title
// + headingPath all contribute. The lexical index is built in-
// memory from the IndexEntry array; callers cache it by
// `(modelId, indexMtime)` so it rebuilds only when the on-disk
// index changes.

import MiniSearch, { type SearchResult } from 'minisearch';

// Tunables. RRF k-constant of 60 is the canonical default
// (Cormack et al., SIGIR'09) and lands close-but-not-equal-rank
// chunks within the top-K of both lists rather than dominating on
// either alone. Freshness boost is intentionally small — it's a
// tiebreaker between hot and cold chunks, not a primary ranking
// signal.
const RRF_K = 60;
const FRESHNESS_BOOST_WEIGHT = 0.05;
// How many top results from each individual ranker to feed into
// fusion. Larger windows broaden recall at the cost of more
// downstream sorting; 50 is enough for the side panel's typical
// 10-result list.
const FUSION_WINDOW = 50;

export interface HybridLexicalIndex {
  readonly mini: MiniSearch<{ id: string; text: string; title: string; heading: string }>;
  readonly idToEntry: ReadonlyMap<string, IndexEntry>;
}

const tokenizer = (s: string): string[] =>
  s
    .toLowerCase()
    // Keep dotted identifiers (`sidetrack.threads.move`) as single
    // tokens AND emit their split parts so a query for either form
    // hits. Without this minisearch's default whitespace tokenizer
    // would treat `sidetrack.threads.move` as one term that fails to
    // match a query of just `move`.
    .split(/[\s,;:!?()[\]{}<>"'`]+/)
    .flatMap((token) => {
      const trimmed = token.replace(/^[.\-_]+|[.\-_]+$/g, '');
      if (trimmed.length === 0) return [];
      if (/[.\-_]/.test(trimmed)) return [trimmed, ...trimmed.split(/[.\-_]+/)];
      return [trimmed];
    })
    .filter((token) => token.length > 0);

export const buildLexicalIndex = (items: readonly IndexEntry[]): HybridLexicalIndex => {
  const mini = new MiniSearch<{ id: string; text: string; title: string; heading: string }>({
    fields: ['text', 'title', 'heading'],
    storeFields: ['id'],
    idField: 'id',
    tokenize: tokenizer,
    processTerm: (term) => term.toLowerCase(),
    searchOptions: {
      tokenize: tokenizer,
      processTerm: (term) => term.toLowerCase(),
      boost: { text: 1, title: 2, heading: 1.5 },
      prefix: true,
      fuzzy: 0.15,
    },
  });
  const idToEntry = new Map<string, IndexEntry>();
  for (const item of items) {
    if (item.tombstoned === true) continue;
    idToEntry.set(item.id, item);
    const heading = (item.metadata?.headingPath ?? []).join(' ');
    mini.add({
      id: item.id,
      text: item.metadata?.text ?? '',
      title: item.metadata?.title ?? '',
      heading,
    });
  }
  return { mini, idToEntry };
};

const buildSnippet = (text: string, query: string, maxChars = 220): string => {
  const lower = text.toLowerCase();
  const q = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  let bestIndex = -1;
  for (const term of q) {
    const idx = lower.indexOf(term);
    if (idx !== -1 && (bestIndex === -1 || idx < bestIndex)) bestIndex = idx;
  }
  if (bestIndex === -1) return text.slice(0, maxChars);
  const radius = Math.max(0, Math.floor(maxChars / 2) - 30);
  const start = Math.max(0, bestIndex - radius);
  const end = Math.min(text.length, start + maxChars);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end)}${suffix}`;
};

export interface HybridRankOptions {
  readonly limit?: number;
  readonly workstreamMembership?: (threadId: string) => boolean;
  // Caller-provided lexical index. Built once per (indexFile,
  // modelId) pair; rebuilt only when the on-disk index changes.
  readonly lexical: HybridLexicalIndex;
}

export const rankHybrid = (
  queryText: string,
  queryEmbedding: Float32Array,
  items: readonly IndexEntry[],
  now: Date,
  opts: HybridRankOptions,
): readonly RankedItem[] => {
  // 1. Vector list — same as plain rank() but capped to the fusion
  //    window and stripped of the freshness multiplier (freshness is
  //    layered back as an additive boost after fusion).
  const vectorList = items
    .filter((item) => item.tombstoned !== true)
    .filter((item) => opts.workstreamMembership?.(item.threadId) ?? true)
    .map((item) => ({
      item,
      similarity: cosine(queryEmbedding, item.embedding),
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, FUSION_WINDOW);

  // 2. Lexical list from minisearch over the live chunks.
  const lexResults: SearchResult[] = opts.lexical.mini
    .search(queryText, { combineWith: 'OR' })
    .filter((result): result is SearchResult => {
      const entry = opts.lexical.idToEntry.get(String(result['id']));
      if (entry === undefined) return false;
      if (entry.tombstoned === true) return false;
      if (opts.workstreamMembership !== undefined && !opts.workstreamMembership(entry.threadId)) {
        return false;
      }
      return true;
    })
    .slice(0, FUSION_WINDOW);

  // 3. RRF fusion: each list contributes 1/(k+rank); freshness is a
  //    small additive boost layered on top.
  type Aggregate = {
    readonly id: string;
    readonly entry: IndexEntry;
    readonly vectorRank?: number;
    readonly vectorSimilarity?: number;
    readonly lexicalRank?: number;
    readonly lexicalScore?: number;
  };
  const byId = new Map<string, Aggregate>();
  vectorList.forEach((row, index) => {
    byId.set(row.item.id, {
      id: row.item.id,
      entry: row.item,
      vectorRank: index + 1,
      vectorSimilarity: row.similarity,
    });
  });
  lexResults.forEach((row, index) => {
    const id = String(row['id']);
    const entry = opts.lexical.idToEntry.get(id);
    if (entry === undefined) return;
    const prior = byId.get(id);
    byId.set(id, {
      id,
      entry,
      ...(prior?.vectorRank === undefined ? {} : { vectorRank: prior.vectorRank }),
      ...(prior?.vectorSimilarity === undefined
        ? {}
        : { vectorSimilarity: prior.vectorSimilarity }),
      lexicalRank: index + 1,
      lexicalScore: typeof row['score'] === 'number' ? row['score'] : 0,
    });
  });

  const fused: RankedItem[] = [];
  for (const agg of byId.values()) {
    const rrfVector = agg.vectorRank !== undefined ? 1 / (RRF_K + agg.vectorRank) : 0;
    const rrfLexical = agg.lexicalRank !== undefined ? 1 / (RRF_K + agg.lexicalRank) : 0;
    const freshness = freshnessDecay(agg.entry.capturedAt, now);
    const fusion = rrfVector + rrfLexical;
    const score = fusion + FRESHNESS_BOOST_WEIGHT * freshness * fusion;
    const why: string[] = [];
    if (agg.vectorRank !== undefined && agg.vectorSimilarity !== undefined) {
      why.push(
        `vector rank ${String(agg.vectorRank)} (sim ${agg.vectorSimilarity.toFixed(3)})`,
      );
    }
    if (agg.lexicalRank !== undefined) {
      why.push(`lexical rank ${String(agg.lexicalRank)}`);
    }
    if (freshness >= 1) {
      why.push('fresh ≤ 3d');
    }
    const text = agg.entry.metadata?.text ?? '';
    const snippet = text.length > 0 ? buildSnippet(text, queryText) : '';
    fused.push({
      id: agg.id,
      threadId: agg.entry.threadId,
      capturedAt: agg.entry.capturedAt,
      score,
      similarity: agg.vectorSimilarity ?? 0,
      freshness,
      ...(agg.vectorRank === undefined || agg.vectorSimilarity === undefined
        ? {}
        : { vector: { rank: agg.vectorRank, similarity: agg.vectorSimilarity } }),
      ...(agg.lexicalRank === undefined || agg.lexicalScore === undefined
        ? {}
        : { lexical: { rank: agg.lexicalRank, score: agg.lexicalScore } }),
      ...(agg.entry.metadata === undefined ? {} : { metadata: agg.entry.metadata }),
      ...(snippet.length === 0 ? {} : { snippet }),
      why,
    });
  }

  return fused.sort((a, b) => b.score - a.score).slice(0, clampLimit(opts.limit));
};
