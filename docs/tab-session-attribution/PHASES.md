# Tab-Session Attribution v1 — Phased Delivery

This document is the load-bearing contract between Claude (lead) and the worker (Codex) for the five-PR delivery of Tab-Session Attribution v1. Each phase is an independent PR. The PRD this implements is the steady-kindling-kay plan; the per-PR phases below are the *implementation surgery* that maps the PRD onto the existing Sync Contract.

## Architectural ground rules (read first, every phase)

These rules apply to every phase. The reviewer's blockers — they exist because v0 of the plan would have built parallel infrastructure that fights existing code.

1. **No parallel event-log architecture.** The PRD's "ObservedEvents / UserAssertions / InferredOpinions" split is *semantic*, not physical. Map onto the existing Sync Contract:
   - Observed facts → existing **Class F** browser/navigation/timeline events; **Class B** projections.
   - User assertions → existing **Class A** `user.organized.item` and friends in `packages/sidetrack-companion/src/feedback/`.
   - Inferred opinions → **Class E** revision artifacts + local audit; **not** canonical synced facts.
2. **Reuse `user.organized.item` for tab-session attribution.** Extend `UserOrganizedItemKind` with `'tab-session'` (and later `'tab-group-link'`). Do **not** create a new `TabAttributedToWorkstream` event family — it would bypass the existing feedback projection and ranker retraining.
3. **Tab-session ID enters via `browser.timeline.observed`.** Add `tabSessionId?: string` to `BrowserTimelineObservedPayload`. Do **not** add a new observation bus.
4. **Stop using `activeWorkstreamId` as visit attribution truth.** It is a *default for new captures/dispatches*, not the answer to "which workstream does this tab belong to."
5. **No new HTTP endpoints, schemas, or routes outside what each phase explicitly authorizes.** Specifically: no `/v1/observed/events` or `/v1/asserted/events` — those are PRD vocabulary, not implementation.
6. **MV3 service-worker dormancy: use the existing 1-minute drain alarm.** Do not add a 30-second alarm or per-tab keepalive ports unless replay diagnostics prove missed boundary events. The existing buffer + drain pattern in `packages/sidetrack-extension/src/timeline/wiring.ts` already handles the realistic case.
7. **HDBSCAN is optional.** Cluster evidence is consumed if `topic_in_workstream` exists in the Connections snapshot; otherwise the resolver runs without it. Do not add `hdbscan-ts` as a critical-path dependency.
8. **Tab groups are Phase 5, not bundled into earlier phases.** Auto-apply / Inbox / resolver must work without tab groups.
9. **T1/L5 replay rebuild mode.** For evaluation, packs must be re-runnable to materialize tab-session attribution from observations + assertions; production upgrades remain "fresh state on upgrade" (no backfill of historical active-pointer attributions).

---

## Phase 1 — Tab-session identity through `browser.timeline.observed`

**Branch:** `feat/tab-session-attribution-phase-1` (already created off main).

**Goal.** Establish `tabSessionId` as a first-class field on the existing observation event, add a tab-session boundary state machine in the extension, persist `tabSessionId` through the timeline projection, and stop writing `workstreamId` at observation time. After this phase, the Connections graph stops emitting `visit_in_workstream` from the active-pointer stamp; it emits nothing yet — Phase 2 wires the tab-session attribution.

**Worker prompt.**

> Implement Phase 1 of `docs/tab-session-attribution/PHASES.md` on branch `feat/tab-session-attribution-phase-1`. Read the architectural ground rules; do not deviate. Keep this PR small.
>
> 1. **Companion (`packages/sidetrack-companion/`):**
>    - Add `tabSessionId?: string` to `BrowserTimelineObservedPayload` in `src/timeline/events.ts` (payload version stays the same; this is an additive optional field — Sync Contract v1 backwards-compatible).
>    - Thread `tabSessionId` into `TimelineEntry` via `src/timeline/projection.ts`. Last-write-wins semantics; existing entries without `tabSessionId` stay unattributed.
>    - In `src/connections/snapshot.ts`: add new node kind `tab-session` (`{ kind: 'tab-session', key: tabSessionId, label: ... }`) and new edge kinds `visit_in_tab_session` (timeline-visit → tab-session) and `tab_session_opener_chain` (child tab-session → parent tab-session, when an opener is recorded). Emit them from the timeline projection. **Do not** emit `tab_session_in_workstream` or `visit_in_workstream` from these — Phase 2 owns that wiring.
>    - In Pass 3 of `snapshot.ts`: stop reading `entry.workstreamId` for the `visit_in_workstream` edge. Comment the old code out with a `// PHASE 2:` marker rather than deleting (Phase 2 will replace it). **No new `visit_in_workstream` edges should be emitted in this phase.**
> 2. **Extension (`packages/sidetrack-extension/`):**
>    - Create `src/tabsession/idMint.ts` minting `tses_<crockford32-ulid>`. Extract the ULID encoder from `tests/e2e/helpers/recordReplay.ts:createSessionId` into a shared helper if straightforward; otherwise inline the same algorithm.
>    - Create `src/tabsession/storage.ts` with chrome.storage.local helpers for a `byTabIdHash` map: `{ tabSessionId, openedAt, lastActivityAt, idleSince? }`. Survives SW restarts.
>    - Create `src/tabsession/boundary.ts` with the v1 boundary state machine: hard stops on `chrome.tabs.onRemoved`, `chrome.windows.onRemoved`, explicit move gesture (callable from Phase 3), and provider-thread-id change in known AI hosts. Soft close on `idle ≥ 15min AND embedding-drift ≥ 0.4` — at this phase the embedding-drift dependency is **not yet wired**, so document and gate that branch behind a feature flag (default off). Idle uses `chrome.idle.onStateChanged` and the existing 1-minute drain alarm — **no new 30-second alarm**.
>    - Modify `src/timeline/wiring.ts`:
>      - Stop reading `cachedActiveWorkstreamId` for stamping observations. The observer must NOT include `workstreamId` in `browser.timeline.observed` payloads it emits.
>      - Resolve the active `tabSessionId` from the boundary state machine on every observation; include it in the payload.
>      - On `chrome.tabs.onRemoved` / `onCreated` / `onActivated`: invoke the boundary state machine.
> 3. **Sync Contract registry (`src/sync/contract/registry.ts`):** No new event types in this phase. Confirm `browser.timeline.observed` remains Class F.
> 4. **Tests:**
>    - Unit test `boundary.ts` deterministically: cover hard stops, idle progression, session reopen on activity within idle window.
>    - Unit test `projection.ts` to assert `tabSessionId` threads correctly into `TimelineEntry`.
>    - Snapshot test `snapshot.ts`: confirm new node/edge kinds appear and `visit_in_workstream` no longer appears for active-pointer-only attribution. (Use a synthetic `EventLog` fixture.)
>    - Re-run T1 manual replay if available locally; expected behavior is **no `visit_in_workstream` edges in the rebuilt graph** (visits are unattributed). This is the intended regression — Phase 2 restores edges from a different source.
> 5. **Type & test gates:** `npx tsc --noEmit -p tsconfig.json` clean across both packages; `npm run test` (companion + extension) green.
> 6. **Commit message:** `feat(tabsession): phase 1 — tabSessionId on browser.timeline.observed + boundary state machine` with the standard `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` trailer.
> 7. Push the branch and announce `READY` in the PR description.

