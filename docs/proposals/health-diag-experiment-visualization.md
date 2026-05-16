# Sidetrack health/diag visualization for active, standby, shadow, and diagnostic data

> Fact-checked against `origin/main` commit `6607a1e88728305112a6a96581d0601ac2aef889`
> in worktree `/Users/yingfei/playground/playground/browser-ai-companion-health-diag-proposal`
> on 2026-05-16.

## Fact check

The inventory is directionally right, but "written but not enabled" needs narrower wording:

- HDBSCAN topics are written and tested, and the materializer has a programmatic selector, but the default topic revision algorithm is still Union-Find before the idf-rkn-split shadow promotion path. There is no production env/user selector for HDBSCAN on `main`.
- Topic-algorithm comparison candidates are written and tested, but only tests reference `runTopicAlgorithmComparison` / `writeTopicAlgorithmComparisonShadows`; no runtime route or materializer calls them.
- The learned gray-zone quality scorer is written, but default page-content storage calls `classifyPageContentQuality(payload.qualitySignals)` with no injected scorer, so runtime behavior remains rule-based unless a caller explicitly loads and passes a model.
- Ranker v3 augmentation is enabled when a valid active model exists. When no valid model exists, the materializer publishes the base snapshot and records `rankerAugmentation.status = "absent"` or `"skipped"`; it does not emit a deterministic learned-ranker fallback.
- Hot/incremental similarity and topic paths are partially hot: the accumulators and indexes are instantiated and folded, but the actual hot fast paths require `SIDETRACK_CONNECTIONS_HOT_SIMILARITY=1` and `SIDETRACK_CONNECTIONS_HOT_TOPICS=1`.
- Content-lane hooks are more than just written: the dirty-source queue is folded from accepted Group B events, and `drainContentLaneQueue(...)` is exposed. What is not enabled is an autonomous production reconciler/cadence that chunks, embeds, and atomically replaces recall-index entries.
- The worker-thread reconcile harness exists, but it is opt-in through `SIDETRACK_CONNECTIONS_WORKER=1`. The CLI default is now `child_process.fork` via `SIDETRACK_CONNECTIONS_CHILD=1`, because worker threads plus native addons were unsafe.
- Ranker methodology enforcement is deliberately not enabled. Training writes the methodology spine and health surfaces it, but `servingGateEnforced` is false and tests assert non-passing ship-gated revisions remain loadable until the serving gate lands.

The diagnostics-only list is accurate with one important nuance:

- ADWIN/KSWIN drift and temporal silhouette are observe-only. They are attached after materializer diagnostics and wrapped so they never fail a drain.
- Topic shadow observations are diagnostics-only, but the idf-rkn-split "shadow candidate" itself is now default-on and promoted to active/served output unless disabled.
- Ranker methodology spine is diagnostics-only today: it explains split/gate state but does not block serving.
- Health/training-mix reporting is diagnostics-only and already partly rendered in the health panel.

Current evidence:

- HDBSCAN builder and selector: `packages/sidetrack-companion/src/connections/hdbscanClusterer.ts`, `packages/sidetrack-companion/src/sync/contract/connectionsMaterializer.ts`
- Topic comparison candidates: `packages/sidetrack-companion/src/connections/topicAlgorithmComparison.ts`
- Gray-zone scorer injection gate: `packages/sidetrack-companion/src/page-content/quality.ts`, `packages/sidetrack-companion/src/page-content/qualityScorer.ts`, `packages/sidetrack-companion/src/page-content/store.ts`
- Ranker augmentation and no-valid-model behavior: `packages/sidetrack-companion/src/sync/contract/connectionsMaterializer.ts`
- Drift and silhouette: `packages/sidetrack-companion/src/connections/drift/*`, `packages/sidetrack-companion/src/connections/materializerDiagnostics.ts`
- Shadow observation: `packages/sidetrack-companion/src/connections/topicShadowObservation.ts`
- Health/training mix: `packages/sidetrack-companion/src/system/workGraphHealth.ts`, `packages/sidetrack-extension/entrypoints/sidepanel/components/HealthPanel.tsx`

## Proposal

Health/diag should get a first-class "candidate lanes" surface before any of this data becomes product UI or promotion logic. The goal is to make experiments legible without implying they are serving, safe, or user-visible.

Use four lane labels everywhere:

| Lane       | Meaning                                                                      | Health-panel treatment                                                   |
| ---------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Active     | Affects the served graph or user-visible result today                        | Can raise red alarms when broken                                         |
| Standby    | Code path is present, configured, or warm, but does not affect served output | Amber only when expected standby data is stale or missing                |
| Shadow     | Runs beside active on the same inputs and writes comparable output/metrics   | Amber on churn/collapse/drift; never red by itself                       |
| Diagnostic | Aggregate observations only; no candidate output                             | Amber on drift/warning; never red unless an active dependency also fails |

