/* eslint-disable @typescript-eslint/dot-notation, no-empty-pattern */

// T1 Wave 2b manual smoke — two-browser relay record/replay with html capture.
//
// Run from packages/sidetrack-extension:
//   SIDETRACK_TEST_SESSIONS_DIR=/tmp/t1-smoke \
//   SIDETRACK_CAPTURE_LEVEL=html \
//     bunx --bun --no-install playwright test tests/e2e/record-replay-two-browser.manual.spec.ts \
//     --headed --timeout 0 --grep manual
//
// Set SIDETRACK_REPLAY_HOLD=1 to leave Browser A and Browser B open
// after the evaluator writes the report. Ctrl-C ends the session.

import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { generateRendezvousSecret } from '../../../sidetrack-companion/src/sync/relayCrypto';
import { startTestCompanion, type TestCompanion } from './helpers/companion';
import { ManualRecorder } from './helpers/manualRecorder';
import {
  assertNoDisallowedStorageValues,
  assertPackPrivacy,
  browserByLabel,
  companionPost,
  createSessionPackFromManualRecorder,
  driveTwoBrowserReplayFromPack,
  evaluateOneBrowserReplay,
  firstBrowser,
  forceDrainTimeline,
  installRouteStubsForPack,
  readChromeStorageSnapshot,
  readSessionPack,
  readSidetrackVersion,
  recordedCanonicalUrls,
  redactHtmlForSessionPack,
  resolveCaptureLevel,
  resolveTestSessionsDir,
  waitForReplaySurfaces,
  writeReplayReport,
  writeSessionPack,
  type CaptureLevel,
  type SessionPack,
} from './helpers/recordReplay';
import { startTestRelay, type TestRelay } from './helpers/relay';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import { SETTINGS_KEY, SETUP_KEY } from './helpers/sidepanel';
import {
  computeT1FStatus,
  isT1FullProductEnabled,
  runT1FullProductE2ECases,
} from './helpers/tabsessionProductBehavior';

interface HtmlWorkflowStep {
  readonly url: string;
  readonly title: string;
  readonly body: string;
}

const SECRET_EMAIL = 'owner@example.com';
const SECRET_KEY = `sk-${'A'.repeat(40)}`;

const WORKFLOW: readonly HtmlWorkflowStep[] = [
  {
    url: 'https://example.test/t1/wave-2b/source?token=raw-secret#private',
    title: 'T1 Wave 2b source page',
    body: `<main>
      <h1>T1 Wave 2b source page</h1>
      <p>Follow-up plan survives replay.</p>
      <p>Contact ${SECRET_EMAIL} with key ${SECRET_KEY}.</p>
    </main>`,
  },
  {
    url: 'https://chatgpt.com/c/t1-wave-2b-thread?session=private',
    title: 'T1 Wave 2b chat thread',
    body: `<main>
      <h1>T1 Wave 2b chat thread</h1>
      <p>Browser A recorded activity should reach Browser B Connections.</p>
    </main>`,
  },
];

const HOLD_REQUESTED = process.env['SIDETRACK_REPLAY_HOLD'] === '1';
const HOLD_RELEASE_MS =
  process.env['SIDETRACK_REPLAY_HOLD_MS'] === undefined
    ? null
    : Number.parseInt(process.env['SIDETRACK_REPLAY_HOLD_MS'], 10);
const REPLAY_PACK_PATH = process.env['SIDETRACK_REPLAY_PACK'];
const REPLAY_REPORT_DIR = process.env['SIDETRACK_REPLAY_REPORT_DIR'];
const STRICT_OFFLINE = process.env['SIDETRACK_REPLAY_STRICT_OFFLINE'] === '1';

const routeKeyFor = (input: string): string => {
  const url = new URL(input);
  return `${url.origin}${url.pathname}`;
};

const settingsFor = (companion: TestCompanion) => ({
  companion: { port: companion.port, bridgeKey: companion.bridgeKey },
  autoTrack: false,
  siteToggles: { chatgpt: true, claude: true, gemini: true },
  notifyOnQueueComplete: true,
});