**Acceptance criteria (lead must verify before merging).**

- All new observed visits carry `tabSessionId` in their payload; no observation includes `workstreamId`.
- `Connections` snapshot rebuilds emit zero `visit_in_workstream` edges sourced from the active-pointer stamp.
- `tab-session` node + `visit_in_tab_session` + `tab_session_opener_chain` edges appear in the rebuilt graph.
- `npx tsc --noEmit` and `npm run test` clean.
- T1 replay shows visits as unattributed (the intended regression). Document the diff vs baseline in the PR description.
- No `tabGroups` permission, no new HTTP routes, no new event types.

---

## Phase 2 — User assertions via `user.organized.item` + tab-session projection

**Branch:** `feat/tab-session-attribution-phase-2` (created from `main` after Phase 1 lands).

**Goal.** Wire user-explicit attribution. Extend the existing Class A `user.organized.item` event family with a new `itemKind: 'tab-session'`. Build the tab-session projection that joins Class F observations + Class A assertions. Add the three HTTP helpers. Connections snapshot now emits `tab_session_in_workstream` and `visit_in_workstream` derived through the tab-session projection.

**Worker prompt.**

> Implement Phase 2 of `docs/tab-session-attribution/PHASES.md` on branch `feat/tab-session-attribution-phase-2`. Phase 1 is on main. Read ground rules.
>
> 1. **Extend `user.organized.item` (Class A).**
>    - In `packages/sidetrack-companion/src/feedback/events.ts` (or wherever the union type lives): add `'tab-session'` and `'tab-group-link'` to `UserOrganizedItemKind`. The latter is reserved for Phase 5; payload validation accepts it but no consumer yet.
>    - Action vocabulary stays the existing one (`'move' | 'reject' | 'split' | 'merge' | ...`). For tab-session attribution: `move` carries `{ fromWorkstreamId, toWorkstreamId | null }`. `null` toWorkstreamId encodes "dismiss to inbox."
> 2. **Tab-session projection.**
>    - Create `packages/sidetrack-companion/src/tabsession/projection.ts` (folder is new). Pure fold over the existing event log; consumes `browser.timeline.observed` (Class F) for `(tabSessionId, openedAt, openerTabSessionId)` and `user.organized.item` with `itemKind: 'tab-session'` (Class A) for current attribution.
>    - Output type: `TabSessionProjection { bySessionId: Map<...>, openSessionsByTabId: Map<...> }`. Each `TabSessionRecord` carries `currentAttribution?: { workstreamId | null, source: 'user_asserted', observedAt, clientEventId }` plus an append-only `attributionHistory`. Class A is the only allowed source in this phase; inferred attribution is Phase 4.
>    - Reducer rule: latest `user.organized.item` for that `tabSessionId` wins. No multi-class precedence yet.
>    - `projection.test.ts` covers determinism under shuffled events, idempotent re-runs, frozen-on-close behavior.
> 3. **HTTP endpoints.**
>    - Extend `packages/sidetrack-companion/src/http/server.ts`:
>      - `GET /v1/tabsessions/projection` → returns the projection.
>      - `GET /v1/tabsessions/inbox?limit&offset` → derived view of sessions where `currentAttribution` is null or absent. Sort by recency. No EVOI ranking yet (Phase 3 stub).
>      - `POST /v1/tabsessions/{tabSessionId}/attribute` → convenience wrapper that emits `user.organized.item` with `itemKind: 'tab-session'`, `action: 'move'`, body `{ workstreamId: string | null }`. Reuses the existing `requireIdempotencyKey` + `runIdempotent` + `appendClient` pattern from privacy projection.
>    - Mirror the privacy projection's response shape: `{ accepted, projection }` for POST.
> 4. **Connections snapshot integration.**
>    - In `packages/sidetrack-companion/src/connections/snapshot.ts`: extend `ConnectionsInput` with `tabSessionProjection: TabSessionProjection`.
>    - In Pass 3 (the `// PHASE 2:` marker from Phase 1): replace the disabled active-pointer-stamp read with a tab-session-projection read. For each timeline entry with a `tabSessionId`, look up the session's `currentAttribution`. If present and `workstreamId !== null`, emit a `visit_in_workstream` edge. Add a new `tab_session_in_workstream` edge from the tab-session node to the workstream node (one per session with attribution).
>    - Edge metadata records `attributionSource: 'user_asserted'` (this is the only source in Phase 2).
> 5. **Side panel (`packages/sidetrack-extension/entrypoints/sidepanel/App.tsx`):**
>    - Update the existing thread drag-to-pill handler to include tab-session drag-to-pill (when a tab-session card is dragged onto a workstream pill, POST `/v1/tabsessions/{id}/attribute`). Light wiring only — full Inbox UI is Phase 3.
>    - **Do not** introduce the Inbox tab yet (Phase 3).
> 6. **Tests.**
>    - Unit tests for the projection.
>    - Integration test posting `user.organized.item` with `itemKind: 'tab-session'` and asserting the projection updates.
>    - Snapshot test confirming `tab_session_in_workstream` and `visit_in_workstream` edges materialize from a tab-session attribution.
> 7. **Type & test gates** + commit message `feat(tabsession): phase 2 — user.organized.item itemKind='tab-session' + projection` with co-author trailer.

**Acceptance criteria.**

- `user.organized.item` with `itemKind: 'tab-session'` validates, persists, and rebuilds the projection deterministically.
- POST `/v1/tabsessions/{id}/attribute` updates the projection within the same request cycle.
- Connections graph shows `visit_in_workstream` edges *only* for tabs that have a Class A attribution; visits without one stay unattributed (no fallback to active pointer).
- Drag-to-pill of a tab-session card emits the assertion and the graph updates within the snapshot rebuild + 30s cache.
- T1 replay against a fixture pack with a synthetic Class A attribution shows the expected `visit_in_workstream` edges.

