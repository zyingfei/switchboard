# Sidetrack — Stage 2/3 (work graph: ranker + feedback + future)

> **Status: planning.** This doc opens the next major iteration on the
> behavioral work graph after Stage 1 ([PR #99](https://github.com/zyingfei/switchboard/pull/99)
> merged at `7c42a570`). Scope is not yet locked — see the candidate
> task list below; the lead will refine it after user input.

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

### Future stages — pending user direction

- [ ] 🟡 **F1.** Optional cloud-LLM enhancement (user supplies own API key) for label / Why Related / Context Pack prose. Slots in via the Class E revision pattern as `*-revision:v2:cloud-llm`. Existing deterministic surfaces remain available as fallback.
- [ ] 🟡 **F2.** Cross-replica continuation classifier — the *inference* edge atop `visit_observed_on_replica`. LightGBM over (engagement, provenance, lineage, recency) features.
- [ ] 🟡 **F3.** Selection-API based visual fingerprinting (gated): screenshot pHash + DOM hash for visual revisitation that text embeddings don't solve.
- [ ] 🟡 **F4.** ANN indexes (USearch/hnswlib/Faiss) — only when cosine over flat float32 stops being interactive on the user's own corpus.
- [ ] 🟡 **F5.** HDBSCAN / centroid-stable clustering replacing Union-Find when topic-id churn becomes a measured user complaint.

### Explicitly deferred (not in this PR even with user direction)

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

## Open scope questions for user

1. **Which 🟡 candidate items go into this PR?** F1–F5 are independently includable.
2. **Stage 2's ranker — start with LightGBM or graduate from simpler logistic regression first?**
3. **Stage 3's first-class feedback signals — the listed five (move/merge/split/rename/promote) the right set, or extend?**

These are answered before lead authors sub-task briefs. Once scope is locked, the lead refines this doc + the PR body's checkbox list and Codex starts pulling.
