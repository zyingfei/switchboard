# Sidetrack — Stage 1 MVP (Consolidated, LLM-Free, Hardware-Neutral)

> **Design principle (re-stated).** Facts are event-sourced. Interpretations are
> versioned. Suggestions are explainable. User organization is authoritative.
> **No inference requires GPU / Apple-Silicon hardware.**

This is the consolidated Stage 1 plan, integrating the local-iteration plan with the
external researcher's converged version. It supersedes both. The structural skeleton
(Northern Star → Out of Scope) follows the researcher's revision; the work-split
section at the end is added so the team can spin major tasks (architecture, planning,
integration) for the lead while parallelizing well-scoped code work to Codex.

## Northern Star

Sidetrack is a **temporal behavioral work graph** for the modern browser worker. The
system observes — with explicit user consent — what the user reads, what they navigate
from and to, what they engage with vs. abandon, and what they copy/paste between
contexts. From those facts it builds an event-sourced graph that the user can replay,
query, label, and re-organize. The graph is shipped through the Sync Contract v1
between the plugin edge (Class F raw events), an optional companion (Class B/D/E
derivations), and an optional relay.

Two non-negotiable properties define the product:

1. **Authoritative user organization.** The user's manual labels, threads, dispatches,
   snippets, and notes always outrank inferred structure. Inferred structure is
   rendered as `confidence: 'inferred'` (Lock 1) and shown with a dashed CSS stroke so
   it is visibly weaker than user-authored facts.
2. **Hardware-neutral inference.** Sidetrack runs in any Manifest V3 browser on any
   consumer machine without assuming a discrete GPU, Apple Silicon, or an AMD APU
   with usable shared memory. **Stage 1 ships zero LLM inference code.** The codebase
   already has a working WASM-backed `multilingual-e5-small` embedder
   (`Xenova/multilingual-e5-small` via `@huggingface/transformers`, 384 dims,
   `query:` / `passage:` prefix discipline, deterministic test embedder) — that is
   the only neural component on the critical path, and it runs on CPU.

Stage 1 is the smallest set of capabilities that turns the existing engine plus the
existing recall stack into a usable behavioral graph. It adds new *facts* (Class F
raw observations), one new *evidence* edge (`visit_observed_on_replica`), one new
*similarity* edge that reuses the existing embedder, deterministic clustering, and
deterministic explanation surfaces. Everything else — learned ranker, supervised
feedback, optional cloud-LLM prose enhancement — is roadmap.

## Architectural Locks (preserved invariants)

These four locks are invariants of the broader Sidetrack design and accepted upstream
of this plan.

**Lock 1 — Confidence enum gains `inferred`.** Every node and edge carries
`confidence ∈ {'asserted', 'observed', 'inferred'}`. `'asserted'` = user said so;
`'observed'` = directly captured event; `'inferred'` = derived by a producer.
Inferred edges render with a dashed CSS stroke (`stroke-dasharray: 4 2`). Enforced in
the renderer, not by content, so it cannot be bypassed.

**Lock 2 — `payloadVersion` + `dimensions` extension slot.** Every Class F event and
every replayable Class B/D/E artifact has `payloadVersion: number` (monotone) and
`dimensions: Record<string, unknown>` (open extension). New behavior fields are
*added through `dimensions`*, never via positional schema mutation.

**Lock 3 — `producedBy` provenance on every Class B edge eligible to be derived.**
Every derived edge records
`{ producer: string, producerVersion: string, inputs: Array<{kind, id, hash}>, producedAt: number }`.
This makes Class E revisions deterministic to reissue.

**Lock 4 — Privacy gates as Class A facts.** Privacy state changes are facts on the
timeline, not flags in a settings store. The events are `privacy.gate.flipped`,
`privacy.permission.granted`, `privacy.permission.revoked`. Replicas materialize from
the event stream so revoking on Replica α propagates to β through Sync Contract
Class A delivery, including retroactive masking of any derived artifact whose
`inputs[]` reference a now-forbidden source.

## Stage 1 — Sub-sections

The C1–C6 increments from the codebase adoption map are the spine of Stage 1.

```
C1: schema/event evolution                                  -> 1.A, 1.B, 1.F
C2: deterministic causality via webNavigation               -> 1.B
C3: engagement intervals                                    -> 1.A, 1.G
C4: copy/paste lineage with hashes                          -> 1.H
C5: relationship ranker v1 (existing stack only)            -> 1.C, 1.E, 1.J (Why Related)
C6: explicit IndexedDB decision for production extension    -> 1.F (transport), all of 1.A/1.H (event sink)
```

### 1.A Engagement dimensions (content script, deterministic, gated)

The content script captures **counts and durations only**. Nothing about page contents
leaves the page unless an explicit Class A privacy gate is open. Engagement events are
emitted as Class F. Raw observations and aggregates are kept separate so a future
producer can re-derive aggregates without losing the raw stream.

| Field | Source primitive | Notes |
|---|---|---|
| `activeMs` | `visibilitychange` + idle detector | wall time tab is visible AND user is not idle (idle threshold default 30 s) |
| `visibleMs` | Page Visibility API | wall time `document.visibilityState === 'visible'`; superset of `activeMs` |
| `focusedWindowMs` | `chrome.windows.onFocusChanged` | window contains tab AND window is OS-foreground |
| `idleMs` | `chrome.idle` (extension) + content-script inactivity | complement of `activeMs` within `visibleMs` |
| `foregroundBursts` | counted hidden→visible transitions | unbounded counter |
| `returnCount` | counted re-entries to same canonical URL within session | session = browser session |
| `scrollEvents` | throttled `scroll` listener (max 1 Hz aggregate) | counts only, no positions |
| `maxScrollRatio` | `(scrollY + clientH) / scrollH` snapped at sample points | float `[0, 1]`; never re-decreases |
| `copyCount` | `copy` event | event-level counter; snippet semantics live in 1.H |
| `pasteCount` | `paste` event | dual to `copyCount` |

Events emit as `engagement.interval.observed` (`payloadVersion: 1`,
`dimensions: { ...above }`). The content script registers dynamically; if the user's
Class A `privacy.gate.flipped` event for "engagement" is `closed`, the content script
is not injected — gate honored before observation, not after. Aggregates over sessions
emit as `engagement.session.aggregated` and are a *replayable Class B reduction* of
the raw `engagement.interval.observed` stream, never a destructive overwrite.

### 1.B Provenance dimensions (deterministic causality)

The plugin gains the `webNavigation` permission. On every committed top-frame
navigation we emit a Class F `navigation.committed`:

