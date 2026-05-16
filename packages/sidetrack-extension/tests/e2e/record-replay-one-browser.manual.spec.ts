/* eslint-disable @typescript-eslint/dot-notation, no-empty-pattern */

// T1 Wave 2a manual smoke — one-browser record/replay vertical slice.
//
// Run from packages/sidetrack-extension:
//   SIDETRACK_TEST_SESSIONS_DIR=/tmp/t1-smoke \
//     bunx --bun --no-install playwright test tests/e2e/record-replay-one-browser.manual.spec.ts \
//     --headed --timeout 0 --grep manual
//
// This spec records a minimal local session pack, writes it under
// SIDETRACK_TEST_SESSIONS_DIR, replays the pack in a fresh browser +
// companion through chrome.tabs navigations and route stubs, then
// writes report.md + report.json under the pack's per-run folder.

import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { startTestCompanion, type TestCompanion } from './helpers/companion';
import { ManualRecorder } from './helpers/manualRecorder';
import {
  assertNoDisallowedStorageValues,
  assertPackPrivacy,
  companionGet,
  companionPost,
  createMinimalOneBrowserPack,
  createSessionPackFromManualRecorder,
  driveReplayFromPack,
  evaluateOneBrowserReplay,
  firstBrowser,
  forceDrainTimeline,
  installRouteStubsForPack,
  installRouteStubsForWorkflow,
  loadTabSessionCaseFixtures,
  readChromeStorageSnapshot,
  readSessionPack,
  readSidetrackVersion,
  readTimeline,
  readTimelineReplayDiagnostics,
  recordedCanonicalUrls,
  redactHtmlForSessionPack,
  resolveCaptureLevel,
  resolveTestSessionsDir,
  TIMELINE_REPLAY_DEBUG_STORAGE_KEY,
  t1AutoApplyDisabled,
  t1ExplicitAttributionFixtureEnabled,
  t1InboxUxReplayEnabled,
  t1ResolverTabGroupReplayEnabled,
  timelineReplayDebugEnabled,
  waitForReplaySurfaces,
  writeReplayReport,
  writeSessionPack,
  type CaptureLevel,
  type MinimalWorkflowStep,
  type SessionPack,
  type T1ProductBehaviorCheck,
} from './helpers/recordReplay';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import { SETTINGS_KEY, SETUP_KEY, WORKSTREAMS_KEY } from './helpers/sidepanel';

const ACTIVE_WORKSTREAM_ID = 'ws_t1_record_replay_2a';
const SECONDARY_WORKSTREAM_ID = 'ws_t1_record_replay_secondary';

const WORKFLOW: readonly MinimalWorkflowStep[] = [
  {
    url: 'https://example.test/t1/record-replay?keep=1&token=secret#private',
    title: 'T1 record/replay charter',
    provider: 'generic',
  },
  {
    url: 'https://example.test/t1/record-replay?keep=1&token=secret#private',
    title: 'T1 record/replay charter — second tab',
    provider: 'generic',
  },
  {
    url: 'https://www.google.com/search?q=sidetrack+record+replay&code=oauth-code',
    title: 'Sidetrack record replay search',
    provider: 'generic',
  },
  {
    url: 'https://chatgpt.com/c/t1-record-replay-thread?session=private',
    title: 'ChatGPT - T1 replay thread',
    provider: 'chatgpt',
  },
];

const REPLAY_PACK_PATH = process.env['SIDETRACK_REPLAY_PACK'];
const REPLAY_REPORT_DIR = process.env['SIDETRACK_REPLAY_REPORT_DIR'];
const STRICT_OFFLINE = process.env['SIDETRACK_REPLAY_STRICT_OFFLINE'] === '1';
const APPLY_EXPLICIT_ATTRIBUTION_FIXTURE = t1ExplicitAttributionFixtureEnabled();
const RUN_INBOX_UX_REPLAY = t1InboxUxReplayEnabled();
const RUN_RESOLVER_TABGROUP_REPLAY = t1ResolverTabGroupReplayEnabled();
const AUTO_APPLY_DISABLED = t1AutoApplyDisabled();

const T1_WORKSTREAMS = [
  {
    bac_id: ACTIVE_WORKSTREAM_ID,
    revision: 'rev_t1_record_replay_2a',
    title: 'Sidetrack T1',
    children: [],
    tags: [],
    checklist: [],
    privacy: 'shared',
    updatedAt: '2026-05-10T00:00:00.000Z',
  },
  {
    bac_id: SECONDARY_WORKSTREAM_ID,
    revision: 'rev_t1_record_replay_secondary',
    title: 'Sidetrack Secondary',
    children: [],
    tags: [],
    checklist: [],
    privacy: 'shared',
    updatedAt: '2026-05-10T00:00:00.000Z',
  },
] as const;

