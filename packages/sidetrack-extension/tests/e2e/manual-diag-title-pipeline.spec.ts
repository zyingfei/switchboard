// Non-interactive title-pipeline diagnostic.
//
// Run with:
//   bun run build && bun run --cwd ../sidetrack-companion build
//   SIDETRACK_MANUAL_BROWSER_MODE=persistent-playwright-stealth-experiment \
//     SIDETRACK_E2E_STEALTH_EXPERIMENT=1 SIDETRACK_E2E_HEADLESS=0 \
//     bunx --bun --no-install playwright test tests/e2e/diag-title-pipeline.spec.ts \
//       --project=manual --grep diag --headed --timeout 0
//
// Captures all console output from the SW, the panel, and a page tab,
// plus a snapshot of the wiring diagnostics. Prints everything to
// stdout so a human (or Claude) can read it without needing the
// Chrome DevTools panel for the SW.

import { mkdtemp } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import { test, type Page, type Worker } from '@playwright/test';

import { generateRendezvousSecret } from '../../../sidetrack-companion/src/sync/relayCrypto';
import { startTestCompanion, type TestCompanion } from './helpers/companion';
import { resolveManualBrowserMode } from './helpers/manualBrowserMode';
import { startTestRelay, type TestRelay } from './helpers/relay';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import { SETTINGS_KEY, SETUP_KEY } from './helpers/sidepanel';

const expandTilde = (input: string): string =>
  input.startsWith('~') ? path.join(homedir(), input.slice(1).replace(/^[/\\]/u, '')) : input;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test.describe('manual title pipeline diagnostic', () => {
  test('manual diag — capture all logs while navigating to a tracked URL', async () => {
    test.setTimeout(120_000);
    process.env.SIDETRACK_E2E_HEADLESS = '0';

    const modeConfig = resolveManualBrowserMode({
      env: process.env,
      defaultMode: 'persistent-playwright-manual',
    });

    let relay: TestRelay | undefined;
    let companionA: TestCompanion | undefined;
    let runtime: ExtensionRuntime | undefined;
    const sw: Worker[] = [];

    const print = (label: string, value: unknown): void => {
      const json =
        typeof value === 'string' ? value : JSON.stringify(value, null, 2).slice(0, 2000);
      // eslint-disable-next-line no-console
      console.log(`\n=== ${label} ===\n${json}`);
    };

    try {
      relay = await startTestRelay({});
      const secret = generateRendezvousSecret().toString('base64url');
      const vaultRoot = await mkdtemp(path.join(tmpdir(), 'sidetrack-diag-'));
      companionA = await startTestCompanion({
        syncRelay: relay.url,
        syncRendezvousSecret: secret,
        vaultDir: vaultRoot,
      });
      print('SETUP', { vaultRoot, companionPort: companionA.port });

      // Always use a temp profile so we don't conflict with the
      // operator's running recorder session.
      const tempProfile = await mkdtemp(path.join(tmpdir(), 'sidetrack-diag-profile-'));
      runtime = await launchExtensionRuntime({
        userDataDir: tempProfile,
        extraHostPermissions: ['https://*/*', 'http://*/*'],
        browserMode: modeConfig.mode,
      });
      print('PROFILE', tempProfile);

      // Capture console output from EVERY page (panel, content scripts,
      // any test tabs we open) and every service worker.
      runtime.context.on('console', (msg) => {
        const text = msg.text();
        // eslint-disable-next-line no-console
        console.log(`[page:${msg.type()}] ${text}`);
      });
      runtime.context.on('weberror', (err) => {
        // eslint-disable-next-line no-console
        console.log(`[page:error] ${err.error().message}`);
      });
      runtime.context.on('serviceworker', (worker) => {
        sw.push(worker);
        // eslint-disable-next-line no-console
        console.log(`[sw:registered] ${worker.url()}`);
      });

      // Open the side panel.
      const panel = await runtime.context.newPage();
      await panel.goto(`chrome-extension://${runtime.extensionId}/sidepanel.html`, {
        waitUntil: 'domcontentloaded',
      });
      await runtime.seedStorage(panel, {
        [SETUP_KEY]: true,
        [SETTINGS_KEY]: {
          companion: { port: companionA.port, bridgeKey: companionA.bridgeKey },
          autoTrack: true,
          siteToggles: { chatgpt: true, claude: true, gemini: true, codex: true },
          notifyOnQueueComplete: true,
        },
        'sidetrack.timeline.enabled': true,
      });
      await panel.reload({ waitUntil: 'domcontentloaded' });

      // Force timeline wiring init.
      const reinit = (await runtime.sendRuntimeMessage(panel, {
        type: 'sidetrack.timeline.reinit',
      })) as { readonly ok?: boolean; readonly error?: string } | null;
      print('REINIT', reinit);

      // Navigate to a real URL with a stable title.
      const target = 'https://news.ycombinator.com/item?id=47952181';
      const tab = await runtime.context.newPage();
      await tab.goto(target, { waitUntil: 'domcontentloaded' });
      print('NAV', { url: target, title: await tab.title() });

      // Let the SW pipeline do its work.
      await sleep(8_000);

      // Diag from the panel.
      const diag = (await runtime.sendRuntimeMessage(panel, {
        type: 'sidetrack.dev.diag',
      })) as {
        readonly ok?: boolean;
        readonly diagnostics?: unknown;
        readonly error?: string;
      } | null;
      print('DIAG', diag);

      // Pull the URL projection directly from companion.
      const projectionResp = await fetch(
        `http://127.0.0.1:${String(companionA.port)}/v1/visits/projection`,
        { headers: { 'x-bac-bridge-key': companionA.bridgeKey } },
      );
      const projectionBody = (await projectionResp.json()) as {
        data?: { byCanonicalUrl?: Record<string, { latestTitle?: string }> };
      };
      print(
        'COMPANION PROJECTION (HN)',
        projectionBody.data?.byCanonicalUrl?.[target] ?? '<not in projection>',
      );

      // Pull the panel's view of the same URL via its own injected DOM.
      // (Panel's loadTabSessions already logs activeTabUrl + urlRecord;
      // the console capture above will have it.)
      print(
        'SW WORKERS',
        sw.map((w) => w.url()),
      );

      // One more wait to capture late title-watcher pushes.
      await sleep(5_000);
      print(
        'SECOND DIAG (after 5 s)',
        await runtime.sendRuntimeMessage(panel, {
          type: 'sidetrack.dev.diag',
        }),
      );

      // Final companion projection.
      const projection2 = await fetch(
        `http://127.0.0.1:${String(companionA.port)}/v1/visits/projection`,
        { headers: { 'x-bac-bridge-key': companionA.bridgeKey } },
      );
      const projection2Body = (await projection2.json()) as {
        data?: { byCanonicalUrl?: Record<string, { latestTitle?: string }> };
      };
      print(
        'COMPANION PROJECTION (HN, final)',
        projection2Body.data?.byCanonicalUrl?.[target] ?? '<not in projection>',
      );

      // Keep the browser alive a bit longer for human inspection if needed.
      await sleep(2_000);
    } finally {
      try {
        await runtime?.close();
      } catch {}
      try {
        await companionA?.close();
      } catch {}
      try {
        await relay?.close();
      } catch {}
    }
  });
});