```ts
{
  payloadVersion: 1,
  visitId: string,                    // canonical URL + commitTimestamp + replicaId
  url: string,                        // pre-canonicalization
  canonicalUrl: string,               // post-normalization (utm/fbclid/gclid/srsltid stripped, scheme+host lowercased, default ports removed, fragment dropped)
  documentId: string,                 // chrome.webNavigation provides UUID
  parentDocumentId: string | null,
  tabId: number,                      // raw, transient
  tabSessionIdHash: string,           // FNV-1a 32-bit of (tabId, browserSessionStart)
  windowSessionIdHash: string,        // FNV-1a 32-bit of (windowId, browserSessionStart)
  openerVisitId: string | null,       // resolved from openerTabId IF opener still exists, else null
  previousVisitId: string | null,     // last visit on the same tabSessionIdHash
  navigationSequence: number,         // monotone within tabSessionIdHash
  transitionType: TransitionType,     // 'link' | 'typed' | 'auto_bookmark' | 'auto_subframe' | 'manual_subframe' | 'generated' | 'start_page' | 'form_submit' | 'reload' | 'keyword' | 'keyword_generated'
  transitionQualifiers: TransitionQualifier[], // any subset of {'client_redirect','server_redirect','forward_back','from_address_bar'}
  commitTimestamp: number,
  dimensions: { /* extension slot */ }
}
```

Two correctness notes (both grounded in Chrome documentation):

1. **`openerTabId` only when opener still exists.** When `chrome.tabs.onCreated` fires
   without `openerTabId`, `openerVisitId = null` and we fall back to `previousVisitId`
   along the same `tabSessionIdHash`. We never invent an opener.
2. **`webNavigation` timestamps are internally consistent only.** They are not
   commensurate with `Date.now()` from inside content scripts. All "duration" math
   stays *within* a single source — engagement durations from content-script clocks,
   navigation deltas from webNavigation timestamps — and never crosses streams.

`tabId` and `windowId` are not stored. They're hashed with FNV-1a (32-bit) to produce
stable, non-identifying session group keys. FNV-1a is non-cryptographic; the hash here
is a stable group key, not a privacy boundary.

### 1.C `visit_resembles_visit` edge — reuses the existing embedder

This is the new similarity edge. It reuses `multilingual-e5-small` *without*
introducing a second embedding stack, vector index, or new ANN library.

**Producer.** For every `navigation.committed` whose canonical URL has stable
extracted text (title + selected headings + first-viewport text, all already produced
by the recall pipeline), the companion (or the plugin in plugin-only mode) computes
the `passage:`-prefixed embedding and inserts through the existing recall index V3
path: `_BAC/recall/index.bin`, with `modelId = 'Xenova/multilingual-e5-small'`, the
pinned HF revision, the chunk schema version, the schema capabilities, per-entry
metadata, the replica id, the Lamport timestamp, the source-scoped replacement
semantics, and the canonical ordering already in production. **No new vector store.**

**Edge predicate.** For each new visit `v`, retrieve top-K (default 50) candidates via
the existing hybrid retrieval (MiniSearch + cosine + RRF, with title/heading/text
field weights and dotted-identifier tokenization, all already shipped). Among those
candidates, emit `visit_resembles_visit(v → u)` with `confidence: 'inferred'` for
every `u` whose cosine on the `query:`-prefixed embedding of `v` exceeds the relative
threshold `T_sim` (default `0.85`).

Threshold note: per the model card and MMTEB, multilingual-E5 cosine scores cluster in
`[0.7, 1.0]`, so `0.85` is a *position within a known distribution*, not a probability.
Exposed as a setting in the developer build and persisted so changes are auditable.

**Persistence.** The edge ships as a Class E revision (`visit-resembles-visit-revision`,
key `visit-resembles:v1:cosine`) so re-embedding under a different model revision or
threshold replaces the prior revision deterministically without orphaning.

### 1.D Persistent topic nodes via deterministic Union-Find with content-derived ids

Topics are **not** k-means and **not** HDBSCAN. A topic is the connected component of
the `visit_resembles_visit` graph at threshold `T_sim`, intersected with manual user
organization (a user who threads two visits forces them into the same topic regardless
of cosine).

```
For each visit v:
  uf.add(v)
  for each edge visit_resembles_visit(v → u) with cosine ≥ T_sim:
    uf.union(v, u)
  for each user-asserted edge in_thread(v, u):
    uf.union(v, u)            // user > inferred

For each component C:
  members = sorted(uf.members(C), by canonical URL ascending)
  topic_id = "topic:" + sha256(members.join("\n")).slice(0, 16)
```

A topic is a `ConnectionNode` of kind `'topic'` (the 8th `ConnectionNodeKind`). Its
`topic_id` is content-derived and therefore *deterministic given its membership* —
two replicas observing the same component independently mint the same id.

When a component splits or merges, the affected components' ids change; this is
acknowledged as the price of determinism without a coordination service. Stage 1
mitigates by emitting a Class B `topic.lineage` edge whenever a component splits or
merges, so the user's prior `topic_id` remains addressable as a tombstone with
`succeededBy` pointers.

For Stage 1 corpus sizes (single user, weeks-to-months, target ≤ 10⁵ visits),
Union-Find with path compression is O(α(n)) per union — flat in practice. HDBSCAN /
Leiden / centroid-stable variants are deferred until the dataset crosses an empirical
scale where Union-Find's coarseness becomes the actual user complaint.

### 1.E Cross-device continuation as evidence edge

When the same canonical URL is observed on multiple replicas within the user's
account, we emit `visit_observed_on_replica(visit, replicaId)` as a **Class B
evidence** edge with `confidence: 'observed'`. This is **not** an inference. It
carries no claim that the user "continued the same task across devices." It is the
raw fact that the URL was observed elsewhere; any classifier converting these into
"continuation" inferences belongs to a later stage and must produce a Class E
artifact with its own producer/version/threshold.

### 1.F Privacy event types replacing chrome.storage flags + the IndexedDB decision

Privacy state expressed as Class A events on the timeline:

- `privacy.gate.flipped`: `{ gate: string, state: 'open' | 'closed', actor: 'user' | 'system', reason?: string }`
- `privacy.permission.granted`: `{ permission: string, scope: object }`
- `privacy.permission.revoked`: `{ permission: string, scope: object, retroactiveMask: boolean }`

These events drive the materializers. There is no `chrome.storage.local.privacy`
settings blob in Stage 1 — the previous representation is migrated to a deterministic
replay over the privacy event stream.

**The IndexedDB decision (C6).** Keep `chrome.storage.local` as the persistence
substrate for the small, hot, mostly-read working set: URL/title timeline summary,
last seen replica id, current Lamport, the small spool of pending sync messages,
user UI preferences. **Introduce IndexedDB-backed Class F event buffer** for
high-volume append-only streams: `engagement.interval.observed`, `selection.copied`,
`selection.pasted`, `navigation.committed`, and the engagement *aggregate* artifacts.

