# Heterogeneous Attributed Graph Embedding Investigation (2026-05-17)

Status: investigation only. Base: `origin/main` at `eb6acc49`.

This document inventories the current Switchboard/Sidetrack evidence graph and evaluates whether it can support future heterogeneous attributed graph embedding or GNN-style candidate generation. It does not propose training a model in this PR, does not add serving behavior, does not create a parallel event stream, and does not emit new production `closest_visit`, topic, workstream, or learned graph edges.

## Executive Verdict

The current Connections snapshot is already a heterogeneous, attributed, provenance-bearing graph over threads, browser visits, visit instances, tab sessions, snippets, annotations, workstreams, topics, replicas, templates, dispatches, queue items, reminders, and coding sessions. The graph is built as a deterministic reducer over the merged event log plus vault stores in `packages/sidetrack-companion/src/connections/snapshot.ts:83-131` and typed in `packages/sidetrack-companion/src/connections/types.ts:22-290`.

That is enough to prototype shadow-only graph proximity lanes:

- V0 PPR / rooted PageRank over existing typed edges.
- V0.5 node2vec / DeepWalk-style unsupervised embeddings over a read-only extracted graph.
- Later inductive embeddings, only as Class E inferred opinion revisions with provenance and evaluation pointers.

It is not enough to ship a supervised graph/link predictor. The prior `closest_visit` leak showed that label provenance must come before model choice. ADR-0005 requires temporal splits, leakage probes, visible candidate-label accounting, baseline comparison, and persisted diagnostics before learned rankers graduate (`docs/adr/0005-ranker-evaluation-methodology.md:31-55`). The remediation path also explicitly stopped deriving visit-pair positives from workstream closure (`packages/sidetrack-companion/src/ranker/retrain.ts:61-72`).

## Source Map

| Area | Source anchor | Why it matters |
|---|---|---|
| Sync classes | `docs/sync-contract-v1.md:93-112` | Defines Class A-F surfaces. Class E is the canonical evolving interpretation layer (`docs/sync-contract-v1.md:76-78`). |
| Work graph locks | `docs/architecture.md:33-153` | Locks confidence/provenance/classes: asserted, observed, inferred; `producedBy`; evidence edges in Class B; inference edges in Class E. |
| Connections graph types | `packages/sidetrack-companion/src/connections/types.ts:22-290` | Enumerates current node kinds, edge kinds, provenance union, confidence enum, snapshot shape. |
| Connections reducer | `packages/sidetrack-companion/src/connections/snapshot.ts:83-131`, `:959-981` | Documents emitted edge set and 13 materialization passes. |
| Contract registry | `packages/sidetrack-companion/src/sync/contract/registry.ts:174-506` | Maps event families to Sync Contract surfaces. |
| Timeline and navigation events | `packages/sidetrack-companion/src/timeline/events.ts:26-51`, `packages/sidetrack-companion/src/navigation/events.ts:24-42` | Browser-observed visit/page/tab/navigation facts. |
| Feedback events | `packages/sidetrack-companion/src/feedback/events.ts:3-148` | User assertions, flow confirmations/rejections, topic renames, snippet promotions. |
| Recall embeddings | `packages/sidetrack-companion/src/sync/contract/recallMaterializer.ts:129-245` | Existing text embeddings and metadata for chat-turn recall chunks. |
| Visit similarity | `packages/sidetrack-companion/src/connections/visitSimilarity.ts:21-48`, `packages/sidetrack-companion/src/connections/types.ts:237-259` | Existing content-similarity revision over visit title/host/path. |
| Ranker leakage lesson | `docs/ranker-closest-visit-leak-diagnosis-and-plan-2026-05-16.md:36-61`, `packages/sidetrack-companion/src/ranker/feature-schema.ts:5-42` | Workstream closure was label leakage; feature schema v3 stopped consuming workstream identity features in the model. |

## Current Graph Inventory

### Node-Like Entities

