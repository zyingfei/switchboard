import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';

import { m1ReadToolNames } from '../capabilities.js';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const tsxCliPath = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url));
const serverCliPath = fileURLToPath(new URL('../cli.ts', import.meta.url));

const createVaultFixture = async (): Promise<string> => {
  const vaultPath = await mkdtemp(join(tmpdir(), 'sidetrack-mcp-stdio-'));
  await mkdir(join(vaultPath, '_BAC', 'threads'), { recursive: true });
  await mkdir(join(vaultPath, '_BAC', 'workstreams'), { recursive: true });
  await mkdir(join(vaultPath, '_BAC', 'queue'), { recursive: true });
  await mkdir(join(vaultPath, '_BAC', 'reminders'), { recursive: true });

  await writeFile(
    join(vaultPath, '_BAC', 'workstreams', 'bac_workstream_test.json'),
    `${JSON.stringify({
      bac_id: 'bac_workstream_test',
      title: 'Sidetrack / MVP PRD',
      children: [],
      checklist: [{ id: 'check_1', text: 'Review M1', checked: false }],
      privacy: 'private',
    })}\n`,
  );
  await writeFile(
    join(vaultPath, '_BAC', 'threads', 'bac_thread_test.json'),
    `${JSON.stringify({
      bac_id: 'bac_thread_test',
      provider: 'claude',
      threadUrl: 'https://claude.ai/chat/thread',
      title: 'VM live migration architecture',
      lastSeenAt: '2026-04-26T21:40:00.000Z',
      primaryWorkstreamId: 'bac_workstream_test',
    })}\n`,
  );
  await writeFile(
    join(vaultPath, '_BAC', 'queue', 'bac_queue_test.json'),
    `${JSON.stringify({
      bac_id: 'bac_queue_test',
      text: 'Ask Claude to compare with VM live migration',
      scope: 'workstream',
      targetId: 'bac_workstream_test',
      status: 'pending',
    })}\n`,
  );
  await writeFile(
    join(vaultPath, '_BAC', 'reminders', 'bac_reminder_test.json'),
    `${JSON.stringify({
      bac_id: 'bac_reminder_test',
      threadId: 'bac_thread_test',
      provider: 'claude',
      detectedAt: '2026-04-26T21:41:00.000Z',
      status: 'new',
    })}\n`,
  );
  return vaultPath;
};

describe('sidetrack MCP stdio server', () => {
  it('serves the M1 read-only tools over stdio', async () => {
    const vaultPath = await createVaultFixture();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [tsxCliPath, serverCliPath, '--vault', vaultPath],
      cwd: packageRoot,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'sidetrack-mcp-test-client', version: '0.0.0' });

    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(m1ReadToolNames);

      const contextPack = await client.callTool({
        name: 'bac.context_pack',
        arguments: { workstreamId: 'bac_workstream_test' },
      });
      const content = contextPack.content as { readonly type: string; readonly text?: string }[];
      expect(content[0]?.text ?? '').toContain('VM live migration architecture');

      const search = await client.callTool({
        name: 'bac.search',
        arguments: { query: 'migration' },
      });
      const structured = search.structuredContent as {
        readonly hits?: readonly { readonly title?: string }[];
      };
      expect(structured.hits?.[0]?.title).toContain('VM live migration');
    } finally {
      await client.close();
    }
  });
});
