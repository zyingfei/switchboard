import { expect, test } from '@playwright/test';

import { generateRendezvousSecret } from '../../../sidetrack-companion/src/sync/relayCrypto';
import { messageTypes } from '../../src/messages';
import { startTestCompanion, type TestCompanion } from './helpers/companion';
import { startTestRelay, type TestRelay } from './helpers/relay';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import {
  SETTINGS_KEY,
  THREADS_KEY,
  WORKSTREAMS_KEY,
  seedAndOpenSidepanel,
} from './helpers/sidepanel';

// Tier 6.1 — cross-browser real-time propagation.
//
// Question: "Does the other browser visibly update?"
//
// Setup:
//   1. Standalone test relay; two companions wired through it
//      with a shared rendezvous secret.
//   2. Two extension runtimes, both seeded with EMPTY THREADS_KEY
//      (the test verifies B learns about the thread purely via
//      sync, not a pre-seed).
//   3. Drive an autoCapture in browser A on a known-provider URL
//      with autoTrack enabled (so the gate forwards into
//      storeCaptureEvent).
//
// Invariant: within 15 s and WITHOUT page.reload(), browser B's
// side panel renders the thread row with the captured title.
//
// Path covered:
//   ext A queue → companion A POST /v1/events
//     → eventLog.appendClient + thread.upserted projection
//     → relay publish → companion B importPeerEvent + projector
//     → companion B writes _BAC/threads/<id>.json
//     → /v1/vault/changes SSE fires for `_BAC/threads/` prefix
//     → ext B's vaultChangesClient subscriber (F9) fetches
//       /v1/threads/<id>/projection, calls mirrorRemoteThread
//     → chrome.storage.sidetrack.threads gets the new row
//     → broadcastWorkboardChanged('thread') triggers refresh
//     → side panel renders the new .thread row

const threadUrl = 'https://chatgpt.com/c/t61-realtime';
const expectedTitle = 'T6.1 cross-browser realtime fixture';
const now = '2026-05-07T06:00:00.000Z';

const settingsFor = (companion: TestCompanion) => ({
  companion: { port: companion.port, bridgeKey: companion.bridgeKey },
  // autoTrack: true so the autoCapture gate at background.ts:1760
  // accepts a brand-new (unseeded) thread. Without this the
  // capture is silently dropped on browser A, no event ever
  // emitted, and B has nothing to mirror.
  autoTrack: true,
  siteToggles: { chatgpt: true, claude: true, gemini: true },
});

