// Synthetic e2e: per-thread auto-send toggle round-trips through
// chrome.storage. The actual drain (paste + send + wait for AI) is
// gated on §24.10 safety primitives that ship in M2; this spec
// covers the contract — the toggle persists, only renders for
// threads that have pending queue items, and survives reloads.
import { expect, test } from '@playwright/test';

import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import {
  THREADS_KEY,
  WORKSTREAMS_KEY,
  seedAndOpenSidepanel,
} from './helpers/sidepanel';

const QUEUE_ITEMS_KEY = 'sidetrack.queueItems';

const now = '2026-04-29T12:00:00.000Z';
const threadId = 'bac_thread_autosend';
const threadUrl = 'https://gemini.google.com/app/autosend-toggle-thread';

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

const baseThread = {
  bac_id: threadId,
  provider: 'gemini' as const,
  threadUrl,
  title: 'Auto-send target',
  lastSeenAt: now,
  status: 'active',
  trackingMode: 'manual',
  primaryWorkstreamId: 'bac_ws_autosend',
  tags: [] as string[],
  lastTurnRole: 'assistant',
};

test.describe('per-thread auto-send toggle (synthetic)', () => {
  test('Auto-send toggle renders only when the thread has pending queue items', async () => {
    let runtime: ExtensionRuntime | undefined;
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const page = await seedAndOpenSidepanel(runtime, {
        [WORKSTREAMS_KEY]: [ws('bac_ws_autosend', 'Auto-send suite')],
        [THREADS_KEY]: [baseThread],
        // No queue items seeded yet.
        [QUEUE_ITEMS_KEY]: [],
      });
      await page.getByRole('tab', { name: 'All threads' }).click();

      const threadRow = page
        .locator('.thread')
        .filter({ has: page.locator('.name', { hasText: 'Auto-send target' }) });
      await expect(threadRow).toBeVisible();
      // Without queued items the toggle isn't rendered.
      await expect(threadRow.locator('.thread-autosend')).toHaveCount(0);
    } finally {
      await runtime?.close();
    }
  });

  test('Clicking the toggle persists autoSendEnabled to storage and flips the on-state class', async () => {
    let runtime: ExtensionRuntime | undefined;
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const page = await seedAndOpenSidepanel(runtime, {
        [WORKSTREAMS_KEY]: [ws('bac_ws_autosend', 'Auto-send suite')],
        [THREADS_KEY]: [baseThread],
        [QUEUE_ITEMS_KEY]: [
          {
            bac_id: 'bac_q_one',
            text: 'first follow-up',
            scope: 'thread' as const,
            targetId: threadId,
            status: 'pending' as const,
            createdAt: now,
            updatedAt: now,
          },
        ],
      });
      await page.getByRole('tab', { name: 'All threads' }).click();

      const threadRow = page
        .locator('.thread')
        .filter({ has: page.locator('.name', { hasText: 'Auto-send target' }) });
      const toggle = threadRow.locator('.thread-autosend');
      await expect(toggle).toBeVisible();
      await expect(toggle).toContainText('Auto-send: off');
      await expect(toggle).not.toHaveClass(/\bon\b/u);

      await toggle.click();

      await expect(toggle).toContainText('Auto-send: on');
      await expect(toggle).toHaveClass(/\bon\b/u);

      // Storage round-trip.
      const stored = await page.evaluate(async (key) => {
        const all = await chrome.storage.local.get([key]);
        const threads = (all[key] ?? []) as { bac_id: string; autoSendEnabled?: boolean }[];
        return threads.find((thread) => thread.bac_id === 'bac_thread_autosend')
          ?.autoSendEnabled;
      }, THREADS_KEY);
      expect(stored).toBe(true);

      // Reload and verify the toggle keeps its state.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('tab', { name: 'All threads' }).click();
      await expect(threadRow.locator('.thread-autosend')).toHaveClass(/\bon\b/u);
    } finally {
      await runtime?.close();
    }
  });
});
