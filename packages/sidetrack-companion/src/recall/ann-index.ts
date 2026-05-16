import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { readIndex, type IndexFile } from './indexFile.js';
import type { IndexEntry } from './ranker.js';

export type AnnBackend = 'hnsw' | 'flat';

export interface AnnSearchOptions {
  readonly limit?: number;
  readonly excludeIds?: ReadonlySet<string>;
  readonly workstreamMembership?: (threadId: string) => boolean;
}

export interface AnnSearchResult {
  readonly item: IndexEntry;
  readonly similarity: number;
}

export interface AnnVectorIndex {
  readonly revisionId: string;
  readonly backend: AnnBackend;
  readonly itemCount: number;
  readonly query: (
    queryEmbedding: Float32Array,
    options?: AnnSearchOptions,
  ) => readonly AnnSearchResult[];
}

export interface AnnLogger {
  readonly warn: (message: string) => void;
}

interface UsearchIndexConfig {
  readonly dimensions: number;
  readonly metric: string;
  readonly quantization: string;
  readonly connectivity: number;
  readonly expansion_add: number;
  readonly expansion_search: number;
  readonly multi: boolean;
}

interface UsearchMatches {
  readonly keys: BigUint64Array;
  readonly distances: Float32Array;
}

interface UsearchIndex {
  readonly add: (
    keys: bigint | readonly bigint[] | BigUint64Array,
    vectors: Float32Array,
    threads?: number,
  ) => void;
  readonly search: (vectors: Float32Array, k: number, threads?: number) => UsearchMatches;
  readonly size: () => number;
}

interface UsearchModule {
  readonly Index: new (config: UsearchIndexConfig) => UsearchIndex;
  readonly MetricKind: { readonly Cos: string };
  readonly ScalarKind: { readonly F32: string };
}

export type UsearchLoader = () => Promise<UsearchModule>;

export interface BuildAnnIndexInput {
  readonly revisionId: string;
  readonly items: readonly IndexEntry[];
  readonly loader?: UsearchLoader;
  readonly logger?: AnnLogger;
}

export interface AnnIndexCache {
  readonly getOrBuild: (input: BuildAnnIndexInput) => Promise<AnnVectorIndex>;
  readonly clear: () => void;
}

export interface AnnIndexFileSnapshot {
  readonly revisionId: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly index: IndexFile;
  readonly vectorIndex: AnnVectorIndex;
}

const HNSW_CONNECTIVITY = 16;
const HNSW_EXPANSION_ADD = 64;
const HNSW_EXPANSION_SEARCH = 64;
const HNSW_FILTER_BUFFER = 8;

const defaultLogger: AnnLogger = {
  warn: (message) => {
    console.warn(message);
  },
};

const require = createRequire(import.meta.url);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const asUsearchModule = (value: unknown): UsearchModule => {
  const candidate =
    isRecord(value) && isRecord(value['default']) && typeof value['Index'] !== 'function'
      ? value['default']
      : value;
  if (!isRecord(candidate)) {
    throw new Error('usearch module is not an object');
  }
  const Index = candidate['Index'];
  const metricKind = candidate['MetricKind'];
  const scalarKind = candidate['ScalarKind'];
  if (typeof Index !== 'function' || !isRecord(metricKind) || !isRecord(scalarKind)) {
    throw new Error('usearch module is missing Index, MetricKind, or ScalarKind');
  }
  if (!isNonEmptyString(metricKind['Cos']) || !isNonEmptyString(scalarKind['F32'])) {
    throw new Error('usearch module is missing cosine/f32 constants');
  }
  return {
    Index: Index as new (config: UsearchIndexConfig) => UsearchIndex,
    MetricKind: { Cos: metricKind['Cos'] },
    ScalarKind: { F32: scalarKind['F32'] },
  };
};

