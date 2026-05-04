import { expect, test, type Page } from '@playwright/test';

import { isRuntimeResponse, messageTypes } from '../../src/messages';
import {
  createMockVaultCompanion,
  type MockVaultCompanion,
} from './helpers/mockVaultCompanion';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import { SETTINGS_KEY, SETUP_KEY } from './helpers/sidepanel';
import { startInProcessMcp, type InProcessMcp } from './helpers/inProcessMcp';

const snapshotSidetrackStorage = async (page: Page): Promise<Record<string, unknown>> => {
  return await page.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return Object.fromEntries(
      Object.entries(all).filter(([key]) => key.startsWith('sidetrack')),
    );
  });
};

const restoreSidetrackStorage = async (
  page: Page,
  snapshot: Record<string, unknown>,
): Promise<void> => {
  await page.evaluate(async (values) => {
    const current = await chrome.storage.local.get(null);
    const toRemove = Object.keys(current).filter((key) => key.startsWith('sidetrack'));
    if (toRemove.length > 0) {
      await chrome.storage.local.remove(toRemove);
    }
    await chrome.storage.local.set(values);
  }, snapshot);
};

const assertRuntimeState = (response: unknown) => {
  if (!isRuntimeResponse(response)) {
    throw new Error('Background returned a non-Sidetrack response.');
  }
  if (!response.ok) {
    throw new Error(response.error);
  }
  return response.state;
};

const extractTokenFromPrompt = async (page: Page): Promise<string> => {
  const text = await page.locator('.coding-handoff-meta').textContent();
  const match = /Token:\s+([A-Za-z0-9_-]+)/u.exec(text ?? '');
  if (match === null) {
    throw new Error('Could not extract attach token from the CodingAttach modal.');
  }
  return match[1];
};

test.describe('live coding attach (logged-in profile)', () => {
  test.skip(
    () =>
      process.env.SIDETRACK_E2E_LIVE_CODING_ATTACH === undefined ||
      process.env.SIDETRACK_E2E_LIVE_CODING_ATTACH.length === 0,
    'opt-in: requires SIDETRACK_E2E_LIVE_CODING_ATTACH=1',
  );
  test.skip(
    () =>
      (process.env.SIDETRACK_USER_DATA_DIR === undefined ||
        process.env.SIDETRACK_USER_DATA_DIR.length === 0) &&
      (process.env.SIDETRACK_E2E_CDP_URL === undefined ||
        process.env.SIDETRACK_E2E_CDP_URL.length === 0),
    'requires SIDETRACK_USER_DATA_DIR or SIDETRACK_E2E_CDP_URL',
  );

  test('mints in the side panel, registers through MCP, and reads back the scoped workstream', async () => {
    test.setTimeout(120_000);

    let companion: MockVaultCompanion | undefined;
    let runtime: ExtensionRuntime | undefined;
    let sidepanel: Page | undefined;
    let originalStorage: Record<string, unknown> | undefined;
    let mcp: InProcessMcp | undefined;

    try {
      companion = await createMockVaultCompanion();
      runtime = await launchExtensionRuntime();
      await companion.attach(runtime.context);

      sidepanel = await runtime.context.newPage();
      await sidepanel.goto(`chrome-extension://${runtime.extensionId}/sidepanel.html`, {
        waitUntil: 'domcontentloaded',
      });
      originalStorage = await snapshotSidetrackStorage(sidepanel);
      await restoreSidetrackStorage(sidepanel, {
        [SETUP_KEY]: true,
        [SETTINGS_KEY]: {
          companion: { port: companion.port, bridgeKey: companion.bridgeKey },
          autoTrack: false,
          siteToggles: { chatgpt: true, claude: true, gemini: true },
        },
      });
      await sidepanel.reload({ waitUntil: 'domcontentloaded' });
      await expect(sidepanel.getByRole('main', { name: 'Sidetrack workboard' })).toBeVisible();

      const title = `Live coding attach ${String(Date.now())}`;
      const createWorkstreamResponse = await runtime.sendRuntimeMessage(sidepanel, {
        type: messageTypes.createWorkstream,
        workstream: {
          title,
          privacy: 'shared',
        },
      });
      const state = assertRuntimeState(createWorkstreamResponse);
      const workstream = state.workstreams.find((candidate) => candidate.title === title);
      expect(workstream).toBeDefined();

      await sidepanel.getByRole('tab', { name: 'All threads' }).click();
      await sidepanel.getByRole('button', { name: 'Attach coding session' }).click();
      await expect(sidepanel.getByRole('heading', { name: 'Attach coding session' })).toBeVisible();
      await sidepanel.locator('select').selectOption(workstream?.bac_id ?? '');
      await sidepanel.getByRole('button', { name: 'Generate prompt' }).click();
      await expect(sidepanel.locator('.coding-handoff')).toBeVisible();
      const token = await extractTokenFromPrompt(sidepanel);

      const activeCompanion = companion;
      mcp = await startInProcessMcp({
        vaultPath: activeCompanion.vaultPath,
        companionClient: {
          async registerCodingSession(input) {
            const result = await activeCompanion.writer.registerCodingSession(
              input,
              'live-mcp-register',
            );
            return { bac_id: result.bac_id };
          },
        },
      });

      const registerResult = (await mcp.callTool('bac.coding_session_register', {
        token,
        tool: 'codex',
        cwd: '/Users/yingfei/Documents/playground/browser-ai-companion',
        branch: 'ux/design-tokens-and-extended-live-tests',
        sessionId: 'live-coding-attach',
        name: 'codex · live',
        resumeCommand: 'codex resume live-coding-attach',
      })) as {
        readonly isError?: boolean;
        readonly structuredContent?: { readonly bac_id?: string };
      };
      expect(registerResult.isError).not.toBe(true);
      expect(registerResult.structuredContent?.bac_id).toBeTruthy();

      // Force a workboard refresh so the side panel's cached
      // codingSessions includes the freshly-registered MCP session.
      // (Side panel doesn't poll for MCP-side session registrations
      // today — separate product gap; tracked as future work.)
      await runtime.sendRuntimeMessage(sidepanel, {
        type: messageTypes.getWorkboardState,
      });

      await expect(
        sidepanel.locator('.coding-session-row .name', { hasText: 'codex · live' }),
      ).toBeVisible({ timeout: 10_000 });

      const workstreamResult = (await mcp.callTool('bac.workstream', {
        id: workstream?.bac_id,
      })) as {
        readonly isError?: boolean;
        readonly structuredContent?: {
          readonly workstreams?: readonly { readonly bac_id: string; readonly title?: string }[];
        };
      };
      expect(workstreamResult.isError).not.toBe(true);
      expect(workstreamResult.structuredContent?.workstreams?.[0]?.bac_id).toBe(workstream?.bac_id);
      expect(workstreamResult.structuredContent?.workstreams?.[0]?.title).toBe(title);
    } finally {
      if (sidepanel !== undefined && originalStorage !== undefined) {
        await restoreSidetrackStorage(sidepanel, originalStorage);
      }
      await sidepanel?.close().catch(() => undefined);
      await mcp?.close();
      await runtime?.close();
      await companion?.close();
    }
  });
});
