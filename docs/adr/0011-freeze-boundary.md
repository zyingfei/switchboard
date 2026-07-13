# ADR-0011 — P1 freeze boundary: serving-math frozen, read-path freeze-safe

- Status: Accepted
- Date: 2026-07-11
- Owner: User + Claude
- Components: API | Shared
- Related: ADR-0005, ADR-0008, PRD §11 decision 9, ROADMAP.md §NOW/§NEXT

## Context

The branch `feat/recall-ranker-v2-replacement` is substantially ahead
of main (~247 commits) and delivers M3 scope early: hybrid
lexical+vector recall (`/v2` pipeline, SQLite FTS5 + sqlite-vec),
a learned reranker (LambdaMART + online LR head, impression emission,
trainable `recall.action` events), connections IVM, suggestions, and
attribution fixes.

PRD §11 decision 9 imposed a **P1 freeze** on ranker/recall/connections/
attribution scope until all 16 §13 acceptance steps pass. The freeze
exists because adding new capability scope to these subsystems before
the core dogfood loop is validated risks compounding complexity, breaking
the evaluation spine, or creating regression ratchets that make §13 harder
to close.

A recurring question during the §15 NEXT-horizon work is: **what
counts as frozen?** Specifically, when a new feature reads the output
of the ranker, recall pipeline, or connections graph to display it in
the UI (packets pulling recall neighbors, déjà-vu chips, where-was-I
rollup), does that cross the freeze boundary?

This ADR records the decision and its rationale so it does not need to
be re-litigated on every new feature request.

## Decision

The freeze boundary is defined along the **write path vs read path**
distinction, not along the subsystem boundary:

**FROZEN until §13 passes + §15 window met**:

- Scoring functions, scoring weights, threshold constants in the recall
  pipeline (`/v2` reranker, `learnedRerank.ts`, `graph_baseline`
  scorer).
- Retrain pipeline changes: new artifact kinds, new feature vectors,
  new training-data sources, new label production paths.
- Graph edge production: new edge types, changed edge weights, changed
  candidate filters, changed aggregator grouping logic.
- Attribution logic: new attribution signals, changed similarity
  thresholds, changed policy decisions in `policy.ts`.
- Any change to the `shipGate` conditions or `reservedTestMetric`
  evaluation (ADR-0008).

**FREEZE-SAFE (permitted during the freeze)**:

- Reading the **output** of the ranker, recall pipeline, or connections
  graph and displaying it in the UI (side panel, packets, chips,
  rollups). The serving math does not change; only the consumer changes.
- Plumbing new read-path endpoints that proxy existing served output
  to new surfaces (e.g. a packet composer calling `/v2/recall` to
  populate suggested inclusions).
- Bug fixes and stability improvements to the retrain loop, impression
  emission, and online head update — provided no new feature scope is
  added (ADR-0008 maintenance-only clause).
- UI/UX changes to how recall results are displayed (chip text, sort
  order in the panel, grouping in the packet composer) — provided the
  underlying scores are unchanged.
- Install, distribution, and supervised-install work (ADR-0001 v1.5
  `--install-service` flag).
- New MCP read-only tools that query existing vault state.
- Documentation, ADRs, roadmap updates.

**Boundary test**: if a proposed change requires editing any of
`ranker/select.ts`, `recall-v2/learnedRerank.ts`, `recall-v2/pipeline.ts`
scoring logic, `connections/policy.ts` edge weights/thresholds,
`connections/similarity.ts` thresholds, or any training/label-production
module — it is FROZEN. If the change only adds a new caller of an
existing `/v2` endpoint or reads an existing field from the served
response, it is freeze-safe.

## Options considered

### Option A — Freeze the entire ranker/recall/connections subsystem (hard boundary)

Pros:
- Simple rule; no judgment calls.

Cons:
- Blocks useful UI work that consumes served output without changing
  any math. The NEXT-horizon features (packets pulling recall neighbors,
  déjà-vu chips, where-was-I rollup) are all read-path consumers — they
  would be unnecessarily blocked.
- The freeze's purpose is to prevent scoring/training regressions, not
  to block consumers of already-validated served output.

### Option B — Write-path vs read-path boundary (chosen)

Pros:
- Permits NEXT-horizon UI/plumbing work without lifting the freeze
  prematurely.
- The serving math (the thing the freeze protects) is unchanged; its
  output is simply read by more consumers.
- Consistent with the maintenance-only clause in ADR-0008 (bug fixes
  permitted; new feature scope is not).