| Entity | Current representation | Source anchors | Notes for graph extraction |
|---|---|---|---|
| Visit | `ConnectionNodeKind = 'timeline-visit'`, keyed by canonical URL / stripped URL | `connections/types.ts:22-36`; timeline node metadata in `connections/snapshot.ts:1437-1499`; timeline projection in `timeline/projection.ts:34-53` | This is the closest thing to a Page node today. It aggregates visits by URL and carries title, URL, provider, visit count, engagement, workstream attribution hints, and search query when detected. |
| Page / canonical URL | Not a separate node kind; represented by `timeline-visit:<canonicalUrl>` and URL projection records | `urls/projection.ts:1-11`, `:58-71`; `connections/snapshot.ts:1440-1469` | Future graph code can treat canonical URL as a node type in an extracted graph, but production Connections currently encodes it as `timeline-visit`. Do not add a production Page node without a contract change. |
| Visit instance | `ConnectionNodeKind = 'visit-instance'` | `connections/types.ts:29-31`; `connections/snapshot.ts:1593-1629` | Per tab-session observation group. Carries canonical URL, title, provider, visit count, tab session, aggregate timeline visit id, and mirrored engagement. |
| Tab session | `ConnectionNodeKind = 'tab-session'`; tab-session projection records | `tabsession/projection.ts:11-38`, `:205-280`; `connections/snapshot.ts:1651-1688` | Observed from `browser.timeline.observed`; user/inferred attribution folds into the projection. |
| Thread | `ConnectionNodeKind = 'thread'`; `thread.upserted` projection and `capture.recorded` fallback | `threads/events.ts:46-58`; `connections/snapshot.ts:1003-1024`, `:2012-2022` | Carries provider, thread URL, title, status, primary workstream. Turns are not graph nodes today. |
| Turn | Not a Connections node; stored inside `capture.recorded` and Class E extraction revisions; recall chunks index turn paragraphs | `recall/events.ts:16-39`; `recall/extraction/events.ts:20-46`; `recallMaterializer.ts:129-245` | Future graph extraction can introduce shadow turn nodes, but production graph should not until an MCP/contract spec exists. |
| Snippet | `ConnectionNodeKind = 'snippet'` | `snippets/events.ts:6-25`; `connections/snapshot.ts:2621-2731` | Hash-only copy/paste lineage. No raw selected text is stored by selection events. |
| Workstream | `ConnectionNodeKind = 'workstream'` | `workstreams/events.ts:23-35`; `connections/snapshot.ts:1025-1083`, `:1513-1556` | User organization/scope evidence. Must not be converted into pair-level positives. |
| Topic | `ConnectionNodeKind = 'topic'`; Class E topic revision | `producers/topic-revision.ts:41-91`; `connections/snapshot.ts:2416-2551` | Inferred cluster membership with revision provenance, cohesion, representative titles, lineage, and optional secondary affiliations. |
| Annotation / note | `ConnectionNodeKind = 'annotation'` | `annotations/events.ts:26-34`; `connections/snapshot.ts:1931-1951`, `:2139-2155` | User-authored notes and page anchors; can reference threads/URLs. |
| Context Pack | Not a persisted graph node; derived view/resource over Connections or MCP workstream snapshot | Extension reducer: `packages/sidetrack-extension/src/sidepanel/connections/contextPack.ts:41-48`; derivation from snapshot: `packages/sidetrack-extension/src/sidepanel/connections/client.ts:362-448`; MCP resource: `packages/sidetrack-mcp/src/server/resources.ts:187-225` | Treat as a target task/output surface, not as current graph truth. |
| Provider | Attribute, not node | Timeline provider in `timeline/events.ts:22-35`; thread provider in `threads/events.ts:46-58`; dispatch target provider in `dispatches/events.ts:14-34` | Candidate feature source, but no first-class Provider node today. |
| Domain / repo | Derived feature keys, not nodes | `ranker/candidates.ts:431-451`; `ranker/feature-schema.ts:16-23` | Currently candidate/feature only. No production `same_domain` or `same_repo` edge. |
| Replica | `ConnectionNodeKind = 'replica'` | `connections/types.ts:35`; cross-replica pass in `connections/snapshot.ts:2553-2619` | Evidence node for observations across replicas. |
| Template | `ConnectionNodeKind = 'template'` | `visual/events.ts:5-10`; `connections/snapshot.ts:2881-2922` | DOM-skeleton hash group from `visual.fingerprint.observed`; no screenshots/pixels/content. |
| Dispatch / queue / reminder / coding session | Existing node kinds | `connections/types.ts:22-36`; dispatch event source in `dispatches/events.ts:14-41`; reducer summary in `connections/snapshot.ts:89-98` | Secondary graph endpoints; useful for context-pack selection and workflow explanation. |

