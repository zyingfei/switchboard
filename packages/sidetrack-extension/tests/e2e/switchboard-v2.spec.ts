import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';

import { messageTypes } from '../../src/messages';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import {
  SETTINGS_KEY,
  THREADS_KEY,
  WORKSTREAMS_KEY,
  seedAndOpenSidepanel,
} from './helpers/sidepanel';

const now = '2026-05-04T12:00:00.000Z';
const companionPort = 17_373;
const bridgeKey = 'switchboard_v2_bridge_key_012345678901234567890123';

const connectedSettings = {
  companion: { port: companionPort, bridgeKey },
  autoTrack: false,
  siteToggles: { chatgpt: true, claude: true, gemini: true },
};

const workstream = (
  bac_id: string,
  title: string,
  options: { readonly parentId?: string } = {},
) => ({
  bac_id,
  revision: `rev_${bac_id}`,
  title,
  ...(options.parentId === undefined ? {} : { parentId: options.parentId }),
  children: [] as string[],
  tags: [] as string[],
  checklist: [] as unknown[],
  privacy: 'shared' as const,
  updatedAt: now,
});

const thread = (
  bac_id: string,
  title: string,
  workstreamId: string,
  overrides: Record<string, unknown> = {},
) => ({
  bac_id,
  provider: 'claude' as const,
  threadUrl: `https://claude.ai/chat/${bac_id}`,
  title,
  lastSeenAt: now,
  status: 'active' as const,
  trackingMode: 'manual' as const,
  primaryWorkstreamId: workstreamId,
  tags: [] as string[],
  lastTurnRole: 'assistant' as const,
  ...overrides,
});

const findThreadRow = (page: Page, title: string) =>
  page.locator('.thread').filter({ has: page.locator('.name', { hasText: title }) });

const fulfillJson = async (route: Route, status: number, body: unknown): Promise<void> => {
  await route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: `${JSON.stringify(body)}\n`,
  });
};

const attachCompanionMocks = async (
  context: BrowserContext,
  handlers: {
    readonly onImportPost?: (url: URL, body: string | null) => void;
  } = {},
): Promise<void> => {
  await context.route(`http://127.0.0.1:${String(companionPort)}/v1/**`, async (route) => {
    const url = new URL(route.request().url());
    const auth = await route.request().headerValue('x-bac-bridge-key');
    if (auth !== bridgeKey) {
      await fulfillJson(route, 401, { detail: 'Bridge key missing or invalid.' });
      return;
    }

    if (route.request().method() === 'GET' && url.pathname === '/v1/status') {
      await fulfillJson(route, 200, {
        data: { companion: 'running', vault: 'connected', requestId: 'switchboard-v2-status' },
      });
      return;
    }
    if (route.request().method() === 'GET' && url.pathname === '/v1/settings') {
      await fulfillJson(route, 200, {
        data: {
          revision: 'rev_switchboard_v2_settings',
          autoSendOptIn: { chatgpt: false, claude: false, gemini: false },
          defaultPacketKind: 'research',
          defaultDispatchTarget: 'claude',
          screenShareSafeMode: false,
        },
      });
      return;
    }
    if (route.request().method() === 'GET' && url.pathname === '/v1/turns') {
      await fulfillJson(route, 200, {
        data: [
          {
            role: 'user',
            text: 'Scope the SwitchBoard v2 handoff.',
            ordinal: 0,
            capturedAt: now,
          },
          {
            role: 'assistant',
            text: 'The composer should suggest the right workstream.',
            ordinal: 1,
            capturedAt: now,
          },
        ],
      });
      return;
    }
    if (route.request().method() === 'GET' && url.pathname === '/v1/dispatch-events') {
      await fulfillJson(route, 200, { data: [] });
      return;
    }
    if (route.request().method() === 'GET' && url.pathname === '/v1/system/service-status') {
      await fulfillJson(route, 200, { data: { installed: true, running: true } });
      return;
    }
    if (route.request().method() === 'GET' && url.pathname === '/v1/buckets') {
      await fulfillJson(route, 200, { data: { items: [] } });
      return;
    }
    if (route.request().method() === 'POST' && url.pathname === '/v1/settings/import') {
      handlers.onImportPost?.(url, route.request().postData());
      if (url.searchParams.get('dryRun') === 'true') {
        await fulfillJson(route, 200, {
          data: {
            added: ['workstream defaults'],
            removed: ['legacy provider toggle'],
            changed: ['screen-share-safe mode'],
            conflicts: 0,
          },
        });
        return;
      }
      await fulfillJson(route, 200, { data: { applied: 3, skipped: 0 } });
      return;
    }

    await fulfillJson(route, 404, {
      detail: `Unhandled mock route: ${route.request().method()} ${url.pathname}`,
    });
  });
};

