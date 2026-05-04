import { expect, test, type BrowserContext, type Route } from '@playwright/test';

import { messageTypes } from '../../src/messages';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import {
  SETTINGS_KEY,
  THREADS_KEY,
  WORKSTREAMS_KEY,
  assertOk,
  seedAndOpenSidepanel,
} from './helpers/sidepanel';

const now = '2026-04-29T12:00:00.000Z';
const companionPort = 17_373;
const bridgeKey = 'review_composer_bridge_key_012345678901234567890123';
const threadUrl = 'https://claude.ai/chat/review-composer-synthetic';

const turns = [
  {
    role: 'user' as const,
    text: 'Please review the migration notes before we ship.',
    ordinal: 0,
    capturedAt: '2026-04-29T11:50:00.000Z',
  },
  {
    role: 'assistant' as const,
    text: 'The migration is safe because all persisted ids remain stable across renames.',
    ordinal: 1,
    capturedAt: '2026-04-29T11:51:00.000Z',
  },
  {
    role: 'assistant' as const,
    text: 'We should still call out the rollback caveat in the release notes.',
    ordinal: 2,
    capturedAt: '2026-04-29T11:52:00.000Z',
  },
] as const;

const workstream = {
  bac_id: 'bac_ws_review_composer',
  revision: 'rev_review_composer',
  title: 'Review composer synthetic',
  children: [] as string[],
  tags: [] as string[],
  checklist: [] as unknown[],
  privacy: 'shared' as const,
  updatedAt: now,
};

const thread = {
  bac_id: 'bac_thread_review_composer',
  provider: 'claude' as const,
  threadUrl,
  title: 'Review composer host thread',
  lastSeenAt: now,
  status: 'active' as const,
  trackingMode: 'manual' as const,
  primaryWorkstreamId: workstream.bac_id,
  tags: [] as string[],
  lastTurnRole: 'assistant' as const,
};

const connectedSettings = {
  companion: { port: companionPort, bridgeKey },
  autoTrack: false,
  siteToggles: { chatgpt: true, claude: true, gemini: true },
};

const fulfillJson = async (route: Route, status: number, body: unknown): Promise<void> => {
  await route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: `${JSON.stringify(body)}\n`,
  });
};

const attachCompanionMocks = async (
  context: BrowserContext,
  onReviewSubmit?: (payload: unknown) => void,
): Promise<void> => {
  await context.route(`http://127.0.0.1:${String(companionPort)}/v1/**`, async (route) => {
    const url = new URL(route.request().url());
    if ((await route.request().headerValue('x-bac-bridge-key')) !== bridgeKey) {
      await fulfillJson(route, 401, {
        title: 'Bridge key missing or invalid.',
        detail: 'Bridge key missing or invalid.',
      });
      return;
    }

    if (route.request().method() === 'GET' && url.pathname === '/v1/status') {
      await fulfillJson(route, 200, {
        data: { companion: 'running', vault: 'connected', requestId: 'review-status' },
      });
      return;
    }

    if (route.request().method() === 'GET' && url.pathname === '/v1/settings') {
      await fulfillJson(route, 200, {
        data: {
          revision: 'rev_review_settings',
          autoSendOptIn: { chatgpt: false, claude: false, gemini: false },
          defaultPacketKind: 'research',
          defaultDispatchTarget: 'claude',
          screenShareSafeMode: false,
        },
      });
      return;
    }

    if (route.request().method() === 'GET' && url.pathname === '/v1/turns') {
      if (url.searchParams.get('threadUrl') !== threadUrl) {
        await fulfillJson(route, 404, { detail: 'Unknown threadUrl.' });
        return;
      }
      await fulfillJson(route, 200, { data: turns });
      return;
    }

    if (route.request().method() === 'POST' && url.pathname === '/v1/reviews') {
      const payloadText = route.request().postData();
      onReviewSubmit?.(payloadText === null ? null : (JSON.parse(payloadText) as unknown));
      await fulfillJson(route, 200, {
        data: {
          bac_id: 'bac_review_event_1',
          status: 'recorded',
        },
      });
      return;
    }

    await fulfillJson(route, 404, {
      detail: `Unhandled mock route: ${route.request().method()} ${url.pathname}`,
    });
  });
};