Avoid calling anything "A/B" until there is real routing that serves different user-visible outputs to different cohorts or time slices. Most current work is comparison, standby, shadow, or diagnostic, not A/B.

## Panel shape

Add an "Experiments" drill-down to the existing health panel, backed by `/v1/system/health` plus `/v1/system/focus-health`.

Top summary:

- Active graph: active topic algorithm, ranker augmentation status, closest-visit edge count.
- Standby paths: HDBSCAN available/off, hot similarity off/on, hot topics off/on, content-lane queue depth, reconcile runner mode.
- Shadow paths: idf-rkn-split candidate/revision, adjacent churn, max topic share, noise share.
- Diagnostic sidecars: drift status, tripped/warning signals, silhouette delta, ranker ship gate.

Main table:

| Column             | Example                                                           |
| ------------------ | ----------------------------------------------------------------- |
| Family             | Topics, Similarity, Ranker, Content lane, Reconcile               |
| Lane               | Active / Standby / Shadow / Diagnostic                            |
| Serving impact     | Serving, not serving, observe-only                                |
| Candidate/revision | `topic-revision:v2:hdbscan`, `ranker-v3`, `idf-rkn-split`         |
| Gate/status        | off, ready, absent, emitted, fail, warning, drift                 |
| Reason             | `no-active-manifest`, `shipGate.fail`, `env off`, `no signal yet` |
| Last observed      | `focus-health.asOf`, `workGraph.ranker.augmentation.asOf`         |
| What changed       | edge count delta, adjacent churn, silhouette delta, new labels    |

Alarm rail:

- Red only for active-path failures: invalid active ranker model, failed materializer, unreadable vault, unavailable health section that serves a fallback.
- Amber for promotion blockers and diagnostic warnings: ranker ship gate fail with `servingGateEnforced=false`, drift status warning/drift, shadow collapse boundary changed, shadow adjacent churn over threshold, content-lane backlog above threshold.
- Info for explicitly disabled paths: HDBSCAN not selected, hot similarity off, hot topics off, no gray-zone model loaded.

Trend area:

- Shadow trend: adjacent churn, max topic share, noise share over the ring buffer.
- Drift trend: per-signal status, tripped/warning signals, silhouette and silhouette delta.
- Ranker trend: labels at train, training negatives, new label count, dataset changed since train, ship gate status.

Receipts:

- Every row links to a raw field source in the copied diagnostics payload.
- Every absent value renders as "unavailable", "disabled", or "no signal yet"; never as zero.
- Every alarm includes an action hint: retrain, collect Keep confirmations, enable env, inspect latest diagnostics, or wait for next drain.

## Data-contract gap

The current panel already reads enough for topics and ranker basics, but it lacks a normalized candidate/experiment contract. Add either:

1. `workGraph.candidates[]` inside `/v1/system/health`, or
2. a narrow `/v1/system/diagnostic-candidates` endpoint.

Suggested record:

```ts
interface DiagnosticCandidate {
  readonly id: string;
  readonly family:
    | "topic"
    | "similarity"
    | "ranker"
    | "content-lane"
    | "reconcile"
    | "quality";
  readonly lane: "active" | "standby" | "shadow" | "diagnostic";
  readonly servingImpact: "serving" | "not-serving" | "observe-only";
  readonly status:
    | "ok"
    | "off"
    | "pending"
    | "warning"
    | "alarm"
    | "unavailable";
  readonly reason: string | null;
  readonly revisionId: string | null;
  readonly asOf: string | null;
  readonly metrics: Record<string, number | string | boolean | null>;
}
```

Initial rows should cover:

- active topic producer from `workGraph.topicProducer`;
- idf-rkn-split shadow/active observation from `focusHealth.digest.shadowVsBaseline` and `.shadowObservation`;
- drift sidecar from `focusHealth.digest.drift`;
- ranker active model, augmentation, training mix, and methodology spine from `workGraph.ranker`;
- hot similarity/topic env status and last fast-path decision;
- content-lane queue size and oldest dirty source age;
- reconcile runner mode: in-process, child process, or worker thread.

## Implementation order

1. Extend the companion health/focus-health adapter to expose drift and candidate lane rows without changing any serving behavior.
2. Add the HealthPanel "Experiments" drill-down and alarm derivation from candidate rows.
3. Add unit tests for no-signal, disabled, warning, and active-failure render states.
4. Only after the panel is trustworthy, consider promotion logic or user-facing A/B surfaces.

This keeps the current architecture honest: diagnostics explain what would change before any candidate is allowed to change the product experience.