const settingsFor = (companion: TestCompanion) => ({
  companion: { port: companion.port, bridgeKey: companion.bridgeKey },
  autoTrack: false,
  siteToggles: { chatgpt: true, claude: true, gemini: true },
  notifyOnQueueComplete: true,
});

const seedTimelineRuntime = async (
  runtime: ExtensionRuntime,
  companion: TestCompanion,
): Promise<{ readonly panel: Page }> => {
  const panel = await runtime.context.newPage();
  await panel.goto(`chrome-extension://${runtime.extensionId}/sidepanel.html`, {
    waitUntil: 'domcontentloaded',
  });
  // Note: ACTIVE_WORKSTREAM_STORAGE_KEY is intentionally NOT included
  // in seedStorage. Writing it via panel.evaluate is racy with the
  // SW's refreshActiveWorkstreamCache (the cross-context propagation
  // can lose to the next chrome.tabs.onUpdated). Instead, we pass
  // the workstream id THROUGH the reinit message below so the SW
  // writes storage from its own context, atomic with the refresh
  // call inside initializeTimelineWiring.
  await runtime.seedStorage(panel, {
    [SETUP_KEY]: true,
    [SETTINGS_KEY]: settingsFor(companion),
    [WORKSTREAMS_KEY]: T1_WORKSTREAMS,
    'sidetrack.timeline.enabled': true,
    ...(timelineReplayDebugEnabled() ? { [TIMELINE_REPLAY_DEBUG_STORAGE_KEY]: true } : {}),
  });
  await panel.reload({ waitUntil: 'domcontentloaded' });
  await expect(panel.getByRole('main', { name: 'Sidetrack workboard' })).toBeVisible({
    timeout: 30_000,
  });
  const reinitResult = await runtime.sendRuntimeMessage(panel, {
    type: 'sidetrack.timeline.reinit',
    activeWorkstreamId: ACTIVE_WORKSTREAM_ID,
  });
  expect((reinitResult as { ok?: boolean } | null)?.ok).toBe(true);
  return { panel };
};

const logTimelineReplayDiagnostics = async (
  runtime: ExtensionRuntime,
  panel: Page,
  label: string,
): Promise<void> => {
  if (!timelineReplayDebugEnabled()) return;
  const diagnostics = await readTimelineReplayDiagnostics(runtime, panel);
  // eslint-disable-next-line no-console
  console.log(`[record-replay:timeline-diagnostics:${label}] ${JSON.stringify(diagnostics)}`);
};

const canonicalForTimelineItem = (input: string): string =>
  input.length > 1 && input.endsWith('/') ? input.slice(0, -1) : input;

interface T1TabSessionRecord {
  readonly tabSessionId: string;
  readonly latestUrl?: string;
  readonly currentAttribution?: {
    readonly workstreamId: string | null;
    readonly source: string;
  };
  readonly attributionHistory: readonly {
    readonly workstreamId: string | null;
    readonly source: string;
  }[];
}

