import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config';

const fixtureConfigPath = fileURLToPath(new URL('../fixtures/demo-config.json', import.meta.url));
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const tsxCliPath = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
const serverCliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

describe('BAC MCP stdio server', () => {
  it('serves the BAC tools over stdio', async () => {
    const config = await loadConfig(fixtureConfigPath);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [tsxCliPath, serverCliPath, '--config', config.configPath],
      cwd: packageRoot,
      stderr: 'inherit',
    });
    const client = new Client({
      name: 'bac-mcp-server-test-client',
      version: '0.0.0',
    });

    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        'bac.recent_threads',
        'bac.workstream',
        'bac.context_pack',
        'bac.search',
        'bac.recall',
      ]);

      const contextPack = await client.callTool({
        name: 'bac.context_pack',
        arguments: {},
      });
      const contextContent = contextPack.content as Array<{ type: string; text?: string }>;
      expect(contextContent[0]?.type).toBe('text');
      expect(contextContent[0]?.text ?? '').toContain(
        '# BAC Context Pack',
      );

      const recall = await client.callTool({
        name: 'bac.recall',
        arguments: {
          query: 'browser-owned mcp server',
          topK: 2,
          project: 'SwitchBoard',
        },
      });
      const structured = recall.structuredContent as { hits?: Array<{ sourcePath: string }> } | undefined;
      expect(structured?.hits?.[0]?.sourcePath).toContain('Projects/SwitchBoard');
    } finally {
      await client.close();
    }
  });
});