**Why.** `chrome.storage.local` defaults to ~10 MB (5 MB pre-Chrome 114), is
JSON-stringified per write, and writes the *entire value* of any changed key.
Behavioral event streams that include per-interval engagement records on dozens of
tabs can exceed comfortable quota in a session-week. IndexedDB is available to MV3
service workers, has no fixed cap (origin quota — typically a percentage of free
disk on Chromium, with `navigator.storage.estimate()` exposing the live number),
supports range queries on indexed keys, and has documented batched-cursor and
`getAll()` patterns that outperform per-item access. Request `unlimitedStorage` so
both substrates are exempt from eviction.

**How (write path).** The service worker batches Class F events into ≤ 100-item
transactions every ≤ 1 s. Each transaction writes to a single object store keyed by
`(streamName, lamport, replicaId)` so canonical ordering is preserved. The
deterministic test embedder pattern from the recall pipeline is mirrored here: in
test runs, the IndexedDB layer swaps for an in-memory adapter behind the same
interface so the e2e suite (1.K) doesn't require a real IndexedDB.

**How (read path).** UI surfaces (Flow Path, Focus View) read through a thin reducer
that subscribes to a `getAllRecords`/cursor pagination over the indexed key range
and re-hydrates aggregates on demand. Never load the full stream into the popup or
side panel.

**MV3 lifecycle implications.** All listeners (`webNavigation.onCommitted`,
`tabs.onCreated`, `idle.onStateChanged`, `runtime.onMessage`) register synchronously
at the top of the service worker. No state lives in module globals between worker
restarts; everything that must survive is in IndexedDB or `chrome.storage.local`.
`chrome.alarms` (minimum 1-minute period) drives periodic flush of in-memory event
batches that haven't yet hit the size threshold.

### 1.G Engagement classification — deterministic ruleset, no learned model

Per-visit engagement class is a Class E revision keyed `engagement-class:v1:rules`.

| Class | Rule (all conditions ANDed unless noted) |
|---|---|
| `parked_background` | `focusedWindowMs < 2000` AND `activeMs < 1000` |
| `glanced` | `activeMs < 5000` AND `maxScrollRatio < 0.15` AND `copyCount = 0` |
| `skimmed` | `5000 ≤ activeMs < 30000` AND `maxScrollRatio ≥ 0.15` AND `copyCount = 0` AND `scrollEvents ≥ 3` |
| `engaged_read` | `activeMs ≥ 30000` AND `maxScrollRatio ≥ 0.4` AND `returnCount ≥ 1` |
| `worked_on_reference` | `activeMs ≥ 30000` AND `copyCount ≥ 1` AND `returnCount ≥ 2` |
| `source_extracted` | `copyCount ≥ 1` AND any `selection.copied` from this visit appears as `selection.pasted` into a thread/dispatch/note/capture |
| `execution_source` | `source_extracted` AND `copyCount ≥ 2` AND distinct destinationKinds ≥ 2 |

The producer is a pure reducer over `engagement.session.aggregated` plus the C4
lineage. Writes a Class E artifact `engagement.class.assigned` with full `producedBy`
(Lock 3). Any future learned classifier (deferred to Stage 2/3) ships as a *different*
producer key (e.g. `engagement-class:v2:learned`); the two co-exist via the revision
pattern; the user can pin which producer's classes the UI surfaces use.

### 1.H Copy/paste lineage — hashes only by default

A new `'snippet'` `ConnectionNodeKind` (the 9th) joins the model. New events:

- `selection.copied`: `{ visitId, selectionHash: SHA-256, simhash64: bigint, charCount, sampledCharRanges: [start,end][], rawTextStored: false }`
- `selection.pasted`: `{ destinationKind: 'thread' | 'dispatch' | 'search' | 'note' | 'capture', destinationId, simhash64, charCount, rawTextStored: false }`

**Default privacy posture.** `rawTextStored: false`. Only hashes leave the page
(`selectionHash` for exact match, `simhash64` for fuzzy match). Raw text is captured
only if the user has flipped the explicit Class A gate
`privacy.gate.flipped({ gate: 'snippet.rawText', state: 'open' })` *or* explicitly
invokes "promote to source/note", at which point the snippet becomes a user-authored
fact (`confidence: 'asserted'`) with full text under the user's control. Sidetrack
does not poll the system clipboard.

**Lineage matching.** A `selection.copied` and a later `selection.pasted` are linked
when:

- `selectionHash` matches exactly, OR
- `simhash64` Hamming distance ≤ 3 within a 24-hour window.

Hamming ≤ 3 over 64-bit SimHash is the canonical near-duplicate band per Manku et
al. (2007 web crawl evaluation). Sidetrack normalizes selections before hashing:
collapse whitespace, drop heuristic UI chrome (header/footer markers), drop pure
timestamp lines.

**Edges minted on lineage match:**

- `snippet_copied_from_visit(snippet → visit)` — `confidence: 'observed'`
- `snippet_pasted_into_thread / _dispatch / _search / _note / _capture` —
  `confidence: 'observed'`
- `snippet_reused_across_threads(snippet → [thread_a, thread_b, ...])` —
  `confidence: 'inferred'` when the same `snippet_id` matches into ≥ 2 threads.

### 1.I Deterministic templates for label, Why Related, Context Pack

**Stage 1 ships zero LLM code.** The three surfaces are deterministic reducers.

**Topic label.** The label of a topic is `representativeTitles[0]` — the title of the
topic member with the highest `focusedWindowMs` (ties broken by canonical URL
ascending). The tooltip carries `cohesion = mean cosine over edges within the
component` and `memberCount = |members|`. No model in the loop.

```ts
function topicLabel(t: Topic): { label: string; tooltip: string } {
  const top = t.members
    .slice()
    .sort((a, b) => b.focusedWindowMs - a.focusedWindowMs || a.canonicalUrl.localeCompare(b.canonicalUrl))[0];
  return {
    label: top.title || top.canonicalUrl,
    tooltip: `cohesion=${t.cohesion.toFixed(2)} · members=${t.members.length}`,
  };
}
```

A user who renames a topic produces a `topic.label.asserted` Class A fact that takes
priority; the deterministic label is only a default.

**Why Related — structured reason-code list.** Each reason has a code and a small
structured payload, renderable in any locale and trivially testable:

