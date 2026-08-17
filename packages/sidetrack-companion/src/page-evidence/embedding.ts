import { createEmbeddingCache, embedTextHash } from '../recall/embeddingCache.js';
import { RECALL_MODEL } from '../recall/modelManifest.js';
import {
  LEGACY_VECTOR_CACHE_MODEL_KEY,
  VECTOR_CORPUS_MODEL_KEY,
} from '../recall/vectorCorpus.js';
import { splitPageContentIntoChunks } from '../page-content/store.js';
import { vectorIdFor } from './vectorRef.js';
import type { PageEvidenceExtractedRequest, VectorRef } from './types.js';

export type PageEvidenceEmbedder = (texts: readonly string[]) => Promise<readonly Float32Array[]>;

// Lazy embedder: this module sits in the static import graph of
// page-evidence/store.ts and, through it, http/server.ts — which must
// not pull recall/embedder.js (transformers/ONNX init) at import time
// per the /v1/status availability contract (statusContract.test.ts).
// The model loads on the first actual embedding call instead.
const defaultEmbed: PageEvidenceEmbedder = async (texts) =>
  (await import('../recall/embedder.js')).embed(texts);

const MAX_EMBED_TEXT_CHARS = 100_000;

// Audibility (2026-08-17): this module is the hot path the disk-wear trace
// pointed at (the background embed lane calls writePageEvidenceDocEmbedding
// once per backlog record). embeddingCache.ts itself defaults its flush log
// to a no-op — the low-level module has too many scattered callers across
// the codebase to default to stdout there — so the caller that matters for
// write-volume attribution wires it explicitly here.
const embeddingCacheLog = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

const embeddingDisabled = (): boolean => {
  const raw = process.env['SIDETRACK_PAGE_EVIDENCE_DOC_EMBEDDINGS'];
  return raw === '0' || raw?.toLowerCase() === 'false';
};

const normalizeSpaces = (value: string): string => value.replace(/\s+/gu, ' ').trim();

const wordCount = (value: string): number =>
  value.split(/\s+/u).filter((part) => part.length > 0).length;

const qualityWeightFor = (quality: PageEvidenceExtractedRequest['quality']): number => {
  if (quality === 'high') return 1;
  if (quality === 'medium') return 0.75;
  return 0.25;
};

export interface DocEmbeddingChunk {
  readonly chunkId: string;
  readonly chunkIndex: number;
  readonly text: string;
}

export const splitDocEmbeddingChunks = (
  payload: PageEvidenceExtractedRequest,
): readonly DocEmbeddingChunk[] => {
  const title = normalizeSpaces(payload.title ?? '');
  return splitPageContentIntoChunks({
    canonicalUrl: payload.canonicalUrl,
    url: payload.url,
    ...(payload.title === undefined ? {} : { title: payload.title }),
    contentHash: payload.content.contentHash,
    text: payload.content.text.slice(0, MAX_EMBED_TEXT_CHARS),
    extractedAt: payload.extractedAt,
    quality: payload.quality,
    extractionStrategy: payload.extractionSource,
  }).map((chunk) => {
    const text = title.length === 0 ? chunk.text : `${title}\n\n${chunk.text}`;
    return {
      chunkId: chunk.id,
      chunkIndex: chunk.chunkIndex,
      text: `passage: ${text}`,
    };
  });
};

const l2Normalize = (vector: Float32Array): Float32Array => {
  let norm = 0;
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index] ?? 0;
    norm += value * value;
  }
  if (norm <= 0) return vector;
  const out = new Float32Array(vector.length);
  const inv = 1 / Math.sqrt(norm);
  for (let index = 0; index < vector.length; index += 1) {
    out[index] = (vector[index] ?? 0) * inv;
  }
  return out;
};

const weightedMean = (
  chunks: readonly DocEmbeddingChunk[],
  vectors: readonly Float32Array[],
  quality: PageEvidenceExtractedRequest['quality'],
): Float32Array | null => {
  const first = vectors.find((vector) => vector.length > 0);
  if (first === undefined) return null;
  const out = new Float32Array(first.length);
  let totalWeight = 0;
  const qualityWeight = qualityWeightFor(quality);
  for (let index = 0; index < vectors.length; index += 1) {
    const vector = vectors[index];
    const chunk = chunks[index];
    if (vector === undefined || chunk === undefined || vector.length !== out.length) continue;
    const chunkWeight =
      qualityWeight * Math.min(1, Math.sqrt(Math.max(1, wordCount(chunk.text)) / 220));
    totalWeight += chunkWeight;
    for (let dim = 0; dim < out.length; dim += 1) {
      out[dim] = (out[dim] ?? 0) + (vector[dim] ?? 0) * chunkWeight;
    }
  }
  if (totalWeight <= 0) return null;
  for (let dim = 0; dim < out.length; dim += 1) {
    out[dim] = (out[dim] ?? 0) / totalWeight;
  }
  return l2Normalize(out);
};

/**
 * Embed chunk texts, consulting the shared (model, sha256(text)) cache first
 * and writing the misses back. One read + one write for the whole page — the
 * chunk count per page is small and bounded, so no extra batching is needed.
 *
 * Best-effort throughout: any cache failure falls through to a plain embed.
 */