interface T1TabSessionProjection {
  readonly bySessionId: Record<string, T1TabSessionRecord>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readTabSessionProjection = async (
  companion: TestCompanion,
): Promise<T1TabSessionProjection> => {
  const body = await companionGet(companion, '/v1/tabsessions/projection');
  const data = isRecord(body) ? body['data'] : undefined;
  if (!isRecord(data) || !isRecord(data['bySessionId'])) {
    throw new Error('Companion returned an invalid tab-session projection.');
  }
  return { bySessionId: data['bySessionId'] as Record<string, T1TabSessionRecord> };
};

const tabSessionRecordsForCanonicals = (
  projection: T1TabSessionProjection,
  expectedUrls: readonly string[],
): readonly T1TabSessionRecord[] => {
  const expected = new Set(expectedUrls.map(canonicalForTimelineItem));
  return Object.values(projection.bySessionId)
    .filter((record) => {
      const url = record.latestUrl;
      return typeof url === 'string' && expected.has(canonicalForTimelineItem(url));
    })
    .sort((left, right) => left.tabSessionId.localeCompare(right.tabSessionId));
};

const pass = (
  mode: T1ProductBehaviorCheck['mode'],
  caseId: string,
  summary: string,
  details: readonly string[] = [],
): T1ProductBehaviorCheck => ({ mode, caseId, status: 'pass', summary, details });

const fail = (
  mode: T1ProductBehaviorCheck['mode'],
  caseId: string,
  summary: string,
  details: readonly string[],
): T1ProductBehaviorCheck => ({ mode, caseId, status: 'fail', summary, details });

const evaluateIdentityReplay = async (input: {
  readonly companion: TestCompanion;
  readonly expectedUrls: readonly string[];
}): Promise<readonly T1ProductBehaviorCheck[]> => {
  const timeline = await readTimeline(input.companion);
  const connections = (await companionGet(input.companion, '/v1/connections')) as {
    readonly data?: {
      readonly snapshot?: {
        readonly nodes?: readonly { readonly id?: string; readonly kind?: string }[];
        readonly edges?: readonly {
          readonly kind?: string;
          readonly fromNodeId?: string;
          readonly toNodeId?: string;
        }[];
      };
    };
  };
  const nodes = connections.data?.snapshot?.nodes ?? [];
  const edges = connections.data?.snapshot?.edges ?? [];
  const timelineItemsWithSessions = timeline.data.items.filter(
    (item) =>
      input.expectedUrls.includes(canonicalForTimelineItem(item.canonicalUrl ?? item.url)) &&
      item.tabSessionId !== undefined &&
      item.tabSessionId.length > 0,
  );
  const tabSessionNodes = nodes.filter((node) => node.id?.startsWith('tab-session:') === true);
  const visitInstanceEdges = edges.filter((edge) => edge.kind === 'visit_instance_in_tab_session');
  const sameUrlEdges = edges.filter(
    (edge) => edge.kind === 'visit_instance_same_url_as_timeline_visit',
  );
  const urlScopedWorkstreamEdges = edges.filter((edge) => edge.kind === 'visit_in_workstream');
  const details = [
    `timeline items with tabSessionId: ${String(timelineItemsWithSessions.length)}`,
    `tab-session nodes: ${String(tabSessionNodes.length)}`,
    `visit_instance_in_tab_session edges: ${String(visitInstanceEdges.length)}`,
    `visit_instance_same_url_as_timeline_visit edges: ${String(sameUrlEdges.length)}`,
    `URL-scoped visit_in_workstream edges: ${String(urlScopedWorkstreamEdges.length)}`,
  ];
  if (
    timelineItemsWithSessions.length === 0 ||
    tabSessionNodes.length === 0 ||
    visitInstanceEdges.length === 0 ||
    sameUrlEdges.length === 0 ||
    urlScopedWorkstreamEdges.length > 0
  ) {
    return [
      fail(
        'T1-A identity replay',
        'case-1-same-url-two-sessions',
        'identity replay failed',
        details,
      ),
      fail(
        'T1-A identity replay',
        'case-6-active-pointer-not-truth',
        'active pointer leaked',
        details,
      ),
    ];
  }
  return [
    pass(
      'T1-A identity replay',
      'case-1-same-url-two-sessions',
      'session-scoped visit identity held',
      details,
    ),
    pass(
      'T1-A identity replay',
      'case-6-active-pointer-not-truth',
      'active pointer did not create URL-scoped graph truth',
      details,
    ),
  ];
};

const applyExplicitAttributionFixture = async (
  companion: TestCompanion,
  pack: SessionPack,
  expectedUrls: readonly string[],
): Promise<readonly T1ProductBehaviorCheck[]> => {
  if (!APPLY_EXPLICIT_ATTRIBUTION_FIXTURE) return [];
  const workstreamId = firstBrowser(pack).activeWorkstreamId;
  if (workstreamId === null) {
    throw new Error('Explicit tab-session attribution fixture requires an active workstream id.');
  }
  const projection = await readTabSessionProjection(companion);
  const records = tabSessionRecordsForCanonicals(projection, expectedUrls);
  const attributed = new Set<string>();
  for (const record of records) {
    const tabSessionId = record.tabSessionId;
    if (attributed.has(tabSessionId)) continue;
    await companionPost(
      companion,
      `/v1/tabsessions/${encodeURIComponent(tabSessionId)}/attribute`,
      {
        workstreamId,
      },
    );
    attributed.add(tabSessionId);
  }
  const after = await readTabSessionProjection(companion);
  const afterRecords = [...attributed].map((tabSessionId) => after.bySessionId[tabSessionId]);
  const missing = afterRecords.filter(
    (record) => record?.currentAttribution?.workstreamId !== workstreamId,
  );
  let tabSessionEdges = 0;
  let visitInstanceEdges = 0;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const body = (await companionGet(companion, '/v1/connections')) as {
      readonly data?: {
        readonly snapshot?: {
          readonly edges?: readonly {
            readonly kind?: string;
            readonly fromNodeId?: string;
            readonly toNodeId?: string;
          }[];
        };
      };
    };
    const edges = body.data?.snapshot?.edges ?? [];
    tabSessionEdges = edges.filter(
      (edge) =>
        edge.kind === 'tab_session_in_workstream' &&
        attributed.has((edge.fromNodeId ?? '').replace(/^tab-session:/u, '')) &&
        edge.toNodeId === `workstream:${workstreamId}`,
    ).length;
    visitInstanceEdges = edges.filter(
      (edge) =>
        edge.kind === 'visit_instance_in_workstream' &&
        edge.toNodeId === `workstream:${workstreamId}`,
    ).length;
    if (tabSessionEdges >= attributed.size && visitInstanceEdges >= attributed.size) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const details = [
    ...[...attributed].sort(),
    `tab_session_in_workstream=${String(tabSessionEdges)}`,
    `visit_instance_in_workstream=${String(visitInstanceEdges)}`,
  ];
  return missing.length === 0 &&
    attributed.size > 0 &&
    tabSessionEdges >= attributed.size &&
    visitInstanceEdges >= attributed.size
    ? [
        pass(
          'T1-B explicit attribution replay',
          'case-1-same-url-two-sessions',
          `explicit fixture attributed ${String(attributed.size)} tab session(s)`,
          details,
        ),
      ]
    : [
        fail(
          'T1-B explicit attribution replay',
          'case-1-same-url-two-sessions',
          'explicit attribution fixture did not materialize',
          [...missing.map((record) => record?.tabSessionId ?? '<missing record>'), ...details],
        ),
      ];
};

const waitForProjection = async (
  companion: TestCompanion,
  predicate: (projection: T1TabSessionProjection) => boolean,
): Promise<T1TabSessionProjection> => {
  let last = await readTabSessionProjection(companion);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    last = await readTabSessionProjection(companion);
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return last;
};

const runInboxUxReplay = async (input: {
  readonly panel: Page;
  readonly companion: TestCompanion;
  readonly expectedUrls: readonly string[];
}): Promise<readonly T1ProductBehaviorCheck[]> => {
  if (!RUN_INBOX_UX_REPLAY) return [];
  const before = await readTabSessionProjection(input.companion);
  const records = tabSessionRecordsForCanonicals(before, input.expectedUrls);
  const [assigned, dismissed, unassigned] = records;
  if (assigned === undefined || dismissed === undefined || unassigned === undefined) {
    return [
      fail(
        'T1-C inbox UX replay',
        'case-2-real-inbox-assignment',
        'not enough tab sessions for three-card UX case',
        [`records: ${records.map((record) => record.tabSessionId).join(', ')}`],
      ),
    ];
  }

  await input.panel.bringToFront();
  await input.panel.reload({ waitUntil: 'domcontentloaded' });
  await input.panel.getByRole('tab', { name: 'Inbox' }).click();
  await expect(input.panel.getByTestId(`tab-session-card-${assigned.tabSessionId}`)).toBeVisible({
    timeout: 30_000,
  });
  const assignedCard = input.panel.getByTestId(`tab-session-card-${assigned.tabSessionId}`);
  await assignedCard.getByRole('combobox').selectOption(ACTIVE_WORKSTREAM_ID);
  await assignedCard.getByRole('button', { name: 'Move' }).click();
  await waitForProjection(
    input.companion,
    (projection) =>
      projection.bySessionId[assigned.tabSessionId]?.currentAttribution?.workstreamId ===
      ACTIVE_WORKSTREAM_ID,
  );

  await input.panel.reload({ waitUntil: 'domcontentloaded' });
  await input.panel.getByRole('tab', { name: 'Inbox' }).click();
  const dismissedCard = input.panel.getByTestId(`tab-session-card-${dismissed.tabSessionId}`);
  await expect(dismissedCard).toBeVisible({ timeout: 30_000 });
  await dismissedCard.getByRole('button', { name: 'Not in any workstream' }).click();
  const after = await waitForProjection(
    input.companion,
    (projection) =>
      projection.bySessionId[dismissed.tabSessionId]?.currentAttribution?.workstreamId === null,
  );
  const assignedOk =
    after.bySessionId[assigned.tabSessionId]?.currentAttribution?.workstreamId ===
    ACTIVE_WORKSTREAM_ID;
  const dismissedOk =
    after.bySessionId[dismissed.tabSessionId]?.currentAttribution?.workstreamId === null;
  const unassignedOk = after.bySessionId[unassigned.tabSessionId]?.currentAttribution === undefined;
  const details = [
    `assigned=${assigned.tabSessionId}:${String(assignedOk)}`,
    `dismissed=${dismissed.tabSessionId}:${String(dismissedOk)}`,
    `unassigned=${unassigned.tabSessionId}:${String(unassignedOk)}`,
  ];
  return assignedOk && dismissedOk && unassignedOk
    ? [
        pass(
          'T1-C inbox UX replay',
          'case-2-real-inbox-assignment',
          'real Inbox UI assigned/dismissed/left cards correctly',
          details,
        ),
      ]
    : [
        fail(
          'T1-C inbox UX replay',
          'case-2-real-inbox-assignment',
          'Inbox UI state did not match expected assignments',
          details,
        ),
      ];
};

const firstSameUrlPair = (
  records: readonly T1TabSessionRecord[],
): readonly [T1TabSessionRecord, T1TabSessionRecord] | null => {
  const byUrl = new Map<string, T1TabSessionRecord[]>();
  for (const record of records) {
    if (record.latestUrl === undefined) continue;
    const key = canonicalForTimelineItem(record.latestUrl);
    const list = byUrl.get(key) ?? [];
    list.push(record);
    byUrl.set(key, list);
  }
  for (const list of byUrl.values()) {
    if (list.length >= 2 && list[0] !== undefined && list[1] !== undefined) {
      return [list[0], list[1]];
    }
  }
  return null;
};

const runResolverTabGroupReplay = async (input: {
  readonly runtime: ExtensionRuntime;
  readonly panel: Page;
  readonly companion: TestCompanion;
  readonly expectedUrls: readonly string[];
}): Promise<readonly T1ProductBehaviorCheck[]> => {
  if (!RUN_RESOLVER_TABGROUP_REPLAY) return [];
  const checks: T1ProductBehaviorCheck[] = [];
  const before = await readTabSessionProjection(input.companion);
  const pair = firstSameUrlPair(tabSessionRecordsForCanonicals(before, input.expectedUrls));
  if (pair === null) {
    return [
      fail(
        'T1-D resolver/tab-group replay',
        'case-3-resolver-dryrun-no-write',
        'no same-URL tab-session pair was available',
        [],
      ),
    ];
  }
  const [anchor, target] = pair;
  await companionPost(
    input.companion,
    `/v1/tabsessions/${encodeURIComponent(anchor.tabSessionId)}/attribute`,
    {
      workstreamId: ACTIVE_WORKSTREAM_ID,
    },
  );
  await waitForReplaySurfaces({
    companion: input.companion,
    expectedCanonicalUrls: input.expectedUrls,
  });

  const dryRunBody = (await companionGet(
    input.companion,
    `/v1/tabsessions/${encodeURIComponent(target.tabSessionId)}/resolve?dryRun=true`,
  )) as {
    readonly data?: {
      readonly decision?: { readonly action?: string; readonly workstreamId?: string };
      readonly fusedCandidates?: readonly {
        readonly workstreamId?: string;
        readonly dominantSource?: string;
        readonly reasons?: readonly unknown[];
      }[];
    };
  };
  const top = dryRunBody.data?.fusedCandidates?.[0];
  const dryRunOk =
    top?.workstreamId === ACTIVE_WORKSTREAM_ID &&
    typeof top.dominantSource === 'string' &&
    top.dominantSource !== 'none' &&
    (top.reasons?.length ?? 0) > 0;
  const projectionAfterDryRun = await readTabSessionProjection(input.companion);
  const dryRunWrote =
    projectionAfterDryRun.bySessionId[target.tabSessionId]?.currentAttribution?.source ===
    'inferred';
  checks.push(
    dryRunOk && !dryRunWrote
      ? pass(
          'T1-D resolver/tab-group replay',
          'case-3-resolver-dryrun-no-write',
          'resolver dry-run returned explainable candidates without inferred writes',
          [`top=${top.workstreamId}:${top.dominantSource}`],
        )
      : fail(
          'T1-D resolver/tab-group replay',
          'case-3-resolver-dryrun-no-write',
          'resolver dry-run failed or wrote inferred attribution',
          [`top=${JSON.stringify(top)}`, `dryRunWrote=${String(dryRunWrote)}`],
        ),
  );

  if (AUTO_APPLY_DISABLED) {
    const disabledProjection = await readTabSessionProjection(input.companion);
    const disabledOk =
      disabledProjection.bySessionId[target.tabSessionId]?.currentAttribution?.source !==
      'inferred';
    checks.push(
      disabledOk
        ? pass(
            'T1-D resolver/tab-group replay',
            'case-5-autoapply-policy-mode',
            'auto-apply disabled; no Class E write attempted',
            [`target=${target.tabSessionId}`],
          )
        : fail(
            'T1-D resolver/tab-group replay',
            'case-5-autoapply-policy-mode',
            'auto-apply disabled but inferred attribution was present',
            [`target=${target.tabSessionId}`],
          ),
    );
  } else {
    const autoBody = (await companionPost(
      input.companion,
      `/v1/tabsessions/${encodeURIComponent(target.tabSessionId)}/resolve`,
      { dryRun: false, policyMode: 'balanced' },
    )) as {
      readonly data?: {
        readonly status?: string;
        readonly projection?: T1TabSessionProjection;
      };
    };
    const applied =
      autoBody.data?.status === 'applied' &&
      autoBody.data.projection?.bySessionId[target.tabSessionId]?.currentAttribution?.source ===
        'inferred' &&
      autoBody.data.projection.bySessionId[target.tabSessionId]?.currentAttribution
        ?.workstreamId === ACTIVE_WORKSTREAM_ID;
    checks.push(
      applied
        ? pass(
            'T1-D resolver/tab-group replay',
            'case-5-autoapply-policy-mode',
            'balanced policy wrote Class E inferred attribution',
            [`target=${target.tabSessionId}`],
          )
        : fail(
            'T1-D resolver/tab-group replay',
            'case-5-autoapply-policy-mode',
            'balanced policy did not auto-apply strong evidence',
            [JSON.stringify(autoBody.data)],
          ),
    );
  }

  const [seedUrl, targetUrl] = input.expectedUrls;
  if (seedUrl === undefined || targetUrl === undefined) {
    checks.push(
      fail(
        'T1-D resolver/tab-group replay',
        'case-4-tabgroup-pull-in-out',
        'missing URLs for tab-group replay',
        [],
      ),
    );
    return checks;
  }
  const seedPage = await input.runtime.context.newPage();
  const targetPage = await input.runtime.context.newPage();
  try {
    await seedPage.goto(seedUrl, { waitUntil: 'domcontentloaded' });
    await targetPage.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await targetPage.bringToFront();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const result = (await input.runtime.sendRuntimeMessage(input.panel, {
      type: 'sidetrack.tabgroups.test.pull-in-out',
      seedUrl,
      targetUrl,
      workstreamId: ACTIVE_WORKSTREAM_ID,
    })) as { readonly ok?: boolean; readonly error?: string };
    const afterTabGroup = await waitForProjection(input.companion, (projection) =>
      Object.values(projection.bySessionId).some((record) =>
        record.attributionHistory.some((entry) => entry.source === 'tab-group-pull-out'),
      ),
    );
    const pullOutRecord = Object.values(afterTabGroup.bySessionId).find((record) =>
      record.attributionHistory.some((entry) => entry.source === 'tab-group-pull-out'),
    );
    const pullInRecord = Object.values(afterTabGroup.bySessionId).find((record) =>
      record.attributionHistory.some((entry) => entry.source === 'tab-group-pull-in'),
    );
    const tabGroupOk =
      result.ok === true &&
      pullInRecord !== undefined &&
      pullOutRecord !== undefined &&
      pullOutRecord.currentAttribution?.workstreamId === null;
    checks.push(
      tabGroupOk
        ? pass(
            'T1-D resolver/tab-group replay',
            'case-4-tabgroup-pull-in-out',
            'tab-group pull-in and pull-out events materialized',
            [
              `pullIn=${pullInRecord?.tabSessionId ?? '<none>'}`,
              `pullOut=${pullOutRecord?.tabSessionId ?? '<none>'}`,
            ],
          )
        : fail(
            'T1-D resolver/tab-group replay',
            'case-4-tabgroup-pull-in-out',
            'tab-group hook did not produce pull-in/pull-out attribution',
            [
              `hook=${JSON.stringify(result)}`,
              `pullIn=${pullInRecord?.tabSessionId ?? '<none>'}`,
              `pullOut=${pullOutRecord?.tabSessionId ?? '<none>'}`,
            ],
          ),
    );
  } finally {
    await seedPage.close().catch(() => undefined);
    await targetPage.close().catch(() => undefined);
  }

  return checks;
};

const runProductBehaviorModes = async (input: {
  readonly runtime: ExtensionRuntime;
  readonly panel: Page;
  readonly companion: TestCompanion;
  readonly pack: SessionPack;
  readonly expectedUrls: readonly string[];
}): Promise<{
  readonly surfaces: Awaited<ReturnType<typeof waitForReplaySurfaces>>;
  readonly checks: readonly T1ProductBehaviorCheck[];
}> => {
  const fixtures = await loadTabSessionCaseFixtures();
  const checks: T1ProductBehaviorCheck[] = [
    fixtures.length === 6
      ? pass(
          'T1-A identity replay',
          'phase-6-fixtures',
          'loaded all six tab-session T1 case fixtures',
          fixtures.map((fixture) => fixture.id),
        )
      : fail(
          'T1-A identity replay',
          'phase-6-fixtures',
          'fixture set is incomplete',
          fixtures.map((fixture) => fixture.id),
        ),
  ];
  await waitForReplaySurfaces({
    companion: input.companion,
    expectedCanonicalUrls: input.expectedUrls,
  });
  checks.push(
    ...(await evaluateIdentityReplay({
      companion: input.companion,
      expectedUrls: input.expectedUrls,
    })),
  );
  checks.push(
    ...(await runResolverTabGroupReplay({
      runtime: input.runtime,
      panel: input.panel,
      companion: input.companion,
      expectedUrls: input.expectedUrls,
    })),
  );
  checks.push(
    ...(await runInboxUxReplay({
      panel: input.panel,
      companion: input.companion,
      expectedUrls: input.expectedUrls,
    })),
  );
  checks.push(
    ...(await applyExplicitAttributionFixture(input.companion, input.pack, input.expectedUrls)),
  );
  return {
    surfaces: await waitForReplaySurfaces({
      companion: input.companion,
      expectedCanonicalUrls: input.expectedUrls,
    }),
    checks,
  };
};

test.describe('manual T1 Wave 2a one-browser record/replay', () => {
  test.skip(
    process.env['SIDETRACK_E2E_SKIP_LIVE_BROWSERS'] === '1',
    'set SIDETRACK_E2E_SKIP_LIVE_BROWSERS=1 to skip when CfT is unavailable',
  );
  test.setTimeout(240_000);

  let recordCompanion: TestCompanion | null = null;
  let replayCompanion: TestCompanion | null = null;
  let recordRuntime: ExtensionRuntime | null = null;
  let replayRuntime: ExtensionRuntime | null = null;

  test.afterEach(async () => {
    if (replayRuntime !== null) await replayRuntime.close();
    if (recordRuntime !== null) await recordRuntime.close();
    if (replayCompanion !== null) await replayCompanion.close();
    if (recordCompanion !== null) await recordCompanion.close();
    replayRuntime = null;
    recordRuntime = null;
    replayCompanion = null;
    recordCompanion = null;
  });

  const recordPack = async (input: {
    readonly captureLevel: CaptureLevel;
    readonly runtime: ExtensionRuntime;
    readonly sidetrackVersion: string;
    readonly activeWorkstreamId: string;
  }): Promise<SessionPack> => {
    if (input.captureLevel === 'minimal') {
      return await createMinimalOneBrowserPack({
        runtime: input.runtime,
        workflow: WORKFLOW,
        activeWorkstreamId: input.activeWorkstreamId,
        sidetrackVersion: input.sidetrackVersion,
      });
    }
    const sessionsRoot = resolveTestSessionsDir();
    await mkdir(sessionsRoot, { recursive: true });
    const artifactDir = path.join(sessionsRoot, `manual-2d-one-${String(Date.now())}`);
    await mkdir(artifactDir, { recursive: true });
    const recorder = new ManualRecorder(input.runtime.context, artifactDir, {
      captureScreenshots: false,
      captureTextSnapshots: false,
      recordTextValues: input.captureLevel === 'html+paste',
      transformHtmlSnapshot: ({ html }) => {
        const redacted = redactHtmlForSessionPack(html);
        return {
          html: redacted.htmlRedacted,
          redactionCounts: redacted.redactionCounts,
        };
      },
    });
    await recorder.install();
    for (const step of WORKFLOW) {
      const page = await input.runtime.context.newPage();
      await page.goto(step.url, { waitUntil: 'domcontentloaded' });
      await recorder.snapshotPage(page, 'wave-2d-record');
      await new Promise((resolve) => setTimeout(resolve, 200));
      await page.close();
    }
    return createSessionPackFromManualRecorder({
      captureLevel: input.captureLevel,
      sidetrackVersion: input.sidetrackVersion,
      browsers: [
        {
          label: 'A',
          activeWorkstreamId: input.activeWorkstreamId,
          events: await recorder.readEvents(),
          snapshots: await recorder.readSnapshotFiles(),
        },
      ],
    });
  };

  const replayPack = async (input: {
    readonly pack: SessionPack;
    readonly packPath: string;
  }): Promise<void> => {
    expect(input.pack.mode.browsers).toBe(1);
    replayCompanion = await startTestCompanion();
    replayRuntime = await launchExtensionRuntime({ forceLocalProfile: true });
    const { panel: replayPanel } = await seedTimelineRuntime(replayRuntime, replayCompanion);
    await logTimelineReplayDiagnostics(replayRuntime, replayPanel, 'after-seed');
    const routeTracker = await installRouteStubsForPack(replayRuntime.context, input.pack, {
      strictOffline: STRICT_OFFLINE,
    });
    const pageReplay = await driveReplayFromPack({
      runtime: replayRuntime,
      senderPage: replayPanel,
      pack: input.pack,
    });
    await logTimelineReplayDiagnostics(replayRuntime, replayPanel, 'after-page-replay');
    const expectedUrls = recordedCanonicalUrls(input.pack);
    const drain = await forceDrainTimeline(replayRuntime, replayPanel, expectedUrls.length);
    await logTimelineReplayDiagnostics(replayRuntime, replayPanel, 'after-force-drain');
    const product = await runProductBehaviorModes({
      runtime: replayRuntime,
      panel: replayPanel,
      companion: replayCompanion,
      pack: input.pack,
      expectedUrls,
    });
    const report = evaluateOneBrowserReplay({
      pack: input.pack,
      routeTracker,
      pageReplay,
      drain,
      timeline: product.surfaces.timeline,
      connections: product.surfaces.connections,
      productBehavior: product.checks,
      strictOffline: STRICT_OFFLINE,
    });
    const writtenReport = await writeReplayReport(path.dirname(input.packPath), report, {
      ...(REPLAY_REPORT_DIR === undefined ? {} : { reportDir: REPLAY_REPORT_DIR }),
    });
    // eslint-disable-next-line no-console
    console.log(`[sidetrack-test] report: ${writtenReport.markdownPath}`);
    // eslint-disable-next-line no-console
    console.log(`[sidetrack-test] report-json: ${writtenReport.jsonPath}`);
    expect(report.status).toBe('pass');
  };

  test('manual minimal pack records, replays, evaluates, and reports', async ({}, testInfo) => {
    expect(testInfo.project.name).toBe('manual');
    if (REPLAY_PACK_PATH !== undefined) {
      await replayPack({
        pack: await readSessionPack(REPLAY_PACK_PATH),
        packPath: REPLAY_PACK_PATH,
      });
      return;
    }
    const captureLevel = resolveCaptureLevel();

    recordCompanion = await startTestCompanion();
    recordRuntime = await launchExtensionRuntime({ forceLocalProfile: true });
    await installRouteStubsForWorkflow(recordRuntime.context, WORKFLOW, {
      strictOffline: STRICT_OFFLINE,
    });
    const { panel: recordPanel } = await seedTimelineRuntime(recordRuntime, recordCompanion);
    const storageBeforeRecording = await readChromeStorageSnapshot(recordPanel);

    const sidetrackVersion = await readSidetrackVersion();
    const draftPack = await recordPack({
      captureLevel,
      runtime: recordRuntime,
      activeWorkstreamId: ACTIVE_WORKSTREAM_ID,
      sidetrackVersion,
    });

    const recordDrain = await forceDrainTimeline(recordRuntime, recordPanel, WORKFLOW.length);
    expect(recordDrain.ok).toBe(true);
    await companionGet(recordCompanion, '/v1/timeline?limit=1000');

    assertNoDisallowedStorageValues(draftPack, storageBeforeRecording);
    assertPackPrivacy(draftPack);

    const writtenPack = await writeSessionPack(draftPack);
    expect(writtenPack.packPath.startsWith(resolveTestSessionsDir())).toBe(true);

    replayCompanion = await startTestCompanion();
    replayRuntime = await launchExtensionRuntime({ forceLocalProfile: true });
    const { panel: replayPanel } = await seedTimelineRuntime(replayRuntime, replayCompanion);
    await logTimelineReplayDiagnostics(replayRuntime, replayPanel, 'record-fresh-after-seed');
    const routeTracker = await installRouteStubsForPack(replayRuntime.context, draftPack, {
      strictOffline: STRICT_OFFLINE,
    });
    const pageReplay = await driveReplayFromPack({
      runtime: replayRuntime,
      senderPage: replayPanel,
      pack: draftPack,
    });
    await logTimelineReplayDiagnostics(
      replayRuntime,
      replayPanel,
      'record-fresh-after-page-replay',
    );
    const expectedUrls = recordedCanonicalUrls(draftPack);
    const drain = await forceDrainTimeline(replayRuntime, replayPanel, expectedUrls.length);
    await logTimelineReplayDiagnostics(
      replayRuntime,
      replayPanel,
      'record-fresh-after-force-drain',
    );
    const product = await runProductBehaviorModes({
      runtime: replayRuntime,
      panel: replayPanel,
      companion: replayCompanion,
      pack: draftPack,
      expectedUrls,
    });
    const report = evaluateOneBrowserReplay({
      pack: draftPack,
      routeTracker,
      pageReplay,
      drain,
      timeline: product.surfaces.timeline,
      connections: product.surfaces.connections,
      productBehavior: product.checks,
      strictOffline: STRICT_OFFLINE,
    });
    const writtenReport = await writeReplayReport(writtenPack.packDir, report);

    expect(report.layers.map((layer) => layer.layer)).toEqual([
      'page-replay',
      'extension-observation',
      'companion-projection',
      'graph-materialization',
      'product-behavior',
      'evaluation-expectations',
    ]);
    expect(report.status).toBe('pass');
    expect(writtenReport.markdownPath).toContain('/runs/');
    expect(writtenReport.jsonPath).toContain('/runs/');

    // eslint-disable-next-line no-console
    console.log(`[record-replay] pack: ${writtenPack.packPath}`);
    // eslint-disable-next-line no-console
    console.log(`[record-replay] report: ${writtenReport.markdownPath}`);
    // eslint-disable-next-line no-console
    console.log(`[sidetrack-test] pack: ${writtenPack.packPath}`);
    // eslint-disable-next-line no-console
    console.log(`[sidetrack-test] report: ${writtenReport.markdownPath}`);
  });
});
