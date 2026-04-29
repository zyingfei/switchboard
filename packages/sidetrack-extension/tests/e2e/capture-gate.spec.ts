// Synthetic e2e for the strict capture gate. autoCapture messages from
// known-provider hosts (chatgpt/claude/gemini) but non-chat URLs (e.g.
// claude.ai/code, /login, /settings) must be dropped at the background
// layer so they don't create junk thread rows.
import { expect, test } from '@playwright/test';

import { messageTypes } from '../../src/messages';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import { THREADS_KEY, WORKSTREAMS_KEY, assertOk, seedAndOpenSidepanel } from './helpers/sidepanel';

const now = '2026-04-29T12:00:00.000Z';

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

test.describe('capture gate (synthetic)', () => {
  test('autoCapture for non-chat URLs on known-provider hosts is silently dropped', async () => {
    let runtime: ExtensionRuntime | undefined;
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const page = await seedAndOpenSidepanel(runtime, {
        [WORKSTREAMS_KEY]: [ws('bac_ws_gate', 'Capture gate suite')],
        [THREADS_KEY]: [],
      });

      // These URLs are on known-provider hosts but aren't chat threads.
      // Firing autoCapture on each must NOT create a thread record.
      const junkUrls = [
        'https://claude.ai/code',
        'https://claude.ai/settings/profile',
        'https://claude.ai/login',
        'https://chatgpt.com/',
        'https://chatgpt.com/gpts',
        'https://gemini.google.com/app',
      ];

      for (const url of junkUrls) {
        const response = await runtime.sendRuntimeMessage(page, {
          type: messageTypes.autoCapture,
          capture: {
            provider: url.includes('claude.ai')
              ? 'claude'
              : url.includes('chatgpt')
                ? 'chatgpt'
                : 'gemini',
            threadUrl: url,
            title: 'Should not be captured',
            capturedAt: now,
            turns: [
              { role: 'user' as const, text: 'noise', ordinal: 0, capturedAt: now },
              {
                role: 'assistant' as const,
                text: 'noise reply',
                ordinal: 1,
                capturedAt: now,
              },
            ],
          },
        });
        // Response is still ok=true (silent drop) but no thread row is
        // created.
        assertOk(response);
      }

      const stored = await page.evaluate(async () => {
        const all = await chrome.storage.local.get(['sidetrack.threads']);
        return ((all['sidetrack.threads'] ?? []) as { threadUrl: string }[]).length;
      });
      expect(stored).toBe(0);

      // For comparison: a real chat-thread URL goes through.
      const realResponse = await runtime.sendRuntimeMessage(page, {
        type: messageTypes.autoCapture,
        capture: {
          provider: 'claude',
          threadUrl: 'https://claude.ai/chat/abc-123',
          title: 'Real chat thread',
          capturedAt: now,
          turns: [
            { role: 'user' as const, text: 'real question', ordinal: 0, capturedAt: now },
            {
              role: 'assistant' as const,
              text: 'real answer',
              ordinal: 1,
              capturedAt: now,
            },
          ],
        },
      });
      assertOk(realResponse);

      const finalCount = await page.evaluate(async () => {
        const all = await chrome.storage.local.get(['sidetrack.threads']);
        return ((all['sidetrack.threads'] ?? []) as { threadUrl: string }[]).length;
      });
      expect(finalCount).toBe(1);
    } finally {
      await runtime?.close();
    }
  });
});
