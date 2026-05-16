import { createEmbeddingCache } from '../recall/embeddingCache.js';
import { embed as defaultEmbed } from '../recall/embedder.js';
import { RECALL_MODEL } from '../recall/modelManifest.js';
import { vectorIdFor } from './vectorRef.js';
import type { PageEvidenceExtractedRequest, VectorRef } from './types.js';

export type PageEvidenceEmbedder = (
  texts: readonly string[],
) => Promise<readonly Float32Array[]>;

const MAX_EMBED_TEXT_CHARS = 100_000;
const TARGET_CHUNK_CHARS = 1_200;
const MAX_DOC_EMBED_CHUNKS = 80;

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

const splitDocEmbeddingChunks = (input: {
  readonly title?: string;
  readonly text: string;
}): readonly string[] => {
  const text = input.text.slice(0, MAX_EMBED_TEXT_CHARS);
  const paragraphs = text
    .split(/\n{2,}/u)
    .map(normalizeSpaces)
    .filter((part) => part.length > 0);
  const chunks: string[] = [];
  let current = normalizeSpaces(input.title ?? '');
  for (const paragraph of paragraphs) {
    const next = current.length === 0 ? paragraph : `${current}\n\n${paragraph}`;
    if (next.length <= TARGET_CHUNK_CHARS || current.length === 0) {
      current = next;
      continue;
    }
    chunks.push(current);
    current = paragraph;
    if (chunks.length >= MAX_DOC_EMBED_CHUNKS) break;
  }
  if (chunks.length < MAX_DOC_EMBED_CHUNKS && current.length > 0) chunks.push(current);
  return chunks.slice(0, MAX_DOC_EMBED_CHUNKS).map((chunk) => `passage: ${chunk}`);
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
  chunks: readonly string[],
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
      qualityWeight * Math.min(1, Math.sqrt(Math.max(1, wordCount(chunk)) / 220));
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
  const chunks = splitDocEmbeddingChunks({
    ...(payload.title === undefined ? {} : { title: payload.title }),
    text: payload.content.text,
  });
  if (chunks.length === 0) return undefined;
  const vectors = await embedder(chunks);
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
