/* eslint-disable @typescript-eslint/dot-notation, no-empty-pattern */

// T1 Wave 2a manual smoke — one-browser record/replay vertical slice.
//
// Run from packages/sidetrack-extension:
//   SIDETRACK_TEST_SESSIONS_DIR=/tmp/t1-smoke \
//     npx playwright test tests/e2e/record-replay-one-browser.manual.spec.ts \
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
  ACTIVE_WORKSTREAM_STORAGE_KEY,
  assertNoDisallowedStorageValues,
  assertPackPrivacy,
  companionGet,
  createMinimalOneBrowserPack,
  createSessionPackFromManualRecorder,
  driveReplayFromPack,
  evaluateOneBrowserReplay,
  firstBrowser,
  forceDrainTimeline,
  installRouteStubsForPack,
  installRouteStubsForWorkflow,
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
  type MinimalWorkflowStep,
  type SessionPack,
} from './helpers/recordReplay';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import { SETTINGS_KEY, SETUP_KEY } from './helpers/sidepanel';

const ACTIVE_WORKSTREAM_ID = 'ws_t1_record_replay_2a';

const WORKFLOW: readonly MinimalWorkflowStep[] = [
  {
    url: 'https://example.test/t1/record-replay?keep=1&token=secret#private',
    title: 'T1 record/replay charter',
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
  await runtime.seedStorage(panel, {
    [SETUP_KEY]: true,
    [SETTINGS_KEY]: settingsFor(companion),
    'sidetrack.timeline.enabled': true,
    [ACTIVE_WORKSTREAM_STORAGE_KEY]: ACTIVE_WORKSTREAM_ID,
  });
  await panel.reload({ waitUntil: 'domcontentloaded' });
  await expect(panel.getByRole('main', { name: 'Sidetrack workboard' })).toBeVisible({
    timeout: 30_000,
  });
  const reinitResult = await runtime.sendRuntimeMessage(panel, {
    type: 'sidetrack.timeline.reinit',
  });
  expect((reinitResult as { ok?: boolean } | null)?.ok).toBe(true);
  return { panel };
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
    const routeTracker = await installRouteStubsForPack(replayRuntime.context, input.pack);
    const pageReplay = await driveReplayFromPack({
      runtime: replayRuntime,
      senderPage: replayPanel,
      pack: input.pack,
    });
    const expectedUrls = recordedCanonicalUrls(input.pack);
    const drain = await forceDrainTimeline(replayRuntime, replayPanel, expectedUrls.length);
    const surfaces = await waitForReplaySurfaces({
      companion: replayCompanion,
      expectedCanonicalUrls: expectedUrls,
      activeWorkstreamId: firstBrowser(input.pack).activeWorkstreamId,
    });
    const report = evaluateOneBrowserReplay({
      pack: input.pack,
      routeTracker,
      pageReplay,
      drain,
      timeline: surfaces.timeline,
      connections: surfaces.connections,
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
    await installRouteStubsForWorkflow(recordRuntime.context, WORKFLOW);
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
    const routeTracker = await installRouteStubsForPack(replayRuntime.context, draftPack);
    const pageReplay = await driveReplayFromPack({
      runtime: replayRuntime,
      senderPage: replayPanel,
      pack: draftPack,
    });
    const expectedUrls = recordedCanonicalUrls(draftPack);
    const drain = await forceDrainTimeline(replayRuntime, replayPanel, expectedUrls.length);
    const surfaces = await waitForReplaySurfaces({
      companion: replayCompanion,
      expectedCanonicalUrls: expectedUrls,
      activeWorkstreamId: firstBrowser(draftPack).activeWorkstreamId,
    });
    const report = evaluateOneBrowserReplay({
      pack: draftPack,
      routeTracker,
      pageReplay,
      drain,
      timeline: surfaces.timeline,
      connections: surfaces.connections,
    });
    const writtenReport = await writeReplayReport(writtenPack.packDir, report);

    expect(report.layers.map((layer) => layer.layer)).toEqual([
      'page-replay',
      'extension-observation',
      'companion-projection',
      'graph-materialization',
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
