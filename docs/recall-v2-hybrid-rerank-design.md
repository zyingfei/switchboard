# Recall v2 — Hybrid retrieval refactor (canonical dedupe + BM25F + gap-gated semantic + CE rerank)

Design decisions for the hybrid-search refactor of `/v2/recall`, captured
during a multi-round review. This document records what changed and
**why**, including the three senior-level watch-outs the reviewer
flagged before merge. Implementation lands across multiple commits in
the same PR.

## Context — what triggered the refactor

User-reported recall regression: visited 5 pages on a single topic
(Mullvad exit IP fingerprinting), selected obvious keywords from a
page title (`Mullvad exit IPs`, `Exit IP fingerprinting between VPN
servers`), and Déjà-vu returned none of the other four. Empirical
trace showed:

1. Raw FTS5 returned all 5 pages with strong BM25 scores
2. Pipeline `collapseByLocationKey` stripped HN `?id=N` query params,
   collapsing 3 separate items into 1 row
3. RRF fusion gave equal weight to semantic_query rank-1 (cosmic-coincidence
   cosine ~0.43 against unrelated docs) and timeline_visit rank-1 (rare
   query term in title — high precision)
4. Default `limit=12` truncated below the relevance threshold; noise
   dominated top results

Empirical measurement: across 8 diverse queries the e5-small cosine
distribution has a **noise floor at ~0.38**. The hard
`SEMANTIC_ABSOLUTE_MIN_COSINE = 0.15` filter let everything through.
`top - p50` gap turned out to be the cleanest signal/noise marker:
queries with gap < 0.05 had a flat noise distribution; gap > 0.10
had real signal at the top.

## Decisions

### D1 — Dedupe by `canonical_url` verbatim

**Replaces:** `collapseByLocationKey` (regex-based path/query stripping)

**Why:** Upstream page-evidence extraction already produces canonical
URLs that preserve structural query params (verified: HN `?id=N` URLs
all stored with their id intact). The `locationKey` transformation was
fighting against correct upstream canonicalization and destroying
identity-bearing query params for entire classes of sites (HN,
YouTube, Reddit, etc.).

Two candidates with different `canonical_url` are different entities.
No further transformation. The merge-evidence logic stays — when two
candidates have the SAME `canonical_url` (e.g. same URL surfaced by
both lexical and semantic), we keep the higher-scoring one and merge
the evidence array.

**For sites without `<link rel="canonical">`:** parameter cardinality
profiling (D7) handles the residual case (e.g. `google.com/?zx=N`
noise visits).

### D2 — Unified `lexical` source via BM25F (collapses 3 sources to 1)

**Replaces:** separate `generatePageContent`, `generateTimelineVisit`,
`generateChatTurn` generators

**Why:** RRF requires its inputs to have comparable ranking quality. A
rank-1 title match in `timeline_visit` and a rank-1 body match in
`page_content` produce the same RRF contribution (`1/(60+1)`), but
have wildly different precision. Splitting into per-`source_kind`
streams was the structural error — FTS5 already supports BM25F (field-
weighted BM25), which is the principled fix.

One FTS5 query over `docs_fts`:

```sql
SELECT
  docs.entity_id, docs.source_kind, ...
  bm25(docs_fts, 5.0, 1.0, 1.0, 0.5)
    * (1.0 + 1.0 / log(COALESCE(length(docs.body), 1) + 1))
    AS modulated_bm25,
  snippet(docs_fts, 1, '', '', '…', 64) AS body_snippet
FROM docs JOIN docs_fts ON docs.rowid = docs_fts.rowid
WHERE docs_fts MATCH ?
ORDER BY modulated_bm25 DESC LIMIT ?
```

- `bm25(..., 5.0, 1.0, 1.0, 0.5)` — title weight 5x body. The
  unified-source design eliminates the source-kind imbalance at the
  retrieval layer.
