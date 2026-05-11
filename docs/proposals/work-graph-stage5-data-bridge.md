# Sidetrack — Stage 5 (close the data bridge + content-aware similarity)

> **Status: scope locked 2026-05-11; plan under review.** Stage 5.0
> tracks T1–T6 (data-bridge closures) are in-scope for this PR. Stage 5.1
> tracks T7a–T7d (full-content search + content-aware graph evidence) are
> scope-locked at the design level and deliver as follow-up PRs.
>
> **Prior stages:** Stage 1 (work-graph MVP, PR #99) and Stage 2/3
> (ranker + feedback skeleton, PR #105) shipped the code spine. Stage 4
> (collector framework) ships in parallel. This stage assumes Stage 1–3
> code is present, agrees that most of it is dark in dogfood, and turns
> on the lights.

## Northern star (carried forward)

> Facts are event-sourced. Interpretations are versioned. Suggestions are
> explainable. User organization is authoritative. No inference requires
> GPU / Apple-Silicon hardware.

Stage 5 doesn't change the locks. It addresses a single observation:
**the Stage 1–3 pipelines are implemented but silent in dogfood**. The
diagnostic is, in summary:

```
captured observations
  → eligible similarity evidence       (gate-blocked today)
  → topic evidence                     (downstream of similarity)
  → ranker-compatible labels           (label-shape mismatch today)
  → resolver evidence                  (starved of attributed anchors)
  → visible attribution                (only 39 % coverage in last run)
```

Stage 5 closes that bridge.

## Inputs

- Dogfood-graph walkthrough against `~/.sidetrack-vault`, recorder run
  `2026-05-11T04-15-55-446Z`.
  Topology: 254 nodes / 281 edges; 0 `visit_resembles_visit`, 0 topic
  nodes, 0 `closest_visit`, 0 `tab_session_in_workstream`; 40 of 102
  visit-instances workstream-attributed (39 %).
- External-review second opinion (recorded in PR description). Key
  corrections folded in:
  1. Similarity materializer **is** wired; the gate is build-side
     eligibility (`focusedWindowMs ≥ 5000` + cosine ≥ 0.85 + ≥2 visits +
     embedding success).
  2. Topic builder accepts `userAssertedRelations` but the materializer
     call site doesn't populate it.
  3. Ranker label-shape blocker:
     `user.organized.item (URL → workstream)` doesn't map to
     `(visit, visit)` training pairs. Even if the 50-label threshold were
     met, training can't consume the data.
  4. `tab_session_in_workstream` is not dead code — the route, projection,
     and Class E inferred-event family all exist; the recorded session
     just didn't exercise the tab-session attribution UX (Phase B routed
     it to canonical-URL). Don't delete, document.
  5. Resolver does have per-edge priors (`edgePriors.ts`); they're just
     starved of evidence-side anchors.

## Architectural locks

Locks 1–5 from Stages 1–4 stay invariant. Stage 5 has no new locks. The
data bridge is closed entirely within existing Class A / B / E surfaces.

## Sub-task list — Stage 5.0 (in scope this PR)

Each track lands as one or two commits on this branch. Independent unless
noted.

### T1 — Materializer diagnostics (observability before fixes)

*Files:* `packages/sidetrack-companion/src/sync/contract/connectionsMaterializer.ts`,
plus a new `connectionsMaterializer.diagnostics.ts` (or inline counter
record).

*Shape:* On every snapshot rebuild, emit a single structured log line
**and** persist a counters file at
`_BAC/connections/diagnostics/<iso>.json` covering:

- `timelineVisitCount`, `engagementEligibleVisitCount`
- `similarityEdgeCountBeforeThreshold`, `similarityEdgeCountAfterThreshold`,
  `similarityEmbeddingFailures`
- `topicComponentSizes: number[]`, `topicNodeCount`, `topicEdgeCount`
- `rankerRetrainSkipReason: 'below-threshold' | 'no-positive-labels' | …`,
  `rankerLabelPositiveCount`, `rankerLabelNegativeCount`
- `tabSessionAssertionCount`, `urlAssertionCount`, `inferredAttributionCount`
- `attributedVisitInstanceCount`, `unattributedVisitInstanceCount`

*Why first:* every fix below is currently un-verifiable without these. We
should not change algorithms before we can measure the difference.

*Tests:* unit test on the counter helper + golden output on a fixture
snapshot rebuild.

### T2 — Similarity dogfood gates + lexical fallback

*Files:* `packages/sidetrack-companion/src/connections/visitSimilarity.ts`,
plus a new `similarityGates.ts` (or env-tunable constants module).

*Change shape:*

- Read environment overrides for the three gates that today are hard-coded:
  - `SIDETRACK_SIMILARITY_THRESHOLD` (default 0.85; dogfood 0.70).
  - `SIDETRACK_SIMILARITY_MIN_ENGAGEMENT_MS` (default 5000; dogfood 1000).
  - `SIDETRACK_SIMILARITY_TOP_K` (default 50; dogfood unchanged).
- Add a lexical fallback (`miniSearch` or `BM25Lite` over the title +
  hostname + path-token corpus) when `embed()` fails or returns fewer
  vectors than visits. Lexical-only edges carry
  `confidence: 'inferred'` with `producedBy.producer: 'visit-similarity-lexical'`
  so they're discounted vs embedding-similarity edges.

*Why:* the user's current run has `eligibleSimilarityVisitCount = 0`
(per T1 diagnostics, once shipped) almost certainly — engagement events
aren't reaching the 5 s gate during click-driven research browsing. Lower
the gate for dogfood, document the production default.

*Tests:* fixture with a mix of 3 s and 6 s engagement visits; assert edge
count under both gate settings.

### T3 — Bootstrap topics from user assertions

*Files:* `packages/sidetrack-companion/src/sync/contract/connectionsMaterializer.ts`
(call site), `packages/sidetrack-companion/src/connections/topicClusterer.ts`
(unchanged API; it already accepts `userAssertedRelations`).

*Change shape:* derive a `UserAssertedRelations` collection from the
event log at materialize time:

```ts
type UserAssertedRelation =
  | { kind: 'visit-in-workstream'; visitKey: string; workstreamId: string }
  | { kind: 'visit-in-tab-session'; visitKey: string; tabSessionId: string }
  | { kind: 'tab-session-in-workstream'; tabSessionId: string; workstreamId: string };
```

Built from:
- `user.organized.item itemKind='canonical-url'` → `visit-in-workstream`
  (resolve URL to all `timeline-visit` / `visit-instance` ids in the
  snapshot).
- `user.organized.item itemKind='tab-session'` →
  `tab-session-in-workstream`.
- `user.organized.item itemKind='visit'` → `visit-in-workstream`.

Pass into the existing `buildTopicRevision({ visits, visitSimilarity,
userAssertedRelations, previousRevision })` call.

*Why:* current materializer call site builds topics from similarity +
prior revisions only. With similarity dark and no user-asserted seeds,
topics never form. This makes the 40 existing user assertions productive
on first rebuild.

*Tests:* fixture with 3 user-asserted URLs, no similarity → expect at
least 1 topic component of size ≥ 2.

### T4 — Ranker label-shape conversion

*Files:* `packages/sidetrack-companion/src/feedback/projection.ts`
(extend to emit visit-pair labels), `packages/sidetrack-companion/src/ranker/train.ts`
(consume them).

*Change shape:* introduce a new projection field on
`FeedbackProjection`:

```ts
readonly rankerLabels: {
  readonly positive: readonly { fromVisitId: string; toVisitId: string }[];
  readonly negative: readonly { fromVisitId: string; toVisitId: string }[];
}
```

Derive positives:
- Pairs of visits within the same asserted **tab session** (existing
  `visit_instance_in_tab_session` edges, restricted to user-asserted
  tab-session-in-workstream sessions or canonical-URL-attributed sessions).
- Pairs of visits within the same asserted **workstream** (via
  `visit_instance_in_workstream` edges), bounded by a recency window
  (default 24 h between the two visits).

Derive negatives:
- `AttributionRejected` events (existing).
- `dismiss` events (`user.organized.item action='ignore'` or
  `toContainer=null`).
- Random unrelated visits (already in `negatives.ts`; raise its weight).

Lower retrain threshold to `SIDETRACK_RANKER_RETRAIN_MIN_LABELS` (default
50, dogfood 15).

*Why:* the load-bearing fix for Stage 2/3. Without this the ranker
cannot train regardless of label count.

*Tests:* unit test on label derivation: 3 visits in one asserted tab
session → 3 positive pairs (Cartesian). 2 dismissed URLs → 2 negative
self-pairs. Threshold gate test: 14 labels → skip; 15 → train.

### T5 — Demote / gate `timeline_same_url_as_thread`

*Files:* `packages/sidetrack-companion/src/connections/snapshot.ts` (the
edge-emit site).

*Change shape:* the edge currently fires whenever a `timeline-visit`'s
canonical URL matches a thread's URL. That's noisy because shared URLs
across tabs / reloads / preview / unrelated visits to a chat host don't
imply the visit "belongs" to that thread.

Add a gate composed of:
- Provider match: the visit's `provider` field equals the thread's
  `provider`.
- Title overlap: token Jaccard between visit title and thread title ≥ 0.25
  (or short-circuit when one side has no title).
- Recency: `|visit.observedAt − thread.lastSeenAt| ≤ 24 h`.

Edges that don't pass the gate are not emitted. Edges that do pass keep
`confidence: 'inferred'` but gain a `producedBy.evidence` blob recording
which gates fired.

*Why:* current edges are the only inferred family at scale (8 of 9) and
they're the weakest signal. Either remove them or make them earn their
inferred status.

*Tests:* fixture with three pairs (matching provider + title vs same URL
different topic vs same URL different recency); assert only the matching
pair emits.

### T6 — Preserve `tab_session_in_workstream` scaffolding (doc-only)

*Files:* `packages/sidetrack-companion/src/connections/snapshot.ts` (add
header comment), `docs/architecture.md` (update Class B edge inventory
section).

*Change shape:* no code change; document the **intentionally-dormant**
status of `tab_session_in_workstream` and `tabsession.attribution.inferred`
post-Phase-B. Note that:

- Routes (`/v1/tabsessions/*`) and the projection (`tabsession/projection.ts`)
  remain authoritative for sync from older replicas.
- The edge family will re-activate once a UX surface that flips
  `itemKind='tab-session'` events is restored.
- T1 diagnostics expose `tabSessionAssertionCount` so dormant ≠ broken.

*Why:* prevents future agents (including me) from deleting working code
that looks unused.

## Sub-task list — Stage 5.1 (follow-up PRs)

Scope-locked plan; not implemented in this PR. Listed here so the
sequence is committed even though delivery happens later.

### T7a — Content-evidence (recall content as candidate source)

*Lowest-risk extension.* No new browser capture; reuses
`capture.recorded` events already in the recall pipeline.

- New resolver evidence source `ContentRecallEvidence`:
  `{ workstreamId, topScore, meanScore, matchedChunkIds, sourceBacIds,
    reasons: ('lexical' | 'embedding' | 'same-heading' | 'same-workstream')[] }`.
- Resolver `fuseCandidates` weights this alongside PPR / similarity /
  cluster. Initial prior weight 0.6 (between similarity and cluster).
- No new edges; resolver-only ephemeral evidence.

### T7b — Explicit page-content extraction

*Adds the `full content` corpus.* Separate from passive timeline
observations — `browser.timeline.observed` payload **does not** carry
DOM text.

- New event `page.content.extracted` (Class B):
  ```ts
  {
    sourceUnitId, canonicalUrl, tabSessionId?, title?, provider?,
    capturedAt, extractionMode: 'visible-text' | 'readability'
                 | 'selection' | 'provider-thread',
    contentHash, text, markdown?
  }
  ```
- Capture policy options (user-selectable, default `manual-capture-only`):
  - Manual: explicit "Capture this page" button only.
  - Allowlist auto-capture: domains the user opted in for.
  - Provider-thread: AI chat extraction continues via existing content.ts
    path; this is the per-page generalization.
- Redaction reuses the existing `sanitizeDimensions` helpers; size
  budget caps `text` at 256 KB pre-redaction.

### T7c — Content-similarity revision for Connections

*Bridges T7a/T7b into the graph.*

- New revision artifact `_BAC/connections/content-similarity/<rev>.json`
  paralleling the existing `visit-similarity/` directory.
- New edge kind `visit_content_resembles_visit` (Class E, `confidence:
  inferred`); `producedBy.producer: 'content-similarity-vN'`.
- Topic builder consumes both `visit-similarity` and `content-similarity`
  revisions; HDBSCAN clusters over the union of evidence.
- `visit_resembles_capture` and `capture_resembles_capture` defer to a
  Stage 5.2.

### T7d — Full-content hybrid search UX

*User-facing surface, independent of graph integration.*

- New side-panel section "Search content" (workstream-scoped + global).
- New companion HTTP route
  `GET /v1/search/content?q=&workstreamId=&provider=&limit=`.
- Hybrid retrieval: lexical (MiniSearch) + embedding cosine + recency +
  workstream prior + heading-path boost. Reciprocal rank fusion.
- Result shape: `{ chunkId, sourceUnitId, sourcePage, headingPath,
  matchedSnippet, score, attribution, openUrl, addToContextPack }`.

## Wave structure (Stage 5.0 parallelization)

**Wave A** — observability foundation (all independent):
- T1 materializer diagnostics
- T6 dormancy docs

**Wave B** — bridge closures (T1 unblocks; otherwise independent):
- T2 similarity gates + lexical fallback
- T3 topics from user assertions
- T5 timeline-same-url-as-thread demotion

**Wave C** — ranker (depends on T1; T3 helpful but not required):
- T4 ranker label-shape conversion

Lead-author work (not Codex):
- L1 — Stage 5 e2e — drives diagnostics through a recorder fixture and
  asserts non-zero counters in the resulting snapshot.
- L2 — Update `docs/architecture.md` § Roadmap + Class B edge inventory
  for the demoted `timeline_same_url_as_thread` and the dormancy of
  `tab_session_in_workstream`.

## How this composes with prior stages

- **Stage 1 (PR #99)**: locks 1–4 unchanged. T2 lowers similarity gates
  via env; production defaults preserved. T3 fills in the missing
  `userAssertedRelations` input to the topic builder — the API has been
  there since Stage 1, just unused. T5 makes Stage 1's only "inferred"
  edge family earn its label.
- **Stage 2/3 (PR #105)**: ranker code remains intact. T4 fixes the
  upstream feedback projection so ranker training can actually fit.
  Retrain threshold default unchanged for production.
- **Stage 4 (collector framework)**: orthogonal. Stage 4 lands in
  parallel without touching Stage 5 surfaces.

## Out of scope (Stage 5.0)

- Cloud-LLM enhancement (F1) — explicitly deferred.
- DOM-skeleton hash / screenshots (F3) — out of scope here.
- HDBSCAN replacement for union-find — keep current default.
- Mobile companion.
- Federated learning across users.

## Open questions (decide during implementation, don't block scope lock)

1. Should the dogfood similarity-threshold env override land as a
   one-off env var or as a documented entry in a new
   `~/.sidetrack/profile.json` configuration file? Either is fine;
   default to env var for symmetry with existing `SIDETRACK_*` config.
2. Should `userAssertedRelations` weight user-canonical-URL attributions
   higher than tab-session ones in topic clustering? Initial default:
   same weight (1.0); revisit after diagnostics show the impact.
3. Negative-label sourcing for the ranker: should `dismiss` events
   count as negative for the dismissed URL across ALL workstreams, or
   only the workstream they were rejected from? Initial default: only
   the rejected workstream.

## Verification (Stage 5.0 acceptance)

After all six tracks land, a recorder run with ≥ 30 minutes of
real-browser activity should produce:

- `similarityEdgeCountAfterThreshold > 0` in T1 diagnostics.
- `topicNodeCount > 0` if any of: similarity edges OR ≥3
  user-asserted relations sharing a workstream.
- `rankerSkipReason != 'no-positive-labels'`; if `labelCount ≥ 15`,
  training runs and produces a closest-visit revision file.
- `timeline_same_url_as_thread` edges ≤ half the count of the same
  recorder run before T5, AND every remaining edge has a non-empty
  `producedBy.evidence` blob.
- `tab_session_in_workstream` count is 0 (expected dormant) but
  `tabSessionAssertionCount` in diagnostics reflects whatever the
  recorder generated.
- All companion unit tests green; extension unit tests green.

## Codex orchestration protocol

Each track is a Codex-eligible work item once the plan merges. Pull from
the unchecked list above. Worktree convention:
`codex/stage5-T<n>-<slug>`. Each track lands as one or two commits on
this PR. Lead reviews; fixes land as **new** commits (no amend).
