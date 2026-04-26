import { describe, expect, it } from 'vitest';
import { MemoryEmbeddingCache } from '../../src/recall/cache';
import { HashingEmbedder } from '../../src/recall/embedder';
import { buildRecallIndexFromDocuments } from '../../src/recall/indexBuilder';
import { RecallVectorIndex } from '../../src/recall/vectorIndex';

const documents = [
  {
    id: 'recent-note',
    sourcePath: 'Projects/recent.md',
    sourceKind: 'markdown' as const,
    title: 'Recent note',
    text: 'Semantic recall should prefer this recent note about calibrated freshness and vector search.',
    capturedAt: '2026-04-24T09:00:00.000Z',
  },
  {
    id: 'archive-note',
    sourcePath: 'Archive/archive.md',
    sourceKind: 'markdown' as const,
    title: 'Archive note',
    text: 'Semantic recall should prefer this recent note about calibrated freshness and vector search.',
    capturedAt: '2024-04-24T09:00:00.000Z',
  },
];

describe('buildRecallIndexFromDocuments', () => {
  it('reuses cached embeddings across rebuilds and ranks by freshness', async () => {
    const cache = new MemoryEmbeddingCache();
    const embedder = new HashingEmbedder('wasm');

    const first = await buildRecallIndexFromDocuments({ documents, cache, embedder });
    const second = await buildRecallIndexFromDocuments({ documents, cache, embedder });

    expect(first.report.embeddedDigests).toBe(1);
    expect(second.report.embeddedDigests).toBe(0);
    expect(second.report.cachedDigests).toBe(1);

    const queryEmbedding = await embedder.embed(['calibrated freshness vector search']);
    const index = new RecallVectorIndex(second.records);
    const hits = index.search(Float32Array.from(queryEmbedding.embeddings[0] ?? []), {
      window: '3w',
      topK: 2,
      now: new Date('2026-04-25T12:00:00.000Z'),
    });

    expect(hits[0]?.title).toBe('Recent note');
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0);
  });
});
