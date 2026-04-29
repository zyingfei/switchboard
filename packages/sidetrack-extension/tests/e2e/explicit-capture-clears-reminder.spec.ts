// Synthetic e2e: when the user dismisses a thread's reminders, the
// lifecycle pill flips from "Unread reply" to the natural derivation
// ("You replied last" for an assistant-final turn). This is the
// observable side effect of dismissRemindersForThread() which runs
// after every explicit captureCurrentTab — the user is actively
// looking at the thread, so the pill shouldn't claim it's unread.
import { expect, test } from '@playwright/test';

import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import {
  REMINDERS_KEY,
  THREADS_KEY,
  WORKSTREAMS_KEY,
  seedAndOpenSidepanel,
} from './helpers/sidepanel';

const now = '2026-04-29T12:00:00.000Z';
const threadId = 'bac_thread_dismiss';
const threadUrl = 'https://gemini.google.com/app/dismiss-reminder-thread';

test.describe('explicit capture clears reminder (synthetic)', () => {
  test('flipping a thread reminder to dismissed clears the Unread reply pill', async () => {
    let runtime: ExtensionRuntime | undefined;
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const page = await seedAndOpenSidepanel(runtime, {
        [WORKSTREAMS_KEY]: [
          {
            bac_id: 'bac_ws_dismiss',
            revision: 'rev_ws_dismiss',
            title: 'Dismiss reminder suite',
            children: [],
            tags: [],
            checklist: [],
            privacy: 'shared',
            updatedAt: now,
          },
        ],
        [THREADS_KEY]: [
          {
            bac_id: threadId,
            provider: 'gemini',
            threadUrl,
            title: 'Reminder dismissal target',
            lastSeenAt: now,
            status: 'active',
            trackingMode: 'manual',
            primaryWorkstreamId: 'bac_ws_dismiss',
            tags: [],
            lastTurnRole: 'assistant',
          },
        ],
        [REMINDERS_KEY]: [
          {
            bac_id: 'bac_reminder_pending',
            threadId,
            provider: 'gemini',
            detectedAt: now,
            status: 'new',
          },
        ],
      });
      await page.getByRole('tab', { name: 'All threads' }).click();

      const threadRow = page
        .locator('.thread')
        .filter({ has: page.locator('.name', { hasText: 'Reminder dismissal target' }) });

      // Initial: pending reminder → "Unread reply" pill.
      await expect(threadRow.locator('.lifecycle-pill')).toContainText('Unread reply');

      // Simulate dismissRemindersForThread (the side effect of
      // explicit captureCurrentTab) by flipping the reminder status.
      await page.evaluate(async (key) => {
        const all = await chrome.storage.local.get([key]);
        const reminders = (all[key] ?? []) as { bac_id: string; status: string }[];
        const next = reminders.map((reminder) => ({ ...reminder, status: 'dismissed' }));
        await chrome.storage.local.set({ [key]: next });
      }, REMINDERS_KEY);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('tab', { name: 'All threads' }).click();

      // After dismissal: natural pill kicks in. Last turn was assistant
      // so the lifecycle resolves to "You replied last".
      await expect(threadRow.locator('.lifecycle-pill')).toContainText('You replied last');
    } finally {
      await runtime?.close();
    }
  });
});
