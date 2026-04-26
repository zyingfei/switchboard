# Recall Vector POC

This POC validates vault-backed semantic recall for Browser AI Companion with the Obsidian vault as the canonical layer and a rebuildable vector cache on top.

## What Was Built

- A standalone WXT + React + TypeScript MV3 package in `poc/recall-vector`.
- Vault readers for:
  - markdown notes with frontmatter-derived timestamps and titles
  - `_BAC/events/*.jsonl` event logs
- Paragraph-first chunking with sentence and word fallback when a paragraph exceeds the chunk budget.
- Embeddings via `@huggingface/transformers` using `onnx-community/all-MiniLM-L6-v2-ONNX`.
- A rebuildable digest cache:
  - vault remains canonical
  - embeddings are cached by chunk-text digest
  - the live query path is an in-memory cosine scan over normalized vectors
- Calibrated-freshness ranking for `3d`, `3w`, `3m`, and `3y` windows.
- A minimal sidepanel flow that can:
  - connect to an Obsidian Local REST API endpoint
  - build the recall index
  - run recall queries
  - mask snippets for screen-share-safe mode
- A benchmark harness in `scripts/benchmark.ts`.
- A contract addition for `bac.recall` in `poc/dogfood-loop/src/mcp/contract.ts`, with the existing dogfood MCP server returning a deliberate "owned by `poc/recall-vector`" stub error until the runtime integration is wired.

## Decisions

- Persistence path chosen: vault-only canonical data plus rebuildable IndexedDB embedding cache in the extension runtime.
- Index storage chosen: in-memory vector scan backed by IndexedDB digest cache.
- PGlite decision: not included in this PoC. The measured warm-cache rebuild and query times did not justify it.
- Chunking strategy: paragraph-first, max 720 characters per chunk, then sentence and word fallback when needed.

## Benchmarks

Benchmarks were run locally on April 25, 2026 with `npm run benchmark`.

Model/runtime:

- Model: `onnx-community/all-MiniLM-L6-v2-ONNX`
- Runtime in the benchmark harness: Node.js `cpu`

Results:

| Corpus | Documents | Chunks | Unique digests | Newly embedded | Build time | Query time |
|---|---:|---:|---:|---:|---:|---:|
| 100 | 100 | 151 | 151 | 151 | 7118 ms | 4 ms |
| 1k | 1000 | 1605 | 245 | 94 | 5203 ms | 21 ms |
| 10k | 10000 | 16115 | 245 | 0 | 177 ms | 31 ms |
| 50k | 50000 | 80589 | 245 | 0 | 778 ms | 124 ms |

Interpretation:

- First-run embedding is the dominant cold-start cost.
- Once the digest cache is warm, rebuild time stays comfortably sub-second even at ~80k chunks.
- Query latency stayed below 200 ms at the largest stress size, so a plain in-memory scan is good enough for this PoC.

Important benchmark caveat:

- The `10k` and `50k` rows are warm-cache stress tests built from repeated BRAINSTORM-derived paragraphs, so they primarily measure rebuild and query behavior, not first-run embedding of 10k or 50k unique chunks.
- The `100` and `1k` rows are the best signal for actual first-run embedding cost on this machine.

## Dogfood Read

Running the benchmark against the real `BRAINSTORM.md` corpus with the query `calibrated-freshness` surfaced freshness-oriented sections from the document rather than unrelated content, which is directionally right.

Subjective quality notes:

- False-positive rate: acceptable for a first semantic pass.
- False-negative feel: still present when the exact section heading is more important than the body text.
- Ranking surprise: the strongest hits clustered around freshness and recall prose, but not always the exact §24.x sentence you would hand-pick.

The next quality improvement should be heading-aware chunk labels or heading injection into each chunk before embedding.

## Recommendation

The PGlite anchor can be relaxed for v1.

Evidence:

- Warm-cache rebuild was `177 ms` at `16,115` chunks and `778 ms` at `80,589` chunks.
- Query latency was `31 ms` at `16,115` chunks and `124 ms` at `80,589` chunks.
- The bottleneck is first-run embedding, not vector search.

That points toward:

- vault as source of truth
- IndexedDB digest cache for embeddings
- in-memory scan for top-K recall
- defer PGlite unless a future corpus needs faster persistence hydration or richer hybrid query semantics

## Known Caveat

`npm run build` succeeds, but bundling `@huggingface/transformers` into the MV3 background worker currently emits an `import.meta` warning and produces a large worker bundle. The Node benchmark path is verified; the browser extension model-loading path still needs manual runtime validation in Chrome before treating this as production-ready.

## Run

```sh
cd poc/recall-vector
npm install
npm run compile
npm test
npm run build
npm run benchmark
```

To try the sidepanel manually:

1. Load `poc/recall-vector/.output/chrome-mv3` in `chrome://extensions`.
2. Open the extension sidepanel.
3. Point it at an Obsidian Local REST API endpoint and API key.
4. Build the vault index and run a recall query.