### Edge-Like Relations

| Requested relation | Current relation(s) | Source and class | Attributes/provenance | Policy |
|---|---|---|---|---|
| `visit_of_page` | `visit_instance_same_url_as_timeline_visit` plus canonical URL keying of `timeline-visit` | Timeline projection, Class B; `connections/snapshot.ts:1689-1696` | `confidence: observed`, `producedBy: timeline-projection` | Candidate/feature source. Not a label. |
| `navigation_next` / `browser.timeline.observed` | `previous_visit_in_tab_session`, `opener_visit`, `tab_session_opener_chain` | `navigation.committed`, Class F input to Class B graph; `navigation/events.ts:24-42`; `connections/snapshot.ts:1825-1930`; `registry.ts:344-363` | Visit ids, tab/window hashes, sequence, transition, timestamp; `confidence: observed` | Strong candidate/feature source. Label only if later confirmed by user flow feedback. |
| `same_tab_session` | `visit_instance_in_tab_session`, `visit_in_tab_session` edge kind exists | Timeline projection; `connections/types.ts:120-122`; emitted visit-instance edge in `connections/snapshot.ts:1697-1704` | `confidence: observed`; stable tab session id | Candidate/feature. Avoid using as implicit positive label. |
| `copied_from` / `pasted_into` | `snippet_copied_from_visit`, `snippet_pasted_into_thread`, `snippet_pasted_into_dispatch`, `snippet_pasted_into_search`, `snippet_pasted_into_note`, `snippet_pasted_into_capture`, `snippet_reused_across_threads` | `selection.copied` / `selection.pasted`; `snippets/events.ts:6-25`; registry `:399-428`; reducer `connections/snapshot.ts:2621-2731` | Hash, simhash, char count, line count, content kind, revision id `snippet-lineage:v1:hash`; mostly observed, reuse is inferred | Candidate/feature. `user.snippet.promoted` can be a label source; raw copy/paste alone is not. |
| `same_canonical_url` | `timeline_same_url_as_thread`; URL projection also groups by canonical URL | Deterministic URL match; `connections/snapshot.ts:1424-1588`; URL projection `urls/projection.ts:58-71` | URL/canonical URL; `confidence: inferred` for thread/visit match | Candidate/feature. Not pair-level supervision. |
| `content_similar` / `visit_similarity` | `visit_resembles_visit` | Class E visit similarity revision over title/host/path corpus; `visitSimilarity.ts:21-48`, `:130-138`; reducer `connections/snapshot.ts:2369-2414` | `cosine`, `threshold`, `revisionId`, producer `embedding` or `lexical` in revision type (`connections/types.ts:237-259`) | Good unsupervised candidate source. Never a supervised label without user confirmation. |
| `same_domain` / `same_repo` | Candidate/feature only; no persisted edge | `ranker/candidates.ts:431-451`; features in `ranker/feature-schema.ts:16-23` | Host and GitHub/GitLab owner/repo parsed from URL | Safe as feature/candidate. Do not emit production edges in this investigation. |
| `same_search_query` | Candidate key plus `thread_text_mentions_search_query` edge | Search detection in timeline metadata; edge pass `connections/snapshot.ts:1454-1459`, `:2263-2367`; ranker source in `ranker/candidates.ts:456-461` | Query string, whole-word match; `confidence: inferred` | Candidate/feature. No label. |
| `user_organized` / `visit_in_workstream` | `visit_in_workstream`, `visit_instance_in_workstream`, `tab_session_in_workstream`, `thread_in_workstream`, `dispatch_in_workstream`, `topic_in_workstream` | `user.organized.item` and URL/tab inferred attribution; feedback events in `feedback/events.ts:21-71`; URL/tab projection folds in `urls/projection.ts:361-430`, `tabsession/projection.ts:227-280`; reducer `connections/snapshot.ts:1500-1556`, `:1763-1823` | `attributionSource`, `attributionOrigin`, source event, dot; confidence asserted for user/thread, inferred for resolver/timeline pointer | Graph evidence and scoping. Forbidden as pair-level positive labels. |
| `user_flow_confirmed` | Feedback label, not Connections edge | `feedback/events.ts:80-93`; `feedback/projection.ts:287-298` | Relation kind (`closest_visit`, `visit_resembles_visit`, `visit_continues_visit`), from/to ids | Allowed positive label source if ids resolve and timestamp policy passes. |
| `user_flow_rejected` | Feedback label, not Connections edge | `feedback/events.ts:95-111`; `feedback/projection.ts:301-312` | Relation kind, from/to ids, rejection reason | Allowed negative label source. |
| `user_snippet_promoted` | Feedback label, not base graph edge | `feedback/events.ts:125-140`; `feedback/projection.ts:328-340` | Snippet id, target kind/id, optional source visit id | Allowed label source for the promoted relation. Do not generalize to all snippet reuse. |
| `topic_member` / `visit_in_topic` | `visit_in_topic`, `topic_in_workstream`, `topic.lineage` | Class E topic revision; `topic-revision.ts:41-91`; reducer `connections/snapshot.ts:2416-2551` | Topic metadata, primary/secondary affiliation, secondary scores/reasons, lineage kind, revision id | Candidate/feature/explanation source. Inferred opinion, not label. |
| `closest_visit` | `closest_visit` | Learned ranker Class E output; reducer `connections/snapshot.ts:2783-2879` | Score, feature schema version, top feature contributions, ranker revision id | Output opinion only. Must not feed back as canonical truth or label. |
| `page_content_extracted` / coverage | Page-content events plus HTTP-read metadata on `timeline-visit` | Payload types in `page-content/types.ts:38-126`; schemas in `http/schemas.ts:589-639`; endpoint appends events in `http/server.ts:4123-4168`; snapshot metadata applied at read time in `http/server.ts:790-842` | Coverage state, quality, quality signals, extraction source, chunk count, indexed char count, tombstone state | Feature/candidate gating source. Open question: page-content events are not currently visible in `sync/contract/registry.ts`. |
| `visit_observed_on_replica` / continuation | `visit_observed_on_replica`, `visit_continues_visit` | Cross-replica materialization and continuation classifier; reducer `connections/snapshot.ts:2553-2619`, `:2733-2781` | Replica id, continuation score/features, revision provenance | Candidate/feature/explanation. Label only after user confirmation. |
| Template similarity | `visit_in_template` | `visual.fingerprint.observed`; `visual/events.ts:5-10`; registry `:487-506`; reducer `connections/snapshot.ts:2881-2922` | DOM skeleton hash only, no pixels/content; `confidence: observed` | Candidate/feature. Watch dominance and privacy gating. |

