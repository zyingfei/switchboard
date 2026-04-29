// Synthetic e2e for the queue auto-resolve word-boundary match.
// Regression: the original substring matcher had a length floor (>=4
// chars) so short queue items like "hi" never auto-resolved. The
// word-boundary matcher catches short text without false-positives.
import { expect, test, type Page } from '@playwright/test';

import { messageTypes } from '../../src/messages';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import {
  THREADS_KEY,
  WORKSTREAMS_KEY,
  assertOk,
  seedAndOpenSidepanel,
} from './helpers/sidepanel';

const QUEUE_ITEMS_KEY = 'sidetrack.queueItems';

const now = '2026-04-29T12:00:00.000Z';
const wsId = 'bac_ws_queue_short';
const threadId = 'bac_thread_queue_short';
const threadUrl = 'https://gemini.google.com/app/queue-short-thread';

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

const thread = {
  bac_id: threadId,
  provider: 'gemini' as const,
  threadUrl,
  title: 'Queue short-text test',
  lastSeenAt: now,
  status: 'active',
  trackingMode: 'manual',
  primaryWorkstreamId: wsId,
  tags: [] as string[],
  lastTurnRole: 'assistant',
};

const queueItem = (id: string, text: string) => ({
  bac_id: id,
  text,
  scope: 'thread' as const,
  targetId: threadId,
  status: 'pending' as const,
  createdAt: now,
  updatedAt: now,
});

interface StoredQueueItem {
  readonly bac_id: string;
  readonly text: string;
  readonly status: string;
}

const readQueue = (page: Page) =>
  page.evaluate(async (key) => {
    const all = await chrome.storage.local.get([key]);
    return ((all[key] ?? []) as { bac_id: string; text: string; status: string }[]).map((q) => ({
      bac_id: q.bac_id,
      text: q.text,
      status: q.status,
    }));
  }, QUEUE_ITEMS_KEY);

test.describe('queue auto-resolve — word-boundary match (synthetic)', () => {
  test('short queue item "hi" flips to done when user turn contains the word hi', async () => {
    let runtime: ExtensionRuntime | undefined;
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const page = await seedAndOpenSidepanel(runtime, {
        [WORKSTREAMS_KEY]: [ws(wsId, 'Queue short suite')],
        [THREADS_KEY]: [thread],
        [QUEUE_ITEMS_KEY]: [queueItem('bac_q_hi', 'hi')],
      });

      // Inject a Gemini-style user turn — the extractor wraps user
      // messages with "You said " prefix, exactly the shape that
      // broke the old length-floor heuristic.
      const response = await runtime.sendRuntimeMessage(page, {
        type: messageTypes.autoCapture,
        capture: {
          provider: 'gemini',
          threadUrl,
          title: 'Queue short-text test',
          capturedAt: now,
          turns: [
            { role: 'user' as const, text: 'You said hi', ordinal: 0, capturedAt: now },
            {
              role: 'assistant' as const,
              text: 'Hello! How can I help?',
              ordinal: 1,
              capturedAt: now,
            },
          ],
        },
      });
      assertOk(response);

      const queue = (await readQueue(page)) as StoredQueueItem[];
      const hiItem = queue.find((q) => q.bac_id === 'bac_q_hi');
      expect(hiItem?.status).toBe('done');
    } finally {
      await runtime?.close();
    }
  });

  test('short queue item "hi" does NOT flip when user turn is "history of art" (no word boundary)', async () => {
    let runtime: ExtensionRuntime | undefined;
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const page = await seedAndOpenSidepanel(runtime, {
        [WORKSTREAMS_KEY]: [ws(wsId, 'Queue short suite')],
        [THREADS_KEY]: [thread],
        [QUEUE_ITEMS_KEY]: [queueItem('bac_q_hi', 'hi')],
      });

      const response = await runtime.sendRuntimeMessage(page, {
        type: messageTypes.autoCapture,
        capture: {
          provider: 'gemini',
          threadUrl,
          title: 'Queue short-text test',
          capturedAt: now,
          turns: [
            {
              role: 'user' as const,
              text: 'You said history of art',
              ordinal: 0,
              capturedAt: now,
            },
            {
              role: 'assistant' as const,
              text: 'Sure, where would you like to start?',
              ordinal: 1,
              capturedAt: now,
            },
          ],
        },
      });
      assertOk(response);

      const queue = (await readQueue(page)) as StoredQueueItem[];
      const hiItem = queue.find((q) => q.bac_id === 'bac_q_hi');
      expect(hiItem?.status).toBe('pending');
    } finally {
      await runtime?.close();
    }
  });

  test('multi-word queue item still matches inside a longer user turn', async () => {
    let runtime: ExtensionRuntime | undefined;
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const page = await seedAndOpenSidepanel(runtime, {
        [WORKSTREAMS_KEY]: [ws(wsId, 'Queue short suite')],
        [THREADS_KEY]: [thread],
        [QUEUE_ITEMS_KEY]: [queueItem('bac_q_phrase', 'add a control arm')],
      });

      const response = await runtime.sendRuntimeMessage(page, {
        type: messageTypes.autoCapture,
        capture: {
          provider: 'gemini',
          threadUrl,
          title: 'Queue short-text test',
          capturedAt: now,
          turns: [
            {
              role: 'user' as const,
              text: 'Please add a control arm to the experiment.',
              ordinal: 0,
              capturedAt: now,
            },
            {
              role: 'assistant' as const,
              text: 'Adding a control arm.',
              ordinal: 1,
              capturedAt: now,
            },
          ],
        },
      });
      assertOk(response);

      const queue = (await readQueue(page)) as StoredQueueItem[];
      const phraseItem = queue.find((q) => q.bac_id === 'bac_q_phrase');
      expect(phraseItem?.status).toBe('done');
    } finally {
      await runtime?.close();
    }
  });
});
