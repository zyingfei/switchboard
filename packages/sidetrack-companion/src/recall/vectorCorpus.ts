import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  createEmbeddingCache,
  embedTextHash,
  type EmbeddingCache,
  type EmbeddingCacheModelKey,
} from './embeddingCache.js';
import { RECALL_MODEL } from './modelManifest.js';

/**
 * R4 canonical vector corpus.
 *
 * The active policy deliberately preserves the model inputs that produced the
 * currently served HNSW and recall vectors: embedder.ts wraps every caller
 * supplied string in `query: `, including strings that already start with an
 * E5 role prefix. The corrected asymmetric policy is named and testable, but
 * remains shadow-only until an eval authorizes a serving migration.
 */
export type VectorInputRole = 'query' | 'passage';
export type VectorInputPolicyId = 'legacy-query-wrapper-v1' | 'e5-asymmetric-v1';

export interface VectorInputPolicy {
  readonly id: VectorInputPolicyId;
  readonly serving: boolean;
}

export const ACTIVE_VECTOR_INPUT_POLICY = {
  id: 'legacy-query-wrapper-v1',
  serving: true,
} as const satisfies VectorInputPolicy;

export const SHADOW_E5_ASYMMETRIC_POLICY = {
  id: 'e5-asymmetric-v1',
  serving: false,
} as const satisfies VectorInputPolicy;

export const VECTOR_CORPUS_REVISION = `${RECALL_MODEL.revision}#input=${ACTIVE_VECTOR_INPUT_POLICY.id}`;

export const VECTOR_CORPUS_MODEL_KEY = {
  modelId: RECALL_MODEL.modelId,
  modelRevision: VECTOR_CORPUS_REVISION,
} as const satisfies EmbeddingCacheModelKey;

export const LEGACY_VECTOR_CACHE_MODEL_KEY = {
  modelId: RECALL_MODEL.modelId,
  modelRevision: RECALL_MODEL.revision,
} as const satisfies EmbeddingCacheModelKey;

export const inferVectorInputRole = (text: string): VectorInputRole =>
  /^passage:\s/iu.test(text) ? 'passage' : 'query';

export const prepareVectorModelInput = (
  text: string,
  role: VectorInputRole = inferVectorInputRole(text),
  policy: VectorInputPolicy = ACTIVE_VECTOR_INPUT_POLICY,
): string => {
  if (policy.id === 'legacy-query-wrapper-v1') return `${RECALL_MODEL.inputPrefix}${text}`;
  const withoutExistingRole = text.replace(/^(?:query|passage):\s*/iu, '');
  return `${role}: ${withoutExistingRole}`;
};

export type VectorCorpusReadState =
  | { readonly kind: 'absent'; readonly revision: string }
  | { readonly kind: 'empty'; readonly revision: string; readonly entries: 0 }
  | { readonly kind: 'measured'; readonly revision: string; readonly entries: number };

export interface VectorProjectionObservation {
  readonly consumer: 'visit_similarity' | 'recall_chunk';
  readonly state: 'absent' | 'empty' | 'measured';
  readonly revision?: string;
  readonly vectorCount: number;
  readonly eligibleCount: number;
}

export interface VectorProjectionCoverageAccounting {
  readonly observations: readonly (VectorProjectionObservation & {
    readonly coverage: number | null;
  })[];
  readonly revisionsAgree: boolean;
  readonly agreedRevision: string | null;
}

export const accountVectorProjectionCoverage = (
  observations: readonly VectorProjectionObservation[],
): VectorProjectionCoverageAccounting => {
  const measured = observations.map((observation) => ({
    ...observation,
    coverage:
      observation.state === 'absent'
        ? null
        : observation.eligibleCount === 0
          ? 1
          : Math.min(1, observation.vectorCount / observation.eligibleCount),
  }));
  const revisions = new Set(
    measured.flatMap((observation) =>
      observation.revision === undefined ? [] : [observation.revision],
    ),
  );
  const revisionsAgree =
    measured.length > 0 &&
    measured.every((observation) => observation.state !== 'absent') &&
    revisions.size === 1;
  return {
    observations: measured,
    revisionsAgree,
    agreedRevision: revisionsAgree ? ([...revisions][0] ?? null) : null,
  };
};