---

## Phase 2 Carryover — storage concurrency + same-URL multi-session test

**Branch:** `feat/tabsession-phase-2-carryover` (off main).

**Goal.** Address two risks flagged in the post-merge review of PR #127 (Phase 2). They were not in the Phase 2 PR; they must land **before Phase 5** because Phase 5's tab-group event listeners will create concurrent `chrome.tabs` callsites that worsen the storage race.

**Worker prompt.**

> Implement Phase 2 Carryover on branch `feat/tabsession-phase-2-carryover` (off main). Two changes in one PR.
>
> 1. **Fix storage concurrency in `packages/sidetrack-extension/src/tabsession/storage.ts`.**
>    Current `set()` and `remove()` do non-atomic read-all → modify → write-all on the single `byTabIdHash` chrome.storage key. Concurrent `chrome.tabs.onCreated` events can lose updates: A reads {}, B reads {}, A writes {A}, B writes {B} → A is lost.
>    Fix with one of (recommended first):
>    - In-memory single-flight serialized write queue. Mirrors the atomic-reinit-message pattern from PRs #122/#124/#125.
>    - Per-tab storage keys (one chrome.storage entry per `tabIdHash`).
>    - Compare-retry loop (read; if mutated since read, retry).
>
>    Add a unit test covering the race: fire two `set()` calls without `await`, then assert both records persist:
>    ```ts
>    // packages/sidetrack-extension/tests/unit/tabsession/storage.test.ts
>    it('concurrent set("tab-a") and set("tab-b") preserves both records', async () => {
>      const storage = createChromeTabSessionStorage(/* ... */);
>      await Promise.all([storage.set('tab_a', recordA), storage.set('tab_b', recordB)]);
>      const all = await storage.readAll();
>      expect(all).toMatchObject({ tab_a: recordA, tab_b: recordB });
>    });
>    ```
>
> 2. **Add same-canonical-URL-across-two-tabSessionIds test** to `packages/sidetrack-companion/src/tabsession/projection.test.ts` (and/or `packages/sidetrack-companion/src/connections/snapshot.test.ts`):
>    ```ts
>    it('same canonicalUrl observed in two tabSessionIds → projection contains both sessions; attribution of session A does not attribute session B', () => {
>      // Observe https://copy.fail under tses_a, then again under tses_b
>      // user.organized.item itemKind='tab-session' move tses_a → ws_security
>      // expect projection.bySessionId has both tses_a and tses_b
>      // expect tses_b.currentAttribution is undefined
>      // expect snapshot has visit_in_workstream edge ONLY for visits in tses_a
>    });
>    ```
>    Without this test the URL-aggregate lossiness regression flagged in the PR #126 review can pass silently.
>
> 3. **Type & test gates** + commit message `fix(tabsession): phase 2 carryover — storage concurrency + multi-session URL test` with co-author trailer.

**Acceptance criteria.**

- `npx tsc --noEmit` clean across both packages.
- `npm run test` green: companion + extension.
- Storage concurrency test (a) passes; the underlying fix is one of the three approved patterns above.
- Multi-session URL test (b) passes and demonstrates per-session attribution isolation.
- Both items in **one PR**.

---

## Phase 3 — Inbox / manual attribution UX

**Branch:** `feat/tab-session-attribution-phase-3`.

**Goal.** Make the Inbox the cold-start product surface. Binary yes/no decisions, AttributionBadge, provenance shell (no resolver yet, so provenance is "user-asserted" or "no attribution"), workstream pill copy clarifying intent vs focused-tab attribution. Hard cap at 50 cards/session.

**Worker prompt.**