## Node Attribute Availability Matrix

`yes` means the attribute is directly present on the node/projection. `partial` means it exists through a related projection, HTTP enrichment, or non-node record. `no` means it is not modeled today.

| Node type | Title | URL/host/path | Provider | Time/recency | Engagement | Page coverage/quality | Recall embedding ref | Topic/workstream metadata | Source kind | Privacy/tombstone | Lineage/revision |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `timeline-visit` | yes | yes, canonical URL; host/path derivable | yes | yes | yes via engagement classifier | partial via HTTP metadata | partial through visit-similarity / recall if page content is indexed | yes, workstream hints and topic edges | implicit browser/timeline | partial via ignored/coverage/tombstone projections | revision on similarity/topic edges |
| `visit-instance` | yes | yes | yes | yes | mirrored URL aggregate | partial through linked timeline visit | no | yes via attribution edges | browser observation | partial | no |
| `tab-session` | latest title | latest URL | yes | opened/last/closed | no direct | no | no | yes, attribution projection | browser/user/inferred | no | attribution history |
| `thread` | yes | thread URL | yes | last seen/captured | no direct | no | yes through recall chunks | primary workstream | capture/thread events | status/deleted projection | extraction revision for turns |
| Turn | partial inside capture/extraction | thread URL only | model/provider partial | capturedAt | no | no | yes, chunk embedding metadata | no | chat turn | extraction active state/tombstone | extraction revision id |
| `snippet` | id/hash label | no | no | copy/paste time | no | no | no | target/promote via feedback | selection events | no raw text by design | snippet lineage revision |
| `workstream` | yes | no | no | updated by events | no | no | no | parent/children/privacy/tags | Class A user/system fact | privacy/screen-share metadata | no |
| `topic` | representative label | member URLs in revision | no | first/last observed | cohesion from similarity graph | no | indirect through visit similarity | dominant workstream, member count | Class E clusterer | no | topic revision and lineage |
| `annotation` | note/label | target URL | no | acceptedAt | no | page anchor only | no | may target thread/workstream | user note | soft delete in projection | no |
| Context Pack | generated title/content | derived from included nodes | derived | generated on demand | derived | derived indexed pages | no | workstream/topic scoped | UI/MCP view | no persisted state | no |
| Provider/domain/repo | no node | derived strings | yes as attribute | no | no | no | no | no | derived feature key | no | no |
| `replica` | id label | no | no | observedAt via edge | no | no | no | no | sync replica | no | no |
| `template` | hash label | no | no | observedAt | no | no | no | no | visual fingerprint | no screenshot/pixels/content | no |