export type VectorCorpusConsumer = 'visit_similarity' | 'recall_chunk' | 'page_evidence';

export interface VectorCorpusBinding {
  readonly consumer: VectorCorpusConsumer;
  /** sha256 of the consumer's projection id. Raw URLs/titles never enter the
   *  corpus lifecycle sidecar. */
  readonly projectionIdHash: string;
  readonly embedTextHash: string;
  readonly sourceRevision: string;
  readonly effectiveAtMs: number;
}

interface BindingFile {
  readonly schemaVersion: 1;
  readonly vectorCorpusRevision: string;
  readonly bindings: readonly VectorCorpusBinding[];
}

export interface ResolveCanonicalVectorsResult {
  readonly vectors: readonly Float32Array[];
  readonly revision: string;
  readonly cacheHits: number;
  readonly embedded: number;
  readonly migratedLegacyCache: boolean;
}

interface VectorCorpusBindingInput {
  readonly consumer: VectorCorpusConsumer;
  readonly projectionId: string;
  readonly sourceRevision: string;
  readonly effectiveAtMs: number;
}

export interface VectorCorpusMetrics {
  cacheHits: number;
  cacheMisses: number;
  embedded: number;
  migrationSucceeded: number;
  migrationFailed: number;
  bindingBackpressure: number;
}

const metrics: VectorCorpusMetrics = {
  cacheHits: 0,
  cacheMisses: 0,
  embedded: 0,
  migrationSucceeded: 0,
  migrationFailed: 0,
  bindingBackpressure: 0,
};

export const vectorCorpusMetrics = (): Readonly<VectorCorpusMetrics> => ({ ...metrics });

export const __resetVectorCorpusMetrics = (): void => {
  for (const key of Object.keys(metrics) as (keyof VectorCorpusMetrics)[]) metrics[key] = 0;
};

const bindingPathFor = (vaultRoot: string): string =>
  join(vaultRoot, '_BAC', 'recall', 'vector-corpus-bindings.v1.json');

const delay = async (ms: number): Promise<void> =>
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const withBindingLock = async <T>(path: string, fn: () => Promise<T>): Promise<T> => {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await mkdir(lockPath);
      try {
        return await fn();
      } finally {
        await rm(lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > 60_000) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (lockError) {
        if (!(lockError instanceof Error && 'code' in lockError && lockError.code === 'ENOENT')) {
          throw lockError;
        }
      }
      if (attempt === 3) {
        metrics.bindingBackpressure += 1;
        throw new Error('VECTOR_CORPUS_BACKPRESSURE: binding writer busy');
      }
      await delay(5 * 2 ** attempt);
    }
  }
  throw new Error('VECTOR_CORPUS_BACKPRESSURE: binding writer busy');
};

const parseBindingFile = (raw: string): BindingFile | null => {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      record['schemaVersion'] !== 1 ||
      record['vectorCorpusRevision'] !== VECTOR_CORPUS_REVISION ||
      !Array.isArray(record['bindings'])
    ) {
      return null;
    }
    const bindings: VectorCorpusBinding[] = [];
    for (const item of record['bindings']) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
      const row = item as Record<string, unknown>;
      const consumer = row['consumer'];
      if (
        (consumer !== 'visit_similarity' &&
          consumer !== 'recall_chunk' &&
          consumer !== 'page_evidence') ||
        typeof row['projectionIdHash'] !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(row['projectionIdHash']) ||
        typeof row['embedTextHash'] !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(row['embedTextHash']) ||
        typeof row['sourceRevision'] !== 'string' ||
        typeof row['effectiveAtMs'] !== 'number' ||
        !Number.isFinite(row['effectiveAtMs'])
      ) {
        return null;
      }
      bindings.push({
        consumer,
        projectionIdHash: row['projectionIdHash'],
        embedTextHash: row['embedTextHash'],
        sourceRevision: row['sourceRevision'],
        effectiveAtMs: row['effectiveAtMs'],
      });
    }
    return { schemaVersion: 1, vectorCorpusRevision: VECTOR_CORPUS_REVISION, bindings };
  } catch {
    return null;
  }
};