> Implement Phase 3 of `docs/tab-session-attribution/PHASES.md` on branch `feat/tab-session-attribution-phase-3`.
>
> 1. **Inbox view (`packages/sidetrack-extension/src/sidepanel/tabsession/`):**
>    - `InboxView.tsx`: new top-level tab in the side panel labelled `Inbox (N)`. Reads `/v1/tabsessions/inbox`.
>    - `InboxCard.tsx`: per-card UI per the PRD. At this phase no resolver exists, so the card just shows favicon, title, host, "Move to" workstream picker, "Not in any workstream" (dismiss → POST attribute with `workstreamId: null`), and "Different…" picker.
>    - 50-card hard cap per panel-open; "Take a break — review more later." sentinel.
>    - `inboxPriority.ts`: stub. Sort by recency; mark TODO for Phase 4 EVOI integration.
> 2. **Per-tab attribution badge (`AttributionBadge.tsx`):**
>    - Solid pill (workstream color) for `user_asserted` non-null.
>    - Grey "?" pill for null/missing attribution (Inbox state).
>    - No outlined-pill variant yet — it activates in Phase 4 when inferred attribution exists.
> 3. **Provenance overlay (`AttributionProvenance.tsx`):**
>    - Shell only. For `user_asserted` show "Attributed by you on {date}." For null show empty state.
> 4. **Pill strip semantics (`entrypoints/sidepanel/App.tsx`):**
>    - The existing pill strip click already sets the intent pointer (via `setCurrentWs` → `chrome.storage.local['sidetrack.activeWorkstreamId']`). Add a small inline cue near the URL bar: `Tab is in: <pill>` showing the *focused* tab's tab-session attribution. If different from the active pointer, both are shown to close the cognitive gap.
>    - No new event types here.
> 5. **Per-workstream tab-session list:**
>    - Inside any workstream view, add a "Tabs in this workstream (N)" section listing currently-open tab sessions with attribution to that workstream. Drag a card to a different pill triggers explicit re-attribution (reuses Phase 2's POST helper).
> 6. **Tests.**
>    - Component tests for `InboxCard` (yes/no/different actions).
>    - Manual smoke documented in the PR description: open 5 unrelated tabs, confirm Inbox shows them; assign one; confirm `visit_in_workstream` edge appears; reopen panel; confirm 50-card cap.
> 7. Commit message `feat(tabsession): phase 3 — Inbox + AttributionBadge + provenance shell` with co-author trailer.

**Acceptance criteria.**

- Inbox tab renders, shows unattributed sessions, accepts yes/no/different decisions, and updates the projection.
- Pill-strip cue shows focused-tab attribution distinct from active-pointer.
- 50-card cap enforced per panel session.
- AttributionBadge solid/grey variants render correctly.
- No regressions in existing thread / workstream UI.
- No new event types or HTTP routes (everything reuses Phase 2's POST helper).

---

## Phase 4 — Resolver dry-run (read-only suggestions)

**Branch:** `feat/tab-session-attribution-phase-4`.

**Goal.** Build the calibrated graph-attribution engine as a *read-only* surface. Signed PPR + similarity + (optional) cluster evidence + log-linear NB fusion + score-margin abstention. Exposed only via `GET /v1/tabsessions/{id}/resolve?dryRun=true`. **No event writes from this phase** — the resolver returns candidates + reasons; the side panel may render them as suggestions.

**Worker prompt.**

> Implement Phase 4 of `docs/tab-session-attribution/PHASES.md` on branch `feat/tab-session-attribution-phase-4`.
>
> 1. **Typed evidence-graph adapter.** Create `packages/sidetrack-companion/src/tabsession/evidenceGraph.ts`. Wraps the Connections snapshot into a `graphology` instance with typed-edge weights from `edgePriors.ts` (also new; documented priors per the PRD). One adapter, multiple consumers.
> 2. **Signed PPR (`tabsession/causalPpr.ts`).** Hand-rolled power-iteration over `graphology` with the personalization vector. Signature: `runPPR(graph, seedVector: Map<NodeId, number>, alpha = 0.15, tol = 1e-6, maxIter = 50): Map<NodeId, number>`. Cache per `(tabSessionId, graphRevision, seedHash)` for 5 min. Iteration cap and timeout are mandatory. **Candidate-only seeding**: only run PPR for workstreams reachable from local graph anchors of the target session — full-graph PPR per workstream is the fallback, not the default. Negative seeds: `score = PPR(S⁺) − γ·PPR(S⁻)` with `γ = 0.5`. Negative anchors: `user.flow.rejected` events + dismissals + (Phase 5) tab-group pull-outs.
> 3. **Similarity generator (`tabsession/similarity.ts`).** Reuses existing `generateCandidates` + `predictRanker` from `packages/sidetrack-companion/src/ranker/`. Per workstream: `simTopScore`, `simMeanScore`, `simAgreement`, `simMargin`. K=10.
> 4. **Cluster evidence (`tabsession/clusterEvidence.ts`).** **Optional.** If the Connections snapshot has `topic_in_workstream` edges, consume them as a Bayesian-smoothed cluster posterior with `minSupport = 3` and Laplace-α = 1. If not, return empty. Do **not** add `hdbscan-ts` as a critical-path dependency in this phase.
> 5. **Fusion (`tabsession/fusion.ts`).** Log-linear NB with hand-set log-LRs. The default weights are documented in code comments (per PRD); they are priors, not learned values. Output `rawFusionLogit(W)` per candidate.
> 6. **Abstention (`tabsession/policy.ts` + decision rule in `resolver.ts`).** Score-margin + corroboration-count abstention. **No conformal, no Beta calibration in this phase** — those are deferred behind label-count triggers. Three policy modes (conservative/balanced/aggressive) pulled from PRD; only the score-margin / corroboration / engagement / source-allowlist gates apply.
> 7. **Resolver orchestrator (`tabsession/resolver.ts`).** Top-level `resolveAttribution(input): ResolutionResult`. Pure function. Returns `fusedCandidates`, dominant source per top candidate, abstention decision (`auto-apply | suggest | inbox`), and a `reasons` blob for the provenance UI.
> 8. **HTTP endpoint.** `GET /v1/tabsessions/{id}/resolve?dryRun=true` runs the resolver and returns the result. **No POST**. **No event writes** from this resolver path. The Inbox UI from Phase 3 can call this endpoint to render top-3 suggestions + provenance, but `Inbox` cards still require an explicit user action to attribute.
> 9. **Dependency tracker (`tabsession/dependencyTracker.ts`).** `ResolverDependencyKey` cache + invalidation queue. Event-driven (graphRevision / rankerRevision / topicRevision / feedbackRevision / modelRevision changes). Resolver runs lazy on `dryRun=true` request; the queue exists but no daemon yet.
> 10. **Provenance overlay (`AttributionProvenance.tsx`):** activate the inferred-source variant. When the resolver returns a candidate, the side panel shows the dominant source + top-3 contributing anchors + score margin. `AttributionBadge` outlined-pill variant activates here for sessions where Phase 3 user-attribution is absent but a strong suggestion exists.
> 11. **SuggestionBanner (`SuggestionBanner.tsx`):** non-modal banner at panel top when ≥1 open session has `action: 'suggest'`. Yes / No / Different actions emit `user.organized.item` (Phase 2's path), not new events.
> 12. **Tests.**
>     - PPR convergence test on a 50-node fixture graph.
>     - Cluster posterior test with smoothing + min-support.
>     - Fusion test on a 5-candidate fixture.
>     - Resolver e2e test: feed a synthetic `ConnectionsInput` + Class A history; assert action and reasons.
>     - Replay test against a T1 pack (or fixture if no pack handy): assert resolver emits at least one auto-apply candidate for a strong-causal session.
> 13. Commit message `feat(tabsession): phase 4 — signed PPR + log-linear fusion + dry-run resolver` with co-author trailer.

**Acceptance criteria.**

- `GET /v1/tabsessions/{id}/resolve?dryRun=true` returns explainable candidates without writing events.
- PPR converges deterministically; cache is keyed correctly; iteration cap enforced.
- Cluster evidence is optional (resolver runs cleanly with `topic_in_workstream` absent).
- No HDBSCAN dependency added.
- Suggestion banner + outlined-pill badge render when the resolver suggests; user actions still flow through Phase 2's `user.organized.item` path.
- No new HTTP write paths; no auto-apply yet.

---

## Phase 5 — Chrome tab groups + auto-apply policy

**Branch:** `feat/tab-session-attribution-phase-5` (already pushed off main).

**Prerequisite:** Phase 2 Carryover must be merged before Phase 5 starts. Phase 5's `chrome.tabs.onUpdated(changeInfo.groupId)` listeners will create concurrent storage callsites that worsen the unfixed `byTabIdHash` race.

**Goal.** Bidirectional Chrome tab-group integration as a feedback surface, durable `TabGroupLink` identity decoupled from Chrome's volatile group ids, and the auto-apply policy gate (gated on telemetry from Phases 1–4).

**Worker prompt.**

> Implement Phase 5 of `docs/tab-session-attribution/PHASES.md` on branch `feat/tab-session-attribution-phase-5`.
>
> 1. **Manifest:** add `'tabGroups'` to `permissions` in `wxt.config.ts`.
> 2. **Tab-group wiring (`packages/sidetrack-extension/src/tabgroups/`):**
>    - `wiring.ts`: subscribe to `chrome.tabGroups.onCreated/onUpdated/onMoved/onRemoved` (metadata) and `chrome.tabs.onUpdated` filtered to `changeInfo.groupId !== undefined` (membership). **Do not use** `chrome.tabs.onAttached/onDetached` — those are window events, not group events.
>    - `originDetection.ts`: 200ms-window classifier for `system-suggested` vs `user-created` group origin (matches against the Sidetrack-issued `chrome.tabs.group` calls).
>    - `reconciliation.ts`: on browser restart, match `(title, color, ordered-set-of-canonical-URLs)` to durable `TabGroupLink`. Drop on weak match; surface "Re-link group?" banner. Never silent re-link.
> 3. **Durable identity.** Mint `linkId = tgrp_<crockford32-ulid>`. Persist via `user.organized.item` with `itemKind: 'tab-group-link'`. Actions: `move` (attach group→workstream), `reject` (detach), `split` (origin transition).
> 4. **Pull-in / pull-out as feedback.**
>    - `tabs.onUpdated` `changeInfo.groupId ≥ 0` (joined): emit `user.organized.item itemKind: 'tab-session', action: 'move', toWorkstreamId: link.workstreamId`. Source-tag the assertion: the projection records `source: 'tab-group-pull-in'` for telemetry.
>    - `changeInfo.groupId === -1` (left): emit `user.organized.item itemKind: 'tab-session', action: 'move', toWorkstreamId: null` + `user.flow.rejected` against the prior link's workstream (existing event family).
> 5. **Auto-create policy.** Use the resolver's cluster output (Phase 4) to suggest groups via `connected components` over the per-window evidence subgraph (`graphology-components`, edge-weight threshold 0.5). Per policy mode threshold (conservative=never, balanced=≥3, aggressive=≥2). On trigger: SW calls `chrome.tabs.group` then `chrome.tabGroups.update`. Mints `TabGroupLink` (`origin: 'system-suggested'`).
> 6. **Cluster → workstream promotion.** Renaming a system-suggested group with no workstream link triggers a SuggestionBanner ("Create workstream from this group?"). On confirm: POST `/v1/workstreams` + `user.organized.item itemKind: 'tab-group-link', action: 'move', toWorkstreamId: <new>`.
> 7. **Auto-apply gate.** In `tabsession/policy.ts`: enable the auto-apply path. Decision rule from Phase 4 now writes a Class E inferred-attribution event (new event type registered as Class E in `sync/contract/registry.ts`) **only when** policy mode allows the dominant source + regret rate is below the source's budget + corroboration count is met. Engagement gate uses Stage 1 classifier. Auto-applied attributions DO NOT override `user_asserted`.
> 8. **Reducer rule.** In `tabsession/projection.ts`: extend the precedence rule to two-tier (`user_asserted > inferred`) within stream class. Verify pull-out-after-pull-in correctly overrides via LWW within `user_asserted`.
> 9. **Visual marker.** 🔄 emoji prefix on system-suggested group titles. Document in onboarding.
> 10. **Tests.**
>     - Unit test reconciliation matcher.
>     - E2e test: drag tab into Chrome group → assertion + attribution; drag out → null attribution; verify pull-out beats earlier pull-in.
>     - Auto-apply telemetry sanity: regret-rate counter increments on user override.
>     - T1 manual replay end-to-end with policy=balanced: confirm at least one auto-apply fires for a strong-causal session.
> 11. Commit message `feat(tabsession): phase 5 — tab groups + auto-apply policy` with co-author trailer.

**Acceptance criteria.**

- Drag tab into a Chrome group attributes the tab to the linked workstream; drag out unattributes.
- Pull-out after pull-in correctly overrides (verifies the source-class fix).
- `chrome.tabs.onAttached/onDetached` is not used for group membership.
- Chrome group ids never appear as canonical state in synced events.
- Browser restart triggers either silent reconciliation on strong match or a "Re-link group?" banner on weak match — never silent re-link on weak match.
- Auto-apply path emits Class E events; never overrides `user_asserted`; respects policy-mode gates.
- T1 replay shows auto-apply working end-to-end at policy=balanced for a strong-causal session.

---

## Phase 6 — T1 alignment with full tab-attribution product behavior

**Branch:** `feat/tabsession-phase-6-t1-alignment` (off main).

**Prerequisite:** Phase 5 merged. (Phases 1–5 + Phase 2 carryover all on main as of PR #132.)

**Goal.** Bring T1 from a plumbing/replay/graph-materialization harness up to a full product-behavior harness across all five implemented phases. T1 currently validates `browser replay → extension observation → timeline projection → graph materialization`, plus a synthetic-attribution bridge added in Phase 2. It does NOT yet validate Inbox UX, real user manual attribution through the side panel, resolver suggestion quality, tab-group pull-in/pull-out, durable tab-group links, auto-apply event writing, or same-URL/different-tab-session correctness in the real reducer path.

### PR-by-PR alignment baseline (record before changing T1)

| PR | T1 alignment | Notes |
|---|---|---|
| #126 (Phase 1) | aligned | Phase 1 regression visible in replay; `tab-session:*` nodes appeared. |
| #127 (Phase 2) | aligned via synthetic | T1 runs with `SIDETRACK_T1_SYNTHETIC_TAB_ATTRIBUTION=1` (record + replay) for an advisory GREEN. |
| #128 (Phase 3) | not aligned | Inbox UX verified by component/unit + manual smoke only. |
| #129 (Phase 4) | not aligned | Resolver verified by resolver/unit + route tests; T1 doesn't check suggestion quality. |
| #131 (carryover) | partial | Storage concurrency + multi-session URL covered by unit tests, not the T1 replay path. |
| #132 (Phase 5) | not aligned | Tab groups + auto-apply verified by unit tests; T1 doesn't exercise real-browser group events or auto-apply event writes. |

### Worker prompt

> Implement Phase 6 of `docs/tab-session-attribution/PHASES.md` on branch `feat/tabsession-phase-6-t1-alignment`. Read ground rules; do not deviate.
>
> 1. **Split T1 into four explicit modes** in `packages/sidetrack-extension/tests/e2e/record-replay-one-browser.manual.spec.ts` and `tests/e2e/helpers/recordReplay.ts`. Each mode is selected by an env knob and produces its own report layer in `report.md`/`report.json`. Modes can be composed (e.g. running A+B in one invocation) — keep the helper modular.
>
>    - **T1-A — Phase 1 identity replay.** Existing default behavior. Replay observation flow; assert timeline carries `tabSessionId`, Connections has `tab-session` nodes + `visit_in_tab_session` edges, and emits zero active-pointer-derived `visit_in_workstream` edges.
>
>    - **T1-B — explicit attribution replay.** **Rename** `SIDETRACK_T1_SYNTHETIC_TAB_ATTRIBUTION` → `SIDETRACK_T1_APPLY_EXPLICIT_ATTRIBUTION_FIXTURE` so the flag name reflects what it actually does (post a Class A `user.organized.item` `itemKind: 'tab-session'` per expected URL, NOT synthesize a fake source). Keep the legacy env name as a deprecation shim that maps to the new one and logs a warning. Assertion: `tab_session_in_workstream` + `visit_in_workstream` materialize through Phase 2's POST helper.
>
>    - **T1-C — real Inbox/manual UX replay.** New mode (env knob: `SIDETRACK_T1_INBOX_UX_REPLAY=1`). Drives the side panel via Playwright (the existing record-replay spec already opens the side panel context — reuse it). Steps: open ≥3 tab sessions (some attributed in the pack, some unattributed), open Inbox tab, assert N=unattributed cards visible, click "Yes" on one card to assign via the real UI flow (NOT the POST helper), leave another card unset, click "Not in any workstream" on a third (dismiss). Assertion: Connections updates `visit_in_workstream` only for the assigned card; the dismissed card emits `dismiss` source; the unassigned card stays unattributed. Also assert the focused-tab "Tab is in: <pill>" cue renders correctly when active workstream pointer ≠ focused-tab attribution. **Do not** use `SIDETRACK_T1_APPLY_EXPLICIT_ATTRIBUTION_FIXTURE` in this mode.
>
>    - **T1-D — resolver + tab-group replay.** New mode (env knob: `SIDETRACK_T1_RESOLVER_TABGROUP_REPLAY=1`). For resolver: invoke `GET /v1/tabsessions/{id}/resolve?dryRun=true` against the running companion, assert the response contains explainable candidates with `dominantSource`, and confirm the SuggestionBanner renders for at least one open session. Assert NO `InferredOpinions/AttributionSuggested` write occurred for the dry-run path. For tab groups: drive Chrome to create a group via the omnibox (or `chrome.tabs.group` from a dev-only test hook if omnibox driving is too brittle), then drag a tab in via `chrome.tabs.update({ groupId })`. Assert: `chrome.tabs.onUpdated(changeInfo.groupId)` fires, a `user.organized.item itemKind: 'tab-session', source: 'tab-group-pull-in'` is emitted, attribution materializes; then move the tab out (`groupId: -1`), assert pull-out is emitted and overrides the prior pull-in. For auto-apply: with policy mode = `balanced`, run a strong-causal fixture (chatgpt thread → its workstream); assert one `InferredOpinions/AttributionAutoApplied` lands and matches the expected workstream.
>
> 2. **Add the six structural replay cases** as parameterized fixtures (one fixture file each under `tests/e2e/fixtures/tabsession-cases/`):
>    - `case-1-same-url-two-sessions.json`: same `canonicalUrl` observed under `tses_a` then `tses_b`; user attributes only `tses_a`. Assert `tses_b.currentAttribution` stays null and `visit_in_workstream` materializes only for `tses_a`'s visit-instance, not the URL aggregate.
>    - `case-2-real-inbox-assignment.json`: drives T1-C above on a 3-session pack.
>    - `case-3-resolver-dryrun-no-write.json`: invokes T1-D resolver flow; asserts dry-run is read-only.
>    - `case-4-tabgroup-pull-in-out.json`: drives T1-D tab-group flow; asserts pull-in then pull-out yields null attribution.
>    - `case-5-autoapply-policy-mode.json`: drives T1-D auto-apply at policy=balanced; asserts Class E event landed, AND a parallel run with auto-apply disabled (`SIDETRACK_T1_AUTO_APPLY_DISABLED=1`) emits no Class E events.
>    - `case-6-active-pointer-not-truth.json`: replay with `activeWorkstreamId` set in storage but no explicit attribution; assert no `visit_in_workstream` edge materializes from the active pointer.
>
> 3. **Update the T1 acceptance contract.** Each PR landing on `main` from this point forward must declare which T1 mode(s) it exercises in the PR description. The default replay command (`npx playwright test record-replay-one-browser`) runs T1-A; CI smoke for the other modes is gated by env knobs to keep the default fast.
>
> 4. **Update the report layers in `report.md`/`report.json`.** New layer ordering: `page-replay → extension-observation → companion-projection → graph-materialization → product-behavior (T1-C/T1-D) → evaluation-expectations`. Document the layer in `tests/e2e/helpers/recordReplay.ts`.
>
> 5. **Type & test gates** + commit message `feat(tabsession): phase 6 — T1 modes A/B/C/D + six product-behavior replay cases` with co-author trailer.

**Acceptance criteria.**

- T1-A still passes for #126's regression (zero active-pointer `visit_in_workstream`; `tab-session` nodes present).
- T1-B passes via the renamed `SIDETRACK_T1_APPLY_EXPLICIT_ATTRIBUTION_FIXTURE` flag (legacy name still works with a deprecation warning).
- T1-C passes the three-card scenario (assigned / unassigned / dismissed) using the real side panel — no synthetic POST helper.
- T1-D passes resolver dry-run (no writes), tab-group pull-in/pull-out (with pull-out overriding pull-in), and auto-apply at policy=balanced.
- All six cases (`case-1` through `case-6`) pass; `case-1` specifically demonstrates same-URL multi-session correctness in the real reducer path (not just the unit test from PR #131).
- `npx tsc --noEmit` clean both packages; vitest green both packages.
- `report.md` shows the new product-behavior layer alongside the existing five.

---

## Phase 7 — T1-F full recent-feature product e2e

**Branch:** `feat/tabsession-phase-7-t1-full-product-e2e` (off main).

**Prerequisite:** Phase 6 merged. (PR #134 on main as of `c5a9672c`.)

**Goal.** A single browser-user story that proves the entire tab-session attribution stack works locally, across relay, through UI, through resolver/ML evidence, through tab groups, through Class A/Class E event paths, and back into Connections. Relay is **one sub-check**, not the whole test. T1-F validates *product behavior*, not just plumbing.

### T1 mode taxonomy (post Phase 7)

| Mode | Scope |
|---|---|
| T1-A / T1-B / T1-C / T1-D | Local tab-session product behavior (Phase 6) |
| T1-R | Relay sync only (the existing two-browser baseline) |
| **T1-F** | Full recent-feature product e2e — Phase 7 |
| L5 | Broad cross-feature realism beyond tab-session attribution |

### Paths the test must exercise

| Path | Must prove |
|---|---|
| Class F observation | `browser.timeline.observed` carries `tabSessionId`; active pointer is not graph truth. |
| Class B projections | timeline + tab-session projection + Connections snapshot rebuild deterministically. |
| Class A assertions | `user.organized.item itemKind='tab-session'` moves/dismisses sessions. |
| Class E inference | `tabsession.attribution.inferred` writes only through POST `dryRun:false`. |
| Resolver dry-run | `GET /resolve?dryRun=true` gives candidates/reasons and writes nothing. |
| ML evidence | PPR/causal, similarity, inherited, target-local cluster evidence where available. |
| Negative feedback | pull-out / reject affects projection and future resolver behavior. |
| UI | Inbox, badge, provenance, focused-tab cue, per-workstream tabs, suggestion banner. |
| Chrome tab groups | `tabs.onUpdated(changeInfo.groupId)` membership; no raw Chrome group id as canonical synced state. |
| Relay | A-origin observations reach B; B assertions/inferences reach A. |
| Redaction | existing HTML/session-pack privacy path remains green. |
| Same-URL sessions | attribution is visit-instance/session-scoped, not URL-scoped. |

### Worker prompt

> Implement T1-F — Full recent-feature product e2e for Tab-Session Attribution v1 on branch `feat/tabsession-phase-7-t1-full-product-e2e`. Read the architectural ground rules at the top of this doc; do not deviate.
>
> Goal: prove the full recent-feature chain end-to-end — Phase 1 `tabSessionId`, Phase 2 projection/user attribution, Phase 3 Inbox UX, Phase 4 resolver dry-run, Phase 5 tab groups + auto-apply, Phase 6 T1 product modes, the carryover fixes, relay sync, and graph/UI agreement.
>
> Phase 6 (PR #134) shipped local T1 modes A/B/C/D and six fixture cases. This phase adds **one comprehensive product e2e** that uses the real browser, side panel, companion, Connections, resolver, tab groups, relay, and report layer — not a parallel event architecture.
>
> Use existing event paths (do **not** create new buses):
> - Observed facts: `browser.timeline.observed`, existing timeline/navigation projections.
> - User assertions: `user.organized.item itemKind='tab-session'`, `user.flow.rejected`.
> - Inferred opinions: `tabsession.attribution.inferred` (Class E).
>
> Existing routes (do **not** add new ones unless the prompt explicitly authorizes):
> - `GET  /v1/tabsessions/projection`
> - `GET  /v1/tabsessions/inbox`
> - `POST /v1/tabsessions/{id}/attribute`
> - `GET  /v1/tabsessions/{id}/resolve?dryRun=true`
> - `POST /v1/tabsessions/{id}/resolve` with `{ dryRun:false, policyMode }`
> - `GET  /v1/connections`
> - `GET  /v1/feedback/projection` if needed
>
> Files to modify (preferred):
> - Extract reusable product-behavior helpers from `packages/sidetrack-extension/tests/e2e/record-replay-one-browser.manual.spec.ts` into `packages/sidetrack-extension/tests/e2e/helpers/tabsessionProductBehavior.ts`.
> - Extend `packages/sidetrack-extension/tests/e2e/record-replay-two-browser.manual.spec.ts`.
> - Extend `packages/sidetrack-extension/tests/e2e/helpers/recordReplay.ts`.
> - Add fixtures only if needed: `packages/sidetrack-extension/tests/e2e/fixtures/tabsession-full-product/*.json`.
>
> Env knob: `SIDETRACK_T1_FULL_PRODUCT_E2E=1`. Default Mode A and the existing two-browser replay must remain unchanged when this var is absent.
>
> #### Required story
>
> Browser A and Browser B run with two companions over a real relay. Two workstreams created up front: `ws_switchboard` ("Switchboard") and `ws_security` ("Security").
>
> **Browser A:**
> 1. Enable timeline observation through the existing test setup path.
> 2. Set `activeWorkstreamId` to Switchboard.
> 3. Open ≥6 tabs/pages through real `chrome.tabs` navigation + route stubs:
>    - same canonical URL twice in two different tab sessions
>    - one source/research page
>    - one GitHub/project-like page
>    - one Google/search-like page
>    - one AI-chat-shaped page
>    - one unrelated/ambient page
> 4. Include ≥1 opener or same-tab causal chain.
> 5. Include ≥1 AI-chat-shaped anchor that can later be assigned to a workstream.
> 6. Force-drain the timeline.
>
> **Browser B:**
> 7. Wait for Browser A observations to relay to Companion B.
> 8. Open the side panel.
> 9. Open Inbox.
> 10. Assign one relayed A-origin tab session to Switchboard through real UI if possible. Fallback only if UI lookup is impossible: call `POST /v1/tabsessions/{id}/attribute`. Report fallback usage in `details`.
> 11. Dismiss a second session as "Not in any workstream".
> 12. Leave a third session unset.
> 13. Verify the focused-tab cue uses `activeTabSessionId` before any URL fallback.
> 14. Verify non-AI browsing pages are NOT in All Threads.
> 15. Verify the workstream view shows "Tabs in this workstream".
>
> **Resolver / ML:**
> 16. `GET /v1/tabsessions/{target}/resolve?dryRun=true` on a target with causal/similarity evidence.
> 17. Assert dry-run: returns `fusedCandidates`; top candidate is the expected workstream; `reasons`/provenance present; `dominantSource !== 'none'`; **writes no `tabsession.attribution.inferred`**; `dependencyKey`/`evidenceHash` stable across two calls when `graphRevision` is unchanged.
> 18. ≥1 case proves causal/PPR evidence beats similarity-only when causal evidence exists.
> 19. Target-local cluster evidence is either exercised through fixture topic edges OR explicitly asserted absent when the target has no `visit_in_topic`. Global topic popularity must NOT influence resolver output.
>
> **Auto-apply:**
> 20. `POST /v1/tabsessions/{target}/resolve` with `{ dryRun:false, policyMode:"balanced" }` on a target with strong evidence.
> 21. Assert: `status` is `applied`; `accepted.type` is `tabsession.attribution.inferred`; payload includes `modelRevision`, `graphRevision`, `evidenceHash`, `resolverDependencyKey`, `reasonSummary`; `currentAttribution.source` is `inferred`.
> 22. Relay to the other companion.
> 23. Emit a Class A user move/dismiss for the same session.
> 24. Assert on both replicas: `user_asserted` overrides inferred; inferred remains in `attributionHistory` but not `currentAttribution`.
>
> **Chrome tab group:**
> 25. On Browser B, drive the real Chrome tab-group path. A runtime test hook is acceptable only if it uses real `chrome.tabs.group` / `chrome.tabs.ungroup` underneath.
> 26. Link a group to Switchboard.
> 27. Pull a tab into the group.
> 28. Pull it out.
> 29. Assert on B and (after relay) on A: `attributionHistory` includes `tab-group-pull-in` then `tab-group-pull-out`; `currentAttribution.workstreamId === null` after pull-out; a `user.flow.rejected` exists for the prior workstream; resolver dry-run after pull-out does NOT auto-apply the rejected workstream; **no raw Chrome `groupId` persisted as canonical synced identity**.
>
> **Same-URL / visit-instance:**
> 30. Use the two same-canonical-URL sessions from Browser A.
> 31. Attribute only one session.
> 32. Assert on A and B: both `tabSessionId`s exist; both visit-instance nodes exist; only the attributed visit instance has `visit_instance_in_workstream`; **no URL-scoped `visit_in_workstream` edge exists**; `timeline-visit:<url>` does not carry workstream truth; subgraph around the unassigned session does not imply membership in the attributed workstream.
>
> **Active pointer:**
> 33. With `activeWorkstreamId` set, open an unrelated non-AI page.
> 34. Assert: tab session appears; **no `visit_instance_in_workstream`**; **no `visit_in_workstream`**; active pointer is intent/default only, never graph truth.
>
> **Relay:**
> 35. A-origin Class F observations visible on B.
> 36. B-origin Class A user assertions visible on A.
> 37. Class E inferred attribution relays or is materialized per existing registry policy.
> 38. Both companions converge to the same effective tab-session projection for tested sessions.
> 39. Both companions converge to the same relevant Connections edges.
>
> **Redaction / privacy:**
> 40. Preserve the existing two-browser HTML redaction checks: fake email redacted; fake OpenAI key redacted; raw secret values absent from pack; raw secret values absent from fulfilled replay body.
> 41. Preserve strict-offline route behavior.

### Required report caseIds

`report.md`/`report.json` gain a first-class **T1-F Full Product E2E** section. Each check carries `{ caseId, status, summary, details }`. The test does NOT pass unless every required `caseId` is `pass`:

- `full-observed-A-to-B`
- `full-inbox-user-assertion-B-to-A`
- `full-same-url-visit-instance-no-leak`
- `full-resolver-dryrun-no-write`
- `full-ppr-causal-beats-similarity`
- `full-cluster-target-local-or-absent`
- `full-autoapply-ClassE`
- `full-user-assertion-overrides-inferred`
- `full-tabgroup-pull-in-out`
- `full-active-pointer-not-truth`
- `full-focused-tab-cue-uses-session-id`
- `full-non-ai-not-all-threads`
- `full-redaction-regression`
- `full-graph-determinism`

### Implementation constraints (negative list)

- Do NOT use `/v1/timeline/events` direct seeding.
- Do NOT use work-graph eval fixture seeding for the browser story.
- Do NOT bypass the side-panel UI for Inbox / manual UX unless the UI element cannot be found; if fallback is used, report it in `details`.
- Do NOT use `chrome.tabs.onAttached` / `onDetached` for group membership.
- Do NOT reintroduce `activeWorkstreamId` stamping.
- Do NOT persist raw Chrome `groupId` as canonical synced state.
- Do NOT allow resolver dry-run to append Class E.
- Do NOT allow inferred attribution to override Class A.
- Do NOT rely on URL-level nodes for attribution.
- Do NOT require HDBSCAN; cluster evidence must be optional and target-local.
- Use existing 1-minute drain / event-buffer behavior; do NOT add 30-second alarms or per-tab keepalive ports.

### Validation commands

```bash
cd packages/sidetrack-companion
npm run typecheck
npm run test -- \
  src/tabsession/resolver.test.ts \
  src/tabsession/projection.test.ts \
  src/http/tabsessionRoutes.test.ts \
  src/connections/snapshot.test.ts

cd ../sidetrack-extension
npm run typecheck
npm run test -- \
  tests/unit/tabsession/InboxCard.test.tsx \
  tests/unit/tabsession/boundary.test.ts \
  tests/unit/tabgroups/wiring.test.ts \
  tests/unit/app.test.tsx

SIDETRACK_CAPTURE_LEVEL=html \
SIDETRACK_REPLAY_STRICT_OFFLINE=1 \
SIDETRACK_T1_FULL_PRODUCT_E2E=1 \
npx playwright test tests/e2e/record-replay-two-browser.manual.spec.ts \
  --headed --timeout 0 --grep manual

# Replay-from-pack must also pass:
SIDETRACK_REPLAY_PACK=<pack-from-first-run>/pack.json \
SIDETRACK_REPLAY_STRICT_OFFLINE=1 \
SIDETRACK_T1_FULL_PRODUCT_E2E=1 \
npx playwright test tests/e2e/record-replay-two-browser.manual.spec.ts \
  --headed --timeout 0 --grep manual
```

### Acceptance criteria

- `report.status === 'pass'`.
- `report` includes a **T1-F Full Product E2E** section.
- Every required `caseId` listed above is `pass`.
- Browser B Connections shows Browser A relayed sessions.
- Browser A sees Browser B user assertions and inferred events after relay.
- Same-URL sessions remain isolated by visit-instance identity.
- `activeWorkstreamId` never produces attribution truth.
- Dry-run resolver writes nothing.
- Auto-apply writes Class E only through POST `dryRun:false`.
- Class A overrides Class E.
- Chrome tab-group pull-in/out produces correct attribution + rejection history.
- Non-AI tabs stay out of All Threads.
- Focused-tab cue uses `activeTabSessionId`.
- Redaction and strict-offline replay remain green.

---

## Out-of-scope across all phases (Wave 1 explicit non-goals)

- Backfill of legacy active-pointer attributions in production.
- Full PRD vocabulary additions (conformal, Beta calibration, BOCPD, Leiden, GBDT ranker, learning-to-defer) — all gated behind label-count triggers documented in the PRD.
- Mobile / non-Chrome surfaces.
- Cross-replica explicit-attribution propagation by URL match (per-replica scoping; cross-replica via similarity evidence stays the policy).

---

## Workflow

- Each phase is its own PR off `main` (Phase N+1 branched after Phase N lands).
- Worker drives implementation; lead reviews diff, runs acceptance checks locally, lands.
- Mode B (PR-poll cadence per session memory).
