# Category flexibility + prototype-lane (HyDE-informed) design

Status: proposed, phase 1 shippable in one PR. Companion research doc:
`docs/research/2026-08-16-hyde-deep-research.md` (verbatim copy, 765 lines,
sourced from `~/Downloads/deep-research-report-hyDE.md`; the source is
volatile so this is now the durable copy).

## Phase status (updated 2026-08-16)

| Phase | Scope | Status | Landed in |
|---|---|---|---|
| 1 — data model + UX events | `membershipEvents.ts`, `workstreamMembershipStore.ts`, additive memberships route, generalized `declineMemory.ts`, one-time backfill | **Not started** | — |
| 2 — prototype lane (offline generation + serve-time match + disclosure) | Evidence-grounded offline generation on Apple FM (or evidence-selection for zh/non-en), sqlite-vec `prototype_vec` storage, guess lane 9 (`prototype`), falsifiability counters, health row | **Shipped** (this PR) | `feat/prototype-lane-apple-fm` — `packages/sidetrack-companion/src/workstreams/prototypeGeneration.ts`, `prototypeEvidence.ts`, `events.ts`; `src/enrichment/appleFmEngine.ts`; `src/tabsession/prototypeLane.ts`, `guessLanes.ts`; `src/recall-v2/store/sqlite.ts` (`prototype_vec`/`prototypes`); `src/system/workGraphHealth.ts` (`attribution.prototype-lane-shadow`); `src/sync/lineage.ts`, `src/sync/contract/registry.ts` |
| 3 — promotion gate | `'prototype-v1'` prequential arm, precision-gated promotion into `laneCorroboration.ts`'s corroborating set, private-codename golden case | **Not started** — this PR only DECLARES the threshold constants (`PROTOTYPE_LANE_MIN_PRECISION`/`_MIN_SAMPLES`/`_MAX_ACTION` in `prototypeLane.ts`) and proves (golden case 5) that the lane cannot yet influence a decision | — |
| 4 — split/new-category suggestion | Structural clustering re-scoped per-workstream, LLM naming-only fallback | **Not started** | — |

**Two deliberate deviations from this doc's original §3 draft, made under
explicit 2026-08-16 follow-up instruction (documented, not silent) —**
1. **Engine.** §3 sized the generation engine choice against measured
   Apple FM vs. WebGPU numbers but left the choice open; the follow-up
   directive pins it to Apple FM ONLY (no nano/WebGPU/remote fallback for
   *generation* — WebGPU and Nano both require a live browser session this
   companion-side background job does not have). Reached over loopback HTTP
   from the companion process directly (`enrichment/appleFmEngine.ts`, a
   companion-local PORT of the extension's `nano/appleService.ts` wire
   contract — the two packages share no dependency edge, so this is a port,
   not an import, kept byte-identical in constants/shapes on purpose).
2. **Default state.** §3 proposed `SIDETRACK_PROTOTYPE_LANE` default OFF.
   The follow-up directive made it (and `SIDETRACK_PROTOTYPE_GENERATION`)
   default ON. This is consistent with, not a departure from, this
   codebase's actual established pattern: every other guess-lane flag
   (`SIDETRACK_GUESS_LANES`, `SIDETRACK_CONTENT_LANE`,
   `SIDETRACK_LANE_PREQUENTIAL`, `SIDETRACK_LANE_CORROBORATION`) already
   defaults ON as a kill-switch, not an opt-in — because
   `laneCorroboration.ts`/`laneFallback.ts` hardcode their lane set to
   `['content','ai']`, the prototype lane is structurally unable to affect
   any served decision in this PR regardless of its flag state (see golden
   case 5, `goldenResolveCases.test.ts`). See `prototypeLane.ts`'s doc
   comment for the full reasoning.

**Scope note on paths.** The brief cites `src/attribution-v1/`,
`src/workstreams/`, `src/tabsession/fusion.ts`. All production code is
under `packages/sidetrack-companion/src/...` and
`packages/sidetrack-extension/src/...` — every path below is the real,
verified one. Two corrections worth flagging up front (also in the final
report): (1) `guessLanes.ts` — the "guess lanes" disclosure mechanism —
lives in `packages/sidetrack-companion/src/tabsession/guessLanes.ts`, not
inside `attribution-v1/`; `attribution-v1/` holds the prequential
evaluator and the vote3/vote4 arms that `guessLanes.ts` imports two
primitives from (`titleNearestWorkstream`, `gatedDomainWorkstream`). (2)
There is no `src/workstreams/` "thread register" — the thread register is
`packages/sidetrack-companion/src/threads/threadRegisterStore.ts`; the
workstream-side analog, `workstreamParentStore.ts`, only tracks the
parent/ancestor chain, not membership. This doc's new membership store
(§1) is modeled on `threadRegisterStore.ts`'s fuller pattern, not
`workstreamParentStore.ts`'s leaner one.

## 0. Why now, and what already anticipates this

The live system is strictly single-membership everywhere except one
place: `packages/sidetrack-companion/src/producers/topic-revision.ts:63-84`
already has `TopicSecondaryAffiliation` + `TopicRevisionTopic
.secondaryAffiliations` for the *auto-clustered topic* layer (not
user workstreams), gated at `SECONDARY_AFFILIATION_MIN_SCORE=0.58`,
`SECONDARY_AFFILIATION_MIN_COSINE=0.85`,
`SECONDARY_AFFILIATION_LIMIT_PER_VISIT=2`
(`connections/topicShadowCandidate.ts:33-35`). And the connections graph
schema at `connections/types.ts:119` already declares a `visit_in_workstream`
edge kind with the comment "Active-workstream attribution: retained for
Phase 2 replacement. Phase 1 stops emitting this from the active pointer" —
alongside `thread_in_workstream`, `visit_instance_in_workstream`,
`tab_session_in_workstream`, `topic_in_workstream`. **This design is that
declared-but-unbuilt Phase 2.**

The feature review (`docs/audits/2026-07-29-recommendation-graph-feature-review.md`)
already named two of the three gaps this closes: **G5** "Declines are
captured but not consulted" and its fix **E6** "decline memory as a
first-class check ... per (canonicalUrl|domain, workstream) decline
tombstones." Reading the live implementation
(`packages/sidetrack-companion/src/tabsession/declineMemory.ts`) shows E6
was never actually built that way: `DeclineLookup.declinedUrls` is a
`Set<string>` keyed **only** by canonical URL — one global "not in any
stream" bit per page, folded from `USER_ORGANIZED_ITEM{toContainer:null}`.
It cannot represent "declined workstream A, still open to B," which is
exactly what multi-membership needs. §2 and §5 below generalize it to the
per-(subject, workstream) pair E6 actually asked for.