- `COALESCE(length(body), 1) + 1` — title-only docs (body NULL) get
  the strongest length boost (multiplier ~2.44); long body docs get a
  smaller boost. Per reviewer: SQLite returns `NULL` from
  `length(NULL)`, so the COALESCE is required to keep title-only docs
  in the result.
- `source_kind` becomes display metadata on the candidate row, not a
  fusion dimension.

**After this change RRF runs over just two streams:** `lexical` and
`semantic_query` (plus `graph_neighbor` when on).

### D3 — Smooth gap-based semantic gate (per-model thresholds)

**Replaces:** `SEMANTIC_ABSOLUTE_MIN_COSINE = 0.15` hard floor +
`SEMANTIC_RELATIVE_FRACTION = 0.5`

**Why:** Static thresholds can't distinguish "high top cosine with no
gap" (pure noise) from "high top cosine with large gap" (real signal).
Measured `top - p50` gap was the clean discriminator:

| Query type | gap | meaning |
|---|---|---|
| 0.009 | "Bayesian" single token | pure noise |
| 0.028-0.041 | "Mullvad exit IPs" / "how to write tests" | flat noise |
| 0.062 | "CVE memory corruption" | marginal |
| 0.075-0.172 | "BGP convergence" / "Claude architect" | real signal |

A linear ramp converts gap → contribution multiplier:

```typescript
multiplier = clamp((gap - noiseFloor) / (fullSignal - noiseFloor), 0, 1)
```

Per-candidate RRF contribution becomes `multiplier * 1/(k+rank)`.

**Important — D8 below:** the noise-floor and full-signal constants
(`0.03` and `0.07` for e5-small) live in a per-model registry, NOT
hardcoded in the gate code. If we ever swap to bge-small / nomic-embed
/ a newer quantization, the cosine space shifts radically and the
constants would silently break. The registry forces an explicit
calibration step per model.

### D4 — Cross-encoder rerank with FTS5 snippet feeding

**Existing:** `rerank.ts` uses Xenova/ms-marco-MiniLM-L-6-v2; off by
default; turned on via `strategy.rerankTopK > 0`.

**Change:** populate `candidate.snippet` with FTS5's
`snippet(docs_fts, body_col, '', '', '…', 64)` — the matched passage
with token budget 64. The cross-encoder already prefers
`snippet ?? title` so the rerank code itself is unchanged.

**Why:** the ms-marco CE has a 512-token sequence limit. Passing the
raw body silently truncates long pages, scoring documents on their
introduction alone — even when BM25 matched a paragraph deep in the
body. Passing the exact matched passage gives the CE the same evidence
the lexical retrieval relied on.

For title-only docs (no body), the snippet is empty and the CE falls
through to title only — which is fine because those docs HAVE no body
to truncate.

**Pre-warm at startup:** measured cold-start cost = 4,483 ms (one-time
model load). Mirror the embedder pre-warm pattern; flag-gated,
default-on. Moves the cold cost out of user-facing latency. Warm rerank
on top-30 measured p50=273 ms, p90=548 ms.

### D5 — Parameter cardinality profiler (background job)

**For:** the residual non-canonical case — sites that don't declare
`<link rel="canonical">` and use noisy query params (`?zx=N`,
`?session=N`, etc.). Without this, those URLs each create a separate
docs row and dedupe doesn't fire.

**Heuristic:** for each `(host, param-name)` observed in `docs`:

1. Group docs by `(host, path, param-name)`.
2. Count distinct `title` values across the group.
3. If `distinct_titles == 1`: param value doesn't affect content →
   candidate for stripping.
4. **SPA fallback** (D9 below): some SPAs forget to update `<title>`
   on route change. Check body-length variance too — if
   `max(length(body)) - min(length(body)) > 15% of mean`, treat as
   structural even when title is flat.

Output: per-host strip-list stored in `recall_metadata` under
`strip_params:<host>`. Applied during the next page-evidence write to
re-canonicalize stored URLs.

