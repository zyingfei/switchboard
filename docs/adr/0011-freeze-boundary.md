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