Cons:
- Requires judgment to classify a proposed change. The boundary test
  above (which source files are touched) makes this mechanical in
  practice.

### Option C — Freeze until §13 only, then lift fully

Pros:
- Simpler exit condition.

Cons:
- Premature. The §15 window provides empirical signal (real usage
  data, real label production, real recall quality) that is necessary
  before changing the serving math. Lifting the freeze at §13 would
  skip the validation window the freeze was designed to protect.

## Consequences

Positive:
- NEXT-horizon features (packets, chips, rollup, redaction preview)
  can proceed in parallel with §13 closure without waiting for a freeze
  lift.
- The freeze-lift condition is now observable: the PRD §15 counter
  table (amended 2026-07-11) and the ROADMAP.md LATER-horizon entry
  together define when to revisit serving math.
- New contributors can classify proposed changes mechanically using the
  boundary test without reading the full freeze history.

Negative:
- Read-path consumers of recall/connections output accumulate during
  the freeze window. When the freeze lifts, a coordinated review of
  all new consumers against the updated serving math is needed to
  ensure they still make sense (e.g. if RRF weights shift, the
  "suggested inclusions" ranking in the packet composer may need
  recalibration).

## Freeze-lift gate (observable)

The freeze lifts when **both** conditions are met:

1. All 16 §13 acceptance steps pass in a live recorded run (runbook:
   `docs/demos/2026-07-11-section13-acceptance-runbook.md`).
2. All six §15 success criteria in the PRD §15 counter table are met
   (≥80% tracked, ≥3 lossless reorgs, ≥5 packets dispatched, ≥1 tab
   recovery, ≥1 MCP context-pack session, ≥7 days zero data loss).

When both gates pass, update this ADR's status to Superseded and record
the freeze-lift date. The first post-freeze ranker/recall/connections
scope item should reference this ADR to confirm the lift.

## Amendment 2026-07-12 — evidence-gated regression repair is freeze-safe

