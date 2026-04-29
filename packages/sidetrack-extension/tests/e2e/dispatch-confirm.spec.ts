// Synthetic e2e for the §24.10 dispatch-confirmation modal — exercises
// the composer-to-confirm transition + the four safety-chain rows + the
// cancel/edit/confirm exits. Companion HTTP is mocked via Playwright
// route.fulfill so no localhost binding is needed.
//
// Complements components.test.tsx unit coverage of DispatchConfirm by
// asserting the full App-level wire-up (PacketComposer → setPendingDispatch
// → DispatchConfirm modal mount).
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
const bridgeKey = 'dispatch_confirm_bridge_key_012345678901234567890123';
const threadUrl = 'https://claude.ai/chat/dispatch-confirm-synthetic';

const turns = [
  { role: 'user' as const, text: 'Plan the experiment.', ordinal: 0, capturedAt: now },
  { role: 'assistant' as const, text: 'Steps: outline, draft, review.', ordinal: 1, capturedAt: now },
  { role: 'user' as const, text: 'Add a control arm.', ordinal: 2, capturedAt: now },
  { role: 'assistant' as const, text: 'Adding control: same prompt without context.', ordinal: 3, capturedAt: now },
] as const;

const workstream = {
  bac_id: 'bac_ws_dispatch_confirm',
  revision: 'rev_dispatch_confirm',
  title: 'Dispatch confirm synthetic',
  children: [] as string[],
  tags: [] as string[],
  checklist: [] as unknown[],
  privacy: 'shared' as const,
  updatedAt: now,
};

const thread = {
  bac_id: 'bac_thread_dispatch_confirm',
  provider: 'claude' as const,
  threadUrl,
  title: 'Dispatch confirm host thread',
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
        data: { companion: 'running', vault: 'connected', requestId: 'dc-status' },
      });
      return;
    }
    if (route.request().method() === 'GET' && url.pathname === '/v1/settings') {
      await fulfillJson(route, 200, {
        data: {
          revision: 'rev_dc_settings',
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
    if (route.request().method() === 'GET' && url.pathname === '/v1/dispatch-events') {
      await fulfillJson(route, 200, { data: [] });
      return;
    }
    await fulfillJson(route, 404, {
      detail: `Unhandled mock route: ${route.request().method()} ${url.pathname}`,
    });
  });
};

test.describe('dispatch confirm (synthetic)', () => {
  test('dispatching from PacketComposer mounts DispatchConfirm with the §24.10 safety chain', async () => {
    let runtime: ExtensionRuntime | undefined;
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      await attachCompanionMocks(runtime.context);

      const page = await seedAndOpenSidepanel(runtime, {
        [SETTINGS_KEY]: connectedSettings,
        [WORKSTREAMS_KEY]: [workstream],
        [THREADS_KEY]: [thread],
      });

      await page.getByRole('tab', { name: 'All threads' }).click();
      await expect(page.locator('.ws-status')).toHaveText('vault: synced');

      // Seed a fresh capture so the composer has turn data.
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
      await threadRow.getByRole('button', { name: 'Send' }).click();

      const composer = page
        .locator('.modal')
        .filter({ has: page.getByRole('heading', { name: 'New packet' }) });
      await expect(composer).toBeVisible();

      // Pick a target — Dispatch button is disabled until target is set.
      await composer.getByRole('button', { name: /^Claude$/u }).click();
      // Click Dispatch — opens DispatchConfirm and dismisses PacketComposer.
      await composer.getByRole('button', { name: /Dispatch/u }).click();

      const confirm = page
        .locator('.modal')
        .filter({ has: page.getByRole('heading', { name: 'Confirm dispatch' }) });
      await expect(confirm).toBeVisible();
      // Subtitle shows target + paste mode.
      await expect(confirm).toContainText('paste mode');

      // Four safety rows are present.
      const rows = confirm.locator('.safety-row');
      await expect(rows).toHaveCount(4);

      // Token-budget bar is attached even at 0% (width:0 makes it
      // invisible per Playwright's heuristic, but the element is in the
      // DOM with the right level class).
      const tokenBar = confirm.locator('.token-bar-fill');
      await expect(tokenBar).toBeAttached();
      await expect(tokenBar).toHaveClass(/\b(green|amber|over)\b/u);
      // Default redacted-count copy.
      await expect(confirm.locator('.safety-row.signal').first()).toContainText('Redaction fired');
      // No screen share + no injection by default → both green rows.
      await expect(confirm.locator('.safety-row.green')).toHaveCount(2);

      // Send-mode pills: Paste is the default; Auto-send is disabled
      // because autoSendOptIn.claude=false in the mocked settings.
      const pasteBtn = confirm.getByRole('button', { name: /Paste mode/u });
      await expect(pasteBtn).toHaveClass(/\bon\b/u);
      const autoSendBtn = confirm.getByRole('button', { name: /Auto-send/u });
      await expect(autoSendBtn).toBeDisabled();

      // Cancel closes the modal cleanly without dispatching.
      await confirm.getByRole('button', { name: 'Cancel' }).click();
      await expect(page.locator('.modal')).toHaveCount(0);
    } finally {
      await runtime?.close();
    }
  });

  test('Edit packet returns from DispatchConfirm to the PacketComposer', async () => {
    let runtime: ExtensionRuntime | undefined;
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      await attachCompanionMocks(runtime.context);

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
      await threadRow.getByRole('button', { name: 'Send' }).click();

      const composer = page
        .locator('.modal')
        .filter({ has: page.getByRole('heading', { name: 'New packet' }) });
      await expect(composer).toBeVisible();
      // Pick a target — Dispatch is disabled until target is set.
      await composer.getByRole('button', { name: /^Claude$/u }).click();
      await composer.getByRole('button', { name: /Dispatch/u }).click();

      const confirm = page
        .locator('.modal')
        .filter({ has: page.getByRole('heading', { name: 'Confirm dispatch' }) });
      await expect(confirm).toBeVisible();

      // Edit packet → confirm closes, composer reappears.
      await confirm.getByRole('button', { name: 'Edit packet' }).click();
      await expect(confirm).toHaveCount(0);
      await expect(composer).toBeVisible();
    } finally {
      await runtime?.close();
    }
  });
});