## Edge Attribute And Policy Matrix

| Edge group | Source event / producer | Observed, asserted, inferred | Score/confidence fields | Revision id | Time window | Sync truth vs local opinion | Candidate | Feature | Label |
|---|---|---|---|---|---|---|---|---|---|
| Thread/workstream/dispatch structural edges | `thread.upserted`, `workstream.upserted`, `dispatch.recorded`, `dispatch.linked`, vault stores | asserted or observed depending source | `confidence` plus `producedBy.eventType` | no | event timestamp | Class A facts reduced into Class B evidence | yes | yes | no, except explicit user flow/snippet feedback |
| Timeline/tab/navigation edges | `browser.timeline.observed`, `navigation.committed` | observed | hashes, sequence, visit ids in metadata | no | event timestamp | Browser facts in Class F/B | yes | yes | no |
| URL/text/search references | `capture.recorded`, `dispatch.recorded`, `annotation.created`; deterministic extraction | observed for URL refs, inferred for quote/search match | query/record id where present | no | acceptedAt / latest endpoint | Class B derived evidence | yes | yes | no |
| Copy/paste snippet lineage | `selection.copied`, `selection.pasted`; hash matcher | observed for copied/pasted edges, inferred for reuse | hash prefix, simhash match, char count | `snippet-lineage:v1:hash` | 24-hour match window (`connections/snapshot.ts:2621-2625`) | Class B/Class E-style revision evidence | yes | yes | only when `user.snippet.promoted` |
| Visit similarity | visit-similarity producer | inferred | cosine, threshold | yes | latest endpoint observedAt | Class E inferred opinion | yes | yes | no |
| Topic membership/lineage | topic-clusterer | inferred; lineage edge currently marked observed but produced by revision | cohesion, affiliation, secondary scores | yes | revision producedAt / observedAt | Class E inferred opinion | yes | yes | no |
| Workstream attribution | `user.organized.item`, URL/tab resolver events, legacy timeline pointer | asserted for user/thread, inferred for resolver/timeline | attribution source/origin | resolver metadata in event payload for inferred URL/tab attribution | event timestamp | User organization or inferred attribution, not pair label truth | yes | yes, with leakage controls | forbidden as pair label |
| Closest visit | active ranker scorer | inferred | score, feature schema version, top contributions | yes | latest endpoint observedAt | Class E inferred opinion | no feedback loop | explanation/debug only | no |
| Page content coverage | page-content endpoints/events and read-time metadata | observed/server-observed plus coverage state | quality, quality signals, coverage state | no formal graph revision today | extracted/tombstoned time | Coverage evidence, not current graph edge | yes as gate | yes | no |
| Visual template | `visual.fingerprint.observed` | observed | DOM hash | no | observedAt | Class B evidence from Class F event | yes, cautiously | yes | no |