**Context.** The engagement→similarity chain regressed: the extension
stopped emitting `engagement.session.aggregated` under MV3 service-worker
eviction (fixed by PR #251's durable session store + drain-alarm sweep),
which starved the >=5000ms visit-similarity gate. Result: the served
connections snapshot dropped from a ~30k `visit_resembles_visit` baseline
(June) to **zero** (July) — verified live on the test companion
(`/v1/connections` shows 0 similarity edges; the eval spine's
`connections-precision` reports `totalServedSimilarityEdges=0` with 70
user-confirmed related-pairs unscored). PR #251 backfilled 127 gap
aggregates, but the OLD visits' similarity edges did not reform, because
the scoped-delta materializer only revisits a visit whose URL is in the
drain window (a fresh `browser.timeline.observed`). A late engagement
event puts the URL in neither the reconcile set nor the touched set — the
visit is starved forever (same structural gap as
content-arrives-never-re-embeds).

**Decision.** Under the OWNER DIRECTIVE ("connect built-but-unserved
intelligence, evidence-gated — every serving change ships behind a flag
whose default is set by the eval-spine verdict"), a change that **repairs
a regression back toward a previously-validated baseline** is classified
freeze-safe, subject to three conditions:

1. It restores prior behavior; it does not add new serving scope, new
   edge types, new weights, or new thresholds. (The similarity math,
   gate, and edge kind are unchanged.)
2. It ships behind a kill-switch env flag. The requalification path is
   `SIDETRACK_SIMILARITY_REQUALIFY` (default ON, restores the lane;
   `=0` disables and reverts to the regressed scoped-delta behavior).
3. It is bounded per the CPU regime — no per-drain full rebuild. The
   full-timeline reload only fires when a late engagement event actually
   requalifies a visit absent from the window, and only re-embeds that
   handful of visits (mirrors the existing `topicFullTimeline` precedent).

**What landed (this amendment's scope):**

- Companion `connectionsMaterializer.ts`: when an `engagement.session.
  aggregated` event lifts an old visit past the similarity gate, that
  visit's full-timeline entry is spliced into the similarity entry set
  and its canonical URL joins `hnswReconcileVisitIds`, so the HNSW
  producer re-embeds it and re-derives its edges. Observable in the
  phase log as `buildVisitSimilarityHnsw.start … requalified=N`.
- Offline CLI `engagement requalify-similarity` (planner/apply, report-
  only default, `--apply`, `--max` batch cap): heals the historical
  June-era backlog (visits gate-eligible but with no served similarity
  edge) without a drain-storm, by emitting a zero-dimension "requalify
  ping" per backlog visit. Zero dimensions add nothing to the classifier
  sum (no double-count); the ping's `engagementVisit` invalidation is
  the sole effect. Dry-run against the live vault copy: 1180 eligible
  visits, all 1180 in the backlog (0 served similarity edges).

**Boundary-test note.** This DID touch `connections/similarity`-adjacent
production code (`connectionsMaterializer.ts`), which the boundary test
lists as FROZEN. The exception is narrow: regression-repair-to-baseline,
flag-gated, no new math. A change that altered the gate value, the
similarity threshold, the edge weight, or added a new edge kind would
still be FROZEN and is out of scope here. The eval-spine verdict that
sets the default: `connections-precision` currently scores nothing
(`overallPrecision=null`) precisely because zero edges are served — so
restoring the lane is a prerequisite for the eval spine to produce any
verdict at all, which is why the flag defaults ON.

## Amendment 2026-07-12b — make similarity page-feature-driven (content embedding lane)

**Context.** Amendment 2026-07-12 restored the engagement→similarity
lane so edges reform at all. The audit's second finding remained: even
with edges flowing, the similarity corpus is TITLE-ONLY
(`corpusForVisitEntry` = `[title, host, path-tokens]`), so served edges
are `metadata_only`/`title_only` tier, never `content_vector`. The cause
is a supply gap, not a logic gap: `corpusForVisitEntry` has ALWAYS
preferred page-evidence content when a content-backed record is loaded,
but doc-embedding coverage sat at ~13.6% because the ONLY producer of
page-evidence doc vectors was an inline `setTimeout(0)` embed on the API
request path (`server.ts`, behind
`SIDETRACK_PAGE_EVIDENCE_BACKGROUND_EMBEDDING`). That path ran ONNX/CoreML
on the main event loop, so the flag was correctly kept OFF (the U1–U3 CPU
post-mortems). And records already written content-tier with
`embeddingState:'missing'` were never revisited — the
"better-evidence-never-revalidates" loop.

**Decision.** Under the OWNER DIRECTIVE ("make similarity page-feature
driven … connect built-but-unserved intelligence, evidence-gated — every
serving change ships behind a flag whose default is set by the eval-spine
verdict"), connecting the content path to similarity is classified
freeze-safe, subject to the same three conditions as the prior amendment
PLUS the CPU regime:

1. No new serving math. No new edge kind, weight, threshold, or gate. The
   content-vector channel, the content-enriched producer, and the
   `content_vector` evidence-tier stamp (`snapshot.ts`
   `evidenceTierForSimilarityMetadata`) are all PRE-EXISTING M4 plumbing;
   this work supplies the doc vectors that make them fire and gates
   whether the corpus draws on them.
2. Every serving flip is behind a kill-switch env flag whose DEFAULT is
   set by the eval-spine verdict, not optimism:
   - `SIDETRACK_PAGE_EVIDENCE_BACKGROUND_EMBEDDING` (default **OFF**) —
     now gates the new OFF-main-loop embedding LANE, not the retired
     request-path embed. Producing vectors is data-side, not serving-side,
     but it stays default-OFF until an operator opts in (it is CPU work).
   - `SIDETRACK_SIMILARITY_CONTENT_CORPUS` (default **OFF**) — the actual
     SERVING flip. While OFF, `corpusForVisitEntry` returns the frozen
     title-only skeleton AND a visit's evidence is invisible to the
     content-enriched pair scoring, so a partially-embedded backlog cannot
     shift served edges before `connections-precision` can score the flip
     against the 70 confirmed pairs. Default OFF is the honest verdict:
     the eval spine cannot yet score content-backed edges (none are
     served), so the flip is NOT authorized by evidence and must not
     default ON. (Contrast the prior amendment's requalify flag, which
     defaults ON only because restoring *any* edge is a precondition for
     the eval spine to run at all.)
   - `SIDETRACK_SIMILARITY_CONTENT_REQUALIFY` (default **ON**) — a pure
     requalification of already-eligible visits (no new math); with the
     corpus flag OFF it is a cheap no-op re-derive against the title
     skeleton, so ON is safe and closes the revalidation loop the moment
     the corpus flag is cleared.
3. Bounded per the CPU regime. The embedding lane
   (`page-evidence/backgroundEmbeddingLane.ts`) is an idle-scheduled
   backlog processor: a hard `batchCap` per cycle, a hard PAUSE whenever a
   connections drain is running (`materializer.isDrainActive()`), a
   re-check of the drain gate between records, a per-record failure
   quarantine, and persisted progress. It forks NO new child — it routes
   embeds through the existing embedder child
   (`setEmbedderOverride`), so no second ONNX instance and no main-loop
   inference. A worker/embed failure is caught and skipped, never inline.

**What landed (this amendment's scope):**

- `page-evidence/backgroundEmbeddingLane.ts` + store adapters
  (`listBackgroundEmbeddingCandidates`, `embedBacklogCanonicalUrl`,
  progress read/write): the OFF-main-loop lane, wired in
  `runtime/companion.ts` (gated on the flag AND `useChildProcesses`). The
  retired `setTimeout(0)` request-path embed is removed from `server.ts`.
- `connections/visitSimilarity.ts`: `similarityContentCorpusEnabled()`
  gate at the single `evidenceForEntry` seam, governing BOTH the corpus
  and the content-enriched pair scoring.
- `connections/connectionsMaterializer.ts`: content-arrival
  requalification. `PAGE_EVIDENCE_EXTRACTED` (window) accumulates a
  requalify key WITHOUT forcing a graph drain (preserves the content-lane-
  only optimization); the lane's `requalifyVisitForSimilarity` accumulates
  AND requests a debounced drain. The drain folds these into
  `hnswReconcileVisitIds` via the existing engagement-requalify splice
  (`loadRequalifiedSimilarityEntries`), bounded to visits absent from the
  window and still gate-eligible.
- Evidence-tier stamping (task 4) needed NO change: verified that
  content-backed pairs emit the `contentVector` channel that
  `snapshot.ts` already stamps `content_vector`
  (`similarityContentCorpus.test.ts` end-to-end + `snapshot.test.ts`
  Pass-7).

**Freeze-lift interaction.** None of this lifts the freeze. The serving
math is unchanged; `SIDETRACK_SIMILARITY_CONTENT_CORPUS` stays OFF until
the `connections-precision` verdict (with content-backed edges finally
scorable) clears it. When it does, flip the default in a follow-up that
cites this amendment and the recorded verdict — the same evidence-gated
protocol the OWNER DIRECTIVE requires.

**Follow-up when the corpus flag flips ON.** The cache-probe revisionId
(`computeVisitSimilarityRevisionId`) already incorporates the gated
corpus, so the on-disk cached-revision path invalidates correctly across
the flip. The persistent HNSW store (`persistentHnswSimilarityMode`),
however, caches per-visit embeddings by visit key and does NOT re-embed
existing visits on a mere flag flip — only NEW visits and content-arrival
requalified visits re-embed. So the FIRST enablement of the corpus flag
should be paired with a one-time similarity HNSW rebuild (bump
`MATERIALIZER_VERSION` or clear the HNSW files) so the whole corpus picks
up content vectors, not just the incremental frontier. Until then the
background lane + requalify path upgrade visits opportunistically as they
are revisited. This is a deployment step for the future flip, not a
correctness gap at the current default-OFF.

## Amendment 2026-07-12c — make RECALL page-feature-driven (chunk-vector serving + provenance down-weight)

**Context.** Amendments 2026-07-12/12b addressed the CONNECTIONS
similarity lane. The sibling gap is on the RECALL serving path
(`/v2/recall`, the single funnel behind déjà-vu, focus/Now-card related,
and Search). Two pieces of retrieval intelligence were BUILT but never
served:

1. **Chunk vectors are written but never queried.** The backfill embeds
   per-passage chunk vectors into `documents_chunks_vec`
   (`backfillChunkVectors`), but the semantic-query generator only ever
   ran `queryVector` over the WHOLE-DOC `docs_vec` centroid. A doc with
   one strongly-relevant passage and a lot of off-topic body scores by
   its average, not its best section — the opposite of what "find the
   page that discussed X" wants. There was no `queryChunkVector` at all.
2. **body_indexed provenance is returned but ignored.** Since #242-M4,
   `queryVector` returns `bodyIndexed` (1 = content-derived vector, 0 =
   title/URL-only, e.g. a bare timeline visit), explicitly READ-ONLY:
   "any down-weighting of title-only hits is a serving-math change gated
   behind the P1 freeze (ADR-0011)." A title-only vector is a weaker
   relevance signal than a content-derived one at the same cosine, but
   fusion treated them identically.

**Decision.** Under the OWNER DIRECTIVE ("make every ML / recommendation
system … connected and working in plugin … evidence-gated — every serving
change ships behind a flag whose default is set by the eval-spine
verdict"), connecting these to the semantic-query lane is classified
freeze-safe, subject to the same conditions as the prior amendments:

1. No new retrieval SOURCE, no new edge kind, no new score fusion
   formula. Both arms operate ENTIRELY within the existing
   `generateSemanticQuery` lane: arm 1 swaps the vector SUBSTRATE
   (chunk-pooled KNN vs whole-doc KNN) feeding the same cosine → floor →
   gap-gate → RRF pipeline; arm 2 applies a cosine multiplier to
   title-only hits BEFORE the same floors/gate. The RRF-K, the semantic
   floors, the `model-registry` gap-gate, and the cross-encoder rerank
   are all unchanged. Doc-level max-chunk pooling (MIN cosine distance ==
   MAX similarity) and the `TITLE_ONLY_COSINE_MULTIPLIER` (0.85) are the
   only new math, and both are dark until a flag is set.
2. Every serving flip is behind a kill-switch env flag whose DEFAULT is
   set by the eval-spine verdict, not optimism:
   - `SIDETRACK_RECALL_CHUNK_VECTORS` (default **OFF**) — prefer
     chunk-vector pooling in the semantic lane.
   - `SIDETRACK_RECALL_PROVENANCE_DOWNWEIGHT` (default **OFF**) —
     down-weight title-only KNN hits.

   Default OFF is the honest verdict: the recall replay harness
   (`recall-v2/eval`) cannot yet score these arms against real
   chunk-vector coverage on the live vault (the same reasoning as
   amendment 12b's `SIDETRACK_SIMILARITY_CONTENT_CORPUS`). The arms are
   INJECTED via `PipelineDeps.retrievalArms` (not just env) so the
   harness can run arm-vs-arm per-run without mutating process env; the
   active arms are surfaced in `meta.flags.recallChunkVectors` /
   `recallProvenanceDownweight` for the debug overlay. When the harness
   scores an arm as a win, flip its default in a follow-up citing the
   recorded verdict.
3. Bounded per the CPU regime. Neither arm adds compute to the drain
   thread. `queryChunkVector` is a single indexed SQLite KNN
   (over-pull `limit * 4`, capped) + a GROUP BY on the request path —
   the same shape and budget as the existing `queryVector`; no embedding
   or rebuild is triggered. Chunk vectors are produced by the EXISTING
   idle-batched backfill, unchanged. The down-weight is a scalar multiply
   per candidate.

**What landed (this amendment's scope):**

- `recall-v2/store/sqlite.ts` + `store/types.ts`: `queryChunkVector` —
  two-stage KNN over `documents_chunks_vec` (so vec0 sees its own LIMIT),
  joined `documents_chunks → docs`, `GROUP BY document` keeping
  `MIN(distance)` (max-chunk pool), returning the doc-level shape plus
  `pooledChunkCount`. Always-available store method; gating is at the
  caller.
- `recall-v2/retrievalFlags.ts`: the two flags, the injectable
  `RetrievalArms` type, `retrievalArmsFromEnv`, and the
  `TITLE_ONLY_COSINE_MULTIPLIER` constant, all documented default-OFF.
- `recall-v2/pipeline.ts`: `generateSemanticQuery` prefers
  `queryChunkVector` when arm 1 is on (falling through to `queryVector`
  then the JSON sidecar so enabling never regresses a chunk-less corpus),
  and applies the provenance down-weight to the effective cosine used for
  ranking + floors + gap-gate when arm 2 is on (raw cosine preserved in
  evidence for honesty). Arms resolved once per run from
  `deps.retrievalArms ?? retrievalArmsFromEnv()`.

**No forked query paths (task 3).** Verified that déjà-vu (`intent:
'dejavu'`), the Now-card related strip (`intent: 'focus'`,
`useFocusedRelatedPages`), and Search (`intent: 'search'`) ALL POST the
same `/v2/recall` via the extension's single `recallV2Query` bridge, and
that the only semantic-vector retrieval in the pipeline is
`generateSemanticQuery`. The `graph_neighbor`/"Similar" pool surface is
anchor-anchored (a distinct SOURCE within the same pipeline), not a
second query path. So both arms take effect uniformly across every recall
surface with no divergence. The `queryVector` reference in
`connections/visitSimilarity.ts` is a comment naming a local variable in
the separate connections-drain subsystem, not a second caller of the
store method.

**Freeze-lift interaction.** None of this lifts the freeze. The served
order is byte-identical to the prior baseline while both flags are OFF
(the eval-spine fixtures are unchanged and green). When the recall replay
harness can score an arm against the live-vault chunk coverage, flip its
default in a follow-up that cites this amendment and the recorded
verdict — the same evidence-gated protocol the OWNER DIRECTIVE requires.

## Amendment 2026-07-13 — extension read-path honesty + impression-loop verify + intelligence observability

**Context.** Amendments 12/12b/12c connected the COMPANION serving lanes
(connections similarity, recall). This amendment covers the EXTENSION
read-path: (1) the suggestion surface presented candidates the resolver's
policy did NOT endorse in the same visual language as endorsed ones —
observed live as a `decision.action='inbox'`, `margin=-0.62` pick rendered
as a "Suggested" badge; (2) the impression → `recall.action` training loop
needed live verification that panel usage actually accumulates joinable
signal; (3) the built-but-unsurfaced intelligence had no glanceable
readout of whether it is wired and moving.

**Decision.** Under the OWNER DIRECTIVE ("make every ML / recommendation
system … connected and working in plugin"), all three are classified
FREEZE-SAFE because they are pure read-path consumers of already-served
output — they change no serving math:

1. No new serving scope. The honesty gate keys ENTIRELY on the resolver's
   existing `decision.action` contract (`policy.ts`: `suggest`/`auto-apply`
   = endorsed, `inbox` = not endorsed) and the existing per-candidate
   `reasons[].source`. No threshold, weight, or policy value is touched;
   the panel merely stops mis-presenting a signal the companion already
   produced. Reason chips map the existing `ppr`/`similarity`/`cluster`
   source (the title-vs-content split reads the existing
   `pageEvidence.vector`). The aggregator quiet-state mirrors the
   companion's existing `COARSE_MULTI_TOPIC_DOMAINS` registrable-domain
   set (read-only classification, no candidate filtering).
2. The Intelligence readout is pure observability. It reads ONLY fields
   the companion already materializes on `GET /v1/system/health`
   (`workGraph.recall.canonicalVectorCounts`,
   `workGraph.ranker.augmentation`, `workGraph.impressionLog`,
   `sync.materializers.connections.lastSuccessAt`) — the same endpoint the
   Health panel consumes. No new scan, no new endpoint, no new event read.
3. No flag is required because nothing about the served math changes; the
   evidence-gate protocol applies to serving flips, and this ships none.
   The impression-loop work is verification + a check that the extension
   emit sites are wired, not a serving change.

**What landed (this amendment's scope):**

- Suggestion honesty (`src/sidepanel/tabsession/`): a single
  `endorsementFor()` source-of-truth classifies a resolution as
  `endorsed` / `weak-guess` / `none` against `decision.action`.
  `AttributionBadge` gains a muted `weak-guess` variant; `AttributionProvenance`
  renders "Weak guess — not filed" (vs "Suggested") with plain-language
  reason chips + the aggregator quiet line; `SuggestionStats` marks the
  un-endorsed headline; `InboxCard` keeps the one-click confirm but with
  honest copy ("Confirm guess" vs "Yes, that's right").
- Impression-loop liveness: VERIFIED on the live test rig (GET-only). The
  extension emit sites (`impressionRegistry` record in `focusedRelated.ts`
  / `FocusView.tsx` / `useRecallSearch.ts`; `emitTrainableAction` from
  `client.ts` feedback + App.tsx URL-attribute) are all wired, and the
  `recallActionEmit` background handler forwards to `/v1/recall/action`.
  Live event log: 1442 `recall.served` accumulating (55 today), 65
  `recall.action`, and 65/65 actions JOIN their parent served impression
  by `servedContextId`+`entityId`. The #242 point-in-time fields
  (`perLaneRanks`/`perLaneScores`/`fusedScore`/`rerankScore`/
  `servedPosition`) are present on served results. No dead extension emit
  site found. (Companion-side note: explicit trainable gestures remain
  sparse — only 1 `flow_confirm` carried a `referencesEventId` — which is a
  data-volume observation for post-restart verification, not a wiring bug.)
- Intelligence observability (`src/settings/intelligenceSummary.ts` pure
  parser + `entrypoints/.../IntelligenceRow.tsx`): a 2x2 living readout in
  Settings → Diagnostics — doc-vector coverage, sim-edge count, last drain,
  impressions collected — visually confirmed live (1,275 doc vectors /
  1,234 chunks · 0 sim edges [page-access-off] · last drain "just now" ·
  1,442 impressions / 65 actions).

**Freeze-lift interaction.** None. The serving math is untouched; this is
read-path presentation + observability + verification only, per the
write-path-vs-read-path boundary this ADR defines.

## Amendment 2026-07-13b — eval-spine verdict: the flag defaults hold (all serving flips stay OFF)

**Context.** Amendments 12/12b/12c connected built-but-unserved
intelligence to the serving path, each behind a kill-switch flag whose
DEFAULT was to be "set by the eval-spine verdict, not optimism." Those
amendments landed the flags at their pre-verdict default (OFF for the
new serving-math flags; ON for the regression-repair requalify flags)
and named the harness that would clear them. This amendment RECORDS the
result of actually running that harness — the evidence gate the OWNER
DIRECTIVE rides on. Read-only, offline, against a consistent snapshot of
the live test vault (`~/.sidetrack-vault-test`, copied to scratch so the
long-running old-code companion was never touched — no mutating call, no
`--apply`).

**How the eval ran.** `sidetrack-companion eval replay` and
`eval connections-precision` (both report-only; neither gates promotion)
over the vault snapshot. The replay harness reads the logged
`recall.served` impressions, joins the `recall.action` labels the
trainer's way (`buildRecallImpressionTrainingGroups`), reconstructs the
point-in-time candidate features against the committed connections
snapshot (no impression here carries a #242 logged feature vector — they
predate it, so every row went through the honest reconstruction
fallback), and re-scores each impression group under every arm.

**What the numbers say.**

*Replay (report-only, over the vault's logged impressions):*

    impressions=707  withPositive=1
      Served order (production)   nDCG@10=1.0000 MRR=1.0000 R@5=1.0000 R@10=1.0000
      Trained model               nDCG@10=0.3155 MRR=0.1250 R@5=0.0000 R@10=1.0000
      Graph/heuristic baseline    nDCG@10=1.0000 MRR=1.0000 R@5=1.0000 R@10=1.0000
      Grep-over-vault (BM25)      nDCG@10=1.0000 MRR=1.0000 R@5=1.0000 R@10=1.0000
      Recency (newest-first)      nDCG@10=1.0000 MRR=1.0000 R@5=1.0000 R@10=1.0000

    paired-bootstrap (trained vs each reference): Δmean nDCG@10=-0.6845,
    CI[-0.6845,-0.6845], p=0.0000, n=1 (degenerate — a single paired
    impression, zero CI width).

  The decisive fact is `withPositive=1`: of 707 reconstructable
  impression groups, exactly ONE carries a joined positive action, so
  every metric is computed over a single gradeable impression. The
  vault holds 1442 `recall.served` and 65 `recall.action` events, but
  61 of the 65 actions are 2026-05-27 test-harness gestures whose served
  contexts/candidates no longer reconstruct against today's snapshot,
  and the remaining handful don't land on a reconstructable candidate.
  n=1 is not a signal; it is the ABSENCE of one. (This is the honest
  read of amendment 13's "65/65 actions join by servedContextId+entityId"
  observation: the raw events join, but the TRAINER's feature-anchored
  join — the unit the replay scores — yields one gradeable positive.)

*Connections precision (report-only, over the committed snapshot):*

    servedSimilarityEdges=0  judged=0  signal(confirmed=70, rejected=2)
      content_vector precision=n/a (served=0)
      metadata       precision=n/a (served=0)
      title_only     precision=n/a (served=0)
      overall precision=n/a (no served edge falls on a user-judged pair)

  The snapshot has 16,593 edges but ZERO `closest_visit` /
  `visit_resembles_visit` similarity edges — the July regression the
  requalify flags exist to repair (June served ~30k, July serves 0,
  page-access-off → engagement gate never trips → no sim lane). There
  ARE 70 confirmed + 2 rejected user pairs, but no served similarity
  edge intersects any of them, because there are no served similarity
  edges at all. Precision by evidence tier is therefore UNDEFINED, not
  low — the harness cannot score a lane that serves nothing.

*Coverage context (read-only over the recall-v2 store + page-evidence):*

    docs=11,801   doc-vectors=1,275 (10.8%)   chunk-vectors=1,234 chunks
    docs.body_indexed: 9,736 content (82%) / 2,065 title-only (18%)
    page-evidence tiers: 1,098 content_features_only · 969 metadata_only
                         · 100 indexed_chunks (4.6% have chunk vectors)

**Decision — the verdict per flag.** No flip is authorized. The replay
harness cannot even MEASURE the two recall retrieval arms (they change
candidate RETRIEVAL; the harness re-ranks a FIXED logged candidate set,
so a retrieval-layer change is not counterfactually replayable from
these impressions), and where it can measure (the reranking arms) it has
n=1 — noise. The connections-precision harness scores the similarity
lane at n/a because that lane serves 0 edges on this vault. So EVERY
serving-math flag stays at its current default; the code already encodes
the honest verdict and this amendment ships no code default change,
only this recorded verdict + the enable commands for when data accrues.

| Flag | Class | Verdict | Default (unchanged) | Enable after data |
|---|---|---|---|---|
| `SIDETRACK_RECALL_CHUNK_VECTORS` | recall serving | inconclusive (unmeasurable by impression-replay; 4.6% chunk coverage) | **OFF** | `SIDETRACK_RECALL_CHUNK_VECTORS=1` + restart |
| `SIDETRACK_RECALL_PROVENANCE_DOWNWEIGHT` | recall serving | inconclusive (n=1 replay; not retrieval-replayable) | **OFF** | `SIDETRACK_RECALL_PROVENANCE_DOWNWEIGHT=1` + restart |
| `SIDETRACK_SIMILARITY_CONTENT_CORPUS` | similarity serving | inconclusive (0 served sim edges → precision n/a) | **OFF** | `SIDETRACK_SIMILARITY_CONTENT_CORPUS=1` + restart |
| `SIDETRACK_PAGE_EVIDENCE_BACKGROUND_EMBEDDING` | infra (child-lane) | inconclusive; keep OFF until a live CPU soak on the child lane clears it | **OFF** | `SIDETRACK_PAGE_EVIDENCE_BACKGROUND_EMBEDDING=1` (requires child-process embedder) + restart |
| `SIDETRACK_PAGE_EVIDENCE_DOC_EMBEDDINGS` | infra (embed-on-extract) | keep default — pre-existing lane, not a serving-math change | **ON** (disable with `=0`) | n/a |
| `SIDETRACK_SIMILARITY_REQUALIFY` | regression-repair | keep default — restores the June baseline lane, not a new serving change; eval cannot argue against a repair it can't yet observe (lane serves 0) | **ON** (kill with `=0`) | n/a |
| `SIDETRACK_SIMILARITY_CONTENT_REQUALIFY` | regression-repair | keep default — pure re-derive of already-eligible visits; no-op against the title skeleton while CONTENT_CORPUS is OFF | **ON** (kill with `=0`) | n/a |

**Why "inconclusive → OFF" and not "OFF because it lost."** The owner
directive is explicit that defaults are set by the verdict, not
optimism — and the honest verdict is that this vault cannot yet produce
the evidence. An inconclusive arm defaults OFF (the freeze-safe posture)
WITH its enable command documented, exactly so a later data-accrual pass
can flip it on the recorded number rather than a hunch. The two recall
arms are additionally UNMEASURABLE by the current replay spine (a
retrieval-layer change vs an impression-replay that re-ranks a fixed
candidate set); clearing them needs a retrieval-level A/B (serve arm-on
vs arm-off over live queries and compare click-through), which is a
post-restart / post-data task, not something the offline impression
replay can decide. This is filed as the concrete next step, not left
implicit.

**Re-run recipe (for the data-accrual pass).** From
`packages/sidetrack-companion`, against a READ-ONLY vault copy (never the
live vault):

    rsync -a --delete ~/.sidetrack-vault-test/_BAC/ /tmp/eval-scratch/_BAC/
    bun src/cli.ts eval replay --vault /tmp/eval-scratch --no-persist
    bun src/cli.ts eval connections-precision --vault /tmp/eval-scratch

  A flip becomes authorized when replay shows `withPositive` in the tens
  with the arm's paired-bootstrap CI excluding 0 (`a_better`), OR — for
  the retrieval arms — a live retrieval A/B clears them; and when
  connections-precision reports a defined per-tier precision with the
  content tier at least matching the title-only floor.

**Freeze-lift interaction.** None. The serving math is byte-identical to
the pre-amendment baseline (all serving flags at their recorded
defaults); this amendment is the recorded EVIDENCE that the gate did not
open, per the write-path-vs-read-path boundary this ADR defines.