Runs as a background job on the existing backfill cadence (signature
flip triggers re-profile). No impact on hot-path latency.

### D6 — RRF stays pure

**Decision:** do NOT add per-source weights to RRF. The fusion math
stays `1/(k+rank)` — same `k=60`, same untouched contribution per
source. All quality differentiation moves UPSTREAM:

- Lexical quality → BM25F field weights (D2)
- Semantic quality → gap-based multiplier on the contribution (D3)
- Match quality across sources → cross-encoder over top-N (D4)

Per reviewer: "Hacking constants into RRF defeats its mathematical
elegance." Score-modulated RRF specifically — multiplying the
reciprocal-rank contribution by a per-stream confidence signal — is
the principled way to encode source quality.

## Watch-outs (incorporated)

### D7 — Model-coupled constants live in a registry

```typescript
// recall-v2/model-registry.ts
export interface RetrievalModelProfile {
  readonly modelId: string;
  readonly embeddingDim: number;
  readonly semGapNoiseFloor: number;     // calibrated per model
  readonly semGapFullSignal: number;     // calibrated per model
  readonly calibratedAt: string;
}

export const KNOWN_MODELS: Record<string, RetrievalModelProfile> = {
  'Xenova/multilingual-e5-small': {
    modelId: 'Xenova/multilingual-e5-small',
    embeddingDim: 384,
    semGapNoiseFloor: 0.03,
    semGapFullSignal: 0.07,
    calibratedAt: '2026-05-26',
  },
};

export const profileFor = (modelId: string): RetrievalModelProfile => {
  const exact = KNOWN_MODELS[modelId];
  if (exact !== undefined) return exact;
  // Unknown model — fall back to "always-on" semantic (multiplier = 1)
  // and log a warn so the operator notices. Better to over-trust
  // semantic than to silently break a new model.
  console.warn(`[recall-v2] unknown embedder ${modelId} — using safe defaults; calibrate by running cosine-distribution probe`);
  return {
    modelId,
    embeddingDim: 384,
    semGapNoiseFloor: 0,    // always-pass
    semGapFullSignal: 0.001,
    calibratedAt: 'default-unsafe',
  };
};
```

The pipeline reads via `profileFor(deps.modelId)` — not via imported
constants. Swapping models requires either an entry in `KNOWN_MODELS`
or an explicit acceptance of the safe-default warn line.

### D8 — Cross-encoder gets snippets, not raw bodies

Already covered by D4. Implementation note: FTS5's `snippet()` function
generates the passage. For docs that match via title only,
`snippet(docs_fts, title_col, ...)` returns the matched title; we
pass that. For body matches, we pass the body snippet. The CE never
sees a raw 100k-char document.

### D9 — SPA length-fallback in cardinality profiler

Already covered by D5. Implementation note: the existing
`page-content/store.ts` stores `indexedCharCount` in the coverage
metadata — we already track body byte-size per doc, so the length
variance check is a free SQL aggregate on existing columns.

## Implementation order (smallest first)

1. **I1** model-registry.ts (D7) — pure new file
2. **I2** drop locationKey, dedupe by canonical_url (D1) — small pipeline.ts diff
3. **I5** FTS5 snippet extraction (D4 first half) — sqlite.ts SELECT addition
4. **I3** smooth gap-based gate (D3) — pipeline.ts diff, uses registry
5. **I6** cross-encoder pre-warm (D4 second half) — cli.ts side-effect
6. **I4** BM25F unified lexical source (D2) — bigger pipeline.ts refactor
7. **I7** cardinality profiler (D5 + D9) — new background job

## Validation

- 13 eval fixtures must stay green (no regressions)
- Mullvad live query: tmctmt #1, mullvad blog top-3, 3 distinct HN
  items, mullvad mitigation top-5
- Cosine-distribution probe re-run after BM25F + gate changes — confirm
  the gap distributions still map cleanly to the registry thresholds
- /v1/status under stress stays sub-200ms with rerank pre-warmed
