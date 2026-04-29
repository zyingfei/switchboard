import { expect, test } from '@playwright/test';

import { isRuntimeResponse, messageTypes } from '../../src/messages';
import { startProviderFixtureServer, type FixtureServer } from './helpers/fixtures';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';

const SETUP_KEY = 'sidetrack:setupCompleted';
const THREADS_KEY = 'sidetrack.threads';
const QUEUE_ITEMS_KEY = 'sidetrack.queueItems';
const WORKSTREAMS_KEY = 'sidetrack.workstreams';

const assertOk = (response: unknown): void => {
  if (!isRuntimeResponse(response)) {
    throw new Error('Background returned a non-Sidetrack response.');
  }
  if (!response.ok) {
    throw new Error(response.error);
  }
};

test('queue auto-detect: a queued follow-up flips to done after the user types it into the chat', async () => {
  let fixtureServer: FixtureServer | undefined;
  let runtime: ExtensionRuntime | undefined;

  try {
    fixtureServer = await startProviderFixtureServer();
    runtime = await launchExtensionRuntime();

    // The side-panel preview page is a real extension page; loading it
    // gives us a chrome.* context we can use to seed storage before the
    // workboard mounts.
    const seederPage = await runtime.context.newPage();
    await seederPage.goto(`chrome-extension://${runtime.extensionId}/sidepanel.html`, {
      waitUntil: 'domcontentloaded',
    });

    const threadUrl = `${fixtureServer.origin}/chatgpt-queue-lifecycle.html`;
    const now = new Date().toISOString();
    await runtime.seedStorage(seederPage, {
      [SETUP_KEY]: true,
      [WORKSTREAMS_KEY]: [
        {
          bac_id: 'bac_ws_nyc',
          revision: 'rev_local_seed',
          title: 'NYC Day Plan',
          children: [],
          tags: [],
          checklist: [],
          privacy: 'private',
          updatedAt: now,
        },
      ],
      [THREADS_KEY]: [
        {
          bac_id: 'bac_thread_nyc',
          provider: 'chatgpt',
          threadUrl,
          title: 'NYC Day Plan',
          lastSeenAt: now,
          status: 'active',
          trackingMode: 'manual',
          primaryWorkstreamId: 'bac_ws_nyc',
          tags: [],
        },
      ],
      [QUEUE_ITEMS_KEY]: [
        {
          bac_id: 'bac_queue_pending',
          text: 'or ny iconic',
          scope: 'thread',
          targetId: 'bac_thread_nyc',
          status: 'pending',
          createdAt: now,
          updatedAt: now,
        },
        {
          bac_id: 'bac_queue_other',
          text: 'somewhere completely unrelated',
          scope: 'thread',
          targetId: 'bac_thread_nyc',
          status: 'pending',
          createdAt: now,
          updatedAt: now,
        },
      ],
    });

    // Reload so the side panel boots with the seeded state.
    await seederPage.reload({ waitUntil: 'domcontentloaded' });
    await expect(seederPage.getByRole('main', { name: 'Sidetrack workboard' })).toBeVisible();
    // Default view is the (empty) Inbox; switch to All threads so the
    // seeded thread + queue pill are visible.
    await seederPage.getByRole('tab', { name: 'All threads' }).click();
    await expect(seederPage.getByText('2 queued')).toBeVisible();

    // Inject a synthetic capture event whose user turn matches the queued
    // item text. We go via messageTypes.autoCapture (instead of
    // captureCurrentTab) because the test fixture is served from
    // localhost and the chatgpt content script only matches chatgpt.com.
    const captureResponse = await runtime.sendRuntimeMessage(seederPage, {
      type: messageTypes.autoCapture,
      capture: {
        provider: 'chatgpt',
        threadUrl,
        title: 'NYC Day Plan',
        capturedAt: new Date().toISOString(),
        turns: [
          {
            role: 'user',
            text: 'chinese food yelp options?',
            ordinal: 0,
            capturedAt: new Date().toISOString(),
          },
          {
            role: 'assistant',
            text: "Try Joe's Shanghai or Wu's Wonton King.",
            ordinal: 1,
            capturedAt: new Date().toISOString(),
          },
          {
            role: 'user',
            text: 'or ny iconic',
            ordinal: 2,
            capturedAt: new Date().toISOString(),
          },
          {
            role: 'assistant',
            text: "Katz's Delicatessen, Russ & Daughters, Peter Luger.",
            ordinal: 3,
            capturedAt: new Date().toISOString(),
          },
        ],
      },
    });
    assertOk(captureResponse);

    // Bring the side panel back, refresh state, and assert the matching
    // queue item flipped to done — pill drops from 2 → 1.
    await seederPage.bringToFront();
    const refreshed = await runtime.sendRuntimeMessage(seederPage, {
      type: messageTypes.getWorkboardState,
    });
    assertOk(refreshed);
    await expect(seederPage.getByText('1 queued')).toBeVisible({ timeout: 10_000 });
  } finally {
    await runtime?.close();
    await fixtureServer?.close();
  }
});
