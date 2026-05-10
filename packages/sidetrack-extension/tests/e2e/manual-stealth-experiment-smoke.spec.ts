// Manual/opt-in smoke for the stealth experiment launcher.
//
// Run with:
//   SIDETRACK_E2E_STEALTH_EXPERIMENT=1 \
//   SIDETRACK_E2E_HEADLESS=0 \
//   playwright test tests/e2e/manual-stealth-experiment-smoke.spec.ts \
//     --project=manual --grep manual --headed

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test } from '@playwright/test';

import {
  installManualNetworkOutcomeRecorder,
  summarizeManualExperiment,
} from './helpers/manualBrowserMode';
import { ManualRecorder } from './helpers/manualRecorder';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';

test.describe('manual stealth experiment smoke', () => {
  test('manual stealth smoke launches a Sidetrack-owned persistent profile', async () => {
    test.skip(
      process.env.SIDETRACK_E2E_STEALTH_EXPERIMENT !== '1',
      'opt-in: requires SIDETRACK_E2E_STEALTH_EXPERIMENT=1',
    );
    test.setTimeout(120_000);
    process.env.SIDETRACK_E2E_HEADLESS = '0';

    const root = await mkdtemp(path.join(tmpdir(), 'sidetrack-stealth-smoke-'));
    const artifactsDir = path.join(root, 'artifacts');
    const profileDir = path.join(root, 'sidetrack-stealth-smoke-profile');
    const fixturePath = path.join(root, 'fixture.html');
    const targetPath = path.join(root, 'target.html');
    let runtime: ExtensionRuntime | undefined;
    try {
      await mkdir(artifactsDir, { recursive: true });
      await writeFile(
        targetPath,
        '<!doctype html><title>Stealth target</title><main>ok</main>',
        'utf8',
      );
      await writeFile(
        fixturePath,
        `<!doctype html><title>Stealth smoke fixture</title><main>Sidetrack local fixture page.</main><a id="target" href="${pathToFileURL(targetPath).toString()}" target="_blank">Open target</a>`,
        'utf8',
      );

      runtime = await launchExtensionRuntime({
        forceLocalProfile: true,
        userDataDir: profileDir,
        browserMode: 'persistent-playwright-stealth-experiment',
      });
      const panel = await runtime.context.newPage();
      await panel.goto(`chrome-extension://${runtime.extensionId}/sidepanel.html`, {
        waitUntil: 'domcontentloaded',
      });
      await panel.close();

      const recorder = new ManualRecorder(runtime.context, artifactsDir, {
        captureScreenshots: false,
      });
      await recorder.install();
      installManualNetworkOutcomeRecorder(runtime.context, recorder, {
        recordLoadedDocuments: true,
      });

      const page = await runtime.context.newPage();
      await page.goto(pathToFileURL(fixturePath).toString(), { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(250);
      const popupPromise = runtime.context.waitForEvent('page');
      await page.locator('#target').click();
      const popup = await popupPromise;
      await popup.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(750);
      await recorder.snapshotPage(page, 'stealth-smoke');

      const events = await recorder.readEvents();
      const snapshots = await recorder.readSnapshotFiles();
      const summary = summarizeManualExperiment({
        runtime,
        events,
        capturedPageSnapshots: snapshots.length,
      });

      expect(runtime.extensionId).toMatch(/^[a-z]{32}$/u);
      expect(runtime.metadata?.patchrightLoaded).toBe(true);
      expect(summary.patchrightLoaded).toBe(true);
      expect(events.some((event) => event.kind === 'click')).toBe(true);
      expect(events.some((event) => event.kind === 'popup-opened')).toBe(true);
      expect(summary.capturedPageSnapshots).toBeGreaterThan(0);
    } finally {
      await runtime?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
