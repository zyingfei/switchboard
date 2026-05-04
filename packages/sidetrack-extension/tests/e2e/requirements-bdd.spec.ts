import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';

import { messageTypes } from '../../src/messages';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import {
  SETTINGS_KEY,
  THREADS_KEY,
  WORKSTREAMS_KEY,
  assertOk,
  seedAndOpenSidepanel,
} from './helpers/sidepanel';

const now = '2026-05-04T12:00:00.000Z';
const companionPort = 17_373;
const bridgeKey = 'requirements_bdd_bridge_key_012345678901234567890123';
const dispatchThreadUrl = 'https://claude.ai/chat/requirements-bdd-dispatch';

const workstream = (
  bac_id: string,
  title: string,
  options: {
    readonly parentId?: string;
    readonly privacy?: 'private' | 'shared';
    readonly screenShareSensitive?: boolean;
  } = {},
) => ({
  bac_id,
  revision: `rev_${bac_id}`,
  title,
  ...(options.parentId === undefined ? {} : { parentId: options.parentId }),
  children: [] as string[],
  tags: [] as string[],
  checklist: [] as unknown[],
  privacy: options.privacy ?? ('shared' as const),
  ...(options.screenShareSensitive === undefined
    ? {}
    : { screenShareSensitive: options.screenShareSensitive }),
  updatedAt: now,
});

const thread = (
  bac_id: string,
  provider: 'chatgpt' | 'claude' | 'gemini',
  title: string,
  workstreamId: string,
  overrides: Record<string, unknown> = {},
) => ({
  bac_id,
  provider,
  threadUrl:
    provider === 'chatgpt'
      ? `https://chatgpt.com/c/${bac_id}`
      : provider === 'gemini'
        ? `https://gemini.google.com/app/${bac_id}`
        : `https://claude.ai/chat/${bac_id}`,
  title,
  lastSeenAt: now,
  status: 'active',
  trackingMode: 'manual',
  primaryWorkstreamId: workstreamId,
  tags: [] as string[],
  lastTurnRole: 'assistant',
  ...overrides,
});

const findThreadRow = (page: Page, title: string) =>
  page.locator('.thread').filter({ has: page.locator('.name', { hasText: title }) });

const openStaleOrClosedBucket = async (page: Page): Promise<void> => {
  const bucket = page.getByRole('button', { name: /Stale or closed/u });
  if ((await bucket.getAttribute('aria-expanded')) === 'false') {
    await bucket.click();
  }
};

const connectedSettings = {
  companion: { port: companionPort, bridgeKey },
  autoTrack: false,
  siteToggles: { chatgpt: true, claude: true, gemini: true },
};

const dispatchTurns = [
  {
    role: 'user' as const,
    text: 'Summarize the scope and keep the acceptance criteria explicit.',
    ordinal: 0,
    capturedAt: now,
  },
  {
    role: 'assistant' as const,
    text: 'The packet should preserve requirements, scope, risks, and verification notes.',
    ordinal: 1,
    capturedAt: now,
  },
] as const;

const fulfillJson = async (route: Route, status: number, body: unknown): Promise<void> => {
  await route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: `${JSON.stringify(body)}\n`,
  });
};

const attachCompanionMocks = async (context: BrowserContext): Promise<void> => {
  await context.route(`http://127.0.0.1:${String(companionPort)}/v1/**`, async (route) => {
    const url = new URL(route.request().url());
    const auth = await route.request().headerValue('x-bac-bridge-key');
    if (auth !== bridgeKey) {
      await fulfillJson(route, 401, { detail: 'Bridge key missing or invalid.' });
      return;
    }

    if (route.request().method() === 'GET' && url.pathname === '/v1/status') {
      await fulfillJson(route, 200, {
        data: { companion: 'running', vault: 'connected', requestId: 'requirements-bdd-status' },
      });
      return;
    }
    if (route.request().method() === 'GET' && url.pathname === '/v1/settings') {
      await fulfillJson(route, 200, {
        data: {
          revision: 'rev_requirements_bdd_settings',
          autoSendOptIn: { chatgpt: false, claude: false, gemini: false },
          defaultPacketKind: 'research',
          defaultDispatchTarget: 'claude',
          screenShareSafeMode: false,
        },
      });
      return;
    }
    if (route.request().method() === 'GET' && url.pathname === '/v1/turns') {
      await fulfillJson(route, 200, { data: dispatchTurns });
      return;
    }
    if (route.request().method() === 'GET' && url.pathname === '/v1/dispatch-events') {
      await fulfillJson(route, 200, { data: [] });
      return;
    }

    await fulfillJson(route, 404, {
      detail: `Unhandled mock route: ${route.request().method()} ${url.pathname}`,
    });
  });
};

