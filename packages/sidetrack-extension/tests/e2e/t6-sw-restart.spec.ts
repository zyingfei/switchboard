import { expect, test } from '@playwright/test';

import { messageTypes } from '../../src/messages';
import { startTestCompanion, type TestCompanion } from './helpers/companion';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import {
  SETTINGS_KEY,
  THREADS_KEY,
  WORKSTREAMS_KEY,
  seedAndOpenSidepanel,
} from './helpers/sidepanel';
import { readBannerCount } from './helpers/ui';

// Tier 6.6 — service-worker restart preserves pending work.
//
// Question: "Does browser/SW restart preserve pending work?"
//
// What we test (proxy):
//   Close the side panel page, then reopen it. The MV3 service
//   worker is allowed to idle-suspend in this window; the
//   chrome.storage.local layer that backs the capture outbox must
//   survive the page lifecycle.
//
// What this is NOT:
//   Closing+reopening the entire BrowserContext against the same
//   profile dir is a stronger restart, but Playwright's MV3
//   service-worker registration becomes racy when the
//   --load-extension flag re-loads against an existing profile —
//   the page-close proxy exercises the same chrome.storage
//   persistence property without that flake.
//
// Setup:
//   1. Boot companion, configure extension, open side panel.
//   2. Stop companion. Drive N captures into the offline outbox.
//   3. Verify side panel shows them as pending.
//   4. close() the side panel PAGE only.
//   5. Open a fresh side panel page in the same context.
//
// Invariant: pending unsynced count is still ≥ N. The captures
// survived because the queue lives in chrome.storage, not in
// the SW's in-memory state.

const CAPTURE_COUNT = 3;
const baseThreadUrl = 'https://chatgpt.com/c/t66-sw-restart';
const now = '2026-05-07T04:00:00.000Z';

const settingsFor = (companion: TestCompanion) => ({
  companion: { port: companion.port, bridgeKey: companion.bridgeKey },
  autoTrack: false,
  siteToggles: { chatgpt: true, claude: true, gemini: true },
});

const seededThreads = Array.from({ length: CAPTURE_COUNT }, (_, i) => ({
  bac_id: `bac_thread_t66_${String(i)}`,
  provider: 'chatgpt' as const,
  threadUrl: `${baseThreadUrl}-${String(i)}`,
  title: `T6.6 SW-restart fixture ${String(i)}`,
  lastSeenAt: now,
  status: 'active' as const,
  trackingMode: 'auto' as const,
  tags: [] as string[],
  lastTurnRole: 'assistant' as const,
}));

const totalUnsynced = async (page: import('@playwright/test').Page): Promise<number> => {
  const queued = (await readBannerCount(page, 'captures-queued')) ?? 0;
  const failed = (await readBannerCount(page, 'captures-failed')) ?? 0;
  return queued + failed;
};

test.describe('Tier 6.6 — SW/browser restart preserves pending work', () => {
  test('captures made offline survive a side-panel close+reopen cycle', async () => {
    test.setTimeout(60_000);

    let companion: TestCompanion | undefined;
    let runtime: ExtensionRuntime | undefined;
    try {
      companion = await startTestCompanion({});
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });

      // Phase 1 — drive captures with companion offline.
      const page1 = await seedAndOpenSidepanel(runtime, {
        [SETTINGS_KEY]: settingsFor(companion),
        [THREADS_KEY]: seededThreads,
        [WORKSTREAMS_KEY]: [],
      });
      await companion.stop();
      for (let i = 0; i < CAPTURE_COUNT; i += 1) {
        await runtime.sendRuntimeMessage(page1, {
          type: messageTypes.autoCapture,
          capture: {
            provider: 'chatgpt',
            threadUrl: `${baseThreadUrl}-${String(i)}`,
            title: `T6.6 SW-restart fixture ${String(i)}`,
            capturedAt: now,
            turns: [
              {
                role: 'user',
                text: `pre-restart capture ${String(i)}`,
                ordinal: 0,
                capturedAt: now,
              },
            ],
          },
        });
      }
      await expect
        .poll(() => totalUnsynced(page1), { timeout: 15_000, intervals: [200, 500] })
        .toBeGreaterThanOrEqual(CAPTURE_COUNT);

      // Phase 2 — close the side panel page. SW may idle-suspend;
      // chrome.storage on the profile is unaffected. Wait briefly
      // before re-opening so the SW has a chance to fully suspend.
      await page1.close();
      await new Promise((r) => setTimeout(r, 2_000));

      // Phase 3 — open a fresh side panel page. SW wakes on the
      // first `chrome.runtime.sendMessage` triggered by the panel's
      // initial refresh(). seedAndOpenSidepanel would WIPE storage
      // by re-seeding — open the page raw instead.
      const page2 = await runtime.context.newPage();
      await page2.goto(`chrome-extension://${runtime.extensionId}/sidepanel.html`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page2.getByRole('main', { name: 'Sidetrack workboard' })).toBeVisible({
        timeout: 15_000,
      });

      // The pending count must survive. If the queue lived in SW
      // memory (it doesn't; it lives in chrome.storage.local) this
      // would fail.
      await expect
        .poll(() => totalUnsynced(page2), { timeout: 15_000, intervals: [200, 500] })
        .toBeGreaterThanOrEqual(CAPTURE_COUNT);
    } finally {
      await runtime?.close();
      await companion?.close();
    }
  });
});