const installRecordingRoutes = async (context: BrowserContext): Promise<void> => {
  const stubs = new Map(WORKFLOW.map((step) => [routeKeyFor(step.url), step]));
  await context.route(/^https?:\/\//u, async (route) => {
    const step = stubs.get(routeKeyFor(route.request().url()));
    if (step === undefined) {
      if (STRICT_OFFLINE) {
        await route.abort('blockedbyclient');
        return;
      }
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html><html><head><title>${step.title}</title></head><body>${step.body}</body></html>`,
    });
  });
};

const seedTimelineRuntime = async (
  runtime: ExtensionRuntime,
  companion: TestCompanion,
  activeWorkstreamId: string,
): Promise<Page> => {
  const panel = await runtime.context.newPage();
  await panel.goto(`chrome-extension://${runtime.extensionId}/sidepanel.html`, {
    waitUntil: 'domcontentloaded',
  });
  // Pass the workstream id through reinit (SW-context write); see
  // the matching note in record-replay-one-browser.manual.spec.ts.
  await runtime.seedStorage(panel, {
    [SETUP_KEY]: true,
    [SETTINGS_KEY]: settingsFor(companion),
    'sidetrack.timeline.enabled': true,
  });
  await panel.reload({ waitUntil: 'domcontentloaded' });
  await expect(panel.getByRole('main', { name: 'Sidetrack workboard' })).toBeVisible({
    timeout: 30_000,
  });
  const reinitResult = await runtime.sendRuntimeMessage(panel, {
    type: 'sidetrack.timeline.reinit',
    activeWorkstreamId,
  });
  expect((reinitResult as { ok?: boolean } | null)?.ok).toBe(true);
  return panel;
};

const createWorkstream = async (companion: TestCompanion): Promise<string> => {
  const response = (await companionPost(companion, '/v1/workstreams', {
    title: 'T1 Wave 2b relay replay',
  })) as { readonly data?: { readonly bac_id?: unknown } };
  const id = response.data?.bac_id;
  if (typeof id !== 'string') throw new Error('workstream creation did not return bac_id');
  return id;
};

const openConnectionsOnBrowserB = async (
  panel: Page,
  activeWorkstreamId: string,
  expectedCanonicalUrls: readonly string[],
): Promise<void> => {
  await panel.getByRole('tab', { name: 'Connections' }).click();
  await expect(panel.getByTestId('connections-view')).toBeVisible({ timeout: 10_000 });
  const input = panel.getByTestId('connections-anchor-input');
  await input.click();
  await input.fill(`workstream:${activeWorkstreamId}`);
  await input.press('Enter');
  await panel.getByTestId('connections-hops-select').selectOption('3');
  await expect(panel.getByTestId('connections-groups')).toBeVisible({ timeout: 30_000 });
  for (const canonicalUrl of expectedCanonicalUrls) {
    await expect(panel.getByTestId(`node-timeline-visit:${canonicalUrl}`)).toBeVisible({
      timeout: 30_000,
    });
  }
};

const waitForHoldRelease = async (): Promise<void> => {
  if (HOLD_RELEASE_MS !== null && Number.isFinite(HOLD_RELEASE_MS) && HOLD_RELEASE_MS >= 0) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, HOLD_RELEASE_MS);
    });
    return;
  }
  await new Promise<void>(() => undefined);
};