```ts
type Reason =
  | { code: 'SAME_THREAD'; threadId: string; threadName: string }
  | { code: 'SAME_TOPIC'; topicId: string; cohesion: number }
  | { code: 'COSINE_ABOVE_THRESHOLD'; cosine: number; threshold: number }
  | { code: 'OPENER_CHAIN'; depth: number; viaTabSessionIdHash: string }
  | { code: 'PREVIOUS_VISIT_IN_TAB_SESSION'; tabSessionIdHash: string }
  | { code: 'TRANSITION_TYPE'; transitionType: TransitionType }
  | { code: 'TRANSITION_QUALIFIER'; qualifier: TransitionQualifier }
  | { code: 'COPIED_FROM'; snippetId: string }
  | { code: 'PASTED_INTO'; snippetId: string; destinationKind: string }
  | { code: 'OBSERVED_ON_OTHER_REPLICA'; replicaId: string }
  | { code: 'LEXICAL_OVERLAP'; topTokens: string[] }
  | { code: 'LINK_OUT_FROM' | 'LINK_IN_TO'; otherVisitId: string };
```

Renderer is a pure switch over `code` emitting parallel-structured bullets ("Same
thread: <name>", "Cosine 0.91 ≥ 0.85", "You pasted from this page into your
dispatch", …). List sorted by fixed reason-code priority (user-asserted relations
first, behavioral facts second, similarity third, lexical overlap last). This is the
production-grade form of "explainable recommendation" per Zhang & Chen 2018; Naiseh
et al.; Ge et al. ACM TORS 2024 — content-based, locally grounded, actionable.
Avoids the LLM-prose risk surveyed in Said 2025.

**Context Pack — structured Markdown.** Pure reducer over the topic, sections
rendered as Markdown lists. No inference. No summarization.

```markdown
# {Topic label}

## Core Sources
- [{title}]({url}) — focused {focusedWindowMs/1000 | 0}s · {engagementClass}

## AI Threads
- {threadName} — {threadCount} messages · last active {timestamp}

## Dispatches
- {dispatchTitle} — sent {timestamp} · {recipient}

## Snippets
- "{first 80 chars of snippet, only if rawTextStored=true; else "(hashed)"}"
  copied from [{title}]({url}) · pasted into {destinationKinds.join(", ")}

## Open Questions
- {extractable line ending in "?"}   // only when literally present in user-authored note text
```

"Open Questions" is **not** generated — it is extracted, line by line, from
user-authored notes (`'?'` line ending plus a length and structure filter). Section
omitted when no extractable question exists.

### 1.J UI surfaces — Flow Path, Focus View, Why Related, Context Pack composer

All four surfaces are deterministic. None has an LLM endpoint. None opens an
outbound network connection for inference.

**Flow Path tab.** Directed temporal view over `navigation.committed`, grouped by
`tabSessionIdHash`. Edges drawn from `previousVisitId` (solid) and `openerVisitId`
(solid). Cross-replica continuations from `visit_observed_on_replica` render as
dashed edges (Lock 1). Hovering a node reveals its engagement class. Clicking a
node opens its "Why Related" panel.

**Focus View tab.** Topic-centric view. Topic nodes (kind `'topic'`) are first-class;
visits inside a topic render as a member list ordered by `focusedWindowMs`. Topics
whose members include user-asserted threads/dispatches/snippets are visually
weighted higher. The top member's title is the topic label per 1.I.

**Why Related panel.** Renders the structured reason list for a (visit, visit) or
(visit, topic) pair. Each bullet is a discrete reason-code. Sorted by fixed priority.
Toggle "Show only user-asserted" hides every `confidence: 'inferred'` reason.

**Context Pack composer.** "Compose" produces the Markdown defined in 1.I and copies
to clipboard with explicit visual confirmation. Never opens a network connection.

### 1.K Browser e2e validation spec — no LLM stubbing required

Stage 1 e2e exercises the system end-to-end without any neural stubbing beyond the
deterministic test embedder pattern that the recall pipeline already uses (returns
deterministic 384-dim vectors keyed by content hash so the same input always
produces the same vector).

**Scenarios:**

1. **Causal spine.** Open tab via address bar (`transitionType: 'typed'`), click
   link (`transitionType: 'link'`, `openerVisitId` populated), force-close opener,
   click another link from new tab (`openerVisitId` is `null`, `previousVisitId`
   populated). Assert all three navigations emit expected Class F shape and graph
   reflects resolved openers.
2. **Engagement classification.** Open three pages: one immediately backgrounded
   (`parked_background`), one scrolled briefly (`skimmed`), one read >30 s with two
   returns (`engaged_read`). Assert deterministic class assignments and the Class E
   artifact key.
3. **Topic formation.** Open a cluster of 6 pages on a single subject; copy text
   from one into a thread (snippet lineage); assert the connected component, the
   deterministic `topic_id` formula, and the topic label = top member's title.
4. **Cross-replica observation.** Simulate a second replica observing the same
   canonical URL; assert `visit_observed_on_replica` is emitted; Flow Path renders
   a dashed edge.
5. **Privacy revocation.** Flip
   `privacy.gate.flipped({ gate: 'engagement', state: 'closed' })`; assert no
   further engagement events emitted, prior aggregates masked in UI, and the
   Class A event is in the replicable timeline.
6. **Storage substrate.** Drive 10 000 synthetic engagement intervals through the
   IndexedDB buffer; assert flush latency, batch size, and that
   `chrome.storage.local` usage stays under 5 MB (proves C6).
7. **Determinism of explanations.** Run the Why Related panel against the same
   fixture twice; assert byte-identical reason-code output. (Impossible against an
   LLM endpoint — one of the reasons the surface was redrawn deterministically.)

**Network-mock assertion:** the test installs a `context.route()` rule that fails
on any outbound LLM-shaped request (`*ollama*`, `*openai*`, `*anthropic*`,
`*claude*`, `*completions*`, etc.). Stage 1 must never make such a call.

## Roadmap (deferred, separate PRs)

| Stage | Capability | Trigger to start |
|---|---|---|
| 2 | Learned ranker for `closest_visit` (LightGBM/XGBoost LambdaMART) over existing scoring features plus behavior features | ≥ N weeks of single-user behavior + user-labeled positive/negative pairs |
| 3 | Supervised feedback loop on user accepts/rejects; producer-versioned Class E revisions | Stage 2 in production with telemetry |
| Future | Optional cloud-LLM enhancement (user supplies their own API key) for label, Why Related, and Context Pack *prose* surfaces | Class E revision pattern from Stage 1 makes this purely additive — existing deterministic surfaces remain available as fallback |
| Future | Cross-replica continuation classifier (the *inference* edge atop `visit_observed_on_replica`) | Ground-truth dataset + Stage 2 ranker |
| Future | ANN indexes (USearch / hnswlib / Faiss) | Cosine retrieval over flat float32 stops being interactive on the user's own corpus |
| Future | HDBSCAN / centroid-stable clustering | Topic id churn from Union-Find becomes a measured user complaint |
| Future | Visual fingerprinting / DOM / screenshot pHash | Need for visual revisitation that text embeddings do not solve |