## Label, Candidate, Feature Policy

| Source | Label policy | Candidate policy | Feature policy | Notes |
|---|---|---|---|---|
| `user.flow.confirmed` | Allowed positive if relation kind and endpoints resolve under time-split policy | yes | yes | Direct pair-level feedback in `feedback/projection.ts:287-298`. |
| `user.flow.rejected` | Allowed explicit negative | yes | yes | Direct rejection in `feedback/projection.ts:301-312`. |
| `user.snippet.promoted` | Allowed positive for promoted source/target only | yes | yes | Projection creates labels at `feedback/projection.ts:328-340`; do not infer all similar snippets as positives. |
| `user.organized.item` workstream membership | Forbidden as visit-pair positive via closure | yes, as scope/candidate source | yes, but keep out of model inputs when it is label-adjacent | Historical leak removed at `ranker/retrain.ts:61-72`; debug features still include workstream fields but ranker model inputs exclude them (`ranker/train.ts:250-274`). |
| Browser observed facts: timeline, navigation, selection, visual | Not labels | yes | yes | Observed facts should seed candidates and proximity, not supervision. |
| Deterministic Class B joins: URL refs, quote/search matches | Not labels | yes | yes | Useful evidence edges; still not user judgments. |
| Class E inferred revisions: visit similarity, topic, closest visit, continuations | Not labels | yes for shadow/candidate extraction | yes with provenance and dominance audits | Inferred opinions cannot become canonical truth or training labels without user confirmation. |
| Unlabeled generated candidates | Not negative | yes | yes | `train.ts:348-364` now makes unlabeled candidates visible and excludes them rather than silently converting them. |
| Random/hard-negative generators | Candidate negatives only under explicit evaluation design | yes | yes | Must be reported separately from user-rejected negatives and audited for artifact/test pollution. |

## Proposed `GraphEmbeddingContract`

This is a TypeScript-oriented contract for future investigation artifacts. It is not implemented here. Any persisted learned output must be a Class E inferred opinion revision with `modelRevisionId`, `featureSchemaVersion`, and `evalReportId` before it can influence serving.

```ts
interface GraphEmbeddingContract {
  inputGraphKind:
    | 'homogeneous'
    | 'heterogeneous'
    | 'attributed'
    | 'constructed';

  nodeTypes: string[];
  edgeTypes: string[];

  outputKind:
    | 'node_embedding'
    | 'edge_embedding'
    | 'hybrid_embedding'
    | 'whole_graph_embedding';

  preservedProximity:
    | 'first_order'
    | 'second_order'
    | 'higher_order'
    | 'typed_relation'
    | 'temporal_path'
    | 'content_similarity';

  targetTask:
    | 'retrieval'
    | 'candidate_generation'
    | 'link_prediction'
    | 'topic_affiliation'
    | 'workstream_suggestion'
    | 'context_pack_selection'
    | 'why_related_explanation';

  allowedLabelSources?: string[];
  forbiddenLabelSources?: string[];
  featureSchemaVersion: string;
  labelPolicyVersion?: string;
  modelRevisionId?: string;
  evalReportId?: string;
}
```

Suggested initial version:

```ts
const graphEmbeddingContractV0 = {
  inputGraphKind: 'heterogeneous',
  nodeTypes: [
    'timeline-visit',
    'visit-instance',
    'tab-session',
    'thread',
    'snippet',
    'annotation',
    'workstream',
    'topic',
    'replica',
    'template',
    'dispatch',
  ],
  edgeTypes: [
    'previous_visit_in_tab_session',
    'opener_visit',
    'visit_instance_same_url_as_timeline_visit',
    'visit_instance_in_tab_session',
    'snippet_copied_from_visit',
    'snippet_pasted_into_thread',
    'visit_resembles_visit',
    'visit_in_topic',
    'topic.lineage',
    'visit_observed_on_replica',
    'visit_in_template',
  ],
  outputKind: 'node_embedding',
  preservedProximity: 'typed_relation',
  targetTask: 'candidate_generation',
  allowedLabelSources: ['user.flow.confirmed', 'user.flow.rejected', 'user.snippet.promoted'],
  forbiddenLabelSources: [
    'workstream-closure',
    'same_workstream',
    'visit_in_workstream',
    'visit_instance_in_workstream',
    'tab_session_in_workstream',
    'topic_in_workstream',
    'closest_visit',
    'visit_resembles_visit',
    'visit_in_topic',
  ],
  featureSchemaVersion: 'graph-embedding-features:v0',
  labelPolicyVersion: 'label-policy:no-workstream-closure:v1',
} satisfies GraphEmbeddingContract;
```

## Fit With The Sync Contract

Future graph embedding should be an extractor/materializer over existing facts, not a new architecture:

1. Inputs come from existing Class A, B, E, and F surfaces:
   - observed/browser facts: `browser.timeline.observed`, `navigation.committed`, engagement, selection, visual fingerprint;
   - user assertions: `user.organized.item`, `user.flow.confirmed`, `user.flow.rejected`, `user.snippet.promoted`, topic rename;
   - inferred opinions: visit similarity, topic revision, closest visit, continuation, URL/tab attribution.
2. The graph extractor must preserve `ConnectionEdge.producedBy` and `confidence` from `connections/types.ts:214-235`.
3. Learned graph output is a Class E revision artifact, never a Class B fact. It should carry:
   - `contractVersion`;
   - `inputSnapshotRevision` or graph extraction revision;
   - `featureSchemaVersion`;
   - `labelPolicyVersion` when supervised;
   - `modelRevisionId`;
   - `evalReportId`;
   - `inputs[]` or an evidence hash sufficient for privacy masking and audit.
4. Serving integration, if ever allowed, should first use the output only as an additional candidate source, not as a replacement ranker or canonical edge emitter.

## Safe Shadow Lanes

| Lane | Safe scope | Why safe | Graduation blocker |
|---|---|---|---|
| V0: PPR / rooted PageRank / path proximity | Read-only graph extraction from `ConnectionsSnapshot`; diagnostic report only | Deterministic, no model training, explainable by edge paths | Needs edge-type weights, privacy filtering, artifact filtering, and comparison to current candidates before any UI use |
| V0.5: node2vec / DeepWalk | Unsupervised embeddings over the snapshot; local diagnostic or candidate-source experiment only | No pair labels required; can measure candidate diversity vs baselines | Must not emit production edges; needs reproducible seeds, versioned graph extraction, and dominance audits |
| V1: GraphSAGE-style inductive node embeddings | Candidate source only; no active ranker replacement | Can handle attributes and new nodes | Requires contract, feature schema, temporal evaluation, and enough non-leaky feedback |
| V2: R-GCN / HGT typed-edge model | Later research only | Matches heterogeneous typed edge structure | Requires stronger infra, typed edge schema, explainability, and eval maturity |
| V3: supervised edge/link predictor | Only after leak-free labels and time-split eval | Could improve link prediction and workstream suggestions | Blocked until label provenance, hard negatives, artifact filters, and baseline gates are proven |

## Forbidden Shortcuts

- No workstream-closure positives.
- No `same_workstream`, `user_asserted_in_workstream`, `visit_in_workstream`, `visit_instance_in_workstream`, `tab_session_in_workstream`, or `topic_in_workstream` leakage into a `closest_visit` scorer or supervised link labels.
- No "unlabeled candidate means negative" shortcut.
- No graph embedding output as canonical truth.
- No production edge emission from graph embeddings without held-out evaluation and a Class E revision contract.
- No hidden double-counting of user organization evidence through candidate source plus feature plus label.
- No treating inferred topic/workstream affiliation as if the user asserted a pair-level relation.
- No new event stream parallel to Sync Contract; new graph work must use registered events and materializers.

