// Synthetic e2e for the tracking-mode toggle on a thread row:
// Stop → updates trackingMode to 'stopped'; Resume → flips it back.
// Complements tab-recovery.spec.ts which only covers the rendered
// state, not the transition.
import { expect, test, type Page } from '@playwright/test';

import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import { THREADS_KEY, WORKSTREAMS_KEY, seedAndOpenSidepanel } from './helpers/sidepanel';

const now = '2026-04-29T12:00:00.000Z';
const wsId = 'bac_ws_tracking';

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

const thread = (overrides: Record<string, unknown>) => ({
  bac_id: `bac_thread_${Math.random().toString(36).slice(2, 10)}`,
  provider: 'claude' as const,
  threadUrl: `https://claude.ai/chat/${Math.random().toString(36).slice(2, 10)}`,
  title: 'Tracking-mode thread',
  lastSeenAt: now,
  status: 'active',
  trackingMode: 'auto',
  primaryWorkstreamId: wsId,
  tags: [] as string[],
  lastTurnRole: 'assistant',
  ...overrides,
});

const expandStaleBucket = async (page: Page) => {
  const staleHeader = page.getByRole('button', { name: /Stale or closed/u });
  if ((await staleHeader.getAttribute('aria-expanded')) === 'false') {
    await staleHeader.click();
  }
};

test.describe('tracking mode toggle (synthetic)', () => {
  test('Stop on an actively-tracked thread flips trackingMode to stopped', async () => {
    let runtime: ExtensionRuntime | undefined;
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const tracked = thread({
        bac_id: 'bac_thread_tracked',
        title: 'Actively tracked thread',
        trackingMode: 'auto',
      });

      const page = await seedAndOpenSidepanel(runtime, {
        [WORKSTREAMS_KEY]: [ws(wsId, 'Tracking suite')],
        [THREADS_KEY]: [tracked],
      });
      await page.getByRole('tab', { name: 'All threads' }).click();

      const row = page
        .locator('.thread')
        .filter({ has: page.locator('.name', { hasText: tracked.title }) });
      await expect(row).toBeVisible();
      // Initial state: a Stop button is visible (and a Resume is not).
      await expect(row.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
      await expect(row.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);

      await row.getByRole('button', { name: 'Stop', exact: true }).click();
      await expandStaleBucket(page);

      // After flip: stamp shows "Tracking stopped"; Resume button replaces Stop.
      await expect(row.locator('.stamp')).toContainText('Tracking stopped');
      await expect(row.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
      await expect(row.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);

      // Storage round-trip.
      const persisted = await page.evaluate(async (id) => {
        const all = await chrome.storage.local.get(['sidetrack.threads']);
        const threads = (all['sidetrack.threads'] ?? []) as {
          bac_id: string;
          trackingMode: string;
        }[];
        return threads.find((t) => t.bac_id === id)?.trackingMode ?? null;
      }, tracked.bac_id);
      expect(persisted).toBe('stopped');
    } finally {
      await runtime?.close();
    }
  });

  test('Resume on a stopped thread flips trackingMode back to auto for known providers', async () => {
    let runtime: ExtensionRuntime | undefined;
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const stopped = thread({
        bac_id: 'bac_thread_stopped_resume',
        title: 'Stopped thread to resume',
        trackingMode: 'stopped',
      });

      const page = await seedAndOpenSidepanel(runtime, {
        [WORKSTREAMS_KEY]: [ws(wsId, 'Tracking suite')],
        [THREADS_KEY]: [stopped],
      });
      await page.getByRole('tab', { name: 'All threads' }).click();
      await expandStaleBucket(page);

      const row = page
        .locator('.thread')
        .filter({ has: page.locator('.name', { hasText: stopped.title }) });
      await expect(row.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
      await row.getByRole('button', { name: 'Resume', exact: true }).click();

      // After resume: Stop button reappears, the "Tracking stopped"
      // stamp goes away.
      await expect(row.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
      await expect(row.locator('.stamp')).not.toContainText('Tracking stopped');

      // Known-provider thread should resume to "auto", not "manual".
      const persisted = await page.evaluate(async (id) => {
        const all = await chrome.storage.local.get(['sidetrack.threads']);
        const threads = (all['sidetrack.threads'] ?? []) as {
          bac_id: string;
          trackingMode: string;
        }[];
        return threads.find((t) => t.bac_id === id)?.trackingMode ?? null;
      }, stopped.bac_id);
      expect(persisted).toBe('auto');
    } finally {
      await runtime?.close();
    }
  });
});
