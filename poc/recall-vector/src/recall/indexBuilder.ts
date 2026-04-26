import { chunkDocument } from './chunking';
import type { EmbeddingCacheStore } from './cache';
import type { Embedder } from './embedder';
import { loadVaultCorpus } from './vaultCorpus';
import type { RecallBuildReport, RecallBuildResult, RecallDocument, VectorRecord } from './model';
import type { VaultClient } from '../obsidian/model';

const toFloat32 = (embedding: number[]): Float32Array => Float32Array.from(embedding);

const collectUniqueTexts = (chunks: ReturnType<typeof chunkDocument>) => {
  const uniqueTexts = new Map<string, string>();
  for (const chunk of chunks) {
    if (!uniqueTexts.has(chunk.digest)) {
      uniqueTexts.set(chunk.digest, chunk.text);
    }
  }
  return uniqueTexts;
};

const buildFromDocuments = async (
  documents: RecallDocument[],
  cache: EmbeddingCacheStore,
  embedder: Embedder,
): Promise<RecallBuildResult> => {
  const generatedAt = new Date().toISOString();
  const totalStart = Date.now();

  const chunkStart = Date.now();
  const chunkGroups = documents.map((document) => chunkDocument(document));
  const chunks = chunkGroups.flat();
  const chunkMs = Date.now() - chunkStart;

  const uniqueTexts = collectUniqueTexts(chunks);
  const digests = Array.from(uniqueTexts.keys());

  const cacheStart = Date.now();
  const cachedEntries = await cache.getMany(digests);
  const cacheMs = Date.now() - cacheStart;
  const missingDigests = digests.filter((digest) => !cachedEntries.has(digest));

  const embedStart = Date.now();
  let embeddedDigests = 0;
  if (missingDigests.length > 0) {
    const texts = missingDigests.map((digest) => uniqueTexts.get(digest) ?? '');
    const result = await embedder.embed(texts);
    const createdAt = new Date().toISOString();
    const entries = missingDigests.map((digest, index) => {
      const embedding = result.embeddings[index] ?? [];
      return {
        digest,
        text: uniqueTexts.get(digest) ?? '',
        embedding,
        dimension: embedding.length,
        createdAt,
      };
    });
    await cache.putMany(entries);
    for (const entry of entries) {
      cachedEntries.set(entry.digest, entry);
    }
    embeddedDigests = entries.length;
  }
  const embedMs = Date.now() - embedStart;

  const hydrateStart = Date.now();
  const records: VectorRecord[] = chunks.flatMap((chunk) => {
    const entry = cachedEntries.get(chunk.digest);
    if (!entry) {
      return [];
    }
    return [
      {
        ...chunk,
        embedding: toFloat32(entry.embedding),
      },
    ];
  });
  const hydrateMs = Date.now() - hydrateStart;

  const dimension = records[0]?.embedding.length ?? 0;
  const report: RecallBuildReport = {
    generatedAt,
    storage: cache.kind,
    modelId: embedder.modelId,
    requestedDevice: embedder.requestedDevice,
    resolvedDevice: embedder.resolvedDevice,
    documents: documents.length,
    chunks: records.length,
    uniqueDigests: digests.length,
    embeddedDigests,
    cachedDigests: digests.length - embeddedDigests,
    dimension,
    timings: {
      loadMs: 0,
      chunkMs,
      cacheMs,
      embedMs,
      hydrateMs,
      totalMs: Date.now() - totalStart,
    },
  };

  return { report, records };
};

export const buildRecallIndexFromDocuments = async (options: {
  documents: RecallDocument[];
  cache: EmbeddingCacheStore;
  embedder: Embedder;
}): Promise<RecallBuildResult> => buildFromDocuments(options.documents, options.cache, options.embedder);

export const buildRecallIndexFromVault = async (options: {
  client: VaultClient;
  cache: EmbeddingCacheStore;
  embedder: Embedder;
}): Promise<RecallBuildResult> => {
  const loadStart = Date.now();
  const documents = await loadVaultCorpus(options.client);
  const loadMs = Date.now() - loadStart;
  const result = await buildFromDocuments(documents, options.cache, options.embedder);
  return {
    ...result,
    report: {
      ...result.report,
      timings: {
        ...result.report.timings,
        loadMs,
        totalMs: result.report.timings.totalMs + loadMs,
      },
    },
  };
};