test.describe('M1/M2 requirements BDD (user experience)', () => {
  test('Scenario: active work is visible, reply-aware, and privacy-safe', async () => {
    let runtime: ExtensionRuntime | undefined;
    let page: Page | undefined;
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const activeRuntime = runtime;

      await test.step('Given Sidetrack has shared AI work and a private workstream', async () => {
        page = await seedAndOpenSidepanel(activeRuntime, {
          [WORKSTREAMS_KEY]: [
            workstream('bac_ws_sidetrack', 'Sidetrack'),
            workstream('bac_ws_mvp', 'MVP PRD', { parentId: 'bac_ws_sidetrack' }),
            workstream('bac_ws_active', 'Active Workstreams', { parentId: 'bac_ws_mvp' }),
            workstream('bac_ws_private', 'Sensitive partner review', { privacy: 'private' }),
          ],
          [THREADS_KEY]: [
            thread(
              'bac_thread_chatgpt_reply',
              'chatgpt',
              'switchboard MVP scope',
              'bac_ws_active',
            ),
            thread(
              'bac_thread_claude_waiting',
              'claude',
              'VM live migration comparison',
              'bac_ws_active',
              { lastTurnRole: 'user' },
            ),
            thread(
              'bac_thread_private',
              'gemini',
              'Sensitive partner contract notes',
              'bac_ws_private',
            ),
          ],
          'sidetrack.reminders': [
            {
              bac_id: 'bac_reminder_chatgpt_reply',
              threadId: 'bac_thread_chatgpt_reply',
              provider: 'chatgpt',
              detectedAt: now,
              status: 'new',
            },
          ],
        });
      });

      await test.step('When the user opens All threads', async () => {
        await page?.getByRole('tab', { name: 'All threads' }).click();
      });

      await test.step('Then active work is readable, replies stand out, and private titles stay masked', async () => {
        if (page === undefined) throw new Error('Side panel did not open.');
        await expect(page.getByText('switchboard MVP scope')).toBeVisible();
        await expect(page.getByText('VM live migration comparison')).toBeVisible();
        await expect(
          page.locator('.thread-bucket-unread .thread', { hasText: 'switchboard MVP scope' }),
        ).toBeVisible();

        const privateRow = page.locator('.thread').filter({
          has: page.locator('.provider.gemini'),
        });
        await expect(privateRow.getByText('[private]', { exact: true })).toBeVisible();
        await expect(privateRow.getByText('Sensitive partner contract notes')).toHaveCount(0);
      });
    } finally {
      await page?.close().catch(() => undefined);
      await runtime?.close();
    }
  });

  test('Scenario: user parks a follow-up without leaving the workboard', async () => {
    let runtime: ExtensionRuntime | undefined;
    let page: Page | undefined;
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const activeRuntime = runtime;

      await test.step('Given a tracked Claude thread is on the workboard', async () => {
        page = await seedAndOpenSidepanel(activeRuntime, {
          [WORKSTREAMS_KEY]: [workstream('bac_ws_active', 'Active Workstreams')],
          [THREADS_KEY]: [
            thread(
              'bac_thread_queue_host',
              'claude',
              'MVP architecture thread',
              'bac_ws_active',
            ),
          ],
        });
        await page.getByRole('tab', { name: 'All threads' }).click();
      });

      await test.step('When the user adds a follow-up from that row', async () => {
        if (page === undefined) throw new Error('Side panel did not open.');
        const row = findThreadRow(page, 'MVP architecture thread');
        await row.getByRole('button', { name: 'More actions', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Queue follow-up', exact: true }).click();
        await row
          .getByPlaceholder(/Ask next/i)
          .fill('Ask Claude to compare with VM live migration architecture.');
        await row.getByRole('button', { name: 'Add' }).click();
      });

      await test.step('Then the queued ask is visible and can be dismissed', async () => {
        if (page === undefined) throw new Error('Side panel did not open.');
        const row = findThreadRow(page, 'MVP architecture thread');
        await expect(row.getByText('1 queued')).toBeVisible({ timeout: 5_000 });
        await expect(
          row.getByText('Ask Claude to compare with VM live migration architecture.'),
        ).toBeVisible();
        await row.getByRole('button', { name: 'Dismiss' }).click();
        await expect(row.getByText('1 queued')).toHaveCount(0, { timeout: 5_000 });
      });
    } finally {
      await page?.close().catch(() => undefined);
      await runtime?.close();
    }
  });

  test('Scenario: an accidentally closed tab remains recoverable in context', async () => {
    let runtime: ExtensionRuntime | undefined;
    let page: Page | undefined;
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const activeRuntime = runtime;

      await test.step('Given a tracked Claude tab was closed while the workstream stayed active', async () => {
        page = await seedAndOpenSidepanel(activeRuntime, {
          [WORKSTREAMS_KEY]: [workstream('bac_ws_active', 'Active Workstreams')],
          [THREADS_KEY]: [
            thread(
              'bac_thread_closed_tab',
              'claude',
              'Closed Claude planning thread',
              'bac_ws_active',
              { status: 'restorable' },
            ),
            thread('bac_thread_still_open', 'chatgpt', 'Still-open GPT thread', 'bac_ws_active'),
          ],
        });
      });

      await test.step('When the user checks All threads', async () => {
        if (page === undefined) throw new Error('Side panel did not open.');
        await page.getByRole('tab', { name: 'All threads' }).click();
        await openStaleOrClosedBucket(page);
      });

      await test.step('Then the closed tab is stamped as restorable without hiding other work', async () => {
        if (page === undefined) throw new Error('Side panel did not open.');
        const closedRow = findThreadRow(page, 'Closed Claude planning thread');
        await expect(closedRow).toBeVisible();
        await expect(closedRow.locator('.stamp')).toContainText('Tab closed');
        await expect(closedRow.locator('.dot.gray')).toBeVisible();
        await expect(findThreadRow(page, 'Still-open GPT thread').locator('.dot.green')).toBeVisible();
      });
    } finally {
      await page?.close().catch(() => undefined);
      await runtime?.close();
    }
  });

  test('Scenario: before dispatch, the user sees the safety chain and can cancel', async () => {
    let runtime: ExtensionRuntime | undefined;
    let page: Page | undefined;
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const activeRuntime = runtime;
      await attachCompanionMocks(activeRuntime.context);

      await test.step('Given a connected vault has captured turns for a packet', async () => {
        page = await seedAndOpenSidepanel(activeRuntime, {
          [SETTINGS_KEY]: connectedSettings,
          [WORKSTREAMS_KEY]: [workstream('bac_ws_dispatch', 'Dispatch readiness')],
          [THREADS_KEY]: [
            {
              ...thread(
                'bac_thread_dispatch',
                'claude',
                'Dispatch readiness thread',
                'bac_ws_dispatch',
              ),
              threadUrl: dispatchThreadUrl,
            },
          ],
        });
        const captureResponse = await activeRuntime.sendRuntimeMessage(page, {
          type: messageTypes.autoCapture,
          capture: {
            provider: 'claude',
            threadUrl: dispatchThreadUrl,
            title: 'Dispatch readiness thread',
            capturedAt: now,
            turns: dispatchTurns,
          },
        });
        assertOk(captureResponse);
      });

      await test.step('When the user prepares to dispatch to Claude', async () => {
        if (page === undefined) throw new Error('Side panel did not open.');
        await page.getByRole('tab', { name: 'All threads' }).click();
        const row = findThreadRow(page, 'Dispatch readiness thread');
        // Hover to reveal the action row (otherwise `.thread-actions` is
        // clipped to max-height: 0 and the user can't see Send to ▾).
        await row.hover();
        await row.getByRole('button', { name: /Send to/u }).click();
        // Regression: the Send-to dropdown lives inside `.thread-
        // actions`, which uses overflow: hidden to clip its slide-down
        // animation. Without the `:has()` rule that switches to
        // overflow: visible when a menu is open, the absolute-
        // positioned menu was rendered into the DOM but cropped to a
        // 40px-tall slot — invisible to the user. Assert the menu is
        // actually visible, not just attached.
        const dropdown = page.locator('.send-to-menu');
        await expect(dropdown).toBeVisible();
        await expect(dropdown.getByRole('button', { name: /Customize first/u })).toBeVisible();
        await page.getByRole('button', { name: /Customize first/u }).click();
        const composer = page
          .locator('.modal')
          .filter({ has: page.getByRole('heading', { name: 'New packet' }) });
        await expect(composer).toBeVisible();
        await composer.getByRole('button', { name: /^Claude$/u }).click();
        await composer.getByRole('button', { name: 'Dispatch', exact: true }).click();
      });

      await test.step('Then the confirmation keeps the user in control before anything leaves Sidetrack', async () => {
        if (page === undefined) throw new Error('Side panel did not open.');
        const confirm = page
          .locator('.modal')
          .filter({ has: page.getByRole('heading', { name: 'Confirm dispatch' }) });
        await expect(confirm).toBeVisible();
        await expect(confirm).toContainText('paste mode');
        const chain = confirm.locator('.safety-chain');
        await expect(chain).toBeVisible();
        await expect(chain.locator('.sc-pip')).toHaveCount(4);
        await expect(chain).toContainText('checks ok');
        await confirm.getByRole('button', { name: 'Cancel' }).click();
        await expect(page.locator('.modal')).toHaveCount(0);
      });
    } finally {
      await page?.close().catch(() => undefined);
      await runtime?.close();
    }
  });
});
