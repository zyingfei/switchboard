import { expect, test } from '@playwright/test';

import { messageTypes } from '../../src/messages';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import {
  THREADS_KEY,
  WORKSTREAMS_KEY,
  assertOk,
  seedAndOpenSidepanel,
} from './helpers/sidepanel';

const now = new Date().toISOString();

test.describe('fork lineage (synthetic)', () => {
  test('synthetic fork capture resolves parentThreadId and renders lineage markers', async () => {
    let runtime: ExtensionRuntime | undefined;
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const parentUrl = 'https://claude.ai/chat/parent-synthetic';
      const childUrl = 'https://claude.ai/chat/child-synthetic';
      const page = await seedAndOpenSidepanel(runtime, {
        [WORKSTREAMS_KEY]: [
          {
            bac_id: 'ws_research',
            revision: 'rev_ws_research',
            title: 'Research',
            children: [],
            tags: [],
            checklist: [],
            privacy: 'shared',
            updatedAt: now,
          },
        ],
        [THREADS_KEY]: [
          {
            bac_id: 'thread_parent',
            provider: 'claude',
            threadUrl: parentUrl,
            title: 'Original parent thread',
            lastSeenAt: now,
            status: 'active',
            trackingMode: 'manual',
            primaryWorkstreamId: 'ws_research',
            tags: [],
            lastTurnRole: 'assistant',
          },
        ],
      });

      await page.getByRole('tab', { name: 'All threads' }).click();

      const response = await runtime.sendRuntimeMessage(page, {
        type: messageTypes.autoCapture,
        capture: {
          provider: 'claude',
          threadUrl: childUrl,
          title: 'Fork child thread',
          capturedAt: now,
          forkedFromTitle: 'Original parent thread',
          forkedFromUrl: parentUrl,
          turns: [
            {
              role: 'user',
              text: 'continue from the previous branch',
              ordinal: 0,
              capturedAt: now,
            },
            {
              role: 'assistant',
              text: 'continuing from the parent context',
              ordinal: 1,
              capturedAt: now,
            },
          ],
        },
      });
      assertOk(response);

      await expect(page.getByText('Fork child thread')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText('1 fork')).toBeVisible();
      await expect(
        page.locator('.thread-lineage').filter({ hasText: 'Original parent thread' }),
      ).toBeVisible();

      const childParentId = await page.evaluate(async () => {
        const state = await chrome.storage.local.get(['sidetrack.threads']);
        const threads = state['sidetrack.threads'] as
          | readonly { readonly threadUrl: string; readonly parentThreadId?: string }[]
          | undefined;
        return threads?.find((thread) => thread.threadUrl === 'https://claude.ai/chat/child-synthetic')
          ?.parentThreadId;
      });
      expect(childParentId).toBe('thread_parent');
    } finally {
      await runtime?.close();
    }
  });
});
