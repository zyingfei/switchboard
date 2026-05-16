# Closest-Visit Ranker v3 Dogfood Verification (2026-05-16)

## Context

This note records the real-vault verification of PR #183 (`ranker/methodology-spine`) against the failure described in [`ranker-snapshot-diagnostics-2026-05-16.md`](./ranker-snapshot-diagnostics-2026-05-16.md).

The earlier v2 dogfood snapshot emitted `596` `closest_visit` edges. All `596 / 596` were same-workstream, `0 / 596` were strictly net-new, and `user_asserted_in_workstream` dominated `595 / 596` top contributions. The v2 training set was also dominated by synthetic workstream-closure positives: `2698` positive labels and `497` negative labels.

PR #183 sits on top of PR #181 and changes the safety posture: stale v2/schema-2 manifests must not score under the v3/schema-3 runtime, workstream-identity features are not model inputs, and ship-gate status is persisted for diagnostics. Load-time enforcement of a non-pass ship gate is intentionally split out of PR #183 until CV-1/CV-2 make a gated-off ranker legible in health diagnostics.

## Procedure

1. Stopped the old `ranker-snapshot-diagnostics` companion process that was still serving v2 expectations and had `SIDETRACK_RANKER_RETRAIN_MIN_LABELS=999999`.
2. Built the PR #183 worktree:

   ```bash
   npx --yes bun@1.3.14 run --filter @sidetrack/companion build
   ```

3. Started the v3 companion against the real vault:

   ```bash
   cd /Users/yingfei/playground/playground/browser-ai-companion-ranker-spine/packages/sidetrack-companion
   env SIDETRACK_TOPIC_SHADOW_CANDIDATE=idf-rkn-split \
     SIDETRACK_CONNECTIONS_CHILD=1 \
     npx --yes bun@1.3.14 dist/cli.js \
     --vault /Users/yingfei/.sidetrack-vault \
     --port 17373
   ```

4. Waited for the connections materializer to rebuild.
5. Forced closest-visit retraining through the local API:

   ```bash
   BRIDGE=$(cat /Users/yingfei/.sidetrack-vault/_BAC/.config/bridge.key)
   curl -sS -X POST \
     -H "content-type: application/json" \
     -H "x-bac-bridge-key: $BRIDGE" \
     --data '{"force":true}' \
     http://127.0.0.1:17373/v1/connections/ranker/retrain
   ```

## Observed v3 Rebuild

After restart, the v3 materializer rebuilt the connections snapshot and reported the old active ranker as stale:

```text
nodes=2780 edges=9853 visits=829 engagementEligible=446
ranker=skipped:below-threshold
rankerAug=absent:stale-model-schema
rankerNeedsRetrain=true
closestVisit=0 rankerSource=0
labels=520(+218/-302)
shadow=idf-rkn-split shadowTopics=41 shadowMax=32 shadowNoise=0.435696
```

Latest observed post-run diagnostics were:

```json
{
  "producedAt": "2026-05-16T09:17:58.990Z",
  "ranker": {
    "status": "skipped",
    "reason": "below-threshold",
    "labelCount": 772,
    "positiveLabelCount": 218,
    "negativeLabelCount": 554,
    "newLabelCount": 0
  },
  "rankerAugmentation": {
    "status": "absent",
    "reason": "stale-model-schema",
    "activeRevisionId": "dd1eb74250435a9b",
    "activeModelVersion": "lightgbm-lambdamart-v2",
    "expectedModelVersion": "lightgbm-lambdamart-v3",
    "activeFeatureSchemaVersion": 2,
    "expectedFeatureSchemaVersion": 3,
    "needsRetrain": true,
    "baseEdgeCount": 9840,
    "finalEdgeCount": 9840,
    "closestVisitEdgeCount": 0,
    "rankerSourceEdgeCount": 0
  }
}
```

The active manifest on disk still points at `dd1eb74250435a9b`, but v3 rejects it because the manifest is `lightgbm-lambdamart-v2` / feature schema `2`, while the runtime expects `lightgbm-lambdamart-v3` / feature schema `3`.

## Forced Retrain Result

The forced retrain ran for approximately `28m15s` and did not write a v3 active revision:

```json
{
  "status": "failed",
  "error": "ranker training requires at least one query group with positive and negative labels",
  "fingerprint": {
    "hash": "5eda7d845bf56c2daf6bdcc1bcec99af90bd9dabd7f0c10ad57b180cfb37b3ff",
    "labelCount": 520,
    "positiveLabelCount": 218,
    "negativeLabelCount": 302
  },
  "newLabelCount": 0,
  "candidateCount": 62643
}
```