## Prior art

References for the Stage 1 design choices, biased toward production-relevant work.

**Behavioral signals from the browser are well-understood.** Reconstructing detailed
browsing activity from incomplete history records — including time-spent and tab-focus
reconstruction — is an established research area (Kovacs, *Reconstructing Detailed
Browsing Activities from Browser History*, 2021); engagement-time heuristics built on
Page Visibility API with heartbeat events at ~10–15 s intervals are the production
standard (GA4, Chartbeat, Kissmetrics).

**Hybrid retrieval (lexical + dense + RRF) is the current MVP default.** Bruch, Gai
& Ingber, *An Analysis of Fusion Functions for Hybrid Retrieval*, ACM TOIS 2023/2024.
Convex combination of lexical and vector scores is sample-efficient and competitive
with RRF; RRF itself is more parameter-sensitive than its zero-shot reputation
suggests.

**Multilingual-E5-small is well-characterized for short-document semantic similarity.**
12 layers, 384 dimensions, instruction-prefixed (`query:` / `passage:`). Per the
model card and the *MMTEB: Massive Multilingual Text Embedding Benchmark* report
(arXiv 2502.13595, 2025), cosine scores on this family characteristically pile in
`[0.7, 1.0]` — *relative order matters, not absolute magnitude*. The 0.85 threshold
for `visit_resembles_visit` is therefore a *relative cutoff against the empirical
distribution*, not a calibrated probability.

