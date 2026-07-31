# Similarity substrate map — the two embedding pipelines, end to end

**Date:** 2026-07-29
**Scope:** `packages/sidetrack-companion`
**Why:** the recommendation & graph feature review
([`2026-07-29-recommendation-graph-feature-review.md`](./2026-07-29-recommendation-graph-feature-review.md))
§G2 names *"two similarity systems that can drift apart"* and §E2 proposes one
substrate. Before merging anything, this document establishes what actually
exists: which model each side uses, what text it embeds, which caches it
consults, who opens what and when, and **every place the two can disagree**.

**Out of scope, deliberately (§E2 goes further than this map licenses):**
merging the two **corpora**, or changing **edge semantics**. Those change what
is served. Everything recorded here is about removing *drift* — two answers to
the same question — not about changing either answer. Where merging is
tempting, this document says so and says why it is not done here.

---

## 0. TL;DR — the three disagreement risks that matter

| # | Risk | Status |
|---|---|---|
| **R1** | **Embedding-function drift via `embedderOverride`.** The shared embed cache is keyed on the sha256 of the text *before* `recall/embedder.ts` prepends its unconditional `E5_PREFIX = 'query: '`. The parent wires `setEmbedderOverride(embedderClient.embed)`, which **bypasses** that prefix in-process and relies on the forked child re-applying it. Any future override that does not re-prefix produces different vectors for an **identical cache key** — the cache would then serve vectors from a different embedding function, silently, with no revision change to detect it. | **Open.** Not fixed here (it needs a decision about where the prefix belongs). Highest-severity item on this list because it is silent and cache-persistent. |
| **R2** | **Model identity was copied, not derived.** Four modules carried their own `'Xenova/multilingual-e5-small'`; three carried their own `384`. None failed loudly on divergence — the worst, `recall-v2/model-registry.ts`, *missed* on an unknown id and returned a "safe default" that **disables the semantic gap-gate**, i.e. a retrieval-quality change dressed as a fallback. | **Fixed.** All derive from `recall/modelManifest.ts`; `src/recall/modelIdentity.test.ts` fails if they diverge again. |
| **R3** | **Two keyspaces in one cache file.** `_BAC/recall/embed-cache.bin` was written by two schemes: sha256(text) (visit similarity) and `vectorId` = hash(canonicalUrl + contentHash + model) (page-evidence doc vectors). A text-keyed lookup can never hit a vectorId-keyed entry, so identical chunk text was embedded twice — once per substrate — and the miss was indistinguishable from a cold cache. | **Mostly fixed.** Chunk embeds on both sides are now sha256(text)-keyed and share hits. The page-evidence **doc** vector keeps its vectorId key (see §5.3) — it is a weighted mean, not the embedding of any text, so it has no text to be keyed by. Documented rather than forced. |

---

## 1. The two substrates, side by side

|  | **S1 — materialized visit similarity** | **S2 — recall-v2 doc/chunk vectors** |
|---|---|---|
| Entry point | `src/connections/visitSimilarity.ts` (+ the HNSW fast path inside `src/sync/contract/connectionsMaterializer.ts`) | `src/recall-v2/store/backfill.ts`, queried via `src/recall-v2/store/sqlite.ts` |
| Runs where | the **fork-per-drain child** (`connectionsReconcileChild`) | the **parent** (backfill on `getOrOpenStore`; query at resolve time) |
| Vector store | `hnswlib-node` index at `_BAC/connections/visit-similarity-hnsw.v<N>.bin` + a JSON sidecar | `sqlite-vec` virtual tables `docs_vec` / `documents_chunks_vec` in `_BAC/recall/v2/index.sqlite` |
| Unit embedded | one vector per **visit** | one vector per **chunk** (plus a doc-level vector) |
| Serves | `visit_resembles` family edges in the connections graph | the content lane (7) and ai lane (8) KNN |
| Gate | engagement ≥ 5 s (`VISIT_SIMILARITY_DEFAULT_ENGAGEMENT_GATE_MS`) | page has indexed content |
| Safety rail | similarity **floor guard** (`similarityFloorGuard.ts`) — a revision publishing < 10 % of the previously-served edge count is suppressed unless a typed reset reason fires | none of comparable strength |

They share exactly one thing at runtime: the embedder (`src/recall/embedder.ts`)
and, as of this change, the embed cache (`src/recall/embeddingCache.ts`).

---

## 2. Model identity

`src/recall/modelManifest.ts` is the single source of truth:

```
RECALL_MODEL   = { modelId: 'Xenova/multilingual-e5-small',
                   revision: '761b726d…', embeddingDim: 384,
                   dtypePreference: ['q8','fp16','fp32'],
                   inputPrefix: 'query: ', … }
RECALL_MODEL_ID = `${modelId}#rev=${revision}#prefix-query-v1`
```

It is now declared `as const satisfies RecallModelManifest` — the previous type
*annotation* widened `modelId` to `string`, which is precisely why the other
modules could not derive from it and kept their own literal.

**Who consumes what, after the fix:**

| Site | Was | Now |
|---|---|---|
| `connections/visitSimilarity.ts` `VISIT_SIMILARITY_MODEL_ID` | own literal | `RECALL_MODEL.modelId` |
| `connections/types.ts` `VisitSimilarityRevision.modelId` | literal *type* | `typeof RECALL_MODEL.modelId` |
| `producers/visit-resembles-revision.ts` runtime guard | literal compare | `!== RECALL_MODEL.modelId` |
| `recall-v2/model-registry.ts` `KNOWN_MODELS` key + `embeddingDim` | own literals | `[RECALL_MODEL.modelId]`, `RECALL_MODEL.embeddingDim` |
| `recall-v2/store/sqlite.ts` vec0 DDL | `FLOAT[384]` ×2 | `FLOAT[${RECALL_MODEL.embeddingDim}]` |

Still-separate identities, by design:

- `RECALL_MODEL_ID` folds the revision; the **HNSW sidecar records only
  `dimension`**, no model id. A same-dimension model swap would silently reuse
  the old index. Staleness is caught out-of-band by
  `similarityFloorState.servedModelRevision !== RECALL_MODEL.revision` in the
  materializer, which pushes an `'embedding-model-change'` floor-reset reason.
  That works, but the HNSW store itself is not self-describing — noted, not
  changed (touching the sidecar schema is an index migration).
- `recall-v2/rerank.ts` uses `Xenova/ms-marco-MiniLM-L-6-v2`. That is a
  **cross-encoder reranker**, a genuinely different model, correctly separate.
- `RECALL_MODEL.inputPrefix` is declared and **never read** — `embedder.ts` has
  its own `E5_PREFIX` constant. Two sources of truth for one string, one of
  them dead. See R1.

---

## 3. Corpus text construction — the two sides embed different things

This is where merging is tempting and where it is **not** done.

**S1, per visit** (`corpusForVisitEntry` → `cleanCorpusText`), default flags:

```
"passage: " + normalize(title + " " + host + " " + pathTokens)
```

with two default-OFF alternatives: `SIDETRACK_SIMILARITY_CONTENT_CORPUS=1`
switches to page-evidence terms/keyphrases/entities, and
`SIDETRACK_SIMILARITY_CLEAN_CORPUS=1` drops the host/path skeleton. The
skeleton is a known false-friend source (it inflates same-site cosine ≈ +0.03,
measured in-file).

**S2, per chunk** (`chunkEmbedText`):

```
"passage: " + (title ? title + "\n\n" + chunk.text : chunk.text)
```

**S2, per query** (`contentLane.acquireQueryVector`), no prefix of its own:

```
lane 7:  gist + " " + title + " " + urlTokens(url)
lane 8:  gist          (gist alone — nothing may dilute it)
```

**These are different corpora answering different questions** — "which visits
resemble each other at the title/URL level" vs "which page bodies are about the
same thing". Merging them would change every served edge and every lane score
at once, which is exactly the kind of change §E2's "without changing served
semantics" constraint forbids. **Not done.** The unification here is confined
to *identity* and *cost*.

### 3.1 The double prefix (a real, shared quirk)

`recall/embedder.ts:embed()` prepends `E5_PREFIX = 'query: '` to **every** text
unconditionally. Sites that also prefix therefore send:

| Site | intended | actually sent to ONNX |
|---|---|---|
| `visitSimilarity` passage side | `passage: …` | `query: passage: …` |
| `visitSimilarity` query side | `query: …` | `query: query: …` |
| `connectionsMaterializer` HNSW path | `passage: …` | `query: passage: …` |
| `page-evidence/embedding.ts` | `passage: …` | `query: passage: …` |
| `recall-v2/store/backfill.ts` | `passage: …` | `query: passage: …` |
| `contentLane` query path | *(none)* | `query: …` ✅ |

E5's asymmetric `passage:`/`query:` design is thus masked on the corpus side.
**Left exactly as is** — every stored vector in both substrates was produced
this way, so "fixing" it re-embeds both corpora and shifts every cosine. It is
recorded here so the next person does not discover it mid-incident. Note the
consequence for the cache: because keys hash the *pre-`embed()`* text, the
double prefix is applied consistently on both sides of a cache hit, so sharing
is safe **as long as R1 holds**.

---

## 4. Caches — three of them, now two

| Cache | Where | Key | Scope | Persistent? |
|---|---|---|---|---|
| **Shared embed cache** | `_BAC/recall/embed-cache.bin` via `recall/embeddingCache.ts` | `(modelId, modelRevision, sha256(text))` | machine-wide | yes |
| **Lane query LRU** | in-process `Map` in `contentLane.ts`, cap 200 | FNV-1a of `url \0 embedText` | one process | no — empty after every restart |
| **HNSW persisted vectors** | `visit-similarity-hnsw.v<N>.bin` + sidecar | visit id ↔ label | vault | yes, but records **no model id** |

### 4.1 What changed in `embeddingCache.ts`

Two additions, both prerequisites for sharing rather than cosmetic:

1. **`getMany` / `putMany`.** `get` read the whole file; `put` read **and
   rewrote** it. The similarity build did one `get` per text and one `put` per
   vector, so a corpus of N texts cost O(N) full-file reads and O(N) full-file
   rewrites of a file that grows to N × 384 × 4 bytes — **quadratic in bytes**.
   At the live corpus (~63 k texts) that is ~97 MB rewritten *per vector*. This
   is a direct contributor to the "cold-cache full-embed freeze" §G2 lists.
   Now: one read and one write **per batch**, at each site's existing batch
   size (64 for similarity, 32 for recall-v2, per-page for page-evidence).
2. **A process memo** validated against the file's `(mtimeMs, size)`. Needed so
   a per-URL lookup on the resolve path costs a `stat`, not a parse. Validating
   against the stat rather than assuming a single writer is what makes it
   correct when the drain **child** writes the file underneath the parent.

`embedTextHash(text)` is now the one exported key derivation. Any site that
keys this file differently is a separate keyspace in the same file (see R3).

### 4.2 Who consults it now

| Site | Reads | Writes | Batch |
|---|---|---|---|
| `visitSimilarity.embedWithCache` | ✅ | ✅ | 64 (flush-as-you-go retained) |
| `recall-v2/store/backfill.ts` (both chunk paths, one shared helper) | ✅ | ✅ | 32 |
| `page-evidence/embedding.ts` per-chunk embeds | ✅ | ✅ | per page |
| `contentLane` query vector (via the injected embed in `server.ts`) | ✅ | ❌ | 1 |

The lane query path is **read-through only, deliberately**: a `put` rewrites
the whole file, and doing that once per resolved URL would put unbounded I/O
back on the request path that the resolve work keeps taking off it. Its bounded
in-process LRU stays the write side. This is the one place where "one embed per
(model, text) machine-wide" is knowingly not achieved, and it is a cost
decision, not an oversight.

---

## 5. Lifecycles — who opens and warms what

### 5.1 S1

The child opens the HNSW store per drain (`ensureLoaded(vaultRoot,
RECALL_MODEL.embeddingDim)`, which throws on a dimension mismatch), embeds the
delta, and persists with a write-new / flip-`.current` / GC-old protocol
mirroring the connections generation buffer. On any throw the materializer
falls back to `buildVisitSimilarity`, which re-embeds the **whole** eligible
corpus — the degradation `connections/drainDegradation.ts` exists to count.

### 5.2 S2 — the `peek` / `warm` / `open` split

`src/recall-v2/pipeline.ts` holds a process-lifetime
`storeCache: Map<vaultRoot, Promise<RecallStore>>` with three doors:

- `getOrOpenStore` — open **and** `ensureFreshBackfill`. Expensive. Only
  `POST /v2/recall` uses it.
- `warmRecallV2Store` — open only, fire-and-forget, never awaited.
- `peekRecallV2Store` — returns `undefined` if nothing has opened it yet.

`buildContentLaneDeps` peeks; on `undefined` it fires `warm` and returns a
typed-empty lane for *this* request. That is the third §G2 incident: until
something calls the eager door, the two content-dependent lanes are silently
dead after a restart. The warm-on-peek-miss mitigation is already in place; the
underlying asymmetry (one door backfills, two don't) is unchanged here.

### 5.3 The page-evidence doc vector

`writePageEvidenceDocEmbedding` chunks a page, embeds the chunks, and stores a
quality-weighted **mean** under `vectorId = hash(canonicalUrl, contentHash,
model)`. The doc vector is not the embedding of any text, so it has no text
hash — its vectorId key stays. What changed is the layer beneath: the per-chunk
embeds are now text-keyed and shared, which is where the duplicated work was
(`chunkEmbedText` and `splitDocEmbeddingChunks` produce byte-identical
`passage: ${title}\n\n${text}` from the same splitter, so every indexed page
previously paid for the same ONNX pass twice).

---

## 6. Complete disagreement inventory

Everything below is a place where the two sides can answer differently. ✅ =
addressed by this change; ⚠️ = recorded, deliberately unchanged.

1. ✅ **Model id literals** — four copies, no failure on divergence. (R2)
2. ✅ **Embedding dimension literals** — manifest, registry, vec0 DDL ×2;
   nothing in application code validated vector length on write, so a mismatch
   surfaced as silently-rejected vectors.
3. ✅ **Retrieval-profile miss** — an unknown id disabled the semantic gap-gate
   via the "safe default" path.
4. ✅ **Two cache keyspaces in one file** — text-sha vs vectorId. (R3)
5. ✅ **Cache write amplification** — O(N) full-file rewrites; a direct cause of
   the cold-cache freeze.
6. ⚠️ **`embedderOverride` bypasses the prefix.** (R1) The cache cannot detect
   it: same key, different embedding function.
7. ⚠️ **HNSW sidecar records no model identity** — only `dimension`. A
   same-dim swap is caught only by the out-of-band floor-state revision check.
8. ⚠️ **Double `query: ` prefix** on every corpus-side vector in both
   substrates. Consistent, therefore safe to share; wrong relative to E5's
   design; expensive to fix (full re-embed of both corpora).
9. ⚠️ **Different eligibility populations** — S1 gates on engagement ≥ 5 s, S2
   on "has indexed content". A page can be in one corpus and not the other, so
   "similar" means different things per lane. **This is the corpus difference
   §E2 wants merged; merging it is out of scope here** because it changes which
   edges exist.
10. ⚠️ **Different vector-staleness stories** — S1 has the floor guard (the
    59,908 → 63,221 expectation shift) and typed reset reasons; S2 has no
    equivalent floor, so a chunk-vector collapse would surface only as quieter
    lanes.
11. ⚠️ **Query-side asymmetry** — S1 compares corpus-to-corpus; S2's lanes
    compare a *query* vector (gist/title/url) against *chunk* vectors. Those
    cosines are not on the same scale and must not be compared or thresholded
    against each other.
12. ⚠️ **Lane LRU is process-local** — it empties on restart while the shared
    cache persists. Read-through (§4.2) narrows this but does not close it,
    since the lane never writes back.

---

## 7. What would actually merge the substrates (not done here)

For whoever picks up §E2 properly. In dependency order:

1. Close **R1** first — decide where the E5 prefix lives, and make the cache key
   cover it. Everything downstream trusts that key.
2. Give the HNSW sidecar a `modelId` + `modelRevision` and check them on load,
   so vector staleness is self-detecting rather than delegated to floor state.
3. Give S2 a floor guard equivalent to S1's before making anything depend on it.
4. Only then consider a shared corpus. That is an edge-semantics change: it
   needs the floor guard, a typed reset reason, and a shadow-serving comparison
   — not a refactor.

---

## 8. Files touched by this change

| File | Change |
|---|---|
| `src/recall/modelManifest.ts` | `as const satisfies` so literal types survive derivation |
| `src/recall/embeddingCache.ts` | `getMany`/`putMany`, `(mtimeMs,size)` memo, exported `embedTextHash` |
| `src/connections/visitSimilarity.ts` | model id derived; batched cache round-trips |
| `src/connections/types.ts` | `modelId` type derived from the manifest |
| `src/producers/visit-resembles-revision.ts` | guard compares the manifest constant |
| `src/recall-v2/model-registry.ts` | key + dim derived from the manifest |
| `src/recall-v2/store/sqlite.ts` | vec0 width from `RECALL_MODEL.embeddingDim` |
| `src/recall-v2/store/backfill.ts` | both chunk paths share one cache-backed helper |
| `src/page-evidence/embedding.ts` | per-chunk embeds routed through the shared cache |
| `src/http/server.ts` | lane query embed reads through the shared cache |
| `src/recall/modelIdentity.test.ts` | fails if any of the above diverges again |
