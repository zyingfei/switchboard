// T1-F (full recent-feature product e2e) orchestration helpers per
// docs/tab-session-attribution/PHASES.md §"Phase 7".
//
// The orchestrator emits one T1ProductBehaviorCheck per required caseId.
// The contract is: T1-F passes only when every required caseId is `pass`.
// Cases that depend on real-browser UI hooks not yet wired return `fail`
// with `summary: "pending implementation"` and a concrete `details` reason.

import type { TestCompanion } from './companion';
import { companionGet, type T1ProductBehaviorCheck } from './recordReplay';

export const T1F_MODE = 'T1-F full product e2e' as const;

export const T1F_REQUIRED_CASE_IDS = [
  'full-observed-A-to-B',
  'full-inbox-user-assertion-B-to-A',
  'full-same-url-visit-instance-no-leak',
  'full-resolver-dryrun-no-write',
  'full-ppr-causal-beats-similarity',
  'full-cluster-target-local-or-absent',
  'full-autoapply-ClassE',
  'full-user-assertion-overrides-inferred',
  'full-tabgroup-pull-in-out',
  'full-active-pointer-not-truth',
  'full-focused-tab-cue-uses-session-id',
  'full-non-ai-not-all-threads',
  'full-redaction-regression',
  'full-graph-determinism',
] as const;

export type T1FRequiredCaseId = (typeof T1F_REQUIRED_CASE_IDS)[number];

export interface T1FStatus {
  readonly status: 'pass' | 'fail';
  readonly missing: readonly string[];
  readonly failed: readonly string[];
}

export const isT1FullProductEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env['SIDETRACK_T1_FULL_PRODUCT_E2E'] === '1';

export const buildPendingT1FCheck = (
  caseId: T1FRequiredCaseId,
  reason: string,
): T1ProductBehaviorCheck => ({
  mode: T1F_MODE,
  caseId,
  status: 'fail',
  summary: 'pending implementation',
  details: [reason],
});

export const buildPassT1FCheck = (
  caseId: T1FRequiredCaseId,
  summary: string,
  details: readonly string[] = [],
): T1ProductBehaviorCheck => ({
  mode: T1F_MODE,
  caseId,
  status: 'pass',
  summary,
  details,
});

export const buildFailT1FCheck = (
  caseId: T1FRequiredCaseId,
  summary: string,
  details: readonly string[] = [],
): T1ProductBehaviorCheck => ({
  mode: T1F_MODE,
  caseId,
  status: 'fail',
  summary,
  details,
});

export const computeT1FStatus = (
  productBehavior: readonly T1ProductBehaviorCheck[],
): T1FStatus => {
  const t1f = productBehavior.filter((c) => c.mode === T1F_MODE);
  const seen = new Set(t1f.map((c) => c.caseId));
  const missing = T1F_REQUIRED_CASE_IDS.filter((id) => !seen.has(id));
  const failed = t1f.filter((c) => c.status !== 'pass').map((c) => c.caseId);
  const status = missing.length === 0 && failed.length === 0 ? 'pass' : 'fail';
  return { status, missing, failed };
};

export interface T1FHarness {
  readonly companionA: TestCompanion;
  readonly companionB: TestCompanion;
  readonly redactionRegressionPassed: boolean;
}

interface ConnectionsSnapshot {
  readonly data: {
    readonly snapshot: {
      readonly nodes: readonly { readonly id: string; readonly kind: string; readonly key: string }[];
      readonly edges: readonly {
        readonly kind: string;
        readonly fromNodeId: string;
        readonly toNodeId: string;
      }[];
      readonly graphRevision?: string;
    };
  };
}

interface TabSessionProjectionSnapshot {
  readonly data: {
    readonly bySessionId: Record<string, unknown>;
  };
}

const runRedactionRegressionCheck = (harness: T1FHarness): T1ProductBehaviorCheck => {
  if (harness.redactionRegressionPassed) {
    return buildPassT1FCheck(
      'full-redaction-regression',
      'pack + replay body redaction assertions from the parent two-browser flow remained green',
    );
  }
  return buildFailT1FCheck(
    'full-redaction-regression',
    'parent two-browser redaction assertions failed; T1-F inherits that failure',
  );
};