**Explainable recommendation literature favors structured, content-based, actionable
explanations over free-text prose for trust calibration.** Zhang & Chen 2018; Ge et
al., *A Survey on Trustworthy Recommender Systems*, ACM TORS 2024; Naiseh et al. on
trust calibration; Said 2025 (*On explaining recommendations with LLMs*) on prose
confabulation risk. NN/g UX guidance ("Tips for Presenting Bulleted Lists in Digital
Content") is in lock-step. **Empirical license to ship deterministic, structured
explanation surfaces in Stage 1 instead of LLM-generated prose.**

**Union-Find is the canonical clustering primitive when the structure is "things
connected by an edge predicate."** Tarjan 1975. HDBSCAN itself uses Union-Find
internally on its mutual-reachability MST. Splink/UniqTag note: cluster IDs are
deterministic so long as clusters are stable; the ID equals a content-derived
function of all nodes in the cluster.

**Manifest V3 storage.** `chrome.storage.local` is capped at ~10 MB unless
`unlimitedStorage` is requested (5 MB pre-Chrome 114), serializes via JSON, not a
recommended substrate for high-frequency append-only event streams. IndexedDB is
available to MV3 service workers, has no fixed cap (origin quota), and modern
guidance (Lawson 2021/2025; RxDB benchmarks) recommends batched writes and
`getAll()`/`getAllRecords` over per-item cursoring.

**Manifest V3 service-worker constraints.** Event-driven; terminated after ~30 s of
inactivity (forcibly after 5 minutes of activity). Global state unsafe; everything
that must survive must be in `chrome.storage.*` or IndexedDB. All listeners must
register at the top level of the service worker module.

**chrome.webNavigation gives the deterministic causal spine.** `onCommitted` exposes
`transitionType` (`link` / `typed` / …) and `transitionQualifiers` (`client_redirect`
/ `forward_back` / `from_address_bar` / …). `chrome.tabs.onCreated` exposes
`openerTabId`, **only present if the opener tab still exists** (Chrome Developers
`chrome.tabs` reference). Plan handles the absent-opener case explicitly.

**SimHash with Hamming ≤ 3 over 64-bit fingerprints is the canonical near-duplicate
threshold.** Manku, Jain & Sarma, *Detecting Near-Duplicates for Web Crawling*, 2007.
`k = 3, b = 64` is the empirical sweet spot for "near-duplicate but not identical"
at web scale. Practitioners caution that too-strict thresholds produce false
negatives and that one must always normalize before hashing — both points reflected
in 1.H.

**Task trail.** Liao et al., *Task Trail: An Effective Segmentation of User Search
Behavior*, TKDE 2014 ([PDF](http://sonyis.me/paperpdf/tkde-2014.pdf)). Multi-signal
segmentation. Applies to Stage 1.B's provenance edges and Stage 2's eventual ranker.

**Cross-session task identification.** Wang et al., *Modeling and Analysis of
Cross-Session Search Tasks*, ICTIR 2013 ([Microsoft Research PDF](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/12/Modeling-and-Analyses-of-Multi-Session-Search-Tasks.pdf)).
Tasks transcend sessions; same canonical URL across weeks must be linkable.

**BrowseRank.** Liu et al., *BrowseRank: Letting Web Users Vote for Page Importance*,
SIGIR 2008. Models user browsing as a continuous-time Markov chain over a graph of
URL visits. The `visit_navigated_from` graph in 1.B is effectively a per-user, scoped
BrowseRank graph.

## Critical files

```
packages/sidetrack-extension/src/
  background/
    service-worker.ts                    # top-level listener registration (MV3-safe)
    listeners/
      web-navigation.ts                  # onCommitted -> navigation.committed (1.B)
      tabs.ts                            # onCreated openerTabId resolution (1.B)
      idle.ts                            # idle.onStateChanged -> activeMs gating
    storage/
      chrome-local.ts                    # small hot working set
      indexeddb-event-buffer.ts          # NEW (C6) — Class F append-only streams (1.A/1.F/1.H)
      flush-scheduler.ts                 # alarms-driven batched flush
    privacy/
      events.ts                          # Class A privacy.* event emission (Lock 4)
      gate-resolver.ts                   # replays events into current gate state
  content/
    engagement/
      visibility.ts                      # Page Visibility API, focus, idle (1.A)
      scroll.ts                          # throttled scrollEvents/maxScrollRatio (1.A)
      copy-paste.ts                      # selection.copied/pasted, hash-only default (1.H)
    inject.ts                            # gated injection per privacy.gate
  graph/
    canonical-url.ts                     # utm/fbclid/gclid/srsltid strip; lowercase host (1.B)
    fnv1a.ts                             # 32-bit FNV-1a for tabSessionIdHash etc. (1.B)
    simhash64.ts                         # 64-bit SimHash; Hamming ≤ 3 within 24h (1.H)
    union-find.ts                        # path-compressed UF; deterministic topic ids (1.D)
    topic-id.ts                          # sha256 of canonical URL members (1.D)
    visit-resembles.ts                   # cosine over existing recall embedder (1.C)
    cross-replica.ts                     # visit_observed_on_replica producer (1.E)
    engagement-class.ts                  # rule-based classifier (1.G)
  ui/
    flow-path/                           # (1.J)
    focus-view/                          # (1.J)
    why-related/
      reasons.ts                         # Reason union type and renderer (1.I)
      sort.ts                            # fixed reason-code priority
    context-pack/
      compose.ts                         # deterministic Markdown reducer (1.I)
  reuse/                                 # imports only; no logic
    recall-embedder.ts                   # re-export of multilingual-e5-small embedder
    minisearch-hybrid.ts                 # re-export of existing hybrid retrieval
    test-embedder.ts                     # deterministic test embedder pattern
packages/sidetrack-companion/src/
  producers/
    visit-resembles-revision.ts          # Class E producer (1.C)
    engagement-class-revision.ts         # Class E producer (1.G)
    topic-revision.ts                    # Class E producer (1.D)
  materializers/
    privacy.ts                           # Class A replay (Lock 4)
    cross-replica.ts                     # Class B materialization (1.E)
  sync/
    contract-v1/                         # already in production
```

## Reuse pointers (load-bearing)

Stage 1 must not duplicate or wrap these production components.

1. **The recall embedder.** `multilingual-e5-small` via `@huggingface/transformers`
   (`Xenova/multilingual-e5-small`, pinned HF revision, 384 dims, `query:` /
   `passage:` prefix discipline, dtype cascade, `RECALL_MODEL_MISSING` typed error,
   deterministic test embedder, model-revision-aware stale-index behavior,
   product-owned model cache). Stage 1 uses this for 1.C and *only* 1.C. Do not
   introduce `bge`, `Nomic`, or `EmbeddingGemma`.
2. **The binary recall index V3** at `_BAC/recall/index.bin`. With `modelId`,
   pinned model revision, chunk schema version, schema capabilities, per-entry
   metadata, replica id, Lamport, tombstones, deterministic canonical ordering,
   source-scoped replacement. Stage 1 inserts visit embeddings through this path.
   Do not introduce `sqlite-vec`, `hnswlib`, USearch, or Faiss.
3. **MiniSearch + cosine + RRF hybrid retrieval.** With title/heading/text field
   weights and dotted-identifier tokenization. Stage 1 uses this for the candidate
   set in 1.C and for the `LEXICAL_OVERLAP` reason in 1.I. Keep the existing fixed
   `lexical*0.3 + vector*0.5 + link*0.2` convex combination at threshold `0.55`.
   **Do not introduce a learned ranker (LightGBM / XGBoost / LambdaMART) in Stage 1.**
4. **The deterministic test embedder pattern.** Mirror it for the IndexedDB layer
   (1.F) so tests don't require a real IndexedDB. Mirror it for the Why Related
   ranker (1.I) so the reason-code output is byte-deterministic in tests.
5. **Sync Contract v1.** Class A–F, plugin-only / companion / relay modes,
   replayable materializers. All new event types in 1.A, 1.B, 1.F, 1.H slot into
   the existing Class F edge; all Class B/D/E producers run in companion or in
   plugin-only fallback. No new transport.

## Verification

| Sub-section | Verification |
|---|---|
| 1.A | Engagement events emitted only when the corresponding privacy gate is open; aggregates reproducible from raw observations (replay test). |
| 1.B | Manifest declares `webNavigation`; `onCommitted` payloads carry the full `transitionType` set; `openerVisitId` is `null` (not invented) when opener tab is gone; FNV-1a hashes are stable across runs given the same inputs. |
| 1.C | New visits produce `visit_resembles_visit` only when cosine ≥ T_sim; threshold is configurable; embedder is the existing recall embedder (no second model loaded); Class E revision replaces prior under model revision change. |
| 1.D | `topic_id` is reproduced byte-identically by an independent replica given the same membership; user `in_thread` overrides cosine-only membership; component split/merge produces a `topic.lineage` edge. |
| 1.E | Multi-replica fixture emits exactly one `visit_observed_on_replica` per (visit, replicaId) pair; edge confidence is `'observed'`, not `'inferred'`. |
| 1.F | `chrome.storage.local` usage stays under 5 MB at 10 k synthetic events; IndexedDB buffer flushes at the documented batch size; deterministic test adapter passes the same suite. |
| 1.G | Each rule fires only when its predicate is satisfied; no class is assigned non-deterministically; the `engagement-class:v1:rules` artifact carries the correct `producedBy`. |
| 1.H | Hash-only default is enforced (raw text never appears in any persisted record unless gate open or explicit promote); SimHash Hamming ≤ 3 within 24 h links copy → paste; `snippet_reused_across_threads` only fires at ≥ 2 threads. |
| 1.I | Topic labels equal `representativeTitles[0]` byte-for-byte; reason-code output is byte-identical run-to-run on the same input; Markdown Context Pack is byte-identical run-to-run. |
| 1.J | All four UI surfaces render without any network call to an inference endpoint (asserted by a network-mock that fails the test on any outbound LLM-shaped request). |
| 1.K | The full e2e suite passes against the deterministic test embedder; no neural stub other than that embedder is required. |

## Out of scope (Stage 1)

- Learned ranker for `closest_visit` (Stage 2).
- User-feedback supervised learning loop (Stage 3).
- Debug-pack MCP tool.
- Visual fingerprinting / DOM hash / screenshot perceptual hash.
- HDBSCAN, Leiden, or other centroid-stable clustering.
- SQLite FTS5, sqlite-vec, DuckDB feature store.
- Cross-replica continuation classifier (the inference edge atop 1.E).
- **Local LLM inference of any kind** — Ollama, llama.cpp, MLX runtime, Llama 3.2,
  Qwen 2.5, Phi, Gemma, SmolLM, EmbeddingGemma 300M, Nomic Embed v2.
- New ANN libraries (USearch, hnswlib, Faiss).
- New embedding models (bge, Nomic, EmbeddingGemma) — keep the existing
  `multilingual-e5-small`.
- Optional cloud-LLM prose enhancement (deferred; the Class E revision pattern in
  1.C and 1.I is in place so a future PR can add it as `*-revision:v2:cloud-llm`
  with the user's own API key, additively, without touching the deterministic
  surfaces).

## Work split — major tasks vs Codex subtasks

This PR is large by line count but the work cleanly partitions. The lead (Claude
Code, this session) holds **planning, integration, cross-cutting design, e2e spec
authorship, and PR-body writing**. Codex handles **deterministic, well-scoped code
additions** in parallel batches.

The pattern: lead authors a self-contained subtask brief (file paths + interfaces +
test requirements + acceptance criteria); user spins Codex with that brief; Codex
delivers; lead integrates and reviews. Multiple subtasks run in parallel when their
dependencies allow.

### Subtask dependency graph

```
S1 confidence enum + dashed CSS  ───┬── (independent, no deps)
S2 payloadVersion + dimensions   ───┘
S3 producedBy union extension    ─── depends on S1+S2
S4 privacy events (Class A)      ─── depends on S2
S5 IndexedDB event buffer (C6)   ─── depends on S2
                                                ↓
S6 webNavigation listeners (1.B) ─── depends on S2,S5
S7 engagement content script (1.A) ─ depends on S2,S5,S4
S8 copy/paste content script (1.H) ─ depends on S2,S5,S4
                                                ↓
S9  visit_resembles_visit (1.C)  ─── depends on S3,S6 (visits exist)
S10 union-find topic clusterer (1.D) ─ depends on S9 (similarity edges exist)
S11 visit_observed_on_replica (1.E) ─ depends on S6
S12 engagement classifier (1.G)  ─── depends on S7,S8 (engagement + lineage)
                                                ↓
S13 deterministic templates (1.I) ── depends on S10,S11,S12 (everything resolved)
S14 UI surfaces (1.J)            ─── depends on S13
                                                ↓
S15 e2e spec (1.K)               ─── depends on all of the above (lead-authored)
S16 docs                         ─── depends on S15 (lead-authored)
```

Two parallel waves possible:

- **Wave A** (S1 / S2 / S4 / S5) — locks + privacy events + storage substrate. Four
  Codex tasks, no inter-dependencies.
- **Wave B** (after Wave A lands) — S6 / S7 / S8 in parallel; S3 in parallel.
- **Wave C** — S9 / S10 / S11 / S12 in parallel.
- **Wave D** — S13 / S14 sequentially (lead-led integration).

### Subtask briefs (for Codex)

Each subtask is a self-contained brief Codex can execute. Lead writes the brief; user
spins Codex; user notifies lead on completion; lead integrates.

**S1 — Confidence enum + dashed CSS rendering** (Lock 1).
- Files: `packages/sidetrack-companion/src/connections/types.ts`,
  `packages/sidetrack-extension/entrypoints/sidepanel/style.css`,
  `packages/sidetrack-extension/src/sidepanel/connections/ConnectionsView.tsx`.
- Extend `ConnectionEdge.confidence` to `{'asserted' | 'observed' | 'inferred'}`.
- Migrate every existing edge stamp: user-entered → `'asserted'`, event-derived →
  `'observed'`, similarity / clustering → `'inferred'`.
- Add CSS rule `.confidence-inferred { stroke-dasharray: 4 2; opacity: 0.7; }` for
  the orbital SVG; analogous rule for the linked-panels view's edge lines.
- Update `connections/snapshot.test.ts` for the new enum.
- Acceptance: every edge in every existing test fixture maps cleanly to one of the
  three values. No existing test reports false confidence.

**S2 — `payloadVersion` + `dimensions` extension slot** (Lock 2).
- Files: every event-type interface under
  `packages/sidetrack-companion/src/{threads,workstreams,timeline,dispatches,annotations,queue,recall}/events.ts`
  + extension-side `packages/sidetrack-extension/src/timeline/events.ts`.
- Add `payloadVersion?: number` (default 1) and `dimensions?: Record<string, unknown>`
  to every event payload.
- Augment `ContractEntry` (`packages/sidetrack-companion/src/sync/contract/registry.ts:72-75`)
  with `currentPayloadVersion?: number`; stamp every entry. Registry coverage test
  asserts presence.
- Loosen runtime predicates (`isBrowserTimelineObservedPayload` etc.) to accept any
  `payloadVersion >= 1` and any `dimensions` shape.
- Acceptance: existing event log replays without modification; new optional fields
  are visible to producers but cause no test failures.

**S3 — `producedBy` provenance union extension** (Lock 3).
- Files: `packages/sidetrack-companion/src/connections/types.ts`.
- Extend `ConnectionEdge.producedBy` union with the new variants:
  - `{ source: 'visit-similarity'; revisionId: string }`
  - `{ source: 'topic-clusterer'; revisionId: string }`
  - `{ source: 'engagement-classifier'; revisionId: string }`
  - `{ source: 'snippet-lineage'; revisionId: string }`
  - `{ source: 'cross-replica' }` (no revisionId — deterministic)
- Existing variants (`'event-log'`, `'vault'`, `'timeline-projection'`) unchanged.
- Acceptance: type-checker accepts both old and new variants; no runtime change yet
  (downstream subtasks consume).

**S4 — Privacy events as Class A facts** (Lock 4).
- Files: `packages/sidetrack-companion/src/privacy/events.ts` (NEW),
  `packages/sidetrack-companion/src/privacy/projection.ts` (NEW),
  `packages/sidetrack-companion/src/privacy/projection.test.ts` (NEW),
  `packages/sidetrack-companion/src/sync/contract/registry.ts` (register).
- Event types: `privacy.gate.flipped`, `privacy.permission.granted`,
  `privacy.permission.revoked`. Schemas per § 1.F.
- Class B projection: replays events into current gate state; supports retroactive
  masking when `retroactiveMask: true` on revoke.
- Migration shim: SW-boot reads existing `chrome.storage.local['sidetrack.timeline.enabled']`,
  emits a `privacy.gate.flipped` event if no privacy events exist yet.
- Acceptance: gate flip drops subsequent observations from derived caches; cross-
  replica revoke replays correctly.

**S5 — IndexedDB Class F event buffer** (C6).
- Files: `packages/sidetrack-extension/src/background/storage/indexeddb-event-buffer.ts`
  (NEW), `packages/sidetrack-extension/src/background/storage/flush-scheduler.ts`
  (NEW), unit tests.
- Append-only event store keyed by `(streamName, lamport, replicaId)`.
- Batched writes ≤ 100 items / ≤ 1 s.
- `chrome.alarms`-driven flush at 60 s minimum.
- Deterministic in-memory adapter behind the same interface for tests.
- Manifest gains `unlimitedStorage`.
- Acceptance: 10 k-event drive-test passes; in-memory adapter passes the same
  contract tests as the IndexedDB adapter.

**S6 — webNavigation listeners + canonical URL + FNV-1a** (1.B).
- Files: `packages/sidetrack-extension/src/background/listeners/web-navigation.ts`,
  `packages/sidetrack-extension/src/background/listeners/tabs.ts`,
  `packages/sidetrack-extension/src/graph/canonical-url.ts`,
  `packages/sidetrack-extension/src/graph/fnv1a.ts`,
  `packages/sidetrack-extension/wxt.config.ts` (manifest add `webNavigation`).
- Wire `chrome.webNavigation.onCommitted` → `navigation.committed` Class F event.
- `tabs.onCreated` opener resolution with explicit `null` fallback when opener gone.
- FNV-1a 32-bit for `tabSessionIdHash` / `windowSessionIdHash`.
- Canonical URL normalizer (utm / fbclid / gclid / srsltid / lowercase host /
  default port / fragment drop).
- Acceptance: causal-spine scenario in 1.K passes against this listener stack.

**S7 — Engagement content script (1.A) + dynamic registration**.
- Files: `packages/sidetrack-extension/src/content/engagement/{visibility,scroll}.ts`,
  `packages/sidetrack-extension/src/content/inject.ts`, runtime-message handler.
- Counts + durations only; no event payloads, no clipboard polling.
- Periodic 30 s sub-emit + final emit on `visibilitychange` / `pagehide` /
  `beforeunload`.
- SW per-tab cache with `chrome.tabs.onRemoved` derivation for crash-safety.
- Dynamic registration via `chrome.scripting.registerContentScripts` gated on
  privacy projection (depends on S4).
- Acceptance: engagement-classification scenario in 1.K passes; privacy-revocation
  scenario passes.

**S8 — Copy/paste content script + simhash + 24h matching** (1.H).
- Files: `packages/sidetrack-extension/src/content/engagement/copy-paste.ts`,
  `packages/sidetrack-extension/src/graph/simhash64.ts`,
  `packages/sidetrack-companion/src/snippets/{events,projection}.ts` (NEW).
- `selection.copied` / `selection.pasted` event types per § 1.H.
- SHA-256 selectionHash; 64-bit SimHash; selection normalization (whitespace
  collapse, chrome strip, timestamp drop).
- Reducer: 24-hour window, exact hash match OR Hamming-≤3 simhash match.
- Edge emission: `snippet_copied_from_visit`, `snippet_pasted_into_*`,
  `snippet_reused_across_threads`.
- Acceptance: snippet-lineage scenario in 1.K passes; raw text never appears in
  persisted record (`grep` assertion).

**S9 — `visit_resembles_visit` producer** (1.C).
- Files: `packages/sidetrack-extension/src/graph/visit-resembles.ts`,
  `packages/sidetrack-companion/src/producers/visit-resembles-revision.ts` (NEW),
  unit tests.
- Reuses existing recall embedder + binary recall index V3.
- Top-K=50 candidates via existing hybrid retrieval; cosine ≥ 0.85 cutoff.
- Class E revision artifact `visit-resembles:v1:cosine`.
- Acceptance: topic-formation scenario in 1.K finds expected similarity edges; no
  new vector store added (manifest grep).

**S10 — Union-Find topic clusterer + `topic.lineage`** (1.D).
- Files: `packages/sidetrack-extension/src/graph/union-find.ts`,
  `packages/sidetrack-extension/src/graph/topic-id.ts`,
  `packages/sidetrack-companion/src/producers/topic-revision.ts` (NEW), unit tests.
- Path-compressed Union-Find.
- Content-derived `topic_id = "topic:" + sha256(sorted_canonical_urls).slice(0,16)`.
- User `in_thread` overrides cosine-only membership.
- `topic.lineage` Class B edge on split/merge with `succeededBy` pointers.
- Acceptance: topic-id reproduced byte-identically by independent replica given
  the same membership.

**S11 — `visit_observed_on_replica` producer** (1.E).
- Files: `packages/sidetrack-companion/src/materializers/cross-replica.ts` (NEW),
  unit tests.
- Pure reducer over merged event log: same canonical URL on multiple replicas →
  evidence edge with `confidence: 'observed'`.
- Acceptance: cross-replica scenario in 1.K passes.

**S12 — Engagement classifier ruleset** (1.G).
- Files: `packages/sidetrack-extension/src/graph/engagement-class.ts`,
  `packages/sidetrack-companion/src/producers/engagement-class-revision.ts` (NEW),
  unit tests.
- Pure reducer per § 1.G rule table.
- Class E revision `engagement-class:v1:rules`.
- Acceptance: 7-class boundary tests pass; revision id stable.

**S13 — Deterministic templates** (1.I).
- Files: `packages/sidetrack-extension/src/ui/why-related/{reasons.ts,sort.ts}`
  (NEW), `packages/sidetrack-extension/src/ui/context-pack/compose.ts` (NEW),
  topic-label helper, unit tests.
- `Reason` union per § 1.I; fixed-priority sort.
- Topic-label = top member by `focusedWindowMs`.
- Context Pack = pure Markdown reducer; "Open Questions" extracted only.
- Acceptance: byte-deterministic outputs on the same inputs (run-to-run); no
  network calls.

**S14 — UI surfaces** (1.J).
- Files: `packages/sidetrack-extension/src/sidepanel/connections/{FlowPathView,FocusView,WhyRelatedPanel,ContextPackComposer}.tsx`
  (NEW), `connectionsClient.ts` extension.
- All four surfaces render deterministically; no LLM endpoints; no outbound
  network calls for inference.
- Network-mock test: any outbound `*ollama*` / `*openai*` / `*completions*`
  request fails the build.
- Acceptance: all four surfaces visible in the e2e (1.K).

**S15 — Browser e2e** (1.K). **Lead-authored.**
- File: `packages/sidetrack-extension/tests/e2e/connections-mvp-user-story.spec.ts`
  (NEW).
- 7 scenarios per § 1.K.
- Network-mock asserts no outbound LLM-shaped requests.

**S16 — Documentation.** **Lead-authored.**
- Files: `docs/timeline.md`, `docs/architecture.md` (NEW or extend).
- Document the engagement / provenance / lineage privacy posture.
- Document the two-tier edge model + Class A-F roles.
- Document the C6 IndexedDB decision.

### Codex hand-off protocol

1. Lead writes a subtask brief (above format) and pastes it into a chat with the user.
2. User spins Codex on that brief.
3. Codex delivers code; user signals lead "S6 done" (or similar).
4. Lead reviews the diff, integrates, runs tests, and either marks the subtask
   complete or returns it to user with corrections.
5. Subtasks in the same wave run in parallel; subtasks across waves serialize on
   the dependency graph above.

The lead never holds the implementation queue alone — every subtask brief is small
enough that Codex can execute it in one batch, and the lead's role is brief
authorship + integration review, not direct coding.

## The most important design principle

> **Facts are event-sourced. Interpretations are versioned. Suggestions are
> explainable. User organization is authoritative. No inference requires GPU /
> Apple-Silicon hardware.**

Every Stage 2-3 PR must preserve this. Every line of code in this PR (locks 1-4 +
Stage 1.A-K) is what makes it preservable.
