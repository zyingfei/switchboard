import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryEmbeddingCache } from '../src/recall/cache';
import { TransformersJsEmbedder } from '../src/recall/embedder';
import { buildRecallIndexFromDocuments } from '../src/recall/indexBuilder';
import type { RecallDocument } from '../src/recall/model';
import { RecallVectorIndex } from '../src/recall/vectorIndex';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const now = '2026-04-25T12:00:00.000Z';

const normalizeParagraphs = (text: string): string[] =>
  text
    .split(/\n\s*\n/gu)
    .map((paragraph) => paragraph.replace(/\s+/gu, ' ').trim())
    .filter((paragraph) => paragraph.length >= 120);

const buildSyntheticDocuments = (paragraphs: string[], count: number): RecallDocument[] =>
  Array.from({ length: count }, (_, index) => {
    const paragraph = paragraphs[index % paragraphs.length] ?? paragraphs[0] ?? '';
    const ageBucket = index % 4;
    const capturedAt =
      ageBucket === 0
        ? '2026-04-24T09:00:00.000Z'
        : ageBucket === 1
          ? '2026-04-10T09:00:00.000Z'
          : ageBucket === 2
            ? '2026-02-14T09:00:00.000Z'
            : '2023-11-03T09:00:00.000Z';
    return {
      id: `synthetic-${count}-${index}`,
      sourcePath: `_BAC/benchmarks/${count}/doc-${index + 1}.md`,
      sourceKind: 'markdown',
      title: `Synthetic recall note ${index + 1}`,
      text: paragraph,
      capturedAt,
    };
  });

const main = async () => {
  const brainstorm = await readFile(resolve(repoRoot, 'BRAINSTORM.md'), 'utf8');
  const paragraphs = normalizeParagraphs(brainstorm).slice(0, 256);
  if (paragraphs.length < 32) {
    throw new Error('Expected at least 32 usable BRAINSTORM paragraphs for benchmark corpus.');
  }

  const embedder = new TransformersJsEmbedder({ device: 'wasm' });
  const cache = new MemoryEmbeddingCache();
  const sizes = [100, 1000, 10000, 50000];
  const query = 'calibrated-freshness recall pglite pgvector vault';
  const rows: Array<Record<string, unknown>> = [];

  for (const size of sizes) {
    const documents = buildSyntheticDocuments(paragraphs, size);
    const build = await buildRecallIndexFromDocuments({
      documents,
      cache,
      embedder,
    });
    const index = new RecallVectorIndex(build.records);
    const queryStart = Date.now();
    const queryEmbedding = await embedder.embed([query]);
    const searchStart = Date.now();
    const hits = index.search(Float32Array.from(queryEmbedding.embeddings[0] ?? []), {
      window: '3w',
      topK: 3,
      now: new Date(now),
    });
    rows.push({
      size,
      documents: build.report.documents,
      chunks: build.report.chunks,
      uniqueDigests: build.report.uniqueDigests,
      embeddedDigests: build.report.embeddedDigests,
      cachedDigests: build.report.cachedDigests,
      totalBuildMs: build.report.timings.totalMs,
      embedMs: build.report.timings.embedMs,
      queryEmbedMs: queryEmbedding.latencyMs,
      searchMs: Date.now() - searchStart,
      totalQueryMs: Date.now() - queryStart,
      topHit: hits[0]?.title ?? null,
      topScore: hits[0]?.score ?? null,
    });
  }

  const dogfood = await buildRecallIndexFromDocuments({
    documents: [
      {
        id: 'brainstorm',
        sourcePath: 'BRAINSTORM.md',
        sourceKind: 'markdown',
        title: 'BRAINSTORM',
        text: brainstorm,
        capturedAt: now,
      },
    ],
    cache,
    embedder,
  });
  const dogfoodIndex = new RecallVectorIndex(dogfood.records);
  const dogfoodQuery = await embedder.embed(['calibrated-freshness']);
  const dogfoodHits = dogfoodIndex.search(Float32Array.from(dogfoodQuery.embeddings[0] ?? []), {
    window: '3w',
    topK: 5,
    now: new Date(now),
  });

  await embedder.dispose();

  console.log(
    JSON.stringify(
      {
        modelId: dogfood.report.modelId,
        device: dogfood.report.resolvedDevice,
        benchmarkDate: now,
        rows,
        dogfoodTopHits: dogfoodHits.slice(0, 3),
      },
      null,
      2,
    ),
  );
};

await main();
