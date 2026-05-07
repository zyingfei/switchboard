import { expect, test } from '@playwright/test';

import { startTestCompanion, type TestCompanion } from './helpers/companion';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import {
  SETTINGS_KEY,
  THREADS_KEY,
  WORKSTREAMS_KEY,
  seedAndOpenSidepanel,
} from './helpers/sidepanel';
import { bannerFor } from './helpers/ui';

// Tier 6.7 — distinct failure-mode banners.
//
// Question: "Does relay/companion failure produce clear UI state?"
//
// Three sub-cases were planned:
//   a) companion-down only          → companion_disconnected banner
//   b) relay-down only              → distinct banner (NEEDS F8)
//   c) both companion & relay down  → composed banners (NEEDS F8)
//
// Sub-cases (b) and (c) require relay status to be exposed in
// /v1/system/health and routed to a new SystemBanners state. That's
// product/UI work tracked as F8 in the task list — until it lands,
// the side panel cannot distinguish "companion up, relay down" from
// "everything fine," because the user's local captures still succeed
// and there's no current signal that cross-device sync is paused.
//
// This file covers (a) only and documents (b)/(c) explicitly so a
// future commit landing F8 has the test scaffolding waiting for it.

const settingsFor = (companion: TestCompanion) => ({
  companion: { port: companion.port, bridgeKey: companion.bridgeKey },
  autoTrack: false,
  siteToggles: { chatgpt: true, claude: true, gemini: true },
});

test.describe('Tier 6.7 — distinct failure-mode banners', () => {
  test('T6.7.a — companion-down only surfaces companion_disconnected without sibling false-positives', async () => {
    test.setTimeout(60_000);

    let companion: TestCompanion | undefined;
    let runtime: ExtensionRuntime | undefined;
    try {
      companion = await startTestCompanion({});
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const page = await seedAndOpenSidepanel(runtime, {
        [SETTINGS_KEY]: settingsFor(companion),
        [THREADS_KEY]: [],
        [WORKSTREAMS_KEY]: [],
      });

      // Sanity: while companion is up, no companion-disconnected
      // banner. (Brief poll because the connection-status check is
      // async after the side panel mounts.)
      await expect(bannerFor(page, 'companion-disconnected')).toHaveCount(0, {
        timeout: 5_000,
      });

      // Stop companion. With no user action to trigger an action-
      // shaped broadcast, the side panel learns about the
      // disconnect via its 15 s periodic refresh
      // (sidepanel/App.tsx:723). Allow ~17 s for one cycle plus
      // jitter. T6.2 covers the sub-5s case where a user action
      // (capture) drives a broadcast immediately.
      await companion.stop();

      // Companion-disconnected banner appears within ~17 s.
      await expect(
        page
          .locator('.sys-banner')
          .filter({ has: page.locator('.sys-title', { hasText: 'Companion: disconnected' }) }),
      ).toHaveCount(1, { timeout: 17_000 });

      // Sibling failure banners must NOT trigger. The user shouldn't
      // see a vault-error banner when only the companion HTTP
      // listener is gone — that's a separate failure shape with
      // its own copy + Re-pick action.
      await expect(bannerFor(page, 'vault-unreachable')).toHaveCount(0);
      // No queued/failed captures on a vault that hasn't done any
      // capture work — the user just opened the panel.
      await expect(bannerFor(page, 'captures-failed')).toHaveCount(0);
    } finally {
      await runtime?.close();
      await companion?.close();
    }
  });

  // T6.7.b — relay-down only. Skipped pending F8 (relay status
  // surfaced in /v1/system/health + a SystemBanners 'relay_disconnected'
  // state). Without those, the extension cannot distinguish
  // "companion up, relay down" from "everything fine," because
  // local captures still succeed and there's no sync-state signal.
  test.skip('T6.7.b — relay-down only surfaces a distinct sync-paused banner (BLOCKED on F8)', async () => {
    // Outline of the test (will pass after F8 ships):
    //
    // 1. Start a standalone TestRelay on its own port.
    // 2. Boot two companions wired to it via --sync-relay; share
    //    a rendezvous secret.
    // 3. Open the side panel against companion A.
    // 4. Stop the relay (NOT the companions).
    // 5. Drive a capture in A — it succeeds locally because the
    //    companion is up.
    // 6. Side panel must surface: "Sync paused" / "Peer sync
    //    unavailable" — distinct copy from companion-disconnected.
    // 7. companion-disconnected banner must NOT appear (companion
    //    is up).
    // 8. Restart relay → banner clears within 15 s.
  });

  // T6.7.c — both companion & relay down. Skipped pending F8.
  test.skip('T6.7.c — both down surfaces both banners, not a single generic message (BLOCKED on F8)', async () => {
    // Outline of the test (will pass after F8 ships):
    //
    // 1. Stop both companion and relay.
    // 2. Side panel surfaces companion-disconnected + the new
    //    relay-disconnected banner — composed, not collapsed
    //    into a single "Something is wrong" message.
    // 3. The user can tell what to fix first.
  });
});
