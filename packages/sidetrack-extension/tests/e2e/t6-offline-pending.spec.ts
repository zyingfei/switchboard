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
import { expectBanner, readBannerCount } from './helpers/ui';

// Tier 6.2 — Offline pending visibility.
//
// Question: "Does offline work show 'unsynced' instead of
// disappearing?"
//
// Setup:
//   1. Boot companion, configure the extension to point at it.
//   2. Stop the companion (vault stays on disk).
//   3. Drive a synthetic capture into the extension's outbox.
//
// User-perceptible invariant:
//   The side panel shows BOTH banners that surface the broken
//   state — `companion-disconnected` AND a queued/failed banner
//   reflecting the captured-but-not-synced item. The capture
//   does NOT silently drop.
//
// What this catches:
//   - capture event created an optimistic local thread record but
//     no UI signal that it's unsynced (silent drop UX)
//   - companion-disconnected banner missing or only ever shown
//     after a full reconnect cycle
//   - the queued/failed indicator showing "0 pending" while the
//     outbox actually has items (background→sidepanel state lag)

const threadUrl = 'https://chatgpt.com/c/t6-offline-pending';
const now = '2026-05-07T03:00:00.000Z';

const settingsFor = (companion: TestCompanion) => ({
  companion: { port: companion.port, bridgeKey: companion.bridgeKey },
  autoTrack: false,
  siteToggles: { chatgpt: true, claude: true, gemini: true },
});

const seededThread = {
  bac_id: 'bac_thread_t62',
  provider: 'chatgpt' as const,
  threadUrl,
  title: 'T6.2 offline-pending fixture',
  lastSeenAt: now,
  status: 'active' as const,
  // 'auto' so the autoCapture handler forwards into storeCaptureEvent
  // (gate at background.ts:1763 silently drops manual+stopped).
  trackingMode: 'auto' as const,
  tags: [] as string[],
  lastTurnRole: 'assistant' as const,
};

test.describe('Tier 6.2 — offline pending visibility', () => {
  test('capture made while companion is offline appears as unsynced in the side panel', async () => {
    test.setTimeout(60_000);

    let companion: TestCompanion | undefined;
    let runtime: ExtensionRuntime | undefined;
    try {
      companion = await startTestCompanion({});
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });

      const page = await seedAndOpenSidepanel(runtime, {
        [SETTINGS_KEY]: settingsFor(companion),
        [THREADS_KEY]: [seededThread],
        [WORKSTREAMS_KEY]: [],
      });

      // Sanity: while companion is up, no companion-disconnected
      // banner should be present. (We poll briefly because the
      // sidepanel's connection-status check is async.)
      await expect
        .poll(
          async () =>
            (await page.locator('.sys-banner').filter({ hasText: 'Companion: disconnected' }).count()) > 0,
          { timeout: 5_000, intervals: [200, 500] },
        )
        .toBe(false);

      // Stop the companion. KEEPS the vault so a later restart can
      // resume against it (T6.3 builds on this).
      await companion.stop();

      // DIAG: poll getWorkboardState to confirm the SW sees the
      // companion as disconnected.
      await expect
        .poll(
          async () => {
            const r = (await runtime!.sendRuntimeMessage(page, {
              type: messageTypes.getWorkboardState,
            })) as { state?: { companionStatus?: string } };
            return r.state?.companionStatus;
          },
          { timeout: 10_000, intervals: [200, 500] },
        )
        .toBe('disconnected');

      // Drive a synthetic capture. autoCapture is the test-friendly
      // entry point — it doesn't depend on a content script.
      // Do NOT `assertOk` — the response intentionally carries
      // ok:false when the companion is offline (assertCompanionReachable
      // throws "Failed to fetch" inside withCompanionStatus). The
      // capture IS still persisted to the local outbox via
      // storeCaptureEvent's catch path; ok:false is the
      // *connectivity* signal, not a "capture lost" signal.
      const captureResponse = (await runtime.sendRuntimeMessage(page, {
        type: messageTypes.autoCapture,
        capture: {
          provider: 'chatgpt',
          threadUrl,
          title: 'T6.2 offline-pending fixture',
          capturedAt: now,
          turns: [
            {
              role: 'user',
              text: 'this capture happens with the companion offline',
              ordinal: 0,
              capturedAt: now,
            },
          ],
        },
      })) as { ok: boolean; error?: string; state?: { companionStatus?: string } };
      // The response should reflect "companion is gone" — that's
      // the right user-facing signal for the SystemBanners stack.
      expect(captureResponse.ok).toBe(false);
      expect(captureResponse.state?.companionStatus).toBe('disconnected');

      // Companion-disconnected banner must appear within a few
      // seconds. Two paths get us there:
      //   1. withCompanionStatus broadcasts workboardChanged even
      //      on the disconnect path (its catch arm).
      //   2. The side panel's refresh() consumes state from
      //      ok:false responses, not just ok:true.
      // Both are required; either alone leaves the user staring
      // at a stale "connected" UI for up to 15 s after they take
      // an action.
      await expectBanner(page, 'companion-disconnected');

      // Queued/failed indicator. Some path through the storage
      // outbox + workboard-state recompute must surface a count.
      // Either banner is acceptable — the contract is "user can see
      // SOMETHING is unsynced," not "we picked exactly this banner."
      const queuedCount = await readBannerCount(page, 'captures-queued');
      const failedCount = await readBannerCount(page, 'captures-failed');
      const total = (queuedCount ?? 0) + (failedCount ?? 0);
      expect(total, 'expected captures-queued OR captures-failed banner with count ≥ 1').toBeGreaterThan(0);
    } finally {
      await runtime?.close();
      await companion?.close();
    }
  });
});