export const loadDefaultUsearch: UsearchLoader = async () =>
  asUsearchModule(require('usearch') as unknown);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const warnHnswFallback = (logger: AnnLogger, revisionId: string, error: unknown): void => {
  logger.warn(
    `[recall-ann] HNSW unavailable for revision ${revisionId}; falling back to flat scan: ${errorMessage(error)}`,
  );
};

const clampLimit = (limit: number | undefined, itemCount: number): number => {
  if (itemCount <= 0) return 0;
  if (limit === undefined || !Number.isFinite(limit)) return Math.min(10, itemCount);
  return Math.min(Math.max(1, Math.trunc(limit)), itemCount);
};

const dotSimilarity = (left: Float32Array, right: Float32Array): number => {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  for (let index = 0; index < length; index += 1) {
    dot += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return dot;
};

const normalizedSimilarityFromCosDistance = (distance: number): number => {
  if (!Number.isFinite(distance)) return 0;
  return Math.min(1, Math.max(-1, 1 - distance));
};

const isSearchable = (item: IndexEntry, options: AnnSearchOptions): boolean => {
  if (item.tombstoned === true) return false;
  if (options.excludeIds?.has(item.id) === true) return false;
  return options.workstreamMembership?.(item.threadId) ?? true;
};

const bySimilarity = (left: AnnSearchResult, right: AnnSearchResult): number => {
  if (right.similarity !== left.similarity) return right.similarity - left.similarity;
  return left.item.id < right.item.id ? -1 : left.item.id > right.item.id ? 1 : 0;
};

export const queryFlatTopK = (
  queryEmbedding: Float32Array,
  items: readonly IndexEntry[],
  options: AnnSearchOptions = {},
): readonly AnnSearchResult[] => {
  const limit = clampLimit(options.limit, items.length);
  if (limit === 0) return [];
  return items
    .filter((item) => isSearchable(item, options))
    .map((item) => ({ item, similarity: dotSimilarity(queryEmbedding, item.embedding) }))
    .sort(bySimilarity)
    .slice(0, limit);
};

const createFlatAnnIndex = (revisionId: string, items: readonly IndexEntry[]): AnnVectorIndex => ({
  revisionId,
  backend: 'flat',
  itemCount: items.filter((item) => item.tombstoned !== true).length,
  query: (queryEmbedding, options) => queryFlatTopK(queryEmbedding, items, options),
});

const vectorForDimension = (embedding: Float32Array, dimensions: number): Float32Array => {
  if (embedding.length === dimensions) return embedding;
  const out = new Float32Array(dimensions);
  out.set(embedding.subarray(0, dimensions));
  return out;
};

const firstVectorDimension = (items: readonly IndexEntry[]): number => {
  for (const item of items) {
    if (item.tombstoned !== true && item.embedding.length > 0) {
      return item.embedding.length;
    }
  }
  return 0;
};

const hnswSearchLimit = (
  requestedLimit: number,
  searchableCount: number,
  options: AnnSearchOptions,
): number => {
  const excluded = options.excludeIds?.size ?? 0;
  const filteredBuffer = options.workstreamMembership === undefined ? 0 : requestedLimit;
  return Math.min(
    searchableCount,
    Math.max(requestedLimit, requestedLimit + excluded + filteredBuffer + HNSW_FILTER_BUFFER),
  );
};

export const buildAnnIndex = async ({
  revisionId,
  items,
  loader = loadDefaultUsearch,
  logger = defaultLogger,
}: BuildAnnIndexInput): Promise<AnnVectorIndex> => {
  const searchable = items.filter((item) => item.tombstoned !== true);
  const dimensions = firstVectorDimension(searchable);
  if (searchable.length === 0 || dimensions === 0) {
    return createFlatAnnIndex(revisionId, items);
  }

  let module: UsearchModule;
  try {
    module = await loader();
  } catch (error) {
    warnHnswFallback(logger, revisionId, error);
    return createFlatAnnIndex(revisionId, items);
  }

  try {
    const index = new module.Index({
      dimensions,
      metric: module.MetricKind.Cos,
      quantization: module.ScalarKind.F32,
      connectivity: HNSW_CONNECTIVITY,
      expansion_add: HNSW_EXPANSION_ADD,
      expansion_search: HNSW_EXPANSION_SEARCH,
      multi: false,
    });
    const keys = new BigUint64Array(searchable.length);
    const vectors = new Float32Array(searchable.length * dimensions);
    const keyToItem = new Map<bigint, IndexEntry>();
    searchable.forEach((item, indexInSearchable) => {
      const key = BigInt(indexInSearchable + 1);
      keys[indexInSearchable] = key;
      keyToItem.set(key, item);
      vectors.set(vectorForDimension(item.embedding, dimensions), indexInSearchable * dimensions);
    });
    index.add(keys, vectors, 0);
    let queryFallbackWarned = false;
    return {
      revisionId,
      backend: 'hnsw',
      itemCount: index.size(),
      query: (queryEmbedding, options = {}) => {
        const requestedLimit = clampLimit(options.limit, searchable.length);
        if (requestedLimit === 0) return [];
        const nativeLimit = hnswSearchLimit(requestedLimit, searchable.length, options);
        try {
          const matches = index.search(
            vectorForDimension(queryEmbedding, dimensions),
            nativeLimit,
            0,
          );
          const results: AnnSearchResult[] = [];
          for (let cursor = 0; cursor < matches.keys.length; cursor += 1) {
            const key = matches.keys[cursor];
            const distance = matches.distances[cursor];
            if (key === undefined || distance === undefined) continue;
            const item = keyToItem.get(key);
            if (item === undefined || !isSearchable(item, options)) continue;
            results.push({ item, similarity: normalizedSimilarityFromCosDistance(distance) });
          }
          return results.sort(bySimilarity).slice(0, requestedLimit);
        } catch (error) {
          if (!queryFallbackWarned) {
            queryFallbackWarned = true;
            warnHnswFallback(logger, revisionId, error);
          }
          return queryFlatTopK(queryEmbedding, items, options);
        }
      },
    };
  } catch (error) {
    warnHnswFallback(logger, revisionId, error);
    return createFlatAnnIndex(revisionId, items);
  }
};

export const createAnnIndexCache = (): AnnIndexCache => {
  const byRevision = new Map<string, Promise<AnnVectorIndex>>();
  return {
    getOrBuild: (input) => {
      const cached = byRevision.get(input.revisionId);
      if (cached !== undefined) return cached;
      const built = buildAnnIndex(input).catch((error: unknown) => {
        byRevision.delete(input.revisionId);
        throw error;
      });
      byRevision.set(input.revisionId, built);
      return built;
    },
    clear: () => {
      byRevision.clear();
    },
  };
};

const revisionIdForIndexFile = (
  path: string,
  index: IndexFile,
  fileStat: Stats | undefined,
): string =>
  [
    path,
    fileStat?.mtimeMs.toFixed(3) ?? 'missing-mtime',
    String(fileStat?.size ?? 0),
    index.modelId,
    index.modelRevision ?? '',
    String(index.items.length),
  ].join('|');

export const readAnnIndexFile = async (
  path: string,
  cache: AnnIndexCache,
  options: Pick<BuildAnnIndexInput, 'loader' | 'logger'> = {},
): Promise<AnnIndexFileSnapshot | null> => {
  const [index, fileStat] = await Promise.all([
    readIndex(path),
    stat(path).catch((): Stats | undefined => undefined),
  ]);
  if (index === null) return null;
  const revisionId = revisionIdForIndexFile(path, index, fileStat);
  const vectorIndex = await cache.getOrBuild({
    revisionId,
    items: index.items,
    ...(options.loader === undefined ? {} : { loader: options.loader }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  return {
    revisionId,
    mtimeMs: fileStat?.mtimeMs ?? 0,
    size: fileStat?.size ?? 0,
    index,
    vectorIndex,
  };
};
