import { expect, test } from '@playwright/test';

import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import {
  REMINDERS_KEY,
  THREADS_KEY,
  WORKSTREAMS_KEY,
  seedAndOpenSidepanel,
} from './helpers/sidepanel';

const now = new Date().toISOString();

const workstream = (bac_id: string, title: string, privacy: 'private' | 'shared') => ({
  bac_id,
  revision: `rev_${bac_id}`,
  title,
  children: [] as string[],
  tags: [] as string[],
  checklist: [] as unknown[],
  privacy,
  updatedAt: now,
});

const thread = (
  bac_id: string,
  title: string,
  workstreamId: string,
  provider: 'claude' | 'chatgpt' = 'claude',
) => ({
  bac_id,
  provider,
  threadUrl: `https://${provider === 'chatgpt' ? 'chatgpt.com' : 'claude.ai'}/chat/${bac_id}`,
  title,
  lastSeenAt: now,
  status: 'active',
  trackingMode: 'manual',
  primaryWorkstreamId: workstreamId,
  tags: [] as string[],
  lastTurnRole: 'assistant',
});

test.describe('live workstream privacy (logged-in profile)', () => {
  test.skip(
    () =>
      process.env.SIDETRACK_E2E_LIVE_PRIVACY === undefined ||
      process.env.SIDETRACK_E2E_LIVE_PRIVACY.length === 0,
    'opt-in: requires SIDETRACK_E2E_LIVE_PRIVACY=1',
  );
  test.skip(
    () =>
      (process.env.SIDETRACK_USER_DATA_DIR === undefined ||
        process.env.SIDETRACK_USER_DATA_DIR.length === 0) &&
      (process.env.SIDETRACK_E2E_CDP_URL === undefined ||
        process.env.SIDETRACK_E2E_CDP_URL.length === 0),
    'requires SIDETRACK_USER_DATA_DIR or SIDETRACK_E2E_CDP_URL',
  );

  test('private workstreams stay masked in the real Chrome profile while shared ones stay readable', async () => {
    let runtime: ExtensionRuntime | undefined;
    try {
      runtime = await launchExtensionRuntime();
      const page = await seedAndOpenSidepanel(runtime, {
        [WORKSTREAMS_KEY]: [
          workstream('ws_private_live', 'Private live work', 'private'),
          workstream('ws_shared_live', 'Shared live work', 'shared'),
        ],
        [THREADS_KEY]: [
          thread('thread_private_live', 'Private capture title', 'ws_private_live'),
          thread('thread_shared_live', 'Shared capture title', 'ws_shared_live', 'chatgpt'),
        ],
        [REMINDERS_KEY]: [
          {
            bac_id: 'reminder_private_live',
            threadId: 'thread_private_live',
            provider: 'claude',
            detectedAt: now,
            status: 'new',
          },
          {
            bac_id: 'reminder_shared_live',
            threadId: 'thread_shared_live',
            provider: 'chatgpt',
            detectedAt: now,
            status: 'new',
          },
        ],
      });

      await page.getByRole('tab', { name: 'All threads' }).click();

      const privateRow = page.locator('.thread').filter({ has: page.locator('.provider.claude') });
      await expect(privateRow.getByText('[private]', { exact: true })).toBeVisible();
      await expect(privateRow.getByText('Private capture title')).toHaveCount(0);

      const sharedRow = page.locator('.thread').filter({ has: page.locator('.provider.chatgpt') });
      await expect(sharedRow.getByText('Shared capture title')).toBeVisible();

      await expect(page.locator('.capture').filter({ hasText: '[private]' }).first()).toBeVisible();
      await expect(page.locator('.capture').filter({ hasText: 'Shared capture title' }).first()).toBeVisible();
    } finally {
      await runtime?.close();
    }
  });
});
