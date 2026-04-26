# TODO — `poc/recall-vector`

> **Instruction**: When the work in this TODO is complete, **delete this
> file** and **add `README.md`** documenting what was built (architecture
> chosen, resolved questions, calibration results, dogfood lessons).

## Status today

Folder created, no code yet, no planning README yet. This `TODO.md` is
the planning artifact until either (a) a separate planning `README.md`
is written first, or (b) the work proceeds directly from this scope and
the post-build README replaces this file.

## Scope summary (one-liner)

Validate calibrated-freshness recall (3 days → 3 weeks → 3 months → 3
years) using the Obsidian vault from `poc/obsidian-integration` as the
canonical persistence layer, with `transformers.js + MiniLM-L6-v2` for
embeddings and a rebuildable cache index.

## Architectural questions to resolve

- **Q1.** **Vault-as-canonical-only** (rebuild index from
  `_BAC/events/*.jsonl` + frontmatter mirror on cold load) **vs vault +
  PGlite cache** (§24's original anchor). The user-suggested
  simplification is to start vault-only and add PGlite only if cold-
  start time or query latency demands it.
- **Q2.** **Index storage**: OPFS vs IndexedDB vs in-memory only. Pick
  the cheapest that delivers <200 ms top-K on a realistic corpus.
- **Q3.** **Embedding latency**: `transformers.js + MiniLM-L6-v2`
  (~25 MB) embed-on-capture cost on consumer hardware. §24 anchor.
- **Q4.** **Cold-start time**: how long to rebuild the full index from
  N months of vault history? Sets the persistence-rebuildability story.
- **Q5.** **Calibrated-freshness ranking** (3d / 3w / 3m / 3y): does the
  weighting feel right against a real dogfood corpus, or is it noisy?

## Pre-build gates

- [ ] Confirm dependency on `poc/obsidian-integration` — this PoC reads
  events + entities from the vault that PoC produces. Sequenced after
  PoC-3.
- [ ] Decide whether to extend `poc/obsidian-integration`'s extension
  in-place, or start a fresh extension that imports its REST client.

## Remaining scope

### Scaffolding

- [ ] WXT + React + TypeScript MV3 project (or extension of
  obsidian-integration's project, per gate decision above).
- [ ] Add `transformers.js` and pin MiniLM-L6-v2 model load. Lazy-load
  on first recall trigger to keep startup snappy.

### Embedding pipeline (resolves Q3)

- [ ] Implement embed-on-capture: when a new capture or event lands in
  the vault, compute its embedding and persist to the index.
- [ ] Measure single-pass embedding latency (WASM and WebGPU paths) on
  consumer hardware. Document numbers.
- [ ] Implement chunking strategy for long captures (e.g. paragraph or
  fixed-window). Document choice.

### Index storage (resolves Q1, Q2, Q4)

- [ ] Implement vault-only path: index lives in OPFS (or IndexedDB);
  rebuilds from `_BAC/events/*.jsonl` + frontmatter on cold start.
- [ ] Measure cold-start rebuild time at corpus sizes 100 / 1k / 10k /
  50k chunks. Document numbers. **Resolves Q4.**
- [ ] If cold-start is too slow, add a persisted-index fast path
  (write the index alongside the vault or under OPFS with a vault
  Merkle hash for invalidation).
- [ ] Decide PGlite + pgvector inclusion based on numbers above.
  Default: skip PGlite. **Resolves Q1, Q2.**

### Recall query path (resolves Q5)

- [ ] Implement query: embed query text, compute top-K against index,
  apply calibrated-freshness weighting (3d / 3w / 3m / 3y).
- [ ] Surface recall in side panel: trigger on user highlight (matches
  §24's calibrated-freshness recall flow); return ranked snippets
  with source + capturedAt + score.
- [ ] Tune the freshness weighting against the dogfood corpus until
  results subjectively pass the "useful, not noisy" bar.
  **Resolves Q5.**
- [ ] Honor screen-share-safe mode (if `getDisplayMedia` permission is
  active, mask snippets in the recall surface).

### MCP contract owner role for `bac.recall` and `bac.search` (vector half)

- [ ] Define `bac.recall` tool shape: args (query text, recency window
  3d / 3w / 3m / 3y, top-K, optional bucket / project filter), return
  (ranked matches with snippet, source, capturedAt, score). Add to
  the canonical contract module in `poc/dogfood-loop`.
- [ ] Decide hybrid `bac.search` (lexical from `poc/dogfood-loop` +
  vector from here) vs separate `bac.recall` only. Document choice.
- [ ] Implement reader interface (`recall(query, opts)`) for
  `poc/mcp-server` to call. Reader handles on-demand query embedding.

### Dogfood

- [ ] Run recall against the BRAINSTORM workstream corpus (BRAINSTORM.md +
  imports + chat captures). Validate that highlighting a phrase like
  "calibrated-freshness" surfaces the right §24.8 / §27 entries with
  the right recency tier.
- [ ] Document subjective quality: false-positive rate, false-negative
  feel, ranking surprises.

### Tests

- [ ] Unit (Vitest): chunker, embed wrapper, index ops (add / search /
  remove), freshness weighting math.
- [ ] Integration: end-to-end embed → store → query against a fixture
  vault of N events.
- [ ] Manual benchmarks: cold-start rebuild time, query latency at
  corpus sizes 100 / 1k / 10k / 50k.

### Documentation

- [ ] On completion: delete this `TODO.md` and write the post-build
  README documenting:
  - persistence path chosen (vault-only or vault + PGlite)
  - index storage chosen (OPFS / IndexedDB / in-memory)
  - embedding model + chunking strategy
  - measured numbers for embed latency, cold-start, query latency
  - calibrated-freshness weighting and tuning lessons
  - hybrid `bac.search` decision
  - dogfood quality assessment

## Out of scope here

- EmbeddingGemma-300M as the v1 default — keep MiniLM-L6-v2 (§24).
  EmbeddingGemma is opt-in, future iteration.
- WebGPU optimization beyond a single benchmark — measure but do not
  productize.
- Encrypted backup of the index — `poc/obsidian-integration` covers
  the vault; index is rebuildable cache, no separate backup needed.
- MCP server transport — `poc/mcp-server`.
- Drift detection (W2) — separate v1 implementation work, consumes
  recall but is not this PoC.
- Prompt corpus / autocomplete (§25) — separate v1 implementation work,
  reuses the embedding model but is not this PoC.
