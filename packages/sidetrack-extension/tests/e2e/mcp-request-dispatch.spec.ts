import { expect, test, type Page } from '@playwright/test';

import type { DispatchEventRecord } from '../../../sidetrack-companion/src/http/schemas.js';
import { messageTypes } from '../../src/messages';
import { createMockVaultCompanion, type MockVaultCompanion } from './helpers/mockVaultCompanion';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import { SETTINGS_KEY, WORKSTREAMS_KEY, seedAndOpenSidepanel } from './helpers/sidepanel';
import { startInProcessMcp, type InProcessMcp } from './helpers/inProcessMcp';

const workstreamId = 'bac_ws_mcp_request_dispatch';
const dispatchId = 'bac_dispatch_mcp_inbound';

const workstream = {
  bac_id: workstreamId,
  revision: 'rev_mcp_request_dispatch',
  title: 'MCP request dispatch synthetic',
  children: [] as string[],
  tags: [] as string[],
  checklist: [] as unknown[],
  privacy: 'shared' as const,
  updatedAt: '2026-05-05T12:00:00.000Z',
};

const extractPrompt = async (page: Page): Promise<string> =>
  (await page.locator('.coding-handoff-prompt').textContent()) ?? '';

const extractAttachToken = (prompt: string): string => {
  const match = /sidetrack_attach_token:\s*([A-Za-z0-9_-]+)/u.exec(prompt);
  if (match?.[1] === undefined) {
    throw new Error('Attach prompt did not include sidetrack_attach_token.');
  }
  return match[1];
};

test.describe('MCP request dispatch (synthetic)', () => {
  test('Codex registers from attach prompt, requests dispatch, and background opens target AI', async () => {
    let companion: MockVaultCompanion | undefined;
    let runtime: ExtensionRuntime | undefined;
    let mcp: InProcessMcp | undefined;

    try {
      companion = await createMockVaultCompanion();
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      await companion.attach(runtime.context);
      await runtime.context.route('https://chatgpt.com/**', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: '<!doctype html><title>ChatGPT synthetic</title><main>synthetic target</main>',
        });
      });

      const sidepanel = await seedAndOpenSidepanel(runtime, {
        [SETTINGS_KEY]: {
          companion: { port: companion.port, bridgeKey: companion.bridgeKey },
          autoTrack: false,
          siteToggles: { chatgpt: true, claude: true, gemini: true },
        },
        [WORKSTREAMS_KEY]: [workstream],
      });

      await sidepanel.getByRole('button', { name: 'Attach coding session' }).click();
      await sidepanel.locator('select').selectOption(workstreamId);
      await sidepanel.getByRole('button', { name: 'Generate prompt' }).click();
      const prompt = await extractPrompt(sidepanel);
      expect(prompt).toContain('sidetrack_mcp: ws://127.0.0.1:8721/mcp?token=');
      expect(prompt).toContain(`sidetrack_workstream_id: ${workstreamId}`);
      expect(prompt).toContain('bac.request_dispatch');
      const token = extractAttachToken(prompt);

      const activeCompanion = companion;
      mcp = await startInProcessMcp({
        vaultPath: activeCompanion.vaultPath,
        companionClient: {
          async registerCodingSession(input) {
            return await activeCompanion.writer.registerCodingSession(
              input,
              'mcp-request-dispatch-register',
            );
          },
          async requestDispatch(input) {
            const requestedAt = new Date().toISOString();
            const record: DispatchEventRecord = {
              bac_id: dispatchId,
              kind: 'coding',
              target: { provider: input.targetProvider, mode: input.mode },
              title: input.title,
              body: input.body,
              createdAt: requestedAt,
              redactionSummary: { matched: 0, categories: [] },
              tokenEstimate: Math.ceil(input.body.length / 4),
              status: 'pending',
              ...(input.workstreamId === undefined ? {} : { workstreamId: input.workstreamId }),
              ...(input.sourceThreadId === undefined
                ? {}
                : { sourceThreadId: input.sourceThreadId }),
              mcpRequest: {
                codingSessionId: input.codingSessionId,
                approval: 'auto-approved',
                requestedAt,
              },
            };
            await activeCompanion.writer.writeDispatchEvent(record, 'mcp-request-dispatch');
            return {
              dispatchId,
              approval: 'auto-approved',
              status: 'recorded',
              requestedAt,
            };
          },
        },
      });

      const registered = (await mcp.callTool('bac.coding_session_register', {
        token,
        tool: 'codex',
        cwd: '/Users/zyingfei/switchboard',
        branch: 'codex/mcp-inbound-dispatch',
        sessionId: 'mcp-request-dispatch-synthetic',
        name: 'codex · request dispatch',
      })) as { readonly structuredContent?: { readonly bac_id?: string } };
      const codingSessionId = registered.structuredContent?.bac_id;
      expect(codingSessionId).toBeTruthy();

      const requested = (await mcp.callTool('bac.request_dispatch', {
        codingSessionId,
        targetProvider: 'chatgpt',
        title: 'Synthetic inbound dispatch',
        body: 'Synthetic MCP inbound dispatch: ask ChatGPT to review this context.',
      })) as {
        readonly structuredContent?: {
          readonly dispatchId?: string;
          readonly approval?: string;
          readonly workstreamId?: string;
        };
      };
      expect(requested.structuredContent).toMatchObject({
        dispatchId,
        approval: 'auto-approved',
        workstreamId,
      });

      await runtime.sendRuntimeMessage(sidepanel, { type: messageTypes.getWorkboardState });

      await expect
        .poll(async () =>
          runtime?.context.pages().some((page) => page.url().startsWith('https://chatgpt.com/')),
        )
        .toBe(true);

      const storage = await sidepanel.evaluate(async () => {
        return await chrome.storage.local.get([
          'sidetrack.recentDispatches',
          'sidetrack.mcpAutoDispatched',
        ]);
      });
      const recent = storage['sidetrack.recentDispatches'] as readonly DispatchEventRecord[];
      const dispatched = storage['sidetrack.mcpAutoDispatched'] as Record<string, string>;
      expect(recent.find((dispatch) => dispatch.bac_id === dispatchId)?.mcpRequest).toMatchObject({
        approval: 'auto-approved',
      });
      expect(dispatched[dispatchId]).toBeTruthy();
    } finally {
      await mcp?.close();
      await runtime?.close();
      await companion?.close();
    }
  });
});
