// Synthetic coverage for the two non-pill lifecycle kinds the side
// panel surfaces — `tab-closed` (status='restorable' or 'closed')
// and `tracking-stopped` (trackingMode='stopped'). Both render the
// thread row with a gray dot, a stamp like "Tab closed · X ago", and
// no lifecycle pill (deriveLifecycle returns undefined for the pill
// in those branches).
//
// Complements spec-coverage.spec.ts which tests the 5 pill kinds.
import { expect, test, type Page } from '@playwright/test';

import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import { THREADS_KEY, WORKSTREAMS_KEY, seedAndOpenSidepanel } from './helpers/sidepanel';

const now = new Date().toISOString();
const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

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
  title: 'Test thread',
  lastSeenAt: fiveMinAgo,
  status: 'active',
  trackingMode: 'manual',
  primaryWorkstreamId: 'bac_ws_recovery',
  tags: [] as string[],
  lastTurnRole: 'assistant',
  ...overrides,
});

const findThreadRowByTitle = (page: Page, title: string) =>
  page.locator('.thread').filter({ has: page.locator('.name', { hasText: title }) });

test.describe('tab-recovery / tracking-stopped lifecycle (synthetic)', () => {
  test('a thread with status=restorable shows "Tab closed" stamp and no lifecycle pill', async () => {
    let runtime: ExtensionRuntime | undefined;
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const wsId = 'bac_ws_recovery';
      const closedThread = thread({
        bac_id: 'bac_thread_closed',
        title: 'Thread with closed tab',
        status: 'restorable',
      });
      const liveThread = thread({
        bac_id: 'bac_thread_live',
        title: 'Thread with live tab',
        status: 'active',
      });

      const page = await seedAndOpenSidepanel(runtime, {
        [WORKSTREAMS_KEY]: [ws(wsId, 'Recovery suite')],
        [THREADS_KEY]: [closedThread, liveThread],
      });
      await page.getByRole('tab', { name: 'All threads' }).click();

      const closedRow = findThreadRowByTitle(page, closedThread.title);
      await expect(closedRow).toBeVisible();
      // Stamp text includes "Tab closed" prefix.
      await expect(closedRow.locator('.stamp')).toContainText('Tab closed');
      // No lifecycle pill is rendered for tab-closed kind.
      await expect(closedRow.locator('.lifecycle-pill')).toHaveCount(0);
      // Dot class is gray.
      await expect(closedRow.locator('.dot.gray')).toBeVisible();

      // The active thread alongside it still gets its normal green dot, so we
      // know the difference is per-thread, not panel-wide.
      const liveRow = findThreadRowByTitle(page, liveThread.title);
      await expect(liveRow.locator('.dot.green')).toBeVisible();
    } finally {
      await runtime?.close();
    }
  });

  test('a thread with trackingMode=stopped shows "Tracking stopped" stamp and no lifecycle pill', async () => {
    let runtime: ExtensionRuntime | undefined;
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const wsId = 'bac_ws_recovery';
      const stoppedThread = thread({
        bac_id: 'bac_thread_stopped',
        title: 'Thread with tracking stopped',
        trackingMode: 'stopped',
      });

      const page = await seedAndOpenSidepanel(runtime, {
        [WORKSTREAMS_KEY]: [ws(wsId, 'Recovery suite')],
        [THREADS_KEY]: [stoppedThread],
      });
      await page.getByRole('tab', { name: 'All threads' }).click();

      const row = findThreadRowByTitle(page, stoppedThread.title);
      await expect(row).toBeVisible();
      await expect(row.locator('.stamp')).toContainText('Tracking stopped');
      await expect(row.locator('.lifecycle-pill')).toHaveCount(0);
      await expect(row.locator('.dot.gray')).toBeVisible();
    } finally {
      await runtime?.close();
    }
  });
});
