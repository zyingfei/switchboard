// Interactive two-browser harness — NOT a CI test.
//
// Run with:
//   npx playwright test tests/e2e/manual-two-browser.spec.ts --headed --grep manual --timeout 0
//
// Spawns:
//   - 1 standalone test relay
//   - 2 companion processes wired to the relay with a shared
//     rendezvous secret (peer sync ON)
//   - 2 Chrome-for-Testing browsers, each with the extension
//     loaded, side panel open, settings pre-seeded so the
//     extension is configured against its dedicated companion
//
// Prints the URLs, bridge keys, and a manual-test scenario list,
// then awaits forever. Ctrl-C ends the session and tears down.

import { expect, test } from '@playwright/test';

import { generateRendezvousSecret } from '../../../sidetrack-companion/src/sync/relayCrypto';
import { startTestCompanion, type TestCompanion } from './helpers/companion';
import { startTestRelay, type TestRelay } from './helpers/relay';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import {
  SETTINGS_KEY,
  THREADS_KEY,
  WORKSTREAMS_KEY,
  seedAndOpenSidepanel,
} from './helpers/sidepanel';

const settingsFor = (companion: TestCompanion) => ({
  companion: { port: companion.port, bridgeKey: companion.bridgeKey },
  // autoTrack: true so unseeded captures don't get silently
  // dropped — you can paste capture events from the chat tabs
  // and watch them propagate.
  autoTrack: true,
  siteToggles: { chatgpt: true, claude: true, gemini: true, codex: true },
});

// Seeded fixture: a single thread visible on BOTH browsers from
// the start. Use it as the target for verdict.set / span add /
// discard exercises. The same bac_id on both sides makes the
// review-draft sync path symmetric — A's edits and B's edits
// share a draft.
const sharedThread = {
  bac_id: 'bac_thread_manual',
  provider: 'chatgpt' as const,
  threadUrl: 'https://chatgpt.com/c/manual-test',
  title: 'Manual test thread',
  lastSeenAt: new Date().toISOString(),
  status: 'active' as const,
  trackingMode: 'auto' as const,
  tags: [] as string[],
  lastTurnRole: 'assistant' as const,
};

const sharedWorkstream = {
  bac_id: 'bac_ws_manual',
  revision: 'rev_manual',
  title: 'Manual test workstream',
  children: [] as string[],
  tags: [] as string[],
  checklist: [] as unknown[],
  privacy: 'shared' as const,
  updatedAt: new Date().toISOString(),
};