const projectionIdHash = (projectionId: string): string =>
  createHash('sha256').update(projectionId).digest('hex');

const publishBindingFile = async (
  path: string,
  bindings: readonly VectorCorpusBinding[],
): Promise<void> => {
  const next: BindingFile = {
    schemaVersion: 1,
    vectorCorpusRevision: VECTOR_CORPUS_REVISION,
    bindings,
  };
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${String(process.pid)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
};

export const writeVectorCorpusBindings = async (
  vaultRoot: string,
  incoming: readonly VectorCorpusBinding[],
): Promise<void> => {
  if (incoming.length === 0) return;
  const path = bindingPathFor(vaultRoot);
  await withBindingLock(path, async () => {
    let existing: BindingFile | null = null;
    try {
      existing = parseBindingFile(await readFile(path, 'utf8'));
    } catch {
      existing = null;
    }
    const byProjection = new Map<string, VectorCorpusBinding>();
    for (const binding of existing?.bindings ?? []) {
      byProjection.set(`${binding.consumer}\u0000${binding.projectionIdHash}`, binding);
    }
    for (const binding of incoming) {
      byProjection.set(`${binding.consumer}\u0000${binding.projectionIdHash}`, binding);
    }
    const bindings = [...byProjection.values()].sort((left, right) => {
      if (left.consumer !== right.consumer) return left.consumer.localeCompare(right.consumer);
      return left.projectionIdHash.localeCompare(right.projectionIdHash);
    });
    await publishBindingFile(path, bindings);
  });
};

export const pruneVectorCorpusBindings = async (
  vaultRoot: string,
  consumer: VectorCorpusConsumer,
  liveProjectionIds: ReadonlySet<string>,
): Promise<void> => {
  const path = bindingPathFor(vaultRoot);
  await withBindingLock(path, async () => {
    let existing: BindingFile | null;
    try {
      existing = parseBindingFile(await readFile(path, 'utf8'));
    } catch {
      return;
    }
    if (existing === null) return;
    const liveHashes = new Set([...liveProjectionIds].map(projectionIdHash));
    const bindings = existing.bindings.filter(
      (binding) => consumer !== binding.consumer || liveHashes.has(binding.projectionIdHash),
    );
    if (bindings.length === existing.bindings.length) return;
    await publishBindingFile(path, bindings);
  });
};

export const readVectorCorpusBindings = async (
  vaultRoot: string,
): Promise<readonly VectorCorpusBinding[] | null> => {
  try {
    return parseBindingFile(await readFile(bindingPathFor(vaultRoot), 'utf8'))?.bindings ?? null;
  } catch {
    return null;
  }
};

const migrateLegacyCache = async (cache: EmbeddingCache): Promise<boolean> => {
  try {
    const result = await cache.migrateModel(LEGACY_VECTOR_CACHE_MODEL_KEY, VECTOR_CORPUS_MODEL_KEY);
    if (result === 'migrated') metrics.migrationSucceeded += 1;
    return result === 'migrated';
  } catch {
    metrics.migrationFailed += 1;
    throw new Error('VECTOR_CORPUS_MIGRATION_FAILED: legacy cache remains active');
  }
};

export const readVectorCorpusState = async (vaultRoot: string): Promise<VectorCorpusReadState> => {
  const cache = createEmbeddingCache(vaultRoot, RECALL_MODEL.embeddingDim);
  await migrateLegacyCache(cache);
  const state = await cache.inspect(VECTOR_CORPUS_MODEL_KEY);
  if (state.kind === 'absent') return { kind: 'absent', revision: VECTOR_CORPUS_REVISION };
  if (state.entries === 0) {
    return { kind: 'empty', revision: VECTOR_CORPUS_REVISION, entries: 0 };
  }
  return { kind: 'measured', revision: VECTOR_CORPUS_REVISION, entries: state.entries };
};

export const resolveCanonicalVectors = async (input: {
  readonly vaultRoot: string;
  readonly texts: readonly string[];
  readonly embed: (texts: readonly string[]) => Promise<readonly Float32Array[]>;
  readonly bindings?: readonly VectorCorpusBindingInput[];
}): Promise<ResolveCanonicalVectorsResult> => {
  if (input.texts.length === 0) {
    const cache = createEmbeddingCache(input.vaultRoot, RECALL_MODEL.embeddingDim);
    await migrateLegacyCache(cache);
    await cache.initialize(VECTOR_CORPUS_MODEL_KEY);
    return {
      vectors: [],
      revision: VECTOR_CORPUS_REVISION,
      cacheHits: 0,
      embedded: 0,
      migratedLegacyCache: false,
    };
  }
  const cache = createEmbeddingCache(input.vaultRoot, RECALL_MODEL.embeddingDim);
  const migratedLegacyCache = await migrateLegacyCache(cache);
  const hashes = input.texts.map(embedTextHash);
  const cached = await cache.getMany(VECTOR_CORPUS_MODEL_KEY, hashes);
  const misses: number[] = [];
  for (let index = 0; index < hashes.length; index += 1) {
    if (!cached.has(hashes[index] ?? '')) misses.push(index);
  }
  const freshByIndex = new Map<number, Float32Array>();
  const embedBatchSize = 64;
  let embeddedCount = 0;
  // Flush every bounded batch. A crash or retry loses at most one batch and
  // converges through cache hits instead of restarting the entire corpus.
  for (let start = 0; start < misses.length; start += embedBatchSize) {
    const batchIndexes = misses.slice(start, start + embedBatchSize);
    const batchTexts = batchIndexes.map((index) => input.texts[index] ?? '');
    const batchVectors = await input.embed(batchTexts);
    if (batchVectors.length !== batchTexts.length) {
      throw new Error(
        `VECTOR_CORPUS_EMBED_COUNT: expected ${String(batchTexts.length)}, received ${String(batchVectors.length)}`,
      );
    }
    const persist: [string, Float32Array][] = [];
    for (let offset = 0; offset < batchIndexes.length; offset += 1) {
      const index = batchIndexes[offset];
      const vector = batchVectors[offset];
      if (index === undefined || vector === undefined) continue;
      if (vector.length !== RECALL_MODEL.embeddingDim) {
        throw new Error(
          `VECTOR_CORPUS_DIMENSION: expected ${String(RECALL_MODEL.embeddingDim)}, received ${String(vector.length)}`,
        );
      }
      freshByIndex.set(index, vector);
      persist.push([hashes[index] ?? '', vector]);
    }
    await cache.putMany(VECTOR_CORPUS_MODEL_KEY, persist);
    embeddedCount += batchVectors.length;
  }
  const vectors = hashes.map((hash, index) => {
    const vector = freshByIndex.get(index) ?? cached.get(hash);
    if (vector === undefined) throw new Error(`VECTOR_CORPUS_ABSENT: ${hash}`);
    return vector;
  });
  const cacheHits = hashes.length - misses.length;
  metrics.cacheHits += cacheHits;
  metrics.cacheMisses += misses.length;
  metrics.embedded += embeddedCount;
  if (input.bindings !== undefined) {
    if (input.bindings.length !== hashes.length) {
      throw new Error('VECTOR_CORPUS_BINDING_COUNT: bindings must align with texts');
    }
    await writeVectorCorpusBindings(
      input.vaultRoot,
      input.bindings.map((binding, index) => ({
        consumer: binding.consumer,
        projectionIdHash: projectionIdHash(binding.projectionId),
        embedTextHash: hashes[index] ?? '',
        sourceRevision: binding.sourceRevision,
        effectiveAtMs: binding.effectiveAtMs,
      })),
    );
  }
  return {
    vectors,
    revision: VECTOR_CORPUS_REVISION,
    cacheHits,
    embedded: embeddedCount,
    migratedLegacyCache,
  };
};