const openComposerForThread = async (page: Page, title: string): Promise<Page> => {
  await page.getByRole('tab', { name: 'All threads' }).click();
  const row = findThreadRow(page, title);
  await row.hover();
  await row.getByRole('button', { name: /Send to/u }).click();
  await page.getByRole('button', { name: /Customize first/u }).click();
  const modal = page
    .locator('.modal')
    .filter({ has: page.getByRole('heading', { name: 'New packet' }) });
  await expect(modal).toBeVisible();
  return page;
};

test.describe('SwitchBoard v2 e2e gap coverage', () => {
  test('SwitchBoard v2 composer suggestions update the packet scope', async () => {
    let runtime: ExtensionRuntime | undefined;
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      await attachCompanionMocks(runtime.context);

      const root = workstream('bac_ws_v2_root', 'Sidetrack');
      const mvp = workstream('bac_ws_v2_mvp', 'MVP PRD', { parentId: root.bac_id });
      const dispatch = workstream('bac_ws_v2_dispatch', 'Dispatch', { parentId: root.bac_id });
      const sourceThread = thread('bac_thread_v2_suggestions', 'Composer suggestions thread', mvp.bac_id);
      const page = await seedAndOpenSidepanel(runtime, {
        [SETTINGS_KEY]: connectedSettings,
        [WORKSTREAMS_KEY]: [root, mvp, dispatch],
        [THREADS_KEY]: [sourceThread],
      });

      await page.route(`http://127.0.0.1:${String(companionPort)}/v1/suggestions/thread/**`, async (route) => {
        await fulfillJson(route, 200, {
          data: [
            { workstreamId: mvp.bac_id, score: 0.92, breakdown: { lexical: 0.55, vector: 0.22 } },
            {
              workstreamId: dispatch.bac_id,
              score: 0.77,
              breakdown: { lexical: 0.31, vector: 0.38 },
            },
            { workstreamId: root.bac_id, score: 0.61, breakdown: { lexical: 0.21, vector: 0.19 } },
          ],
        });
      });

      await test.step('When the composer opens, it renders all companion suggestions', async () => {
        await openComposerForThread(page, sourceThread.title);
        const modal = page
          .locator('.modal')
          .filter({ has: page.getByRole('heading', { name: 'New packet' }) });
        await expect(modal.getByText('Suggested scope')).toBeVisible();
        await expect(modal.locator('.scope-sug')).toHaveCount(3);
      });

      await test.step('Then picking the middle suggestion updates the dispatch scope', async () => {
        const modal = page
          .locator('.modal')
          .filter({ has: page.getByRole('heading', { name: 'New packet' }) });
        await modal.getByRole('button', { name: /Sidetrack \/ Dispatch/u }).click();
        await expect(modal.locator('.scope-sug.on')).toContainText('Sidetrack / Dispatch');
        await modal.getByRole('button', { name: /^Claude$/u }).click();
        await modal.getByRole('button', { name: 'Dispatch', exact: true }).click();
        const confirm = page
          .locator('.modal')
          .filter({ has: page.getByRole('heading', { name: 'Confirm dispatch' }) });
        await expect(confirm).toBeVisible();
        await confirm.getByRole('button', { name: 'Cancel' }).click();
      });
    } finally {
      await runtime?.close();
    }
  });

  test('SwitchBoard v2 design-preview gating hides production preview unless query-enabled', async () => {
    let runtime: ExtensionRuntime | undefined;
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const page = await seedAndOpenSidepanel(runtime, {
        [WORKSTREAMS_KEY]: [workstream('bac_ws_v2_preview', 'Preview suite')],
        [THREADS_KEY]: [],
      });

      await expect(page.getByLabel('Open design preview')).toHaveCount(0);
      await page.goto(`chrome-extension://${runtime.extensionId}/sidepanel.html?design-preview=1`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.getByRole('main', { name: 'Sidetrack workboard' })).toBeVisible();
      await expect(page.getByLabel('Open design preview')).toBeVisible();
    } finally {
      await runtime?.close();
    }
  });

  test('SwitchBoard v2 settings import preview applies with a second persisted POST', async () => {
    let runtime: ExtensionRuntime | undefined;
    const importPosts: { readonly href: string; readonly body: string | null }[] = [];
    const importPayload = JSON.stringify({ version: 1, settings: { screenShareSafeMode: true } });
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      await attachCompanionMocks(runtime.context, {
        onImportPost: (url, body) => {
          importPosts.push({ href: url.href, body });
        },
      });
      const page = await seedAndOpenSidepanel(runtime, {
        [SETTINGS_KEY]: connectedSettings,
        [WORKSTREAMS_KEY]: [workstream('bac_ws_v2_import', 'Import suite')],
        [THREADS_KEY]: [],
      });

      await test.step('When a JSON settings bundle is chosen, a diff preview renders', async () => {
        await page.getByRole('button', { name: 'Settings' }).click();
        const chooserPromise = page.waitForEvent('filechooser');
        await page.getByRole('button', { name: /Choose file/u }).click();
        const chooser = await chooserPromise;
        await chooser.setFiles({
          name: 'sidetrack-config.json',
          mimeType: 'application/json',
          buffer: Buffer.from(importPayload),
        });
        await expect(page.getByText('Import diff preview')).toBeVisible();
        await expect(page.locator('.diff')).toContainText('+ workstream defaults');
        await expect(page.locator('.diff')).toContainText('- legacy provider toggle');
      });

      await test.step('Then Apply posts the same payload without dryRun and clears the diff', async () => {
        await page.getByRole('button', { name: 'Apply' }).click();
        await expect(page.getByText('Import diff preview')).toHaveCount(0);
        expect(importPosts).toHaveLength(2);
        expect(new URL(importPosts[0].href).searchParams.get('dryRun')).toBe('true');
        expect(new URL(importPosts[1].href).searchParams.has('dryRun')).toBe(false);
        expect(importPosts[0].body).toBe(importPayload);
        expect(importPosts[1].body).toBe(importPayload);
      });
    } finally {
      await runtime?.close();
    }
  });

  test('SwitchBoard v2 MCP host probe marks reachable hosts online and leaves failures offline', async () => {
    let runtime: ExtensionRuntime | undefined;
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      await attachCompanionMocks(runtime.context);
      await runtime.context.route('http://127.0.0.1:18888/**', async (route) => {
        await route.fulfill({ status: 204 });
      });
      const page = await seedAndOpenSidepanel(runtime, {
        [SETTINGS_KEY]: connectedSettings,
        [WORKSTREAMS_KEY]: [workstream('bac_ws_v2_mcp', 'MCP suite')],
        [THREADS_KEY]: [],
      });

      await page.getByRole('button', { name: 'Settings' }).click();
      const onlineUrl = 'http://127.0.0.1:18888/online';
      const offlineUrl = 'http://127.0.0.1:18889/offline';
      const addForm = page.locator('#sec-mcp .mcp-add');

      await addForm.locator('input[placeholder="http://localhost:port"]').fill(onlineUrl);
      await addForm.locator('input[placeholder="bearer token"]').fill('online-token');
      await addForm.getByRole('button', { name: 'Add' }).click();
      await addForm.locator('input[placeholder="http://localhost:port"]').fill(offlineUrl);
      await addForm.locator('input[placeholder="bearer token"]').fill('offline-token');
      await addForm.getByRole('button', { name: 'Add' }).click();

      const onlineRow = page.locator('.mcp-row').filter({ hasText: onlineUrl });
      const offlineRow = page.locator('.mcp-row').filter({ hasText: offlineUrl });
      await expect(onlineRow.locator('.hp-dot.green')).toBeVisible({ timeout: 3_000 });
      await page.waitForTimeout(3_000);
      await expect(offlineRow).toHaveClass(/off/u);
      await expect(offlineRow.locator('.hp-dot.green')).toHaveCount(0);
    } finally {
      await runtime?.close();
    }
  });

  test('SwitchBoard v2 déjà-vu jump message focuses the matching side-panel row', async () => {
    let runtime: ExtensionRuntime | undefined;
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const seeded = thread('bac_thread_v2_dejavu', 'Déjà-vu recalled thread', 'bac_ws_v2_dejavu');
      const page = await seedAndOpenSidepanel(runtime, {
        [WORKSTREAMS_KEY]: [workstream('bac_ws_v2_dejavu', 'Déjà-vu suite')],
        [THREADS_KEY]: [seeded],
      });

      await page.getByRole('tab', { name: 'All threads' }).click();
      const row = findThreadRow(page, seeded.title);
      await row.evaluate((element) => {
        element.scrollIntoView = () => undefined;
      });
      await page.evaluate(async ({ threadUrl, type }) => {
        await chrome.runtime.sendMessage({
          type,
          threadUrl,
        });
      }, {
        threadUrl: seeded.threadUrl,
        type: messageTypes.focusThreadInSidePanel,
      });
      await expect(row).toHaveClass(/focusing/u);
    } finally {
      await runtime?.close();
    }
  });
});
