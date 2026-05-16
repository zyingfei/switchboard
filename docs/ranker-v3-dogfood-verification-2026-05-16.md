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

## Conclusion

The verification confirms the core safety improvement over the v2 diagnostic failure:

| Check | v2 diagnostic | v3 PR #183 dogfood |
|---|---:|---:|
| Active ranker accepted for scoring | yes | no, stale schema rejected |
| `closest_visit` edges emitted | 596 | 0 |
| ranker-produced edges | 596 | 0 |
| same-workstream emitted share | 596 / 596 | n/a |
| strictly net-new emitted share | 0 / 596 | n/a |
| positive labels used by retrain | 2698 synthetic-heavy | 218 non-closure positives |
| negative labels used by retrain | 497 | 302 during forced run; 554 in latest diagnostics |
| v3 replacement model written | n/a | no |

This should be treated as a safe-block result, not a quality win for emitted ranking. The next engineering fix is to add a cheap preflight for "no usable query group with both positive and negative labels" before LightGBM/tuning work starts. The next product/data requirement is more genuine visit-to-visit positive supervision if `closest_visit` is expected to emit learned edges again.