This is an important distinction: the PR improves safety by preventing the leaky v2 model from scoring, but the current real vault does not yet contain enough genuine visit-to-visit supervision to train a replacement learned ranker. In this state, `closest_visit` correctly stays silent rather than emitting same-workstream duplicates.

## Post-#186 Retry Result

After PR #186 merged, the companion was restarted from
`origin/main` `b8dff3b2` so `/v1/system/health` exposed the new
`ranker.methodologySpine` and
`ranker.augmentation.methodologySpine` health fields. The active
ranker on disk was still:

```json
{
  "activeRevisionId": "dd1eb74250435a9b",
  "activeModelVersion": "lightgbm-lambdamart-v2",
  "expectedModelVersion": "lightgbm-lambdamart-v3",
  "loadStatus": "invalid-model",
  "rankerAugmentationReason": "stale-model-schema"
}
```

A second forced retrain ran for approximately `1325s` and failed
before writing a v3 active revision:

```json
{
  "status": "failed",
  "error": "ranker training requires at least one query group with positive and negative labels",
  "fingerprint": {
    "hash": "ed14cb57cff3fdab2dba71fc2e7fb9bb4cd0fb38cd84138ae72870c89c476d9b",
    "labelCount": 790,
    "positiveLabelCount": 218,
    "negativeLabelCount": 572
  },
  "newLabelCount": 0,
  "candidateCount": 63864
}
```

A follow-up inspection of the actual training rows showed:

```json
{
  "events": 47835,
  "snapshot": { "nodes": 2804, "edges": 9928 },
  "candidates": 63864,
  "labelingSummary": {
    "totalCandidates": 63864,
    "labeledRows": 1075,
    "positiveRows": 0,
    "negativeRows": 1075,
    "implicitNegativeRows": 655,
    "unlabeledCandidateCount": 62789
  },
  "groupCounts": {
    "total": 151,
    "usable": 0,
    "posOnly": 0,
    "negOnly": 151
  },
  "generatedAtDistinctInRows": 136
}
```

This changes the operational diagnosis. The batch-stamp/split concern
is not the immediate dogfood blocker because labeled rows already have
many distinct timestamps. The blocker is that no positive feedback
labels resolve into positive candidate rows. The real-vault positive
labels are mostly item/container-shaped labels from
`user.organized.item`, while training rows are visit-pair candidates.
With the old workstream-closure expansion intentionally removed, the
ranker has negative rows but no usable query group with at least one
positive and one negative label.

Do not "fix" this by restoring `in_workstream` all-pairs closure. The
next safe engineering slice is a cheap preflight that returns quickly
with `no-usable-query-groups` diagnostics before LightGBM/tuning work
starts. The next modeling/product decision is which positive evidence
is legitimate enough to expand into visit-to-visit supervision without
reintroducing the #179 leak.

## Post-#187 Fast-Fail Result

PR #187 added a structural retrain preflight before candidate
generation. Running the same real-vault forced retrain against that
branch returned immediately:

```json
{
  "status": "skipped",
  "reason": "no-usable-query-groups",
  "fingerprint": {
    "hash": "2bcc5fbfe3c7f874358825a61348548ee16ca7452eab8e05ed1844fed7234f84",
    "labelCount": 790,
    "positiveLabelCount": 218,
    "negativeLabelCount": 572
  },
  "newLabelCount": 0,
  "candidateCount": 0
}
```

This confirms #187 fixed the expensive failure mode: the vault still
lacks trainable positive visit-pair supervision, but the companion no
longer spends tens of minutes generating and featurizing candidates
before discovering that fact.

## Conclusion

The verification confirms the core safety improvement over the v2
diagnostic failure, and the post-#186 retry narrows the remaining
blocker:

| Check | v2 diagnostic | v3 dogfood |
|---|---:|---:|
| Active ranker accepted for scoring | yes | no, stale schema rejected |
| `closest_visit` edges emitted | 596 | 0 |
| ranker-produced edges | 596 | 0 |
| same-workstream emitted share | 596 / 596 | n/a |
| strictly net-new emitted share | 0 / 596 | n/a |
| positive labels available | 2698 synthetic-heavy | 218 non-closure labels |
| positive training rows after row-building | synthetic-heavy | 0 in the post-#186 retry |
| negative training rows after row-building | 497 labels | 1075 rows in the post-#186 retry |
| distinct labeled-row timestamps | not evaluated | 136 in the post-#186 retry |
| usable query groups | tautologically separable | 0 |
| post-#187 forced retrain | n/a | `skipped:no-usable-query-groups`, `candidateCount: 0` |
| v3 replacement model written | n/a | no |

This should be treated as a safe-block result, not a quality win for
emitted ranking. The cheap preflight is now landed via #187. The next
product/data requirement is more genuine visit-to-visit positive
supervision if `closest_visit` is expected to emit learned edges again.
