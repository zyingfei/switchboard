import { createEmbeddingCache } from '../recall/embeddingCache.js';
import { RECALL_MODEL } from '../recall/modelManifest.js';
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
  const cache = createEmbeddingCache(vaultRoot, ref.dimensions);
  const existing = await cache.get({
    modelId: ref.modelId,
    modelRevision: ref.modelVersion,
    embedTextHash: ref.vectorId,
  });
  if (existing !== null) return ref;
  const chunks = splitDocEmbeddingChunks(payload);
  if (chunks.length === 0) return undefined;
  const vectors = await embedder(chunks.map((chunk) => chunk.text));
  const docVector = weightedMean(chunks, vectors, payload.quality);
  if (docVector === null || docVector.length !== ref.dimensions) return undefined;
  await cache.put(
    {
      modelId: ref.modelId,
      modelRevision: ref.modelVersion,
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
  return await cache.get({
    modelId: ref.modelId,
    modelRevision: ref.modelVersion,
    embedTextHash: ref.vectorId,
  });
};