const runGraphDeterminismCheck = async (harness: T1FHarness): Promise<T1ProductBehaviorCheck> => {
  try {
    const a = (await companionGet(harness.companionA, '/v1/connections')) as ConnectionsSnapshot;
    const b = (await companionGet(harness.companionA, '/v1/connections')) as ConnectionsSnapshot;
    const aEdges = a.data.snapshot.edges.length;
    const bEdges = b.data.snapshot.edges.length;
    const aNodes = a.data.snapshot.nodes.length;
    const bNodes = b.data.snapshot.nodes.length;
    if (aEdges !== bEdges || aNodes !== bNodes) {
      return buildFailT1FCheck(
        'full-graph-determinism',
        'two consecutive Connections rebuilds on Companion A diverged',
        [
          `nodes: first=${String(aNodes)} second=${String(bNodes)}`,
          `edges: first=${String(aEdges)} second=${String(bEdges)}`,
        ],
      );
    }
    return buildPassT1FCheck(
      'full-graph-determinism',
      `two consecutive Connections rebuilds on Companion A produced ${String(aNodes)} nodes / ${String(aEdges)} edges`,
    );
  } catch (err) {
    return buildFailT1FCheck(
      'full-graph-determinism',
      `Connections rebuild check failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};

const runActivePointerNotTruthCheck = async (
  harness: T1FHarness,
): Promise<T1ProductBehaviorCheck> => {
  try {
    const snap = (await companionGet(
      harness.companionA,
      '/v1/connections',
    )) as ConnectionsSnapshot;
    const visitInWorkstream = snap.data.snapshot.edges.filter(
      (edge) => edge.kind === 'visit_in_workstream',
    );
    // Phase 1+2 contract: visit_in_workstream may exist, but only via the
    // tab-session attribution projection — never via the active-pointer stamp.
    // We can't distinguish the two here without per-edge metadata, so we
    // only assert the URL-aggregate edge form is absent (Phase 7 visit-instance
    // identity), and let `full-same-url-visit-instance-no-leak` carry the
    // affirmative invariant.
    const urlAggregate = visitInWorkstream.filter((edge) =>
      edge.fromNodeId.startsWith('timeline-visit:'),
    );
    if (urlAggregate.length === 0) {
      return buildPassT1FCheck(
        'full-active-pointer-not-truth',
        'no URL-aggregate visit_in_workstream edges materialized from active-pointer state',
      );
    }
    return buildFailT1FCheck(
      'full-active-pointer-not-truth',
      `${String(urlAggregate.length)} URL-aggregate visit_in_workstream edges present; active pointer must not produce graph truth`,
      urlAggregate.slice(0, 5).map((e) => `${e.fromNodeId} → ${e.toNodeId}`),
    );
  } catch (err) {
    return buildFailT1FCheck(
      'full-active-pointer-not-truth',
      `Connections fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};

const runObservedAToBCheck = async (harness: T1FHarness): Promise<T1ProductBehaviorCheck> => {
  try {
    const a = (await companionGet(
      harness.companionA,
      '/v1/tabsessions/projection',
    )) as TabSessionProjectionSnapshot;
    const b = (await companionGet(
      harness.companionB,
      '/v1/tabsessions/projection',
    )) as TabSessionProjectionSnapshot;
    const aIds = Object.keys(a.data.bySessionId).sort();
    const bIds = Object.keys(b.data.bySessionId).sort();
    const overlap = aIds.filter((id) => bIds.includes(id));
    if (aIds.length === 0) {
      return buildFailT1FCheck(
        'full-observed-A-to-B',
        'Companion A projection has no tab sessions; setup likely failed before T1-F started',
      );
    }
    if (overlap.length === 0) {
      return buildFailT1FCheck(
        'full-observed-A-to-B',
        'no A-origin tab sessions reached Companion B via relay',
        [`A sessions: ${String(aIds.length)}`, `B sessions: ${String(bIds.length)}`],
      );
    }
    return buildPassT1FCheck(
      'full-observed-A-to-B',
      `${String(overlap.length)} of ${String(aIds.length)} A-origin sessions visible on Companion B`,
    );
  } catch (err) {
    return buildFailT1FCheck(
      'full-observed-A-to-B',
      `projection fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};

export const runT1FullProductE2ECases = async (
  harness: T1FHarness,
): Promise<readonly T1ProductBehaviorCheck[]> => {
  const checks: T1ProductBehaviorCheck[] = [];

  checks.push(await runObservedAToBCheck(harness));
  checks.push(
    buildPendingT1FCheck(
      'full-inbox-user-assertion-B-to-A',
      'requires real side-panel UI driver hook; sidepanel.ts does not yet expose Inbox card click APIs',
    ),
  );
  checks.push(
    buildPendingT1FCheck(
      'full-same-url-visit-instance-no-leak',
      'requires fixture wiring of two same-canonical-URL sessions through real chrome.tabs navigations + visit_instance_in_workstream edge introspection',
    ),
  );
  checks.push(
    buildPendingT1FCheck(
      'full-resolver-dryrun-no-write',
      'requires GET /v1/tabsessions/{id}/resolve?dryRun=true integration + InferredOpinions stream count delta assertion',
    ),
  );
  checks.push(
    buildPendingT1FCheck(
      'full-ppr-causal-beats-similarity',
      'requires fixture with both causal and similarity evidence + dominantSource assertion in fusedCandidates',
    ),
  );
  checks.push(
    buildPendingT1FCheck(
      'full-cluster-target-local-or-absent',
      'requires topic_in_workstream fixture or explicit assertion that resolver does not consume global topic popularity',
    ),
  );
  checks.push(
    buildPendingT1FCheck(
      'full-autoapply-ClassE',
      'requires POST /v1/tabsessions/{id}/resolve dryRun:false integration + accepted.type === tabsession.attribution.inferred check',
    ),
  );
  checks.push(
    buildPendingT1FCheck(
      'full-user-assertion-overrides-inferred',
      'requires sequence: auto-apply Class E → user.organized.item Class A → assert currentAttribution.source === user_asserted',
    ),
  );
  checks.push(
    buildPendingT1FCheck(
      'full-tabgroup-pull-in-out',
      'requires real chrome.tabs.group/ungroup driver + chrome.tabs.onUpdated(changeInfo.groupId) observation in Playwright',
    ),
  );
  checks.push(await runActivePointerNotTruthCheck(harness));
  checks.push(
    buildPendingT1FCheck(
      'full-focused-tab-cue-uses-session-id',
      'requires side-panel DOM assertion that "Tab is in: <pill>" cue resolves via activeTabSessionId before URL fallback',
    ),
  );
  checks.push(
    buildPendingT1FCheck(
      'full-non-ai-not-all-threads',
      'requires side-panel All Threads list inspection after non-AI page observation',
    ),
  );
  checks.push(runRedactionRegressionCheck(harness));
  checks.push(await runGraphDeterminismCheck(harness));

  return checks;
};