const embedChunksThroughSharedCache = async (
  vaultRoot: string,
  ref: VectorRef,
  chunks: readonly DocEmbeddingChunk[],
  embedder: PageEvidenceEmbedder,
): Promise<readonly Float32Array[]> => {
  const model = VECTOR_CORPUS_MODEL_KEY;
  let cache: ReturnType<typeof createEmbeddingCache> | null = null;
  try {
    cache = createEmbeddingCache(vaultRoot, ref.dimensions, { log: embeddingCacheLog });
    await cache.migrateModel(LEGACY_VECTOR_CACHE_MODEL_KEY, VECTOR_CORPUS_MODEL_KEY);
  } catch {
    cache = null;
  }
  const hashes = chunks.map((chunk) => embedTextHash(chunk.text));
  let cached: ReadonlyMap<string, Float32Array> = new Map();
  if (cache !== null) {
    try {
      cached = await cache.getMany(model, hashes);
    } catch {
      cached = new Map();
    }
  }
  const missIndexes: number[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    if (!cached.has(hashes[index] ?? '')) missIndexes.push(index);
  }
  const fresh =
    missIndexes.length === 0
      ? []
      : await embedder(missIndexes.map((index) => chunks[index]?.text ?? ''));
  const out: Float32Array[] = [];
  const toPersist: [string, Float32Array][] = [];
  const freshByIndex = new Map<number, Float32Array>();
  for (let m = 0; m < missIndexes.length; m += 1) {
    const index = missIndexes[m];
    const vector = fresh[m];
    if (index === undefined || vector === undefined) continue;
    freshByIndex.set(index, vector);
    const hash = hashes[index];
    if (hash !== undefined && vector.length > 0) toPersist.push([hash, vector]);
  }
  for (let index = 0; index < chunks.length; index += 1) {
    out.push(freshByIndex.get(index) ?? cached.get(hashes[index] ?? '') ?? new Float32Array(0));
  }
  if (cache !== null && toPersist.length > 0) {
    try {
      await cache.putMany(model, toPersist);
    } catch {
      /* best-effort */
    }
  }
  return out;
};

export const pageEvidenceDocEmbeddingRefFor = (input: {
  readonly canonicalUrl: string;
  readonly contentHash: string;
}): VectorRef => ({
  vectorId: vectorIdFor({
    canonicalUrl: input.canonicalUrl,
    contentHash: input.contentHash,
    modelId: RECALL_MODEL.modelId,
    modelVersion: RECALL_MODEL.revision,
    dimensions: RECALL_MODEL.embeddingDim,
  }),
  modelId: RECALL_MODEL.modelId,
  modelVersion: RECALL_MODEL.revision,
  dimensions: RECALL_MODEL.embeddingDim,
});

export const isCurrentPageEvidenceVectorRef = (ref: VectorRef): boolean =>
  ref.modelId === RECALL_MODEL.modelId &&
  ref.modelVersion === RECALL_MODEL.revision &&
  ref.dimensions === RECALL_MODEL.embeddingDim;

export const writePageEvidenceDocEmbedding = async (
  vaultRoot: string,
  payload: PageEvidenceExtractedRequest,
  embedder: PageEvidenceEmbedder = defaultEmbed,
): Promise<VectorRef | undefined> => {
  if (embeddingDisabled()) return undefined;
  const ref = pageEvidenceDocEmbeddingRefFor({
    canonicalUrl: payload.canonicalUrl,
    contentHash: payload.content.contentHash,
  });
  const cache = createEmbeddingCache(vaultRoot, ref.dimensions, { log: embeddingCacheLog });
  const existing = await cache.get({
    ...VECTOR_CORPUS_MODEL_KEY,
    embedTextHash: ref.vectorId,
  });
  const legacyExisting =
    existing === null
      ? await cache.get({ ...LEGACY_VECTOR_CACHE_MODEL_KEY, embedTextHash: ref.vectorId })
      : existing;
  if (legacyExisting !== null) return ref;
  const chunks = splitDocEmbeddingChunks(payload);
  if (chunks.length === 0) return undefined;
  // E2 — the per-CHUNK embeds now go through the shared text-keyed cache.
  //
  // This function already used the cache, but keyed on `ref.vectorId`
  // (canonicalUrl + contentHash + model) and only for the FINAL doc vector, so
  // the chunk embeds underneath it were uncached. Those chunk texts are
  // byte-identical to what recall-v2's `chunkEmbedText` produces (both are
  // `passage: ${title}\n\n${chunk.text}` off the same splitter), which made
  // every indexed page pay for the same ONNX pass twice — once here, once in
  // the recall-v2 chunk backfill. Text-keying the chunk embeds is what turns
  // the second pass into a cache hit. The doc-vector entry keeps its vectorId
  // key: it is a WEIGHTED MEAN, not the embedding of any text, so it has no
  // text hash to be keyed by (documented in the substrate map as a deliberate
  // second keyspace in the same file).
  const vectors = await embedChunksThroughSharedCache(vaultRoot, ref, chunks, embedder);
  const docVector = weightedMean(chunks, vectors, payload.quality);
  if (docVector === null || docVector.length !== ref.dimensions) return undefined;
  await cache.put(
    {
      modelId: ref.modelId,
      modelRevision: VECTOR_CORPUS_MODEL_KEY.modelRevision,
      embedTextHash: ref.vectorId,
    },
    docVector,
  );
  return ref;
};

export const readPageEvidenceDocVector = async (
  vaultRoot: string,
  ref: VectorRef,
): Promise<Float32Array | null> => {
  if (!isCurrentPageEvidenceVectorRef(ref)) return null;
  const cache = createEmbeddingCache(vaultRoot, ref.dimensions);
  const current = await cache.get({
    ...VECTOR_CORPUS_MODEL_KEY,
    embedTextHash: ref.vectorId,
  });
  return (
    current ??
    (await cache.get({ ...LEGACY_VECTOR_CACHE_MODEL_KEY, embedTextHash: ref.vectorId }))
  );
};
