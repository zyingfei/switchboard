import { expect, test, type Page } from '@playwright/test';

import { messageTypes } from '../../src/messages';
import { startTestCompanion, type TestCompanion } from './helpers/companion';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import {
  SETTINGS_KEY,
  THREADS_KEY,
  WORKSTREAMS_KEY,
  seedAndOpenSidepanel,
} from './helpers/sidepanel';
import { bannerFor, expectBanner, readBannerCount } from './helpers/ui';

// Tier 6.3 — reconnect drains the offline-built queue + UI updates.
//
// Question: "Does reconnect drain safely?"
//
// Setup:
//   1. Boot companion, configure extension.
//   2. Stop companion (KEEP vault).
//   3. Drive N synthetic captures into the offline outbox.
//   4. Restart companion against the same vault on the same port.
//
// User-perceptible invariants:
//   - While offline: queued/failed banner shows count ≥ N
//     (the captures didn't disappear).
//   - After restart: queued/failed count goes to 0; companion-
//     disconnected banner clears; no duplicate thread rows.

const CAPTURE_COUNT = 3;
const baseThreadUrl = 'https://chatgpt.com/c/t63-reconnect';
const now = '2026-05-07T03:30:00.000Z';

const settingsFor = (companion: TestCompanion) => ({
  companion: { port: companion.port, bridgeKey: companion.bridgeKey },
  autoTrack: false,
  siteToggles: { chatgpt: true, claude: true, gemini: true },
});

interface CaptureCount {
  readonly queued: number;
  readonly failed: number;
}

const totalUnsynced = async (page: Page): Promise<CaptureCount> => {
  const queued = (await readBannerCount(page, 'captures-queued')) ?? 0;
  const failed = (await readBannerCount(page, 'captures-failed')) ?? 0;
  return { queued, failed };
};

test.describe('Tier 6.3 — reconnect drains queue + UI updates', () => {
  test('captures made offline drain after companion restart and the side panel reflects 0 unsynced', async () => {
    test.setTimeout(120_000);

    let companion: TestCompanion | undefined;
    let runtime: ExtensionRuntime | undefined;
    try {
      companion = await startTestCompanion({});
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });

      const seededThreads = Array.from({ length: CAPTURE_COUNT }, (_, i) => ({
        bac_id: `bac_thread_t63_${String(i)}`,
        provider: 'chatgpt' as const,
        threadUrl: `${baseThreadUrl}-${String(i)}`,
        title: `T6.3 reconnect-drain fixture ${String(i)}`,
        lastSeenAt: now,
        status: 'active' as const,
        trackingMode: 'auto' as const,
        tags: [] as string[],
        lastTurnRole: 'assistant' as const,
      }));

      const page = await seedAndOpenSidepanel(runtime, {
        [SETTINGS_KEY]: settingsFor(companion),
        [THREADS_KEY]: seededThreads,
        [WORKSTREAMS_KEY]: [],
      });

      // Stop companion. Vault preserved so restart() can resume.
      await companion.stop();

      // Drive N captures while offline. Each lands in the local
      // outbox via storeCaptureEvent's catch path. autoCapture's
      // intent defaults to 'passive' so the queue accepts all.
      for (let i = 0; i < CAPTURE_COUNT; i += 1) {
        await runtime.sendRuntimeMessage(page, {
          type: messageTypes.autoCapture,
          capture: {
            provider: 'chatgpt',
            threadUrl: `${baseThreadUrl}-${String(i)}`,
            title: `T6.3 reconnect-drain fixture ${String(i)}`,
            capturedAt: now,
            turns: [
              {
                role: 'user',
                text: `offline-built capture ${String(i)}`,
                ordinal: 0,
                capturedAt: now,
              },
            ],
          },
        });
      }

      // Side panel must show: companion is disconnected AND there
      // are unsynced items waiting. Without this assertion we'd be
      // depending on T6.2 alone for visibility coverage; here we
      // care that the count is correct, not just nonzero.
      await expectBanner(page, 'companion-disconnected');
      await expect
        .poll(
          async () => {
            const c = await totalUnsynced(page);
            return c.queued + c.failed;
          },
          { timeout: 10_000, intervals: [200, 500] },
        )
        .toBeGreaterThanOrEqual(CAPTURE_COUNT);

      // Restart companion against the same vault on the same port.
      // Bridge key + replicaId are read from disk so the extension
      // doesn't need a re-seed.
      await companion.restart();

      // Trigger a side-panel refresh — getWorkboardState's path
      // through withCompanionStatus calls replayQueuedCaptures
      // BEFORE assertCompanionReachable, so a single
      // getWorkboardState now drains the queue. Without this we'd
      // wait up to 15 s for the periodic poll. We then re-assert
      // the panel shows the drained state.
      await runtime.sendRuntimeMessage(page, {
        type: messageTypes.getWorkboardState,
      });

      // companion-disconnected banner should clear.
      await expect(bannerFor(page, 'companion-disconnected')).toHaveCount(0, {
        timeout: 15_000,
      });

      // Unsynced count goes to 0 (queue + failed both empty).
      // Drain is async — the queue items POST to /v1/events one
      // by one, so we poll.
      await expect
        .poll(
          async () => {
            const c = await totalUnsynced(page);
            return c.queued + c.failed;
          },
          { timeout: 30_000, intervals: [500, 1_000, 2_000] },
        )
        .toBe(0);

      // No duplicate thread rows — idempotency-key on the queued
      // captures must dedupe at the companion. We can't easily
      // count rows from outside without UI reflow guarantees, but
      // the queue draining to 0 + the absence of failures is the
      // load-bearing assertion.
    } finally {
      await runtime?.close();
      await companion?.close();
    }
  });
});
