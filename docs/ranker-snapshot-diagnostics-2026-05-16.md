# Ranker Snapshot Diagnostics — Dogfood Findings (2026-05-16)

## Branch context
- Worktree branch: `codex/ranker-snapshot-diagnostics`
- Working branch for this report: attached worktree at `/Users/yingfei/.codex/worktrees/ranker-snapshot-diagnostics/browser-ai-companion`

## Summary
- No-skip dogfood rebuild at `2026-05-16T03:09:52.167Z` reached ranker augmentation path.
- Diagnostics initially reported active-manifest mismatch as:
  - `rankerAugmentation.status = "absent"`
  - `reason = "invalid-active-manifest"`
- Active on-disk manifest was `lightgbm-lambdamart-v1` / feature schema `1` while runtime expects `lightgbm-lambdamart-v2` / schema `2`.
- This made `closest_visit` emission visible as blocked by diagnostic state instead of hidden by skip flag.

## Changes on this branch (implemented)
- Added ranker-augmentation diagnostics:
  - `skipped`, `absent`, `emitted`, counts, active revision, freshness status.
- Made missing/invalid active ranker manifests visible in work-graph health output.
- Kept `SIDETRACK_SKIP_RANKER_SNAPSHOT=1` as an explicit opt-out only.
- Stopped E2E companion helper from inheriting that env by default.
- Added recorder-only opt-out env var: `SIDETRACK_RECORDER_SKIP_RANKER_SNAPSHOT=1`.
- Added raw manifest probing to retain schema metadata while keeping strict manifest parser behavior for scoring.
- Reworked stale mismatch classification from `invalid-active-manifest` to `stale-model-schema`.
- Added diagnostics/work-graph health fields:
  - `activeModelVersion`
  - `expectedModelVersion`
  - `activeFeatureSchemaVersion`
  - `expectedFeatureSchemaVersion`
  - `needsRetrain`
- Ensured stale schema state no longer auto-forces retrain and reports `needsRetrain: true` for normal startup policy.
- Added tests for:
  - skip env set -> skipped
  - skip absent + valid mock ranker -> emitted
  - skip absent + stale-v1 manifest under v2 runtime -> `stale-model-schema` + `needsRetrain`
  - missing manifest -> `absent` / `no-active-manifest`

## Controlled v2 retrain + live verification
- Runtime constants confirmed:
  - `RANKER_MODEL_VERSION = lightgbm-lambdamart-v2`
  - `FEATURE_SCHEMA_VERSION = 2`
- Forced retrain command used `SIDETRACK_RANKER_RETRAIN_FORCE=1` (no skip flag).
- Retrain timing:
  - started `2026-05-16T03:45:29.003Z`
  - finished `2026-05-16T04:04:35.007Z`
  - duration ~19m 06s
- Revision:
  - `dd1eb74250435a9b`
- Training stats:
  - candidateCount: `60,249`
  - labels: `3195` total / `2698` positive / `497` negative
- trainQuality:
  - grade histogram: `0=700`, `1=2472`
  - score spread: `p05=-5.2059`, `p50=4.3007`, `p95=5.2170`
  - stdDev `4.0661`
  - distinctRatio `0.0271`
  - in-sample `ndcg@5=1`
- Post-restart verification (no skip / no force):
  - active manifest: `lightgbm-lambdamart-v2`
  - active feature schema: `2`
  - `rankerAugmentation.status = "emitted"`
  - `rankerAugmentation.needsRetrain = false`
  - snapshot totals: `10,150` edges
  - `closest_visit`: `596`
  - `producedBy.source == "ranker"`: `596`
  - diagnostics transitioned from stale to emitted and `closest_visit` became visible.

## Ranking quality audit (dogfood snapshot `3c8174063201226a`, 596 edges)

### 1) Duplicate vs novel relation profile
- same workstream: `596` (`100.0%`)
- same topic: `37` (`6.2%`)
- same `visit_resembles_visit`: `37` (`6.2%`)
- same URL/domain/repo overlap: `106` (`17.8%`)
- exact same URL: `0`
- strictly new net-new relation: `0` (`0.0%`)

### 2) Contribution distribution
- Dominant feature (as top contribution):
  - `user_asserted_in_workstream`: `595` (`99.8%`)
  - `recency_score_to`: `1` (`0.2%`)
- Top-3 presence:
  - `user_asserted_in_workstream`: `596` (`100%`)
  - `recency_score_to`: `596` (`100%`)
  - `page_quality_tier_to`: `557` (`93.5%`)
  - `cosine_similarity`: `23` (`3.9%`)
  - `recency_score_from`: `16` (`2.7%`)
- `same_active_topic`, `same_repo`, `same_host`, `same_search_query`: not materially dominant in top-3.

### 3) Score distribution
- min: `2.301612`
- p05: `3.891520`
- p50: `5.217020`
- p95: `5.217020`
- max: `5.217954`
- distinct rounded scores: `21`

### 4) Coverage
- distinct fromVisit with at least one emitted `closest_visit`: `130`
- average emitted per fromVisit: `4.58`
- top workstreams by emitted edges:
  - `ai: 205`, `switchboard: 90`, `linux-security: 65`, `cloud: 60`, `interview: 45`, `trading: 45`, `db: 40`, `tech-reading: 20`
- high-activity visits with zero emitted edges include several root-level pages (e.g., ChatGPT root, Gemini root, Google root, HN root/news/newcomments, etc.), so emission is concentrated in organized workstreams.

### 5) Utility sample (stratified 30 edges)
- useful net-new: `0`
- redundant but correct/plausible: `21`
- noisy/wrong: `2`
- recorder/test-artifact noise: `7`
- recorder/test-artifact contamination: `76 / 596` overall; `6 / 20` top-20; `20 / 50` top-50.

### 6) Diagnosis
- Model appears useful but narrow:
  - strongly concentrated within existing workstreams
  - overfit to `user_asserted_in_workstream` (dominant feature on emitted edges)
  - threshold is unlikely root issue (lowest emitted score ≈ `2.30` vs threshold `0.3`)
  - likely issue is ranking selectivity/order within workstreams + candidate/workstream saturation
  - binary label distribution (`0`/`1` only) limits ordering signal for LambdaMART
  - recorder/test artifacts pollute top ranks and should be filtered before model assessment and tuning

## Operational conclusion
- Yes: with a v2/schema2 manifest in place and no skip flag, the companion now emits `closest_visit` edges in live dogfood; no UI changes are required for visibility assuming the UI reads current snapshot.
- Known remaining concerns are model utility (narrowness, feature dominance, artifact contamination), not operational correctness of retrain/publish flow.