## Evaluation Gates

Any future graph embedding or GNN path must report, at minimum:

| Gate | Required question |
|---|---|
| Time-split evaluation | Does performance hold when training data precedes validation/test interactions? |
| Net-new relation share | How many surfaced candidates are not already same-workstream, same-topic, same-URL, or existing `closest_visit` neighbors? |
| Same-workstream duplication rate | Is the model just rediscovering user organization? |
| Hard-negative precision | Does it avoid plausible but wrong neighbors, not just random unrelated pages? |
| Source/edge-type diversity | Which edge families drive candidates and accepted results? |
| Feature/edge-type dominance audit | Does one label-adjacent feature dominate scores? |
| Recorder/test artifact filtering | Are fixtures, recorder pages, localhost, and test domains filtered or separately reported? |
| Baseline comparison | Must beat PPR plus existing `idf-rkn-split` topic baseline plus leak-free LightGBM candidate/ranker baseline before serving. |
| Label accounting | Positive, explicit negative, implicit negative, and unlabeled counts must be visible. |
| Revision audit | Every learned output must point to model, features, labels, eval report, and input snapshot/revision. |

## Minimal Code Inventory For A Shadow Extractor

The safest first extractor should be a read-only function over `ConnectionsSnapshot`:

- Source type: `ConnectionsSnapshot` in `connections/types.ts:270-290`.
- Node fields: `id`, `kind`, `label`, `firstSeenAt`, `lastSeenAt`, `originReplicaIds`, `metadata`.
- Edge fields: `kind`, `fromNodeId`, `toNodeId`, `observedAt`, `producedBy`, `confidence`, `family`, `metadata`.
- Required filters:
  - skip edges whose endpoints are absent;
  - preserve `confidence` and `producedBy`;
  - preserve edge direction and allow per-edge reverse-direction policy;
  - exclude or separately tag Class E inferred opinions when training/evaluating supervised models;
  - filter tombstoned/private/ignored page-content and URL states before export;
  - do not invent Page, Turn, Provider, Domain, or Repo nodes in production snapshots.

For diagnostics, a lightweight script can summarize a snapshot's current node/edge inventory before any graph model work. It should read an existing `_BAC/connections/current.json` and print counts by node kind, edge kind, confidence, and producer. It must not import the materializer or write runtime state.

## Open Questions

1. Should page-content events be registered in `sync/contract/registry.ts` as a declared surface? They are payload-typed and appended by HTTP today, but not visible in the contract registry search.
2. Should a future extracted graph introduce shadow-only Page and Turn node types while keeping production `ConnectionNodeKind` unchanged?
3. What is the durable location and schema for graph-embedding Class E revisions and eval reports?
4. How should privacy gates, URL ignored state, and page-content tombstones be applied to an extracted graph before diagnostics are written?
5. Which edge-type weights are acceptable for V0 PPR, and should inferred Class E edges be excluded by default?
6. What counts as a non-leaky positive for workstream suggestion? Direct `user.flow.confirmed` and `user.snippet.promoted` are clear; workstream membership is not.
7. Should context-pack selection optimize over the same graph extractor, or remain a pure reducer over scoped Connections snapshots until evaluation exists?

## Final Recommendation

Prototype V0 first: a read-only graph extractor plus PPR/rooted PageRank diagnostic against existing snapshots. Compare it against current candidate sources, `visit_resembles_visit`, topic `idf-rkn-split`, and the leak-free `closest_visit` baseline without emitting production edges.

V0.5 node2vec/DeepWalk can follow as an unsupervised candidate-source experiment if V0 reveals useful path structure. V1+ learned embedding/GNN work must wait for a formal Class E revision contract, label policy, and ADR-0005-style evaluation gates. Supervised link prediction must wait the longest because the failure mode is not model weakness; it is label provenance leakage.
