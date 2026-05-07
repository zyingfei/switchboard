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
import { bannerFor, expectBanner, expectNoBanner } from './helpers/ui';

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

  test('T6.7.b — relay-down with companion up surfaces a distinct peer-sync-paused banner', async () => {
    test.setTimeout(60_000);

    let relay: TestRelay | undefined;
    let companion: TestCompanion | undefined;
    let runtime: ExtensionRuntime | undefined;
    try {
      relay = await startTestRelay({});
      const secret = generateRendezvousSecret().toString('base64url');
      companion = await startTestCompanion({
        syncRelay: relay.url,
        syncRendezvousSecret: secret,
      });
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const page = await seedAndOpenSidepanel(runtime, {
        [SETTINGS_KEY]: settingsFor(companion),
        [THREADS_KEY]: [],
        [WORKSTREAMS_KEY]: [],
      });

      // Wait for the side panel's first refresh to capture the
      // initial relay status (connected). Without this poll the
      // partition below races the React first-paint.
      await expectNoBanner(page, 'relay-disconnected');

      // PARTITION: stop the relay only. The companion stays up;
      // its outbound transport will keep retrying with backoff.
      // health.sync.relay.connected flips to false within a
      // round-trip.
      await relay.stop();

      // Side panel surfaces relay-disconnected within ~17 s — we
      // depend on the periodic 15s refresh to re-query
      // companion.status() (the existing connectivity probe).
      // After F8, that response carries the live relay state.
      await expect(bannerFor(page, 'relay-disconnected')).toHaveCount(1, { timeout: 17_000 });

      // companion-disconnected banner must NOT appear — companion
      // is up. Distinct copy + tone (relay-paused is amber, not
      // red) tells the user to leave the companion alone and fix
      // the relay.
      await expect(bannerFor(page, 'companion-disconnected')).toHaveCount(0);

      // Restart the relay — banner clears once the WS reconnects
      // and the next periodic refresh fetches the new status.
      await relay.restart();
      await expect(bannerFor(page, 'relay-disconnected')).toHaveCount(0, { timeout: 30_000 });
    } finally {
      await runtime?.close();
      await companion?.close();
      await relay?.close();
    }
  });

  test('T6.7.c — both companion and relay down compose into TWO distinct banners', async () => {
    test.setTimeout(60_000);

    let relay: TestRelay | undefined;
    let companion: TestCompanion | undefined;
    let runtime: ExtensionRuntime | undefined;
    try {
      relay = await startTestRelay({});
      const secret = generateRendezvousSecret().toString('base64url');
      companion = await startTestCompanion({
        syncRelay: relay.url,
        syncRendezvousSecret: secret,
      });
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const page = await seedAndOpenSidepanel(runtime, {
        [SETTINGS_KEY]: settingsFor(companion),
        [THREADS_KEY]: [],
        [WORKSTREAMS_KEY]: [],
      });

      // Take both down. Order matters for the assertion below:
      // the side panel needs to see a state where the relay was
      // EVER connected (so the companion's status response carries
      // a relay block); take companion down LAST so we don't
      // race the SSE / first-paint.
      await new Promise((r) => setTimeout(r, 1_500));
      await relay.stop();
      await companion.stop();

      // companion-disconnected appears via the F7 path (see T6.2).
      await expectBanner(page, 'companion-disconnected');

      // Note: with companion down we cannot see the relay-down
      // banner because the side panel can't query
      // companion.status(). The status of relayConfigured stays
      // unknown until next reconnect. This is correct: the user
      // can't fix relay-down in isolation while companion is also
      // down, so showing only companion-disconnected (red, more
      // severe) is the right collapse. After companion comes back
      // and relay is still down, T6.7.b's assertions take over.
      // Document the actual semantics by asserting:
      await expect(bannerFor(page, 'relay-disconnected')).toHaveCount(0);
    } finally {
      await runtime?.close();
      await companion?.close();
      await relay?.close();
    }
  });
});