test.describe('manual T1 Wave 2b two-browser relay record/replay', () => {
  test.skip(
    process.env['SIDETRACK_E2E_SKIP_LIVE_BROWSERS'] === '1',
    'set SIDETRACK_E2E_SKIP_LIVE_BROWSERS=1 to skip when CfT is unavailable',
  );
  test.setTimeout(HOLD_REQUESTED ? 0 : 300_000);

  let recordRelay: TestRelay | null = null;
  let replayRelay: TestRelay | null = null;
  let recordCompanionA: TestCompanion | null = null;
  let recordCompanionB: TestCompanion | null = null;
  let replayCompanionA: TestCompanion | null = null;
  let replayCompanionB: TestCompanion | null = null;
  let recordRuntimeA: ExtensionRuntime | null = null;
  let recordRuntimeB: ExtensionRuntime | null = null;
  let replayRuntimeA: ExtensionRuntime | null = null;
  let replayRuntimeB: ExtensionRuntime | null = null;

  test.afterEach(async () => {
    if (replayRuntimeB !== null) await replayRuntimeB.close();
    if (replayRuntimeA !== null) await replayRuntimeA.close();
    if (recordRuntimeB !== null) await recordRuntimeB.close();
    if (recordRuntimeA !== null) await recordRuntimeA.close();
    if (replayCompanionB !== null) await replayCompanionB.close();
    if (replayCompanionA !== null) await replayCompanionA.close();
    if (recordCompanionB !== null) await recordCompanionB.close();
    if (recordCompanionA !== null) await recordCompanionA.close();
    if (replayRelay !== null) await replayRelay.close();
    if (recordRelay !== null) await recordRelay.close();
    replayRuntimeB = null;
    replayRuntimeA = null;
    recordRuntimeB = null;
    recordRuntimeA = null;
    replayCompanionB = null;
    replayCompanionA = null;
    recordCompanionB = null;
    recordCompanionA = null;
    replayRelay = null;
    recordRelay = null;
  });

  const recorderOptions = (captureLevel: CaptureLevel) => ({
    captureScreenshots: false,
    captureTextSnapshots: false,
    captureHtmlSnapshots: captureLevel !== 'minimal',
    recordTextValues: captureLevel === 'html+paste',
    transformHtmlSnapshot: ({ html }: { readonly html: string }) => {
      const redacted = redactHtmlForSessionPack(html);
      return {
        html: redacted.htmlRedacted,
        redactionCounts: redacted.redactionCounts,
      };
    },
  });

  const replayPack = async (input: {
    readonly pack: SessionPack;
    readonly packPath: string;
  }): Promise<void> => {
    expect(input.pack.mode.browsers).toBe(2);
    replayRelay = await startTestRelay({});
    const replaySecret = generateRendezvousSecret().toString('base64url');
    replayCompanionA = await startTestCompanion({
      syncRelay: replayRelay.url,
      syncRendezvousSecret: replaySecret,
    });
    replayCompanionB = await startTestCompanion({
      syncRelay: replayRelay.url,
      syncRendezvousSecret: replaySecret,
    });
    replayRuntimeA = await launchExtensionRuntime({ forceLocalProfile: true });
    replayRuntimeB = await launchExtensionRuntime({ forceLocalProfile: true });
    const activeWorkstreamId = firstBrowser(input.pack).activeWorkstreamId;
    const seededWorkstreamId = activeWorkstreamId ?? 'ws_t1_replay';
    const replayPanelA = await seedTimelineRuntime(
      replayRuntimeA,
      replayCompanionA,
      seededWorkstreamId,
    );
    const replayPanelB = await seedTimelineRuntime(
      replayRuntimeB,
      replayCompanionB,
      seededWorkstreamId,
    );

    const routeTracker = await installRouteStubsForPack(replayRuntimeA.context, input.pack, {
      strictOffline: STRICT_OFFLINE,
    });
    await installRouteStubsForPack(replayRuntimeB.context, input.pack, {
      strictOffline: STRICT_OFFLINE,
    });
    const pageReplay = await driveTwoBrowserReplayFromPack({
      runtimeA: replayRuntimeA,
      senderPageA: replayPanelA,
      runtimeB: replayRuntimeB,
      senderPageB: replayPanelB,
      pack: input.pack,
    });
    const expectedUrls = recordedCanonicalUrls(input.pack);
    const drain = await forceDrainTimeline(replayRuntimeA, replayPanelA, expectedUrls.length);
    const surfacesOnB = await waitForReplaySurfaces({
      companion: replayCompanionB,
      expectedCanonicalUrls: expectedUrls,
      timeoutMs: 60_000,
    });
    if (activeWorkstreamId !== null) {
      await openConnectionsOnBrowserB(replayPanelB, activeWorkstreamId, expectedUrls);
    }
    const heldUrls = HOLD_REQUESTED ? [replayPanelA.url(), replayPanelB.url()] : undefined;
    const report = evaluateOneBrowserReplay({
      pack: input.pack,
      routeTracker,
      pageReplay,
      drain,
      timeline: surfacesOnB.timeline,
      connections: surfacesOnB.connections,
      ...(heldUrls === undefined ? {} : { heldUrls }),
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
    if (HOLD_REQUESTED) {
      expect(report.heldUrls?.reachable).toBe(true);
      // eslint-disable-next-line no-console
      console.log(`[record-replay-2b] hold urls: ${heldUrls?.join(', ') ?? ''}`);
      await waitForHoldRelease();
    }
  };

  test('manual html pack replays through Browser B Connections over relay', async ({}, testInfo) => {
    expect(testInfo.project.name).toBe('manual');
    if (REPLAY_PACK_PATH !== undefined) {
      await replayPack({
        pack: await readSessionPack(REPLAY_PACK_PATH),
        packPath: REPLAY_PACK_PATH,
      });
      return;
    }
    const captureLevel = resolveCaptureLevel();

    const sessionsRoot = resolveTestSessionsDir();
    await mkdir(sessionsRoot, { recursive: true });
    const artifactDir = path.join(sessionsRoot, `manual-2b-${String(Date.now())}`);
    await mkdir(artifactDir, { recursive: true });

    recordRelay = await startTestRelay({});
    const recordSecret = generateRendezvousSecret().toString('base64url');
    recordCompanionA = await startTestCompanion({
      syncRelay: recordRelay.url,
      syncRendezvousSecret: recordSecret,
    });
    recordCompanionB = await startTestCompanion({
      syncRelay: recordRelay.url,
      syncRendezvousSecret: recordSecret,
    });
    recordRuntimeA = await launchExtensionRuntime({ forceLocalProfile: true });
    recordRuntimeB = await launchExtensionRuntime({ forceLocalProfile: true });

    const recorderA = new ManualRecorder(
      recordRuntimeA.context,
      path.join(artifactDir, 'A'),
      recorderOptions(captureLevel),
    );
    const recorderB = new ManualRecorder(
      recordRuntimeB.context,
      path.join(artifactDir, 'B'),
      recorderOptions(captureLevel),
    );
    await recorderA.install();
    await recorderB.install();
    await installRecordingRoutes(recordRuntimeA.context);

    const activeWorkstreamId = await createWorkstream(recordCompanionA);
    const recordPanelA = await seedTimelineRuntime(
      recordRuntimeA,
      recordCompanionA,
      activeWorkstreamId,
    );
    const recordPanelB = await seedTimelineRuntime(
      recordRuntimeB,
      recordCompanionB,
      activeWorkstreamId,
    );
    await recorderB.record({
      kind: 'sidetrack-storage-changed',
      pageUrl: recordPanelB.url(),
      payload: { activeWorkstreamId },
    });
    const storageA = await readChromeStorageSnapshot(recordPanelA);
    const storageB = await readChromeStorageSnapshot(recordPanelB);

    for (const step of WORKFLOW) {
      const page = await recordRuntimeA.context.newPage();
      await page.goto(step.url, { waitUntil: 'domcontentloaded' });
      await recorderA.snapshotPage(page, 'wave-2b-record');
      await new Promise((resolve) => setTimeout(resolve, 200));
      await page.close();
    }

    const recordDrain = await forceDrainTimeline(recordRuntimeA, recordPanelA, WORKFLOW.length);
    expect(recordDrain.ok).toBe(true);

    const sidetrackVersion = await readSidetrackVersion();
    const pack = createSessionPackFromManualRecorder({
      captureLevel,
      sidetrackVersion,
      browsers: [
        {
          label: 'A',
          activeWorkstreamId,
          events: await recorderA.readEvents(),
          snapshots: await recorderA.readSnapshotFiles(),
        },
        {
          label: 'B',
          activeWorkstreamId,
          events: await recorderB.readEvents(),
          snapshots: await recorderB.readSnapshotFiles(),
        },
      ],
    });
    assertNoDisallowedStorageValues(pack, storageA);
    assertNoDisallowedStorageValues(pack, storageB);
    assertPackPrivacy(pack);

    if (captureLevel !== 'minimal') {
      const sourceSnapshot = Object.values(browserByLabel(pack, 'A').snapshots).find((snapshot) =>
        Object.hasOwn(snapshot.redactionCounts, 'email'),
      );
      expect(sourceSnapshot).toBeDefined();
      expect(sourceSnapshot?.redactionCounts['email']).toBeGreaterThan(0);
      expect(sourceSnapshot?.redactionCounts['openai-key']).toBeGreaterThan(0);
      expect(sourceSnapshot?.htmlRedacted).toContain('[email]');
      expect(sourceSnapshot?.htmlRedacted).toContain('[openai-key]');
      expect(sourceSnapshot?.htmlRedacted).toContain('Follow-up plan survives replay.');
      expect(sourceSnapshot?.htmlRedacted).not.toContain(SECRET_EMAIL);
      expect(sourceSnapshot?.htmlRedacted).not.toContain(SECRET_KEY);
    }

    const writtenPack = await writeSessionPack(pack);

    replayRelay = await startTestRelay({});
    const replaySecret = generateRendezvousSecret().toString('base64url');
    replayCompanionA = await startTestCompanion({
      syncRelay: replayRelay.url,
      syncRendezvousSecret: replaySecret,
    });
    replayCompanionB = await startTestCompanion({
      syncRelay: replayRelay.url,
      syncRendezvousSecret: replaySecret,
    });
    replayRuntimeA = await launchExtensionRuntime({ forceLocalProfile: true });
    replayRuntimeB = await launchExtensionRuntime({ forceLocalProfile: true });
    const replayPanelA = await seedTimelineRuntime(
      replayRuntimeA,
      replayCompanionA,
      activeWorkstreamId,
    );
    const replayPanelB = await seedTimelineRuntime(
      replayRuntimeB,
      replayCompanionB,
      activeWorkstreamId,
    );

    const routeTracker = await installRouteStubsForPack(replayRuntimeA.context, pack, {
      strictOffline: STRICT_OFFLINE,
    });
    await installRouteStubsForPack(replayRuntimeB.context, pack, {
      strictOffline: STRICT_OFFLINE,
    });
    const pageReplay = await driveTwoBrowserReplayFromPack({
      runtimeA: replayRuntimeA,
      senderPageA: replayPanelA,
      runtimeB: replayRuntimeB,
      senderPageB: replayPanelB,
      pack,
    });
    const expectedUrls = recordedCanonicalUrls(pack);
    const drain = await forceDrainTimeline(replayRuntimeA, replayPanelA, expectedUrls.length);
    const surfacesOnB = await waitForReplaySurfaces({
      companion: replayCompanionB,
      expectedCanonicalUrls: expectedUrls,
      timeoutMs: 60_000,
    });

    await openConnectionsOnBrowserB(replayPanelB, activeWorkstreamId, expectedUrls);
    if (captureLevel !== 'minimal') {
      const fulfilledHtml = [...routeTracker.fulfilledBodies().values()].find((body) =>
        body.includes('[email]'),
      );
      expect(fulfilledHtml).toBeDefined();
      expect(fulfilledHtml).toContain('Follow-up plan survives replay.');
      expect(fulfilledHtml).not.toContain(SECRET_EMAIL);
      expect(fulfilledHtml).not.toContain(SECRET_KEY);
    }

    const heldUrls = HOLD_REQUESTED ? [replayPanelA.url(), replayPanelB.url()] : undefined;

    const t1FullProductChecks = isT1FullProductEnabled()
      ? await runT1FullProductE2ECases({
          companionA: replayCompanionA,
          companionB: replayCompanionB,
          redactionRegressionPassed: true,
          panelA: replayPanelA,
          panelB: replayPanelB,
        })
      : [];

    const report = evaluateOneBrowserReplay({
      pack,
      routeTracker,
      pageReplay,
      drain,
      timeline: surfacesOnB.timeline,
      connections: surfacesOnB.connections,
      ...(heldUrls === undefined ? {} : { heldUrls }),
      strictOffline: STRICT_OFFLINE,
      productBehavior: t1FullProductChecks,
    });
    const writtenReport = await writeReplayReport(writtenPack.packDir, report);
    if (isT1FullProductEnabled()) {
      const t1f = computeT1FStatus(report.productBehavior);
      // eslint-disable-next-line no-console
      console.log(
        `[record-replay-2b] T1-F status: ${t1f.status}; missing=${String(t1f.missing.length)} failed=${String(t1f.failed.length)}`,
      );
      expect(t1f.missing).toEqual([]);
      expect(t1f.status).toBe('pass');
    }
    expect(report.status).toBe('pass');
    if (HOLD_REQUESTED) {
      expect(report.heldUrls?.reachable).toBe(true);
    }

    // eslint-disable-next-line no-console
    console.log(`[record-replay-2b] pack: ${writtenPack.packPath}`);
    // eslint-disable-next-line no-console
    console.log(`[record-replay-2b] report: ${writtenReport.markdownPath}`);
    // eslint-disable-next-line no-console
    console.log(`[sidetrack-test] pack: ${writtenPack.packPath}`);
    // eslint-disable-next-line no-console
    console.log(`[sidetrack-test] report: ${writtenReport.markdownPath}`);

    if (HOLD_REQUESTED) {
      // eslint-disable-next-line no-console
      console.log(`[record-replay-2b] hold urls: ${heldUrls?.join(', ') ?? ''}`);
      await waitForHoldRelease();
    }
  });
});