test.describe('Tier 6.1 — cross-browser real-time propagation', () => {
  test('capture in A appears in B side panel within 15 s without manual reload', async () => {
    test.setTimeout(120_000);

    let relay: TestRelay | undefined;
    let companionA: TestCompanion | undefined;
    let companionB: TestCompanion | undefined;
    let runtimeA: ExtensionRuntime | undefined;
    let runtimeB: ExtensionRuntime | undefined;
    try {
      relay = await startTestRelay({});
      const secret = generateRendezvousSecret().toString('base64url');

      companionA = await startTestCompanion({
        syncRelay: relay.url,
        syncRendezvousSecret: secret,
      });
      companionB = await startTestCompanion({
        syncRelay: relay.url,
        syncRendezvousSecret: secret,
      });

      runtimeA = await launchExtensionRuntime({ forceLocalProfile: true });
      runtimeB = await launchExtensionRuntime({ forceLocalProfile: true });

      const pageA = await seedAndOpenSidepanel(runtimeA, {
        [SETTINGS_KEY]: settingsFor(companionA),
        [THREADS_KEY]: [],
        [WORKSTREAMS_KEY]: [],
      });
      const pageB = await seedAndOpenSidepanel(runtimeB, {
        [SETTINGS_KEY]: settingsFor(companionB),
        [THREADS_KEY]: [],
        [WORKSTREAMS_KEY]: [],
      });

      // Switch BOTH side panels to All-threads view. Default Inbox
      // filters out brand-new unread threads in some configurations.
      // All-threads unconditionally lists them, so the assertion
      // below doesn't depend on the lifecycle pill being in the
      // right state.
      await pageA.getByRole('tab', { name: 'All threads' }).click();
      await pageB.getByRole('tab', { name: 'All threads' }).click();

      // Give SSE clients on both sides a moment to attach.
      await new Promise((r) => setTimeout(r, 2_500));

      // Drive autoCapture in A. autoCapture's gate at
      // background.ts:1758 looks up the URL in readThreads();
      // unseeded → falls through to the autoTrack=true branch →
      // forwards into storeCaptureEvent.
      await runtimeA.sendRuntimeMessage(pageA, {
        type: messageTypes.autoCapture,
        capture: {
          provider: 'chatgpt',
          threadUrl,
          title: expectedTitle,
          capturedAt: now,
          turns: [
            {
              role: 'user',
              text: 'real-time peer-sync probe',
              ordinal: 0,
              capturedAt: now,
            },
          ],
        },
      });

      // Wait for the storage write triggered by upsertLocalThread
      // to settle before forcing a reload — without this, the
      // reload can race the upsertLocalThread that runs inside
      // sendToCompanion's response path.
      await expect
        .poll(
          async () =>
            await pageA.evaluate(async () => {
              const all = await chrome.storage.local.get('sidetrack.threads');
              return Array.isArray(all['sidetrack.threads']) ? all['sidetrack.threads'].length : 0;
            }),
          { timeout: 15_000, intervals: [200, 500] },
        )
        .toBeGreaterThan(0);

      // DIAG: dump vault state on both companions before the
      // assertion so a failure tells us which layer broke.
      await new Promise((r) => setTimeout(r, 5_000));
      const { readdir, readFile } = await import('node:fs/promises');
      const path = await import('node:path');
      const dumpVaultThreads = async (vault: string): Promise<string[]> => {
        const dir = path.join(vault, '_BAC', 'threads');
        const files = await readdir(dir).catch(() => [] as readonly string[]);
        return [...files];
      };
      const aThreads = await dumpVaultThreads(companionA!.vaultPath);
      const bThreads = await dumpVaultThreads(companionB!.vaultPath);
      const fs3 = await import('node:fs/promises');
      await fs3.writeFile(
        '/tmp/t61-vaults.json',
        JSON.stringify(
          { aThreads, bThreads, aVault: companionA!.vaultPath, bVault: companionB!.vaultPath },
          null,
          2,
        ),
      );

      // The load-bearing T6.1 assertion: B's chrome.storage gets
      // the same thread without a page.reload(). The path is
      // F9's SSE subscription → fetchThreadProjection →
      // mirrorRemoteThread → storageSet.
      await expect
        .poll(
          async () =>
            await pageB.evaluate(async (url) => {
              const all = await chrome.storage.local.get('sidetrack.threads');
              const list = all['sidetrack.threads'];
              return (
                Array.isArray(list) && list.some((t: { threadUrl?: string }) => t.threadUrl === url)
              );
            }, threadUrl),
          { timeout: 30_000, intervals: [500, 1_000] },
        )
        .toBe(true);

      // Confirm the title carried through (a bug in mirrorRemoteThread
      // that wrote a placeholder record would satisfy "row exists"
      // but break this.)
      const bRow = await pageB.evaluate(async (url) => {
        const all = await chrome.storage.local.get('sidetrack.threads');
        const list = (all['sidetrack.threads'] as { threadUrl?: string; title?: string }[]) ?? [];
        return list.find((t) => t.threadUrl === url) ?? null;
      }, threadUrl);
      expect(bRow).not.toBeNull();
      expect((bRow as { title: string }).title).toBe(expectedTitle);
    } finally {
      await runtimeB?.close();
      await runtimeA?.close();
      await companionB?.close();
      await companionA?.close();
      await relay?.close();
    }
  });
});
