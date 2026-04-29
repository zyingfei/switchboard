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

test.describe('workstream privacy (synthetic)', () => {
  test('private workstreams mask thread and inbound titles while shared workstreams keep them visible', async () => {
    let runtime: ExtensionRuntime | undefined;
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const page = await seedAndOpenSidepanel(runtime, {
        [WORKSTREAMS_KEY]: [
          workstream('ws_private', 'Secret work', 'private'),
          workstream('ws_shared', 'Visible work', 'shared'),
        ],
        [THREADS_KEY]: [
          thread('thread_private', 'Stealth planning doc', 'ws_private'),
          thread('thread_shared', 'Public roadmap draft', 'ws_shared', 'chatgpt'),
        ],
        [REMINDERS_KEY]: [
          {
            bac_id: 'reminder_private',
            threadId: 'thread_private',
            provider: 'claude',
            detectedAt: now,
            status: 'new',
          },
          {
            bac_id: 'reminder_shared',
            threadId: 'thread_shared',
            provider: 'chatgpt',
            detectedAt: now,
            status: 'new',
          },
        ],
      });

      await page.getByRole('tab', { name: 'All threads' }).click();

      const privateRow = page.locator('.thread', { hasText: 'Unread reply' }).filter({
        has: page.locator('.provider.claude'),
      });
      await expect(privateRow.getByText('[private]', { exact: true })).toBeVisible();
      await expect(privateRow.getByText('Stealth planning doc')).toHaveCount(0);

      const sharedRow = page.locator('.thread', { hasText: 'Public roadmap draft' }).filter({
        has: page.locator('.provider.chatgpt'),
      });
      await expect(sharedRow.getByText('Public roadmap draft')).toBeVisible();

      await expect(page.locator('.capture').filter({ hasText: '[private]' }).first()).toBeVisible();
      await expect(page.locator('.capture').filter({ hasText: 'Public roadmap draft' }).first()).toBeVisible();
    } finally {
      await runtime?.close();
    }
  });
});