The deferred "Prototype dictionaries + sparse-coding (P3)" mechanism named in
`docs/design/2026-07-13-context-model-north-star.md:102` ("adopt when
title-lexical plateaus AND head workstreams have ≥30 members with
decision-time vectors") is **related but not identical** to what §3
proposes: P3 is sparse-coded exemplar assignment over *real* decision-time
vectors (Apple-Photos-People style, no generation); this design's
prototype lane is *generated* text prototypes (HierPrompt/HyPE-style),
gated by its own precision measurement, not by P3's trigger. They can
coexist; P3's ≥30-member density finding is still useful evidence for
cold-start sizing (§6). Separately, north-star §3's "Novelty / new-workstream
branch (P5)" trigger — "owner creates ≥1 new workstream/month, two months
running" — has not fired (north-star §1: 0 new workstreams in 49 days).
The 2026-08-16 user directive pulls that forward by explicit instruction,
which is allowed (user instruction outranks doc anchors per
`CLAUDE.md`'s priority order) but is a deliberate override worth naming,
not a silent contradiction.

## 1. Data model for multi-membership

New event pair in a new file `packages/sidetrack-companion/src/workstreams/membershipEvents.ts`,
parallel to `workstreams/events.ts`'s `WORKSTREAM_UPSERTED`/`WORKSTREAM_DELETED`:

```ts
export const WORKSTREAM_MEMBERSHIP_SET = 'workstream.membership.set' as const;
export const WORKSTREAM_MEMBERSHIP_REMOVED = 'workstream.membership.removed' as const;

export interface WorkstreamMembershipSetPayload {
  readonly payloadVersion: 1;
  readonly subjectKind: 'canonical-url' | 'thread' | 'tab-session';
  readonly subjectId: string;
  readonly workstreamId: string;
  readonly role: 'primary' | 'secondary';
  readonly provenance: 'user-filed' | 'ai-suggested-accepted' | 'prototype-matched';
  readonly sourceOpportunityId?: string; // ties back to a served lane/opportunity
}
// WorkstreamMembershipRemovedPayload mirrors it minus role/provenance, plus
// reason: 'user-declined' | 'user-removed' | 'superseded'.
```

Fold is **latest-wins per (subjectId, workstreamId) pair** — the same
`acceptedAtMs` then `dot.seq` tie-break `declineMemory.ts:116-123` and
`resolver.ts`'s `urlUserDeclinedNoWorkstream` already use, just keyed on
the pair instead of the subject alone. At most one row per subject may
carry `role: 'primary'`; setting a new primary demotes the prior one to
`secondary` (fold-time invariant, not a write-time lock — CRDT-safe under
concurrent replicas the same way `workstreams/projection.ts`'s
`mergeRegister` is).

New derived store `packages/sidetrack-companion/src/workstreams/workstreamMembershipStore.ts`,
modeled on `threads/threadRegisterStore.ts` (buckets a subject's complete
raw membership-event history by `subjectId`, unpruned — "storage is
intentionally UNPRUNED ... per-subject history is small ... cheap and
provably correct by construction"), table:

```sql
CREATE TABLE workstream_membership_state (
  subject_kind TEXT, subject_id TEXT, workstream_id TEXT,
  role TEXT, provenance TEXT, deleted INTEGER,
  dot_at INTEGER, dot_seq INTEGER,
  PRIMARY KEY (subject_kind, subject_id, workstream_id)
);
```

**Backward compatibility for existing single-valued fields.** `Thread
.primaryWorkstreamId`, `TabSessionAttribution.workstreamId`,
`UrlAttribution.workstreamId` (all confirmed scalar in `threads/events.ts`,
`tabsession/events.ts`, `urls/events.ts`) become *derived* from the
membership fold's `role: 'primary'` row instead of independent write
paths. `fusion.ts`'s `CandidateEvidence` (one row per workstream already)
and the resolver's single-winner collapse in `policy.ts`/`autoApply.ts`
are untouched — they keep writing exactly one `role: 'primary'` membership
row per decision, same as today.

**Graph edges.** Mint one `visit_in_workstream` edge per membership row
(not just the primary), each carrying the existing
`ConnectionEdgeProducedBy` tagged union and `confidence: 'asserted' |
'inferred'` fields already declared at `connections/types.ts:216-229` —
`asserted` for `user-filed`, `inferred` for `ai-suggested-accepted` /
`prototype-matched`. No new edge-kind machinery; this is precisely the
Phase 2 the schema comment names.

**Migration.** Repo convention (confirmed: no `migrations/` directory
anywhere in the tree) is rebuild-from-canonical-log, not a migration
script — every derived SQLite store exposes `rebuildFromJsonl(logRoot)`,
consent-gated via `sidetrack-companion connections-rebuild --vault <path>`
(`cli.ts:~227-238,1495-1592`). Per
`docs/plans/2026-08-16-f8-ivm-designs.md:145-163`'s standing authorization
("NO backward compatibility: stores/formats may be replaced outright; no
dual-read shims... a ONE-TIME user-consented reimport/derive command
rebuilds all derived state"): a one-time backfill step maps every existing
`URL_ATTRIBUTION_INFERRED` / `TAB_SESSION_ATTRIBUTION_INFERRED` /
`USER_ORGANIZED_ITEM{action:'move'}` into one
`WORKSTREAM_MEMBERSHIP_SET{role:'primary', ...}` event, run once via the
same consent-gated CLI family, then the old scalar fields are read-derived
only — no dual-write shim retained after cutover.

## 2. UX operations as events

| Operation | Event(s) appended | Route |
|---|---|---|
| Add category to an already-filed item | `WORKSTREAM_MEMBERSHIP_SET{role:'secondary', provenance:'user-filed'}` | new `POST /v1/visits/:canonicalUrl/memberships {workstreamId}` — additive, sits beside the existing replace-primary `POST /v1/visits/:canonicalUrl/attribute` |
| Create category at filing time | `WORKSTREAM_UPSERTED` (unchanged) then `WORKSTREAM_MEMBERSHIP_SET{role:'primary', provenance:'user-filed'}` | reuses `POST /v1/workstreams` create + the new memberships route — same "no new backend route" pattern `App.tsx:3405-3440`'s `createWorkstreamFromThread` already uses for create+move |
| Accept an AI/prototype suggestion | `SUGGESTION_ACCEPTED{suggestionSource, servedOpportunityId}` **then** a `WORKSTREAM_MEMBERSHIP_SET{provenance:'ai-suggested-accepted' \| 'prototype-matched'}` | same memberships route, `provenance` set from the accept event |
| Decline an AI/prototype suggestion | `SUGGESTION_DECLINED{suggestionSource, servedOpportunityId}` | no membership row; feeds decline memory (§5) |

`SUGGESTION_ACCEPTED`/`SUGGESTION_DECLINED` (`workstream.suggestion.accepted`
/ `.declined`) fill a **real gap**, not a duplicate: today there is no
explicit accept event at all (acceptance is inferred only when a later
`USER_ORGANIZED_ITEM move` happens to agree with a served suggestion), and
decline is silently overloaded onto `USER_ORGANIZED_ITEM{toContainer:null}`
with no suggestion-source attribution. `USER_ORGANIZED_ITEM_ACTIONS`
(`feedback/events.ts`, currently `['move','merge','split','rename',
'promote','ignore']`) gains `'add-container'`/`'remove-container'` so the
existing `recordOrganizedItemFeedback` → lane-outcome telemetry path
(`feedback/events.ts` → `lanePrequential.ts`'s `recordLaneOutcome`)
keeps working unchanged for the new additive operations — every
membership mutation also appends one of these for telemetry continuity.

## 3. The prototype lane

**Cadence.** Offline, per-workstream, not per-page — the compute-placement
inversion the research report calls out (§"Latency and compute
placement": `N_workstream_revisions × m` generations, not `N_page_events`).
Regeneration triggers on a `membershipRevisionId(W)` change (hash of W's
membership fold, same pure-function-of-state pattern
`connectionsMaterializer.ts:6216-6238` already uses for
`expectedLeidenId`) **debounced**: only after ≥5 new members since last
generation OR ≥14 days elapsed, whichever first — coarser than
`servedFeatureModel.ts`'s 120s TTL warmer because workstream semantics
drift far slower than serve traffic.

**Engine tier.** `resolveReadyEngine()`/`enginePolicy()`
(`packages/sidetrack-extension/src/sidepanel/nano/engine.ts`) — same
nano→apple→webgpu→remote precedence. Default to Apple FM when available:
measured 4.1s median / 0.61 groundedness vs. WebGPU gemma's 17.3s/0.47
(`nano/appleService.ts:10-18`) — groundedness, not fluency, is the right
axis here per the research report's HierPrompt citation (generate
*evidence-conditioned* example text, not free invention).

**zh hazard (G7, feature review).** Nano and Apple FM refuse zh; WebGPU
gemma answers zh pages in English and gets rejected by the validator. A
prototype is *reused for weeks*, unlike a one-shot query-time HyDE call,
so a broken/English-leaking zh prototype would silently mis-serve every
future zh page in that workstream until regeneration. For workstreams
whose evidence is zh-dominant
(`detectContentLanguage` ratio, `nano/language.ts`, `ZH_DOMINANT_SHARE=0.6`
threshold applied over the workstream's own evidence corpus), **skip
generation and fall back to reverse-prototype *selection*, not
generation**: embed real evidence excerpts directly as the prototype
vectors (the research report's ReDE-RF pattern) — safe because
`multilingual-e5-small` (the embedding model, `recall/modelManifest.ts`)
handles zh embeddings fine; only the *generation* engines have the zh
hole, not the embedder.

**Token budgeting.** Evidence sampled per workstream (titles + existing
gists — gists are already computed, "4s each on Apple FM" per the feature
review, so reuse rather than re-summarize), chunked via the CJK-aware
budget already built for this exact hazard class:
`nano/chunking.ts`'s `TARGET_CHUNK_TOKENS=900`,
`CHARS_PER_TOKEN={en:4, zh:1.2, 'mixed-en-zh':2}`, capped to the engine's
`EngineLimits.maxInputChars` (`nano/engineLimits.ts`). Generate `m=3–5`
prototypes per workstream, varying prompt angle (likely activity / likely
page excerpt / likely terminology) per the research report's finding that
one canonical summary collapses to the corpus centroid and represents
none of the actual pages.

**Embedding + storage.** Same model as recall-v2
(`Xenova/multilingual-e5-small`, dim 384, `RECALL_MODEL_ID` revision
stamp). Reuse the **sqlite-vec** store
(`packages/sidetrack-companion/src/recall-v2/store/sqlite.ts`) — not the
HNSW connections-similarity store
(`connections/visitSimilarityHnsw.ts`), which carries clustering-specific
persistence machinery a per-category prototype set doesn't need — via a
new `prototype_vec USING vec0(prototypeId TEXT PRIMARY KEY, embedding
FLOAT[384])` table beside `docs_vec`/`documents_chunks_vec`, through the
existing `upsertVector`/`queryVector` API (dimension-safe, fallback-safe
when the vec extension is unavailable). Point-in-time capture record
modeled on `recall/events.ts`'s `RecallServedCandidateSnapshot`:

```ts
interface PrototypeGeneratedSnapshot {
  readonly payloadVersion: 1;
  readonly prototypeId: string;
  readonly workstreamId: string;
  readonly generatedText: string;
  readonly embeddingSchemaVersion: number;
  readonly sourceEvidenceIds: readonly string[];
  readonly generatorModelId: string;   // e.g. "apple-fm#rev=..." mirrors RECALL_MODEL_ID
  readonly generatedAt: number;
}
```

New `LineageNode` in `sync/lineage.ts`'s `LINEAGE_REGISTRY`: `id:
'workstream-prototypes'`, `derivesFrom: ['event-log', 'recall-v2-index']`,
`sourceEventTypes: ['workstream.prototype.generated']`, `defaultState:
'default-off'`.

**Serve-time = pure vector match, no LLM call.** KNN of the incoming
page's own (already-computed) embedding against `prototype_vec`, top-`r`
or max similarity per workstream — `s_proto(w|x) = max_j
sim(e(x), e(P_{w,j}))` per the research report's notation.

**Disclosure as a guess lane.** New member `'prototype'` on the `GuessLane`
union (`tabsession/guessLanes.ts`), appended the same async, idempotent
way lanes 7/8 (`content`/`ai`) are (`appendPrototypeLane`, replace-by-lane-id
in `result.lanes`, NOT added to the synchronous `GUESS_LANE_ORDER`).
`SIDETRACK_PROTOTYPE_LANE` env flag, **default OFF** — observe-first, the
same rule `declineMemory.ts` states explicitly ("serving-behavior changes
default OFF") and PR #288 established for lanes generally. Every populated
candidate carries `why` ("matches 2 of 4 prototypes generated for
'kv-cache-recsys'"); every empty result carries `emptyReason`
("insufficient evidence to generate prototypes yet").

**Promotion gate — reuse `laneCorroboration.ts`'s template exactly**, per
`docs/proposals/calibrated-lane-fusion-promotion.md`'s four-part extension
model: (1) prequential identity + outcome join, via
`lanePrequential.ts`'s existing `LanePredictionRecord`/`LaneOutcomeRecord`
machinery, extended to cover the `'prototype'` lane id; (2) an explicit
precision/sample threshold, measured fresh (not inherited from
`LANE_CORROBORATION_MIN_PRECISION=0.6`/`MIN_SAMPLES=20` — those numbers
are for `content`/`ai`); (3) a golden failure case in
`goldenResolveCases.test.ts`; (4) a declared max action capped at
`'suggest'`, never auto-file. Additionally, add a `'prototype-v1'` arm to
`attribution-v1/eval/prequential.ts`'s `ATTRIBUTION_PREQUENTIAL_ARMS`
tuple, scored with the existing no-peeking replay against the frozen
baselines (`title-lexical` measured 40.0% top1, `vote4`/`vote3` per the
north-star study) using the existing `buildPrequentialVerdict` rule
(`TOP1_BEAT_MARGIN=0.02`, `PRECISION_WHEN_SUGGESTING_FLOOR=0.6`,
`ABSTENTION_BASE_RATE_FLOOR=0.4`) — no new verdict logic.

## 4. Split/new-category suggestion

**Structural signal first** — not-everything-is-an-LLM ordering, the same
"measured rather than hardcoded" discipline the north-star study applied
to domain priors (`context-model-north-star.md:68`). Reuse
`hdbscanClusterer.ts` (`HDBSCAN_TOPIC_MIN_SAMPLES=3`) and/or
`leidenCpm.ts`/`leidenCpmTopicRevision.ts`
(`CPM_GAMMA=0.18`, `LEIDEN_CPM_COSINE_THRESHOLD=0.9`) — the exact
algorithms `servedTopicProducer.ts` (`DEFAULT_SERVED_TOPIC_PRODUCER=
'leiden-cpm'`) already runs vault-wide — **re-scoped to one workstream's
own evidence-embedding subgraph** instead of the whole vault. A split
suggestion fires only when the within-workstream clustering finds ≥2
stable sub-clusters (stability = HDBSCAN's own stability score / Leiden's
modularity gain — no new metric), each above a minimum member count
(tune against the golden set, starting above `HDBSCAN_TOPIC_MIN_SAMPLES=3`
since "worth splitting" is a higher bar than "is a cluster"). A
new-category suggestion is the same machinery applied to pages the
resolver currently abstains/holds on, looking for an emergent tight
cluster with no existing-workstream affiliation at all.

The north-star study's own numbers name the concrete target case: `"ai"`
is a 28%-of-members, 59-domain catch-all
(`context-model-north-star.md:18-19`) — the canonical shape a split
suggestion should eventually fire on.

**LLM only for naming, offline, optional** — the one and only LLM role in
this section, matching the brief's explicit constraint. Once structural
stats decide a split/new-category is warranted, an on-device generation
call (same engine precedence and groundedness framing as §3) proposes a
title from the cluster's member evidence. If generation is unavailable
(engine down, zh hazard, budget exceeded), the suggestion still surfaces
with a structural fallback name (top discriminative terms from the
cluster, reusing `titleNearestWorkstream`'s term-index machinery in
`attribution-v1/state.ts`) — naming never gates visibility.

**Accept flow** is not a new mechanism: `POST /v1/workstreams` create +
a batch of `WORKSTREAM_MEMBERSHIP_SET{provenance:'ai-suggested-accepted'}`
(§2) for every visit in the accepted sub-cluster.

## 5. Falsifiability spine — must exist before serving anything

- **Per-lane hit/agreement**: extend `lanePrequential.ts`'s
  `LanePrecision{lane,n,hits,precision}` to the `'prototype'` lane id.
- **Suggestion accept/decline rates**: new counters folded from
  `SUGGESTION_ACCEPTED`/`SUGGESTION_DECLINED`, bucketed by
  `suggestionSource`, surfaced in HealthPanel's Experiments row (the same
  surface the shadow-serving A/B diagnostics already use) beside the
  existing lane-calibration section.
- **Decline memory, generalized and consulted**: `declineMemory.ts`'s
  `DeclineLookup{declinedUrls: Set<string>}` becomes
  `Map<subjectId, ReadonlySet<workstreamId>>`, folded from
  `SUGGESTION_DECLINED` (in addition to the existing
  `USER_ORGANIZED_ITEM{toContainer:null}` global-decline fold, kept for
  the "not in any stream" case). Consulted by the prototype lane, the
  split-suggestion surfacer, and `laneFallback.ts` — this is E6
  (`docs/audits/2026-07-29-recommendation-graph-feature-review.md`)
  actually built at the granularity it asked for, and it fixes G5's
  live-verified bug (`declineMemory.ts`'s own header: fallback
  re-suggested a workstream the gate detail said was just declined) for
  every future lane, not only this feature's two new ones.
- **Golden set additions before promotion**: one case per new failure
  class — multi-membership double-file regression, prototype-lane
  false-positive on a private-codename workstream (the report's central
  risk, §6), split-suggestion false split on a legitimately cohesive
  workstream (negative control) — added to `goldenResolveCases.test.ts`
  before either promotion gate (§3, §4) is evaluated.
- **Ship gate**: `bun run test:golden` remains the named blocking CI
  referee; prototype-lane promotion additionally requires the
  `'prototype-v1'` arm to clear `buildPrequentialVerdict` in
  `attribution-v1/eval/prequential.ts`.

## 6. Non-goals and risks

**Non-goals.** (a) Query-side/literal HyDE — generating a hypothetical
description of the *new page* at serve time. The research report's
central finding is that this is weak for private/idiosyncratic labels
(the generator has no prior on a private workstream's meaning) and adds
online latency/stochasticity per page; explicitly out of scope for every
phase here. (b) LLM as the split/new-category decision-maker — naming
only, never clustering. (c) Auto-apply from either the prototype lane or
split-suggestion — max action is `'suggest'`, matching
`LANE_CORROBORATION_MAX_ACTION`; the user always confirms.

**Risks.** (1) **Plausible-but-privately-wrong** — the report's main
warning: an LLM can produce a fluent prototype for a private-codename
workstream that is confidently wrong, and because prototypes persist for
weeks (unlike a one-shot HyDE call), a bad batch silently biases every
future match until regeneration. Mitigated by groundedness-first
generation (evidence-conditioned, never free invention), point-in-time
provenance (§3's `PrototypeGeneratedSnapshot`, so a bad batch is
identifiable and revertible), precision-gated promotion (never
authoritative — §3), and decline memory feeding back into regeneration
priority. (2) **Double cold-start** — new pages (existing, handled) *and*
sparse workstreams (new: the report's "reverse prototypes exchange page
cold-start sensitivity for target cold-start sensitivity"). North-star's
P3 trigger implies real-vector density needs ~30 members before it's
meaningful; propose a lower floor for attempting generation at all
(≥5 evidence items, just above `HDBSCAN_TOPIC_MIN_SAMPLES=3`) — below it,
typed-empty with `emptyReason`, never a bare-title guess. (3) **zh
generation hazard compounds with persistence** — see §3's
selection-not-generation fallback. (4) **Prototype homogenization** — the
report's finding that related workstreams can collapse to generic
phrasing under one prompt; mitigated by the diversity requirement (m
prototypes, varied angle) and a golden case for two deliberately-separate
similar workstreams. **Privacy**: all generation on-device, same
precedence as every other engine call in this repo, remote only if the
user explicitly enabled it (`remoteEngineIfConfigured()` never probes by
default); prototype text/embeddings live in
`_BAC/recall/v2/index.sqlite` alongside existing recall data and never
leave the vault — the same boundary-contract line
`calibrated-lane-fusion-promotion.md` already states for lane
corroboration applies verbatim here.

## 7. Phased delivery plan

**Phase 1 — data model + UX events only (one PR, no prototype lane, no
split-suggestion).** `membershipEvents.ts`,
`workstreamMembershipStore.ts`, `USER_ORGANIZED_ITEM_ACTIONS` additions,
the additive memberships route, the generalized `declineMemory.ts`
(per-pair, independent value even without §3/§4), the one-time backfill
port. *Acceptance*: file a visit into workstream A, add workstream B —
both appear in the membership store and as two `visit_in_workstream`
edges; decline a suggested workstream C on that visit — C never
resurfaces while A/B are unaffected (new golden case extending
`declineMemory.ts`'s existing pattern); `bun run test:golden` stays green.

**Phase 2 — prototype lane, offline generation + serve-time match +
disclosure, default OFF.** *Acceptance*: lane appears in guess-lanes
disclosure with typed emptiness below the evidence floor; `lanePrequential
.ts` records ≥20 joined outcomes; golden case for a zh-dominant workstream
verifies the selection-not-generation fallback never stores
broken/English-leaking text.

**Phase 3 — promotion gate.** *Acceptance*: `bunx sidetrack-companion
eval` reports `prototype-v1` clearing `buildPrequentialVerdict` vs. the
frozen baseline; golden case for the private-codename risk (§6.1) must
show the lane declining to confidently mis-suggest.

**Phase 4 — split/new-category suggestion.** *Acceptance*: fires on a
scoped-down version of the north-star study's `"ai"` catch-all shape;
does not fire on a legitimately cohesive workstream (negative control).

## 8. Landing note — Phase 1 + Phase 4 stats/data layer (2026-08-16)

Shipped in one PR on `feat/category-multi-membership`: the multi-membership
data model + events (§1), the additive UX-operation events (§2), and the
split/new-category suggestion STATS machinery (§4, no LLM). Phase 2/3 (the
prototype lane) are untouched — a concurrent sibling branch owns
`guessLanes.ts` / `laneCorroboration.ts` / recall-v2 / the enrichment
engine, and this PR deliberately does not touch lane or generation code.

**§1 — data model.** `workstreams/membershipEvents.ts`
(`WORKSTREAM_MEMBERSHIP_SET` / `WORKSTREAM_MEMBERSHIP_REMOVED`,
`foldWorkstreamMembership`) implements the fold exactly as specified:
latest-wins per (subjectKind, subjectId, workstreamId) pair on an
(acceptedAtMs, replicaId, seq) tuple, plus the cross-pair "at most one
primary" invariant (setting a new primary demotes the previous one to
secondary, never silently promotes another). `workstreams/
workstreamMembershipStore.ts` is modeled on `threadRegisterStore.ts` as
directed: an unpruned per-subject event bucket, the resolved projection
recomputed from the COMPLETE bucket on every ingest (order-independent by
construction), plus a normalized `workstream_membership_current` reverse
index for O(indexed rows) "who's in workstream W" reads. One deviation from
a literal reading of the SQL sketch in §1: the store keeps the raw bucket
*in addition to* the flattened `workstream_membership_state`-shaped table,
because — per the same reasoning threadRegisterStore itself documents — an
incrementally-maintained single-row cache (workstreamParentStore's leaner
pattern) cannot correctly reproduce the cross-pair primary invariant under
arbitrary out-of-order catch-up without re-deriving it from full history
anyway.

**One-time backfill.** `workstreams/membershipBackfill.ts` +
`sidetrack-companion membership-backfill --vault <path> [--apply] [--json]`
(cli.ts, same consent-gated / process-lock pattern as
`connections-rebuild`). Derives `role:'primary'` rows from the THREE
sources the design names (`urls.attribution.inferred` /
`tabsession.attribution.inferred` / `user.organized.item` moves) by calling
the EXISTING `projectUrls`/`projectTabSessions` projectors rather than
re-deriving their tie-break logic — compatibility by construction. Also
backfills `thread.upserted`'s `primaryWorkstreamId` register field (not one
of the three literal event types, but explicitly one of the three scalar
fields the design names as becoming derived, so it needed its own source).
Report-only by default; deterministic and idempotent (safe to re-run).

**Graph edges.** `workstreams/membershipEdges.ts`'s
`visitInWorkstreamEdgesFromMembership` mints one `visit_in_workstream` edge
per active membership row with the asserted/inferred confidence split the
design specifies. It is NOT wired into `connections/snapshot.ts`'s existing
single-primary emission of that edge — doing so needs
`sync/contract/connectionsMaterializer.ts` (explicitly off-limits for this
PR) to thread membership-store reads into the snapshot input assembly.
Left as a ready-to-splice, fully-tested pure function; wiring it in is the
next PR's first task.

**§2 — UX-operation events + routes.** `USER_ORGANIZED_ITEM_ACTIONS` gained
`'add-container'` / `'remove-container'` (feedback/events.ts). New routes,
additive beside the existing replace-primary `/attribute`:
`POST /v1/visits/:canonicalUrl/memberships` (set — accepts an optional
`suggestionSource` to also append `SUGGESTION_ACCEPTED` first, matching
the design's accept flow), `POST /v1/visits/:canonicalUrl/memberships/
:workstreamId/remove`, and `POST /v1/visits/:canonicalUrl/suggestions/
decline`. Scope note: these routes only cover `subjectKind:'canonical-url'`
— thread/tab-session membership routes are not built this PR (no existing
UI surface calls for them yet); the store and fold already support all
three subject kinds.

**§4 — split/new-category suggestions.** `connections/hdbscanClusterer.ts`
gained one new exported pure primitive, `densityConnectedComponents`
(mutual-reachability MST + cosine-threshold cut, extracted from the
existing visit-topic pipeline so it's genuinely reused, not duplicated) —
the existing `buildHdbscanTopicRevision` now calls the same extracted core
functions. `workstreams/splitSuggestionEngine.ts` +
`suggestionCandidateStore.ts` implement the stats engine: scoped clustering
(split = one workstream's own evidence; new-category = same machinery over
a caller-supplied unaffiliated pool), a stability gate requiring 3
CONSECUTIVE recomputations with matching (Jaccard-overlap, not exact-id)
cluster membership before a candidate is allowed to emit, sticky
`emitted` (never re-emits), and dirty-marking via a caller-supplied
`revisionId` that short-circuits the whole clustering pass when unchanged.
The "3 consecutive" and "0.75 overlap" constants are judgment calls the
design left unspecified numerically — flagged here for the golden-set
tuning pass §5 calls for before promotion. Deliberately NOT built this PR:
live evidence-embedding retrieval from recall-v2 for a real workstream, and
gathering the vault-wide "unaffiliated pool" from the resolver's abstain
set — both real-data wiring that would touch the sibling branch's recall-v2
area; the engine takes plain `evidence: {id, embedding, title}[]` so that
wiring is a pure addition later, not a rewrite. LLM naming is out of scope
as designed; a structural fallback name (top-3 discriminative title terms,
reusing `suggestions/tokens.ts`'s tokenizer) is always computed instead.

**§5 — falsifiability spine.** `declineMemory.ts`'s `DeclineLookup` gained
`declinedWorkstreamsByUrl` (folded from `SUGGESTION_ACCEPTED`/
`SUGGESTION_DECLINED`, latest-wins per pair) and a new `isWorkstreamDeclined
(lookup, subjectId, workstreamId)` export, additive beside the untouched
existing `isUrlDeclined` — no existing caller (`laneFallback.ts`,
`laneCorroboration.ts`) needed to change. `system/workGraphHealth.ts` gained
one new `DiagnosticCandidate` (`workstreams.membership-suggestions`,
`family:'workstreams'` — new union member, `lane:'diagnostic'`,
`servingImpact:'observe-only'`) folding suggestion accept/decline-by-source
and raw membership-edit counts live from the merged log, same idiom as
`topic.incremental-shadow`.

**Deviations from a literal reading of the design, all judgment calls
under the "conservative defaults" instruction:** (1) stability threshold =
3 consecutive computations, overlap-match threshold = 0.75 Jaccard — both
unspecified numerically in §4, chosen conservative-but-not-paralyzing,
flagged for golden-set tuning. (2) Graph-edge minting stops at a tested
pure function rather than reaching into the forbidden materializer file.
(3) Thread/tab-session membership HTTP routes not built (store/fold already
support them). (4) recall-v2 evidence-gathering wiring for the suggestion
engine deferred to avoid the sibling branch's active files.

Full test suite green (`bun test`); `bun run build` clean. See the PR for
file list and exact test counts.

## 9. Landing note — UI-visibility phase (2026-08-17)

USER DIRECTIVE that scoped this phase: "shipped features are invisible;
get them into the panel where the user already looks." §1/§2 (multi-
membership) landed in #376, §2/§3 (prototype lane) in #377, §4 (split/
new-category stats) also in #376 — none of it had a panel surface until
this PR. No new computation anywhere in this phase: every route below is
a READ (or a thin write reusing #376's existing event types) over data
those two PRs already produce.

**A.1 — multi-membership chips.** New file
`packages/sidetrack-companion/src/workstreams/membershipEvents.ts`'s
`foldAllActiveMemberships(subjectKind, events)` — one bucketing pass over
the raw membership-event set, then one `foldWorkstreamMembership` call
per subject over ONLY that subject's own bucket (never O(subjects ×
events)). Three route changes in `http/routes/visitsRoutes.ts`: a new
`GET /v1/visits/:canonicalUrl/memberships` (single-URL, on-demand), and a
`memberships` overlay added to both `GET /v1/visits/projection` and
`GET /v1/visits/inbox` (batched, one extra type-indexed event read per
request). **Important finding, test-verified**
(`http/visitsRoutes.test.ts`, "overlay SECONDARY memberships onto
items"): `currentAttribution` (the pre-multi-membership scalar
`AttributionBadge` reads) and the new `memberships` fold are TWO
INDEPENDENT sources today — a page filed via the older `/attribute` route
has a `currentAttribution` but zero rows in the new fold, because no
backfill has run (§1's backfill is explicitly a separate, one-time,
consent-gated CLI step, not automatic). The panel's `MembershipChips`
component (`src/sidepanel/tabsession/MembershipChips.tsx`) is written
defensively around this: it always filters out any membership row whose
`workstreamId` equals the primary, so a future backfill landing changes
nothing about how chips render. Wired into `InboxCard.tsx` beside the
existing `AttributionBadge` (primary stays the one visually-dominant
chip); rendered in both `InboxView` (Inbox) and the workstream detail
"Pages in this workstream" list in `App.tsx`. Strings: `Also in: <name>`
label + pill chips with a `×` remove (secondary chips only, per spec) +
a `+` "Add to another workstream" affordance that opens the existing
`WorkstreamPicker` in a new additive mode (new `membershipAddTargetId`
state, parallel to the existing replace-primary `tabSessionMoveId`
state — independent so the two pickers never fight over what a selection
means). Picking "Not assigned" in that additive picker is a no-op
(documented in code) rather than a new no-membership-add mechanism.

**A.2 — split / new-category suggestions.** `suggestionCandidateStore.ts`
gained `dismissed`/`dismissedAtMs` fields (additive `ALTER TABLE ADD
COLUMN`, same guarded idiom `sync/eventStore.ts` uses for `resolver_url`)
and a `dismissCandidate(scopeId, kind, fingerprint, dismissedAtMs)`
method; `splitSuggestionEngine.ts` carries `dismissed`/`dismissedAtMs`
forward across recomputes via the SAME Jaccard-overlap match that already
carries `consecutiveStableCount` forward — decline memory that survives
a re-cluster, matching "per-scope decline memory means it never recurs."
Replaced the predecessor's uncommitted, single-purpose
`GET /v1/workstreams/:workstreamId/split-suggestion` with ONE generalized
read surface for BOTH kinds: `GET /v1/workstreams/suggestions?kind=split
&workstreamId=<id>` or `?kind=new-category` (workstreamId ignored,
always reads the store's `NEW_CATEGORY_SCOPE_ID` sentinel internally —
never leaked over the wire), returning every `emitted && !dismissed`
candidate. `POST /v1/workstreams/suggestions/decline` (body
`{kind, fingerprint, workstreamId?}`) is the whole-CLUSTER counterpart to
#376's per-URL `.../suggestions/decline` — that route declines "this URL
into this EXISTING workstream"; this one declines "this proposed NEW
grouping, which has no workstream yet," a real gap the existing
`SUGGESTION_DECLINED` event schema (keyed to an existing workstreamId)
cannot express. One `WorkstreamSuggestionCard` component renders BOTH
kinds off the store's own `kind` discriminator — split cards render
inside the source workstream's own "Pages in this workstream" list
(fetched per-workstream on switch); new-category cards render at the top
of the Inbox (fetched once on entering that view) — surfaced exactly
where their affected pages already live. Strings: split —
`These N pages look like their own group — split?` (+ the structural
name as a secondary line when one exists); new-category —
`These N unfiled pages look like a topic: <keywords> — create it?` (or
the nameless fallback when the structural namer found nothing). Actions
are `Accept`/`Decline` (not the codebase's usual dismiss-icon `×`) —
deliberate: this is a create-a-new-workstream decision, a different
stakes class than a per-row hint dismissal. **Accept flow** (design §4,
"not a new mechanism"): `POST /v1/workstreams` create, then
`POST .../memberships {role:'primary', suggestionSource}` for every
member, then the candidate is immediately consumed via the SAME decline
endpoint (`declineSuggestionCandidate`) so it stops resurfacing — the
store's `dismissed` flag doesn't distinguish accepted-vs-declined by
design; both mean "never show me this exact cluster again." `role:
'primary'` was chosen deliberately: per the A.1 finding above,
`currentAttribution` doesn't read this event type at all yet, so
`'primary'` has no worse a display side effect than `'secondary'` today,
and is the semantically correct value once the backfill lands.
**Realistic caveat, stated plainly:** `recomputeSuggestionCandidates` is
still never called by anything in production (per #376's own landing
note, §8 above) — this phase's read/accept/decline surfaces are real and
fully tested against a manually-seeded store, but will show empty in a
running companion until a future PR wires a recompute pass. That wiring
is explicitly out of scope here (same reasoning #376 gave: it touches
the sibling recall-v2 branch's active files).

**B — prototype-lane visibility.** Kept the prior session's
`GET /v1/workstreams/prototypes/status` route and
`workstreams/prototypeStatus.ts` unchanged (verified correct; added the
test file it was missing, `prototypeStatus.test.ts`, 10 cases covering
every `whyNot`/`methodNote` branch). New client
`src/companion/categoryFlexibilityClient.ts` (extension) fetches it once
per bridge connection (not per-render), building a
`Map<workstreamId, WorkstreamPrototypeStatus>` threaded to three panel
surfaces via one shared formatter,
`src/sidepanel/tabsession/prototypeStatusText.ts`'s `prototypeStatusLine`
— so the wording can never drift between them: (1) the prototype lane's
own row in the guess-lanes hover/expanded disclosure
(`GuessLanes.tsx`/`SuggestionStats.tsx`), appended beneath the per-match
`why` line (distinct — `why` describes THIS match, the new line
describes the workstream's STANDING prototype state); (2) every
`WorkstreamPicker` row (all three instances — the create/re-file/
add-membership pickers all share the one component), as a one-line
subtitle under the workstream name; (3) `WorkstreamDetailPanel`'s new
"Prototype matching" section. String: `{N} prototype(s) · updated
{relative} from {M} page(s)`, or the route's own honest `whyNot` verbatim
when none exist (`needs 5+ saved pages, has 2`, `Apple Intelligence
engine unavailable`, `generation pending — runs in the background`). No
separate dashboard — all three are places the user already looks per the
UI taste rules.

**B.3 — why-string jargon pass.** Audited every `emptyReason`/`why`
string `prototypeLane.ts` emits. The `emptyReason` set (`recall store
unavailable`, `vector backend unavailable`, `embedder cold — cannot
compare`, …) turned out to be a DELIBERATE, pre-existing CROSS-LANE
convention — `contentLane.ts` emits byte-identical strings for the same
underlying conditions, and `laneFallback.test.ts` string-matches
`'recall store unavailable'` regardless of which lane produced it. That's
house style spanning the whole guess-lane subsystem, not jargon #377
introduced — left untouched (rewriting it means touching every lane and
dozens of pinned tests, well outside this phase's scope). The ONE string
that WAS prototype-lane-specific and read as jargon: the populated `why`,
`"closest of N matching generated prototype(s), similarity 0.NN"` — stiff
phrasing, and "prototype" is an ML term the client never needs (the
matched workstream's NAME already renders adjacent to this string).
Rewritten to `"close to N example(s) generated for this workstream
(0.NN)"` — closer to the brief's own suggested tone
(`"close to the examples generated from your Research pages (0.81)"`,
minus the redundant name already shown beside it). Updated the one
pinned assertion (`prototypeLane.test.ts`) and a golden-case fixture
(`goldenResolveCases.test.ts` case 5 — the string there is incidental
fixture data, not an assertion target, so this is cosmetic-only there).

**Deviations, stated plainly (none silent):** (1) Thread/tab-session
membership chips not built — the read/write routes only cover
`subjectKind:'canonical-url'` (#376's own scope note, §8 above); no
extension UI surface reads thread/tab-session membership today either.
(2) The additive "add to workstream" picker reuses the existing
single-select `WorkstreamPicker` rather than a new multi-select
component — picking "Not assigned" there is a silent no-op, documented
in code, not a new mechanism. (3) `role:'primary'` for suggestion-accept
memberships, reasoned above. (4) Cherry-picked PR #383's two commits
(`fix/prototype-lane-panel-allowlist` — adds `'prototype'` to the
extension's `GuessLane`/`VALID_LANES`/`OPTIONAL_LANE_ORDER`/label maps;
was open, not yet on `origin/main`, per the task's own instruction to
reuse rather than duplicate) as this branch's first two commits.

Both packages: `bun test` (companion, 3474 pass / 8 skip / 0 fail) and
`vitest run tests/unit` (extension, 1442 pass / 161 files) green;
`bun run build` clean in both (companion `tsc -p tsconfig.build.json`;
extension `wxt build`). One companion test was observed flaky on a single
loaded-machine run (passed clean on immediate rerun and on the final full
run) — unrelated file, not caused by this phase's changes. Bun itself
(v1.3.14) panics with a C++ exception on process EXIT after `bun test`'s
own summary prints "0 fail" — an engine-level crash ("this indicates a
bug in Bun, not your code"), not a test failure.

## 10. Landing note — gist keywords as sparse-data clustering features + new-topic suggestions (2026-08-17)

Shipped in one PR on `feat/gist-keywords-clustering`, branched from this
doc's §8 landing point. Doc-vector coverage sits at ~16% of pages
(embedding-only clustering starves); this closes the gap by making the
already-shipped, quality-approved gist enrichment ALSO emit 3-7 keywords
per page, and using discrete keyword-concept overlap as a clustering
feature everywhere embeddings are sparse — binding doctrine: the LLM is an
offline feature extractor inside the already-running enrichment lane, every
downstream consumer is deterministic stats, never a second model call.

**Architecture correction, stated up front (documented, not silent).** The
brief scoped this to "the enrichment pipeline (src/enrichment/,
appleFmEngine.ts)" and described gists as "the existing Apple FM
enrichment." Neither is quite how gists actually work: gist SYNTHESIS runs
in the BROWSER extension (`packages/sidetrack-extension/src/sidepanel/nano/
gistSynthesis.ts`, on-device Nano/Apple FM/WebGPU, routed by
`resolveEngineForLanguage`), not in the companion's `appleFmEngine.ts` — that
module is a *different*, already-shipped lane (§3 above, workstream-prototype
generation, companion-side, offline, reading gists rather than producing
them). The companion only receives, validates, and folds the finished gist
text via `ENTITY_CONTENT_ENRICHED` events. Given this, "amend the existing
gist call" is implemented as: amend the EXTENSION's gist-synthesis prompts to
append one more labelled line to the SAME generation call (§10.1), then build
a PURE, RETROACTIVE PARSER on the companion side — exactly the precedent
`enrichment/entityExtract.ts` + `entityIndex.ts` already established for
"Key Entities" (same review finding, `docs/audits/2026-07-29-recommendation-
graph-feature-review.md` §G4/§E3: a gist section generated and then thrown
away). This keeps the companion-side surface literally inside
`src/enrichment/` as scoped, costs zero new event types, and is retroactive
+ retraction-safe for free (downstream of the already-correct gist fold).

**§1 — extraction.** `enrichment/keywordExtract.ts`'s `extractKeywords(gist,
{language?})` is ONE function with two paths, not two features:
- **LLM-authored.** `titleSynthesis.ts`'s `GIST_PROMPT_PREFIX` (single-pass;
  previously had no structured section at all) and
  `GIST_SYNTHESIS_PROMPT_PREFIX` (chunk-merge pass; already asked for "key
  entities") both gained one shared instruction line asking for `Keywords:
  term1, term2, term3` (3-7 terms) appended after the summary. Trusted only
  when the gist's OWN detected language is `'en'` — `extractLlmKeywords`
  line-anchors the "Keywords:" marker (unlike entities' "key entities" phrase,
  matched anywhere) because the bare word is common enough in ordinary prose
  that mid-sentence matching would comma-split real text into fake keywords.
- **Deterministic fallback.** Frequency-ranked, stopword-filtered extraction
  straight over the gist text — zero LLM calls, ever. Latin words: length≥3,
  filtered against `suggestions/tokens.ts`'s `STOPWORDS` (exported additively
  so a third stopword list wasn't forked). CJK: no segmentation library
  exists in this codebase, so Han runs are windowed as sliding bigrams
  (always) + sliding 4-grams (common compound-term length —
  "神经网络"/"深度学习"/"人工智能" are all 4 characters); a count TIE between an
  n-gram and its own substring breaks toward the LONGER span (by
  construction, equal counts mean the longer span is fully supported).
  `detectGistLanguage` is a 4th port of the same byte-identical Han-range/
  share constants already ported twice (`nano/language.ts` →
  `prototypeEvidence.ts`) — kept local rather than imported across the
  package's own dependency direction (`workstreams/` already depends on
  `enrichment/`, not the reverse).

This composition means **the deterministic path IS the backfill path IS the
zh path** — one function, not three. A gist with no "Keywords:" line (every
gist saved before this PR, or a zh/mixed one where the line is never
trusted) falls through identically. Normalization: lowercase always
(a keyword is a feature key, not a display name — the one deliberate
difference from `entityExtract.ts`'s casing-preserved names), trimmed,
deduped, capped at `KEYWORD_MAX_PER_GIST=10` with overflow counted in
`dropped`, never silently lost.

**§2 — the maintained index.** `search-index/keywordIndexStore.ts` — same
family as `searchQueryIndexStore.ts`/`captureTextFtsStore.ts`
(`bun:sqlite`, WAL, additive `CREATE ... IF NOT EXISTS`). Two tables:
`keyword_posting(keyword, page_key, observed_at_ms)` (the inverted index) and
`keyword_page(page_key, keywords_json, source, updated_at_ms)` (the per-page
reverse lookup, where `page_key` is the SAME `kind:id` key
`contentEnrichment.ts`'s `GistLookup` already uses). `keywordsForPage`
returns `undefined` for "never processed" vs. `[]` for "processed, found
nothing" — the exact typed-emptiness distinction the backfill lane's
idempotency depends on. Posting lists are capped at
`KEYWORD_POSTING_CAP=500` per keyword (evict-oldest-by-`observedAtMs`) — a
NEW precedent, since neither sibling store in this family bounds row count
at write time (bounding there is done at the read call site); a keyword
index needs it because an unbounded posting list for a common term would
make every lookup of it an O(vault) scan, the same hub failure mode
`entityIndex.ts`'s `ENTITY_HUB_MAX_REFS` exists to avoid one layer up.
**Not wired into `connectionsMaterializer.ts`** (off-limits) — driven
instead from two call sites, both outside that file: the live-ingest hook in
`http/routes/enrichmentRoutes.ts`'s `POST /v1/enrichment/content` handler
(one `ingestGistKeywords` call per freshly-accepted gist — true O(1) per
event) and the retraction route (`resyncGistKeywordsAfterRetraction`, which
re-reads the already-correct gist fold rather than re-deriving hash/
timestamp retraction semantics itself). `enrichment/keywordIngest.ts` is the
orchestration glue — kept OUT of `contentEnrichment.ts` on purpose, since
that module's own header states it is a pure, side-effect-free fold and this
one owns two SQLite handles plus an embedder call.

**§3 — concept normalization.** `enrichment/keywordConcepts.ts` (pure) +
`keywordConceptStore.ts` (persistence, same store family). Each DISTINCT
keyword is embedded once (`recall/embedder.ts`'s existing `embed()`, e5
`query:`-prefixed) and assigned to a concept via cosine-threshold
(`DEFAULT_CONCEPT_COSINE_THRESHOLD=0.82`, a judgment call between this
repo's two nearest precedents — `SECONDARY_AFFILIATION_MIN_COSINE=0.85` and
`DEFAULT_TOPIC_COSINE_THRESHOLD=0.85` — flagged for golden-set tuning, same
as every other unspecified numeric in this design) against INCREMENTAL
centroids: online/leader-style assignment, not k-means (no fixed k, no
reassignment pass). `foldConceptMember` is the incremental equivalent of
`suggestions/centroid.ts`'s `meanNormalized` (now exported additively) — a
weighted running mean, renormalized, so a concept never needs to retain
every member's embedding. **Concept stability, precisely**: a keyword's
assignment is idempotent (`assignKeyword` on an already-assigned keyword is
a no-op, never double-folds the centroid — verified by
`keywordConceptStore.test.ts`), and survives a store reopen (a near-
duplicate keyword introduced after restart still joins the persisted
centroid). Downstream consumption uses concept ids; raw keywords are kept
only for display/naming, per the directive.

**§4 — hybrid distance + naming, additive to `splitSuggestionEngine.ts`.**
`SuggestionEvidenceItem` gained two optional fields (`conceptIds`,
`keywords`) — absent on every item reproduces the pre-existing pure-cosine
behavior exactly (proven: the original 8-test `splitSuggestionEngine.test.ts`
suite is unchanged and green). `hybridSimilarity(left, right, weight)`
formula:
```
both usable  -> similarity = (1 - weight) * cosine + weight * conceptJaccard
concepts only -> similarity = conceptJaccard        (embedding term DROPPED,
                                                      not zero-weighted)
vectors only -> similarity = cosine                 (identical to pre-change)
neither      -> similarity = 0
```
`weight` = `SIDETRACK_KEYWORD_CLUSTER_WEIGHT` (`resolveKeywordClusterWeight`,
default `0.35`), same env-knob shape as `topic-revision.ts`'s
`resolveTopicCosineThreshold` (named `_ENV` constant, range-validated,
garbage/absent falls back silently). Zero-vector-coverage golden case (6
pages, 2 keyword groups, no embeddings at all): `hybridSimilarity` degrades
to pure `conceptJaccard` and the split comes out correct —
`splitSuggestionHybridDistance.test.ts`. **Naming**: `keywordNameFor` (top-3
shared RAW keywords by frequency, same tie-break as the existing
`structuralNameFor`) is tried FIRST, falling back to the pre-existing
title-token naming only when no member carries keywords — still no LLM
naming, per the directive, just a more direct signal (a gist's keywords are
already "what someone would search for"; a title's tokens are whatever words
a junk/URL-shaped title happened to contain).

**§5 — aggregator shadow entropy (the PR #373 blind spot).**
`DomainAggregatorCounters` gained `keywordConceptEntropyBits` — Shannon
entropy of a domain's keyword-CONCEPT distribution, folded incrementally (a
new optional `keywordConceptIds` field on `AggregatorVisitObservation`, O(1)
amortized, same discipline as every other counter in this module). SHADOW
ONLY, diagnostic only — NOT consulted by `classifyLearnedAggregatorPage` /
`isLearnedAggregatorHost`, same status as the pre-existing
`firstPathSegmentEntropyBits`. Why it adds signal that one doesn't: path
shape is a URL-STRUCTURE property a hub can normalize away (HN's uniform
`/item`) or a blog can vary a lot without being an aggregator; keyword-
concept entropy is a CONTENT-TOPIC property — a true aggregator's items span
many unrelated concepts, a single-source blog's don't, independent of URL
shape. Tested with a single-source fixture (entropy 0) vs. a 6-concept
diverse fixture (entropy = log2(6), the maximum for that count), plus a
regression proving the signal changes nothing about
`isLearnedAggregatorHost` for a structurally non-hub domain
(`learnedAggregatorKeywordEntropy.test.ts`). **Deferred, documented**:
surfacing an aggregate of this in `workGraphHealth.ts`'s existing
`aggregator.learned-stats-shadow` diagnostic, and populating
`keywordConceptIds` on REAL observations in
`ranker/learnedAggregatorStatsEvents.ts`'s event adapter — both require
reading the keyword-concept store from a new call site and are presentation
polish on top of an already-complete, already-tested shadow signal; left
for the next PR rather than shipped shallow.

**§6 — backfill.** `enrichment/keywordBackfillLane.ts` — same self-
scheduling idiom as `page-evidence/backgroundEmbeddingLane.ts` (bounded
`batchCap` per cycle, fast poll while backlog remains, slow poll once
empty, `.unref()`'d timers) but simpler in one load-bearing respect: "is
this page done" has a TRIVIAL answer here (`keywordIndexStore.hasPage`) —
unlike an embedding's missing/failed/ready lifecycle, a keyword-index row
either exists or it doesn't, so correctness never depends on a resumption
cursor (only observability does — `KeywordBackfillProgress` persists
`processedTotal` + per-page attempt counts, with PERMANENT quarantine after
`maxAttemptsPerPage=3`, deliberately no cooldown-decay: a gist's text never
changes on its own, so a page that fails deterministic extraction three
times will fail it forever and retrying is pure waste — unlike
`backgroundEmbeddingLane.ts`'s cooldown, which exists for a genuinely
transient failure class (embedder warm-up races) that has no analogue
here). `indexCandidate` is expected to be `keywordIngest.ts`'s
`ingestGistKeywords` itself — no separate "backfill extraction," since
`extractKeywords` already falls through to the deterministic path on its
own for any gist with no Keywords line. `keywordBackfillCandidatesFromGistLookup`
bounds the population (`SIDETRACK_KEYWORD_BACKFILL_POPULATION_CAP`,
most-recent-first) — never a boot full-pass. **Not wired into
`runtime/companion.ts`** (a concurrent sibling's active file) — ships as a
standalone, fully-tested factory function, ready to splice in.

**§7 — new-topic suggestions (the missing half of "suggest new categories
AND splits").** Discovery: `splitSuggestionEngine.ts`'s `'new-category'`
mode and `suggestionCandidateStore.ts`'s `kind` discriminator
(`'split' | 'new-category'`) were ALREADY BUILT by the prior PR (#376) as
generic clustering infrastructure — the directive's "kind discriminator
(split | new-topic)" is the SAME discriminator, reused rather than forked
under a second name (a `'new-topic'` value would have meant the same thing
as `'new-category'` and split the discriminator space the sibling UI branch
is about to bind to). What was genuinely missing, and is what this PR adds:
- **Real unfiled-population wiring.** `workstreams/unfiledEvidence.ts`'s
  `gatherUnfiledEvidence` is the structural INVERSE of
  `prototypeEvidence.ts`'s `gatherWorkstreamEvidence` (same metadata-only
  snapshot read, filters IN pages with no `currentAttribution.workstreamId`
  instead of filtering to one workstream). `suggestionEvidenceFromUnfiled`
  bounds it (`SIDETRACK_UNFILED_POPULATION_CAP`, default 500, most-recent-
  first — the same idiom as §6's backfill cap and
  `prototypeEvidence.ts`'s `selectEvidenceWithinBudget`) and joins keyword-
  layer data. Embeddings are an OPTIONAL injected join (defaulting to none)
  — live recall-v2 vector retrieval is explicitly DEFERRED, the identical
  scope cut PR #376 made for its own evidence gathering ("real-data
  wiring... touches files outside this PR's scope," recall-v2 being a
  concurrently-developed sibling area); `hybridSimilarity` runs on pure
  concept-Jaccard until that wiring lands, with zero behavior change needed
  here when it does.
- **Population-scoped decline memory** (additive to
  `suggestionCandidateStore.ts`: a new `suggestion_candidate_decline` table
  + `declineCandidate`/`declinedConceptSets`, the existing 5-method read API
  untouched). Distinct from `declineMemory.ts`'s per-(subject,workstream)
  decline: a new-topic candidate has no workstreamId until accepted, so
  there is no X to say "declined workstream X." Instead the DECLINED
  CLUSTER's own concept-id fingerprint is persisted; `isSuppressedByDecline`
  (splitSuggestionEngine.ts) withholds a future candidate from
  `newlyEmitted` whenever its concept-id set overlaps a declined fingerprint
  at/above `DEFAULT_DECLINE_CONCEPT_OVERLAP_THRESHOLD=0.75` (concept-
  Jaccard, not member-id Jaccard — new pages joining a declined TOPIC are
  still the same declined topic). Suppression withholds the PERSISTED
  `emitted` flag too (not just the one-shot `newlyEmitted` push), so a
  cluster whose concept makeup later drifts enough to clear the decline can
  re-attempt the emit transition rather than being frozen out forever by a
  stale `wasEmitted:true`.
- **Accept/decline routes**: new `http/routes/workstreamSuggestionsRoutes.ts`
  (registered additively in `server.ts`, pinned order updated in
  `routeTable.characterization.test.ts`) — `POST /v1/workstreams/
  suggestions/new-topic/:fingerprint/accept` (create workstream + the SAME
  3-event shape `visitsRoutes.ts`'s existing `/memberships` route already
  uses — `workstream.suggestion.accepted` → `workstream.membership.set` →
  `USER_ORGANIZED_ITEM` — applied to every member) and `.../decline`
  (re-derives the candidate's concept-id set from the keyword layer at
  decline time and persists it — no event append, matching this store's own
  "derived stats, not event-sourced" precedent). WRITE-only, deliberately:
  the sibling `feat/category-prototype-ux` branch owns "small READ routes
  around suggestionCandidateStore" for the panel, so no read route was added
  here to avoid overlap. `RouteMatch` gained one additive field
  (`fingerprint`).
- **Fixture**: 8 unfiled pages (2 clear 3-member groups + 2 noise
  singletons) → exactly 2 new-topic candidates after the real 3-consecutive-
  computation stability gate (not a shortcut) —
  `splitSuggestionNewTopic.test.ts`, alongside decline-recurrence
  (a declined cluster stays suppressed across further stable
  recomputations, and a decline at one scope never leaks into another) and
  an explicit incremental-no-recompute case (unchanged `revisionId` short-
  circuits the whole pass, proven by handing it deliberately-wrong evidence
  that is never looked at).

**Files changed** (companion unless noted): NEW —
`enrichment/keywordExtract.ts`, `keywordConcepts.ts`, `keywordConceptStore.ts`,
`keywordIngest.ts`, `keywordBackfillLane.ts`, `search-index/
keywordIndexStore.ts`, `workstreams/unfiledEvidence.ts`, `http/routes/
workstreamSuggestionsRoutes.ts`, + one `.test.ts` per module (10 new test
files). MODIFIED (additive) — `suggestions/tokens.ts` (export `STOPWORDS`),
`suggestions/centroid.ts` (export `normalize`), `workstreams/
splitSuggestionEngine.ts` (hybrid distance, keyword naming, decline
suppression), `workstreams/suggestionCandidateStore.ts` (decline table),
`ranker/learnedAggregatorStats.ts` (concept entropy field), `http/routes/
enrichmentRoutes.ts` (live-ingest + retraction-resync hooks), `http/
routeSupport.ts` (`RouteMatch.fingerprint`), `http/server.ts` (route
registration), `gc/vaultLedger.ts` (2 new sidecar-db leaf names), `http/
routeTable.characterization.test.ts` (pinned order). EXTENSION package,
MODIFIED — `sidepanel/nano/titleSynthesis.ts` (`KEYWORDS_LINE_INSTRUCTION`
appended to `GIST_PROMPT_PREFIX` and `GIST_SYNTHESIS_PROMPT_PREFIX`);
verified against the existing 115-test suite covering gist synthesis,
validation, and Chinese chunking — all green, no prompt-tuning regression.

**Deviations, all documented rather than silent:** (1) the architecture
correction in this section's opening (gist synthesis is browser-side, not
`appleFmEngine.ts`). (2) `'new-category'` reused instead of adding a
`'new-topic'` discriminator value. (3) `aggregator.learned-stats-shadow`
health-panel surfacing and the real `keywordConceptIds` observation-adapter
wiring deferred (§5). (4) Live recall-v2 embedding retrieval for unfiled
evidence deferred (§7), matching PR #376's own identical scope cut. (5)
`DEFAULT_CONCEPT_COSINE_THRESHOLD=0.82` and
`DEFAULT_DECLINE_CONCEPT_OVERLAP_THRESHOLD=0.75` are judgment calls,
flagged for golden-set tuning like every other unspecified numeric
threshold in this design.

`bun run build` clean (both packages); `bun run typecheck` clean modulo a
pre-existing, unrelated repo-wide gap (`tsconfig.json` lacks `bun-types`, so
every `bun:test`-importing spec — including ones this PR never touched,
e.g. `entityExtract.test.ts` — fails module resolution under that specific
config; `tsconfig.build.json`, the actual build gate, excludes all
`*.test.ts` and is unaffected). See the PR for the full test run and exact
counts.

**§10 addendum — production recompute scheduler (2026-08-17, same PR).**
Post-review finding: neither `recomputeSuggestionCandidates` (PR #376) nor
this PR's own §7 real-data wiring had a PRODUCTION CALLER — confirmed by
cross-checking PR #384 (panel UI: membership chips, suggestion cards,
dismiss), whose own landing note states plainly that wiring a recompute
pass is deferred to "a future PR." Closed the gap in this PR rather than
leaving it to a third:

- `workstreams/splitEvidence.ts` — sibling adapter to `unfiledEvidence.ts`,
  turning `prototypeEvidence.ts`'s `gatherWorkstreamEvidence` output into
  `SuggestionEvidenceItem[]` for `'split'` mode (same "embeddings optional,
  deferred" contract, same most-recent-first population cap).
- `workstreams/suggestionRecomputeLane.ts` — the scheduler.
  `computeSuggestionEvidenceRevision` hashes one scope's evidence
  (member ids + keyword sets, order-independent) into the `revisionId`
  `recomputeSuggestionCandidates` already dirty-marks against — the SAME
  `"<count>:<sha256>"` shape `prototypeGeneration.ts`'s `evidenceWatermark`
  uses. `runSuggestionRecomputeCycle` covers BOTH kinds in one bounded pass
  (every workstream with ≥1 filed page for `'split'`, plus the always-
  considered vault-wide unfiled pool for `'new-category'`), bounding
  ACTUAL re-clustering (not cheap dirty-checks) to `batchCap` scopes/cycle.
  `createSuggestionRecomputeLane` self-schedules (fast poll while backlog
  remains, slow poll once caught up), and
  `scheduleSuggestionRecomputeLoop(connectionsStore, eventLog, vaultRoot)`
  is the actual production entry point — wired into
  `runtime/companion.ts` immediately after `schedulePrototypeGenerationLoop`
  (same disposer-into-`teardown[]` contract), reusing the SAME already-open
  `connectionsStore`/`baseEventLog`, opening its own small keyword-layer +
  candidate-store handles.
- **Wiring `runtime/companion.ts` directly** (not left "ready to splice,"
  unlike this PR's other schedulers) is itself a deviation worth naming:
  the original plan deferred touching that file because a sibling branch's
  active-file list (checked 2026-08-16) included `runtime/*`. Re-checked
  2026-08-17 against PR #384's ACTUAL diff (the authoritative, current
  state, not the earlier snapshot) — it touches
  `splitSuggestionEngine.ts`/`suggestionCandidateStore.ts` (a real,
  expected merge-conflict surface, see below) but NOT `runtime/*`,
  `page-evidence/*`, or `generationBuffer.ts`. With that risk gone and the
  coordinator flagging "no caller = the whole feature stays dead" as
  blocking, wiring in directly was the right call.
- **Known merge-conflict surface, flagged rather than avoided**: PR #384
  ALSO adds a per-fingerprint `dismissed`/`dismissedAtMs` field to
  `SuggestionCandidateRecord` (sticky across recomputes via the engine's
  existing Jaccard member-overlap match) — a DIFFERENT, complementary
  decline mechanism from this PR's population-scoped, concept-overlap
  `declineCandidate`/`declinedConceptSets` (§7). The two key differently
  (exact/overlapping MEMBER ids vs. CONCEPT ids) and can coexist without
  contradiction; whoever merges second should keep BOTH additive column
  sets on `suggestionCandidateStore.ts`'s schema and BOTH suppression
  checks in `recomputeSuggestionCandidates`, not pick one.
- Tests: `splitEvidence.ts` reuses `unfiledEvidence.ts`'s already-tested
  join/bound shape (no separate suite); `suggestionRecomputeLane.test.ts`
  covers dirty-marking (unchanged evidence -> skipped, changed evidence ->
  re-clustered), `batchCap` bounding across multiple cycles without
  dropping backlog, both kinds populating the store in one real
  (non-mocked) end-to-end cycle, and per-scope failure isolation.
  `runtime/companion.ts`'s own boot/shutdown suite
  (`runtime/companion.test.ts`) passes unchanged with the new scheduler
  wired in.

**§10 addendum #2 — keyword-backfill lane wiring (2026-08-17, follow-up
fix).** Live-vault check (build 4f27316b, ~3h deployed) found
`keyword-index.db` / `keyword-concepts.db` EMPTY — `0` rows, no keyword-index
log marks ever — starving `suggestionRecomputeLane.ts`'s recompute pass of
the keyword-concept features `hybridSimilarity` needs (§4). Root cause: this
was the THIRD "engine without a caller" instance in the same delivery
window (after `recomputeSuggestionCandidates` and the main-card membership
chips, both already fixed) — `enrichment/keywordBackfillLane.ts`'s
`createKeywordBackfillLane` was exported, fully unit-tested, and explicitly
documented as "ready to splice in" (§6 above), but nothing in
`runtime/companion.ts` ever called it.

**Audit — every wiring verified or added, not just the one that was
broken:**

| Component | Exported from | Production caller | Status |
|---|---|---|---|
| `createKeywordBackfillLane` | `enrichment/keywordBackfillLane.ts` | `scheduleKeywordBackfillLoop` → `runtime/companion.ts` | **FIXED this PR** — was uncalled |
| `ingestGistKeywords` (live ingest) | `enrichment/keywordIngest.ts` | `http/routes/enrichmentRoutes.ts`, `POST /v1/enrichment/content` handler | Verified wired (pre-existing) |
| `resyncGistKeywordsAfterRetraction` | `enrichment/keywordIngest.ts` | `http/routes/enrichmentRoutes.ts`, `POST /v1/enrichment/retract` handler | Verified wired (pre-existing) |
| `assignKeyword` (concept assignment) | `enrichment/keywordConceptStore.ts` | Called from `ingestGistKeywords` (itself wired per above) | Verified wired (pre-existing) |
| `gatherUnfiledEvidence` / `suggestionEvidenceFromUnfiled` | `workstreams/unfiledEvidence.ts` | `suggestionRecomputeLane.ts`'s `buildDeps.gatherNewCategoryEvidence` → `scheduleSuggestionRecomputeLoop` → `runtime/companion.ts` | Verified wired (pre-existing, §10 addendum #1) |
| `gatherWorkstreamEvidence` / `suggestionEvidenceFromWorkstreamItems` | `workstreams/prototypeEvidence.ts` / `splitEvidence.ts` | `suggestionRecomputeLane.ts`'s `buildDeps.gatherSplitEvidenceByWorkstream`; also `http/routes/workstreamsRoutes.ts` (serve path) and `workstreams/prototypeGeneration.ts` | Verified wired (pre-existing) |
| `recomputeSuggestionCandidates` | `workstreams/splitSuggestionEngine.ts` | `suggestionRecomputeLane.ts`'s `runSuggestionRecomputeCycle` → `runtime/companion.ts` | Verified wired (pre-existing, §10 addendum #1) |

No other exported-but-uncalled production machinery found in the #385
delivery — the backfill lane was the only gap.

**Fix, in `enrichment/keywordBackfillLane.ts` + `runtime/companion.ts`:**
- `scheduleKeywordBackfillLoop(eventLog, vaultRoot, options?)` — added to the
  END of `keywordBackfillLane.ts` (same file, same split as
  `suggestionRecomputeLane.ts`: pure DI-only lane above, production
  scheduler below). Opens its OWN `keywordIndexStore`/`keywordConceptStore`
  handles (the "no shared singleton" idiom `keywordIngest.ts` established —
  see `suggestionRecomputeLane.ts`'s header), `mkdir -p`'s
  `_BAC/connections` itself first (self-sufficient — does not assume some
  OTHER companion.ts component created that directory first), and calls the
  lane's own self-scheduling `start()`. `indexCandidate` delegates to
  `keywordIngest.ts`'s `ingestGistKeywords` — the SAME function the live-
  ingest hook calls, so a backfilled page goes through the identical
  extract+upsert+concept-assign path.
- Env-gated: `SIDETRACK_KEYWORD_BACKFILL` (default ON; `'0'`/`'false'`
  disables — zero handles opened, zero timers started, not merely a no-op
  cycle). `listCandidates` additionally short-circuits to `[]` whenever
  `keywordIngestEnabled()` (the SEPARATE `SIDETRACK_KEYWORD_INGEST` flag) is
  off, rather than letting `indexCandidate` throw per-candidate — load-
  bearing, because `maxAttemptsPerPage` quarantine has NO cooldown decay
  (§6): treating a global ingest-disabled window as a per-candidate failure
  would have permanently quarantined the entire backlog within 3 cycles
  (~6s at the default `cycleIntervalMs`).
- Startup delay `KEYWORD_BACKFILL_STARTUP_DELAY_MS=30s` (short, deliberately
  — NOT the 10-minute delay `scheduleSuggestionRecomputeLoop`/
  `schedulePrototypeGenerationLoop` use; the live vault's index was found
  completely empty, so backfill should begin promptly), overridable via
  `SIDETRACK_KEYWORD_BACKFILL_STARTUP_DELAY_MS` for tests.
- **Audibility (binding requirement).** Every cycle — including a fully-idle
  one — now emits `[keyword-backfill] cycle processed=N remaining=M
  concepts=K` (added inside `runOnce()`, via a new optional
  `conceptsTotal()` dep, best-effort — a concept-store read failure reports
  `concepts=0` rather than suppressing the mark). One boot line states
  enabled/disabled: `[keyword-backfill] enabled` or `[keyword-backfill]
  disabled via SIDETRACK_KEYWORD_BACKFILL=0`. Silence is exactly how this
  shipped broken for ~3 hours undetected.
- **Shutdown (#374 lane-stop discipline).** `disposeKeywordBackfill()` is
  pushed to `teardown[]` (startup-failure rollback) AND called explicitly in
  `close()`'s pre-drain "stopping-lanes" block, alongside
  `stopBodyEvidenceLane`/`stopBackgroundEmbeddingLane`. Not itself an event-
  log-appending lane (writes only to its own keyword-index/concept-store
  SQLite handles, never `eventLog.append*`), so it cannot cause the
  SIGTERM-hang `awaitIdle()`-never-converges failure mode #374 fixed — but a
  lane left ticking past `close()` is still a live timer + live SQLite
  handles outliving the "shut down" process, so it is stopped explicitly
  rather than relying on the unref'd-timer-dies-with-the-process assumption
  alone.

**Tests:**
- `enrichment/keywordBackfillLane.test.ts` (extended) — env-flag defaults;
  the audible per-cycle mark (including the idle case and a
  `conceptsTotal()`-throws case); an end-to-end `scheduleKeywordBackfillLoop`
  fixture — 3 gists seeded directly onto the event log (bypassing live
  ingest, reproducing exactly the "gist predates the keyword layer"
  backlog shape) are backfilled by a real cycle, `keyword-index.db` rows +
  concepts appear, and the resulting `SuggestionEvidenceItem[]` (built the
  same way `suggestionRecomputeLane.ts`'s join does) feeds a REAL
  `hybridSimilarity` computation that correctly scores same-topic pages
  higher than cross-topic ones — proving consumability, not just presence;
  plus the disabled-flag no-op case.
- `runtime/companion.test.ts` (extended) — a real `startCompanion()` boot
  (25 seeded gists, `SIDETRACK_KEYWORD_BACKFILL_STARTUP_DELAY_MS=0`) proves
  the boot line fires and a real cycle runs and durably indexes; a second
  test proves `close()` stops the lane before its already-armed next cycle
  (~2s out, since backlog > `batchCap`) fires — same shape as the existing
  body-evidence-lane SIGTERM regression suite; a third test proves
  `SIDETRACK_KEYWORD_BACKFILL=0` opens no handle and starts no timer at all.

**Deviation from the original plan:** none beyond what's documented above.
Scope was kept to exactly the reported gap — wiring the backfill lane and
verifying/documenting the rest of the audit. (Two further scope additions —
liberal suggestion-stability gating and a new-label hint on batch-resolve —
landed in the SAME PR as coordinator-directed follow-ups; see the next
addendum for both, kept as a clearly separated addition rather than folded
silently into this one.)

`bun run build` clean; `bun run typecheck` clean modulo the same pre-
existing repo-wide `bun:test` module-resolution gap noted in §10's landing
note above (unrelated to this change, `tsconfig.build.json` unaffected).
Full `bun test` for `packages/sidetrack-companion` green (see PR for the
exact count).

**§10 addendum #3 — liberal suggestion gating + new-label hint (2026-08-17,
same PR, coordinator-directed follow-up).**

**(1) Liberal suggestion gating.** The stability gate that decides how many
CONSECUTIVE stable computations a split/new-category candidate must survive
before it is ever allowed to emit (`recomputeSuggestionCandidates`'s
`stabilityMinConsecutive`, §4 above) was a flat `3`. Made env-tunable
(`SIDETRACK_SUGGESTION_STABILITY`, `resolveSuggestionStabilityMinConsecutive`
in `workstreams/splitSuggestionEngine.ts`) and the DEFAULT lowered to `1` —
a qualifying candidate now surfaces on its first computation. Rationale:
population-scoped decline memory (`declineCandidate`/`declinedConceptSets`,
§7) makes a wrong suggestion nearly free to dismiss — one click, and that
concept-set never resurfaces for the scope+kind again — so the 2-extra-
cycle wait the old gate imposed on every GOOD candidate (minutes, at
`suggestionRecomputeLane.ts`'s cadence) was withholding value to guard
against a cost the decline UI already makes cheaper than the gate itself.
`minClusterMembers` also gained an env knob
(`SIDETRACK_SUGGESTION_MIN_MEMBERS`, `resolveSuggestionMinClusterMembers`)
but its DEFAULT is UNCHANGED (still `HDBSCAN_TOPIC_MIN_SAMPLES + 1` = 4) and
floored at `SUGGESTION_MIN_MEMBERS_FLOOR` (`HDBSCAN_TOPIC_MIN_SAMPLES` = 3,
never settable below — a cluster smaller than the density primitive's own
min-samples isn't a cluster by that primitive's own definition) — unlike
stability, "how big must a cluster be" did not loosen, only "how many times
must it look the same" did.

Verified the `GET /v1/workstreams/suggestions` read surface has NO hidden
second gate: its filter is exactly `candidate.emitted && !candidate.dismissed`
(`http/routes/workstreamsRoutes.ts`) — `emitted` IS the stability-gated
flag, so a candidate the engine emits under the new liberal default is
immediately visible, proven by a new route-level test that runs the REAL
engine (not a hand-built store row) and fetches it back same-request.

Tests: the two original stability-mechanism tests
(`splitSuggestionEngine.test.ts`) now pass `stabilityMinConsecutive: 3`
explicitly (proving the MECHANISM is unchanged, only the bare-call default
moved) and are renamed to say so; `splitSuggestionNewTopic.test.ts`'s shared
options constant does the same (every test in that file is specifically
about the 3-round cadence); new tests prove (a) a qualifying candidate
emits on its bare-default first computation, (b) a declined signature stays
suppressed even under the liberal default while an unrelated fresh cluster
in the same cycle still emits on ITS first computation (decline memory
beats liberal stability), (c) the GET-route immediate-visibility case above,
and (d) env-parsing for both new resolvers (default/override/garbage/
below-floor).

**(2) New-label hint.** Additive, companion-side-only wire field on the
batch-resolve response (`UrlResolutionResult.newLabelHint?: {name,
keywords}`, `tabsession/newLabelHint.ts`, attached by `http/server.ts`'s
`finalizeBatchResolveResults`) — panel rendering is a separate, already-
in-flight change building against this contract; this PR ships the
computation + wire shape only. Present when, for one URL: (a) NO existing
workstream reached confidence — reusing, byte-for-byte, the SAME
"genuinely no confident pick" condition `tabsession/laneFallback.ts`'s
`applyLaneFallbackGuess` already established
(`fusedCandidates.length === 0 && decision.gate?.reason === 'no-candidates'`),
checked AFTER `applyLaneDecisions` so a page the lane-fallback guess
successfully rescued is correctly NOT hinted; AND (b) the page carries
`SIDETRACK_NEW_LABEL_HINT`-gated (default ON), so a keyword-store hiccup or
an explicit disable costs nothing (`newLabelHintForPage` never throws, and
the flag check happens before any store handle opens). `name` is the top-3
keywords joined (same convention `splitSuggestionEngine.ts`'s
`keywordNameFor` uses for cluster naming, applied here to one page's own
terms). Lazy per-vault `KeywordIndexStore` singleton — a THIRD independent
production caller of that store (after `keywordIngest.ts` and
`workstreamSuggestionsRoutes.ts`), same "no shared singleton across
modules" idiom.

**Decline-exclusion, load-bearing, reused not reinvented.**
`declineMemory.ts`'s own header documents the EXACT live bug this hint
could have reintroduced: `gate.reason === 'no-candidates'` ALSO fires for a
URL the user explicitly declined ("not in any stream"), and
`applyLaneFallbackGuess`/`applyLaneCorroboration` both learned the hard way
that re-suggesting on a declined page reads the decline as an invitation.
The new-label-hint attachment in `finalizeBatchResolveResults` applies the
SAME `isUrlDeclined(laneContext.declines, canonicalUrl)` guard those two
lanes use, before ever reaching the keyword lookup — a page the user
declined never gets a "make a new category" prompt either.

Self-sufficiency note: `newLabelHintForPage`'s handle-opening `mkdir -p`s
`_BAC/connections` itself (same defensive fix already applied to
`scheduleKeywordBackfillLoop` above) — harmless in production (boot always
creates that directory long before the HTTP listener starts accepting
requests) but caught a real race in the new route-level tests against a
freshly-created test vault.

**Tests:**
- `tabsession/newLabelHint.test.ts` (new) — pure `computeNewLabelHint`
  (null below the 2-keyword floor, top-3 naming, full keyword list
  preserved); env-flag defaults; per-vault lookup (present/absent by
  indexed-keyword-count, flag-off no-op, lazy-singleton reuse).
- `http/visitsRoutes.test.ts` (extended, `POST /v1/visits/batch-resolve —
  newLabelHint` block) — weak lanes (edgeless snapshot, `gate.reason ===
  'no-candidates'`) + >=2 keywords -> present; a strong existing-workstream
  match (direct `closest_visit` -> `visit_in_workstream` asserted edge
  chain, keywords present too, isolating the variable) -> absent; no
  keywords indexed -> absent even with weak lanes; a declined URL -> absent
  even with weak lanes + keywords; `SIDETRACK_NEW_LABEL_HINT=0` -> absent
  for an otherwise-qualifying page.

`bun run build` clean. Full `bun test` for `packages/sidetrack-companion`
green (see PR for the exact count); the newly-touched suites
(`splitSuggestionEngine.test.ts`, `splitSuggestionHybridDistance.test.ts`,
`splitSuggestionNewTopic.test.ts`, `suggestionRecomputeLane.test.ts`,
`http/workstreamsRoutes.test.ts`, `tabsession/newLabelHint.test.ts`,
`http/visitsRoutes.test.ts`, `http/server.test.ts`,
`http/routeTable.characterization.test.ts`,
`http/batchResolveShape.characterization.test.ts`, `tabsession/
resolver.test.ts`, `tabsession/laneFallback.test.ts`, `tabsession/
laneCorroboration.test.ts`, `tabsession/declineMemory.test.ts`,
`http/resolveSwrRoutes.test.ts`) reran green in isolation.
