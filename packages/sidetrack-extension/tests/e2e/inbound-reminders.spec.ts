// Synthetic e2e: confirms reminders no longer render in the captures
// rail. The All Threads "Unread reply" bucket is the canonical
// inbound-reply signal; the rail is notes-only.
import { expect, test } from '@playwright/test';

import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import {
  REMINDERS_KEY,
  THREADS_KEY,
  WORKSTREAMS_KEY,
  seedAndOpenSidepanel,
} from './helpers/sidepanel';

const now = '2026-04-29T12:00:00.000Z';
const wsId = 'bac_ws_inbound';

const ws = (id: string, title: string) => ({
  bac_id: id,
  revision: `rev_${id}`,
  title,
  children: [] as string[],
  tags: [] as string[],
  checklist: [] as unknown[],
  privacy: 'shared' as const,
  updatedAt: now,
});

test.describe('captures rail: reminders no longer render (synthetic)', () => {
  test('two reminders on the same thread surface as ONE row in the Unread reply bucket — captures rail stays empty', async () => {
    let runtime: ExtensionRuntime | undefined;
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const page = await seedAndOpenSidepanel(runtime, {
        [WORKSTREAMS_KEY]: [ws(wsId, 'Inbound replies')],
        [THREADS_KEY]: [
          {
            bac_id: 'bac_thread_inbound',
            provider: 'gemini' as const,
            threadUrl: 'https://gemini.google.com/app/inbound-thread',
            title: 'Domain Name Productivity Tool Analysis - Google Gemini',
            lastSeenAt: now,
            status: 'active',
            trackingMode: 'manual',
            primaryWorkstreamId: wsId,
            tags: [] as string[],
            lastTurnRole: 'assistant',
          },
        ],
        [REMINDERS_KEY]: [
          {
            bac_id: 'bac_reminder_one',
            threadId: 'bac_thread_inbound',
            provider: 'gemini',
            detectedAt: now,
            status: 'new',
          },
          {
            bac_id: 'bac_reminder_two',
            threadId: 'bac_thread_inbound',
            provider: 'gemini',
            detectedAt: now,
            status: 'new',
          },
        ],
      });

      await page.getByRole('tab', { name: 'All threads' }).click();

      // The thread renders exactly once in the Unread reply bucket.
      const unreadBucket = page.locator('.thread-bucket-unread');
      await expect(unreadBucket.locator('.thread-bucket-label')).toContainText('Unread reply');
      const threadRow = unreadBucket.locator('.thread').filter({
        has: page.locator('.name', { hasText: 'Domain Name Productivity Tool' }),
      });
      await expect(threadRow).toHaveCount(1);
      await expect(threadRow.locator('.dot.signal')).toBeVisible();

      // The captures rail does NOT render either reminder. Notes-only.
      // (No `.capture-list .capture` rows for reminder text.)
      await expect(
        page.locator('.capture-list .capture').filter({ hasText: 'Domain Name Productivity Tool' }),
      ).toHaveCount(0);

      // When SIDETRACK_E2E_DEMO_PAUSE_MS is set, leave the page up so a
      // human can eyeball the rail. Has no effect in CI / headless.
      const pauseMs = Number(process.env.SIDETRACK_E2E_DEMO_PAUSE_MS ?? '0');
      if (Number.isFinite(pauseMs) && pauseMs > 0) {
        await page.waitForTimeout(pauseMs);
      }
    } finally {
      await runtime?.close();
    }
  });

  test('captures rail still renders manual notes (no regression)', async () => {
    let runtime: ExtensionRuntime | undefined;
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const page = await seedAndOpenSidepanel(runtime, {
        [WORKSTREAMS_KEY]: [ws(wsId, 'Inbound replies')],
        [THREADS_KEY]: [],
        ['sidetrack.captureNotes']: [
          {
            bac_id: 'bac_note_one',
            kind: 'manual',
            text: 'A pinned reminder from the user.',
            workstreamId: wsId,
            createdAt: now,
            updatedAt: now,
          },
        ],
        [REMINDERS_KEY]: [
          {
            bac_id: 'bac_reminder_solo',
            threadId: 'bac_thread_solo',
            provider: 'claude',
            detectedAt: now,
            status: 'new',
          },
        ],
      });
      await page.getByRole('tab', { name: 'All threads' }).click();

      // Manual note still appears.
      await expect(page.getByText('A pinned reminder from the user.')).toBeVisible();
      // Captures count badge counts the manual note only — reminders
      // don't contribute to the rail count.
      const capturesHead = page.locator('.sec-head').filter({ hasText: /^Captures/u });
      await expect(capturesHead.locator('.count')).toHaveText('1');
    } finally {
      await runtime?.close();
    }
  });
});
