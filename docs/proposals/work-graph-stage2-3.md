# Sidetrack — Stage 2/3 (work graph: ranker + feedback + future)

> **Status: scope locked, briefs being authored.** This doc opens the
> next major iteration on the behavioral work graph after Stage 1
> ([PR #99](https://github.com/zyingfei/switchboard/pull/99) merged at
> `7c42a570`). Scope was confirmed by the user on 2026-05-08; detailed
> sub-task briefs land in
> `docs/proposals/work-graph-stage2-3-briefs.md` next.

## Northern star (carried forward from Stage 1)

> **Facts are event-sourced. Interpretations are versioned. Suggestions
> are explainable. User organization is authoritative. No inference
> requires GPU / Apple-Silicon hardware.**

Architectural locks 1–4 from Stage 1 stay invariant. Every Stage 2/3
addition slots into Class E (revisioned interpretations) or extends
Class B (deterministic facts) — never mutates the locks.

## Candidate task list (Codex pulls from this; lead refines after user input)

Pulled from the deferred roadmap in
`docs/architecture.md` § Roadmap. Marked:
- 🟢 likely in scope for this PR.
- 🟡 candidate for this PR pending user direction.
- 🔵 documented but explicitly deferred.

### Stage 2 — Learned ranker for `closest_visit`

- [ ] 🟢 **S17.** Candidate-generation framework (multi-source: same workstream, opener chain, same canonical URL, same repo/domain, same search query, same copied snippet hash, same title/path tokens, same embedding neighborhood, cross-replica continuation).
- [ ] 🟢 **S18.** Feature engineering + extraction layer over event log + Class B/E artifacts. Per-pair feature vector for ranker input.
- [ ] 🟢 **S19.** Negative-candidate producer (random unrelated visits + recent skipped visits) so the ranker learns what's NOT close.
- [ ] 🟢 **S20.** LightGBM/XGBoost LambdaMART ranker. CPU-only. Class E revision keyed by `(model_version, feature_schema_version)`.
- [ ] 🟢 **S21.** `closest_visit` edge emission — scored, sorted by score, decomposable per-feature contributions.
- [ ] 🟢 **S22.** Debug-pack MCP tool (`sidetrack.debug.explainRanking({ from, to })`) that returns full feature vector + per-feature contribution.

### Stage 3 — Supervised feedback loop

- [ ] 🟢 **S23.** Feedback event types: `user.organized.item`, `user.engagement.relabeled`, `user.flow.confirmed/.rejected`, `user.topic.renamed`, `user.snippet.promoted`.
- [ ] 🟢 **S24.** Feedback projection (Class B) that aggregates user actions into training-label datasets.
- [ ] 🟢 **S25.** Ranker retraining loop — companion-side periodic re-train against accumulated feedback. Each retrain produces a new Class E revision; old outputs survive for audit.
- [ ] 🟢 **S26.** Side-panel UI affordances for capturing feedback (move/merge/split/rename/promote/ignore).
- [ ] 🟢 **S27.** Producer-pin UI: "this ranker version learned from N corrections" surface; user can pin a specific producer revision for stability.

### Future stages — locked scope (per user direction 2026-05-08)

- [ ] 🔵 **F1 deferred.** Optional cloud-LLM enhancement — NOT in this PR. Stays a future PR; the Class E revision pattern from Stage 1 makes it purely additive.
- [ ] 🟢 **F2.** Cross-replica continuation classifier — the *inference* edge atop `visit_observed_on_replica`. LightGBM over (engagement, provenance, lineage, recency) features.
- [ ] 🟢 **F3-partial.** DOM-skeleton hash only (no screenshots, no pHash). Captures structural template recognition + DOM-duplicate detection. Privacy-gated (separate `visual.fingerprint` gate).
- [ ] 🟢 **F4.** ANN indexes (USearch/hnswlib/Faiss). Wraps existing recall index V3 access path; no migration of the binary format.
- [ ] 🟢 **F5.** HDBSCAN / centroid-stable clustering. Alternative to Union-Find for `topic` formation; consumer of the existing `visit_resembles_visit` edges.

### Explicitly deferred (not in this PR even with user direction)

- [ ] 🔵 F1 cloud-LLM — separate future PR.
- [ ] 🔵 F3 screenshot pHash — separate future PR (only DOM hash here).
- [ ] 🔵 Federated learning across users (privacy-preserving; needs DP primitives).
- [ ] 🔵 Mobile companion (out of MV3 scope).

## Lead-author work (not Codex)

- [ ] 🟢 **L1.** Stage 2/3 e2e suite — drives a feedback-driven ranker training cycle end-to-end.
- [ ] 🟢 **L2.** Update `docs/architecture.md` with Stage 2/3 model registry concepts.
- [ ] 🟢 **L3.** Author detailed sub-task briefs (schemas, test scenarios, fixtures, verification commands) per scope agreed.

## Codex orchestration protocol

- Each Codex job pulls a task from the unchecked list above.
- Worktree branch convention: `codex/stage2-3-s<n>-<slug>`.
- Each subtask lands as an independent commit on this PR.
- When complete, Codex MARKS THE BOX `[x]` (this PR's body is the source of truth for completion).
- Lead reviews each subtask commit; if a fix is needed, lead lands a new commit (no amend).
- Lead resolves any merge conflicts at integration time.

## Wave structure (parallelization plan)

**Wave A** (foundational, all independent):
- S17 candidate-generation framework
- S23 feedback event types + registry
- F3-partial DOM hash content script + event type
- F4 ANN index integration (wraps existing recall index)
- F5 HDBSCAN clusterer (alternative to Union-Find for topics)

**Wave B** (depends on Wave A foundations):
- S18 feature engineering / extraction layer
- S19 negative-candidate producer
- S24 feedback projection (Class B)
- F2 cross-replica continuation classifier (depends on Stage 2 features pipeline)

**Wave C** (depends on Wave B):
- S20 LightGBM/LambdaMART ranker
- S21 closest_visit edge emission with per-feature contribution
- S22 debug-pack MCP tool
- S25 ranker retraining loop (depends on S24 + S20)
- S26 side-panel feedback-capture UI

**Wave D** (sequential, lead-led):
- L1 Stage 2/3 e2e suite
- L2 update architecture.md (model registry concepts)
- S27 producer-pin UI (depends on S25 + S26)

## Scope decisions (locked 2026-05-08)

| Decision | Resolution |
|---|---|
| Future-stage items in PR scope | F2 + F3-partial + F4 + F5 (F1 cloud-LLM deferred) |
| Ranker tier | LightGBM/XGBoost LambdaMART direct (S20) |
| Feedback signal set | Five listed: user.organized.item / .engagement.relabeled / .flow.confirmed/.rejected / .topic.renamed / .snippet.promoted |
| F3 scope | DOM-skeleton hash only; no screenshot pHash, no captureVisibleTab |