test.describe('review composer (synthetic)', () => {
  test('opens from the thread row, renders turns + actions, and can save a review', async () => {
    let runtime: ExtensionRuntime | undefined;
    let submittedReview: unknown;

    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      await attachCompanionMocks(runtime.context, (payload) => {
        submittedReview = payload;
      });

      const page = await seedAndOpenSidepanel(runtime, {
        [SETTINGS_KEY]: connectedSettings,
        [WORKSTREAMS_KEY]: [workstream],
        [THREADS_KEY]: [thread],
      });

      await page.getByRole('tab', { name: 'All threads' }).click();
      await expect(page.locator('.ws-status')).toHaveText('vault: synced');

      const captureResponse = await runtime.sendRuntimeMessage(page, {
        type: messageTypes.autoCapture,
        capture: {
          provider: 'claude',
          threadUrl,
          title: thread.title,
          capturedAt: now,
          turns,
        },
      });
      assertOk(captureResponse);

      const threadRow = page
        .locator('.thread')
        .filter({ has: page.locator('.name', { hasText: thread.title }) });
      // v2 design pass: Review now lives behind the ⋯ overflow menu.
      await threadRow.getByRole('button', { name: 'More actions', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Review captured turns', exact: true }).click();

      const modal = page
        .locator('.review-composer')
        .filter({ has: page.getByRole('heading', { name: 'Review' }) });
      await expect(modal).toBeVisible();

      await expect(modal.locator('.review-span-card')).toHaveCount(3);
      await expect(modal).toContainText(turns[0].text);
      await expect(modal).toContainText(turns[1].text);
      await expect(modal).toContainText(turns[2].text);

      await modal.getByRole('button', { name: '+ add verdict (optional)' }).click();
      // Use exact match for these verdict names — they're prefix-y
      // (e.g. "Agree" partially matches "Disagree").
      for (const verdict of ['Agree', 'Disagree', 'Partial', 'Needs source', 'Open']) {
        await expect(modal.getByRole('button', { name: verdict, exact: true })).toBeVisible();
      }
      await expect(modal.getByRole('button', { name: 'Save only' })).toBeVisible();
      await expect(modal.getByRole('button', { name: 'Send back to Claude' })).toBeVisible();
      await expect(modal.getByRole('button', { name: 'Dispatch to other AI…' })).toBeVisible();

      await modal.getByRole('button', { name: 'Close' }).click();
      await expect(page.locator('.review-composer')).toHaveCount(0);

      // v2 design pass: Review now lives behind the ⋯ overflow menu.
      await threadRow.getByRole('button', { name: 'More actions', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Review captured turns', exact: true }).click();
      await expect(modal).toBeVisible();

      await modal
        .locator('.review-comment-card')
        .nth(1)
        .locator('textarea')
        .fill('This needs a source.');
      await modal
        .locator('.review-overall textarea')
        .fill('Capture the caveat before we ship this.');
      await modal.getByRole('button', { name: '+ add verdict (optional)' }).click();
      await modal.getByRole('button', { name: 'Needs source' }).click();
      await modal.getByRole('button', { name: 'Save only' }).click();

      await expect(page.locator('.review-composer')).toHaveCount(0);
      expect(submittedReview).toEqual({
        sourceThreadId: thread.bac_id,
        sourceTurnOrdinal: 1,
        provider: 'claude',
        verdict: 'needs_source',
        reviewerNote: 'Capture the caveat before we ship this.',
        spans: [
          {
            id: 'turn_1',
            text: turns[1].text,
            comment: 'This needs a source.',
            capturedAt: turns[1].capturedAt,
          },
        ],
        outcome: 'save',
      });
    } finally {
      await runtime?.close();
    }
  });
});