test.describe('manual interactive two-browser harness', () => {
  test('manual', async () => {
    test.setTimeout(0); // no timeout — hang forever until user kills

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
        [THREADS_KEY]: [sharedThread],
        [WORKSTREAMS_KEY]: [sharedWorkstream],
      });
      const pageB = await seedAndOpenSidepanel(runtimeB, {
        [SETTINGS_KEY]: settingsFor(companionB),
        [THREADS_KEY]: [sharedThread],
        [WORKSTREAMS_KEY]: [sharedWorkstream],
      });

      // Switch both panels to All-threads so the seeded thread
      // is immediately visible.
      await pageA.getByRole('tab', { name: 'All threads' }).click();
      await pageB.getByRole('tab', { name: 'All threads' }).click();

      // Sanity: both side panels are mounted with the seeded thread.
      await expect(pageA.locator('.thread').first()).toBeVisible();
      await expect(pageB.locator('.thread').first()).toBeVisible();

      // ---- Print everything the human needs ----
      const banner = `
================================================================
 MANUAL TWO-BROWSER HARNESS — both browsers + sync are ready
================================================================

  Browser A (extension): chrome://extensions/?id=${runtimeA.extensionId}
    side panel: chrome-extension://${runtimeA.extensionId}/sidepanel.html
    profile:    ${runtimeA.userDataDir}
    companion:  http://127.0.0.1:${String(companionA.port)}
    bridge key: ${companionA.bridgeKey}
    vault:      ${companionA.vaultPath}

  Browser B (extension): chrome://extensions/?id=${runtimeB.extensionId}
    side panel: chrome-extension://${runtimeB.extensionId}/sidepanel.html
    profile:    ${runtimeB.userDataDir}
    companion:  http://127.0.0.1:${String(companionB.port)}
    bridge key: ${companionB.bridgeKey}
    vault:      ${companionB.vaultPath}

  Relay:        ${relay.url}
  Rendezvous:   ${secret.slice(0, 12)}…${secret.slice(-6)}

----------------------------------------------------------------
 SUGGESTED SCENARIOS
----------------------------------------------------------------

 1. Cross-browser thread propagation (T6.1)
    -----------------------------------------
    Both side panels start with one thread ("Manual test thread").
    To verify peer sync of NEW threads:
      a. In browser A, you'd need to capture from a real chat tab,
         OR paste a synthetic capture via chrome.devtools (see
         "drive autoCapture" snippet below).
      b. Within ~2-3 s, browser B's All-threads list should show
         the new row WITHOUT a manual reload.

 2. Conflict UI (T6.4 / T6.5)
    --------------------------
    a. In browser A: click the seeded thread → click "Review draft"
       chip. The footer should expand. Add a span (highlight some
       quote). Then in the verdict picker, choose "Agree".
    b. In browser B: same — click the thread → expand draft →
       choose verdict "Partial".
    c. Within a few seconds (relay round-trip), BOTH side panels
       should show a "Verdict has 2 versions:" ConflictBanner with
       both candidates.
    d. Click "Use Agree" on either side — the conflict clears on
       both within a few seconds.

 3. Failure-mode banners (T6.7)
    ----------------------------
    Open a terminal and run:
      lsof -nP -iTCP:${String(companionA.port)} -sTCP:LISTEN
    Note the PID, then:
      kill -TERM <pid>
    Browser A's side panel should within 15 s show a
    "Companion: disconnected" banner (red).
    Restart by re-running this script.

 4. Offline-pending visibility (T6.2)
    ----------------------------------
    Same as #3 but observe the captures-queued / captures-failed
    banner appears alongside companion-disconnected when you try
    to capture while offline.

----------------------------------------------------------------
 DRIVE A SYNTHETIC AUTOCAPTURE FROM EITHER BROWSER
----------------------------------------------------------------

 Open the side panel page's DevTools (right-click side panel →
 Inspect) and paste:

   await chrome.runtime.sendMessage({
     type: 'sidetrack.capture.auto',
     capture: {
       provider: 'chatgpt',
       threadUrl: 'https://chatgpt.com/c/manual-test-' + Date.now(),
       title: 'Synthetic capture ' + new Date().toLocaleTimeString(),
       capturedAt: new Date().toISOString(),
       turns: [
         { role: 'user', text: 'manual probe', ordinal: 0,
           capturedAt: new Date().toISOString() },
         { role: 'assistant', text: 'manual probe reply',
           ordinal: 1, capturedAt: new Date().toISOString() },
       ],
     },
   });

 The new thread appears in THIS panel immediately. Within a few
 seconds it should propagate to the other panel via relay → F9
 thread-SSE → mirrorRemoteThread.

----------------------------------------------------------------
 STOPPING THE HARNESS
----------------------------------------------------------------

 Press Ctrl-C in this terminal. Cleanup runs in the finally{}
 block: closes both browsers, kills both companions, kills the
 relay, removes vault tmpdirs.

================================================================
`;
      // eslint-disable-next-line no-console
      console.log(banner);

      // Hang forever. The user kills with Ctrl-C; Playwright
      // catches SIGINT and runs our finally{} cleanup.
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      await new Promise(() => {});
    } finally {
      await runtimeB?.close();
      await runtimeA?.close();
      await companionB?.close();
      await companionA?.close();
      await relay?.close();
    }
  });
});
