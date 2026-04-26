import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

import { loadConfig, parseCliArgs } from './config';

const serverCommand = (): { command: string; args: string[] } => {
  if (import.meta.url.endsWith('.ts')) {
    return {
      command: process.execPath,
      args: [
        fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url)),
        fileURLToPath(new URL('./cli.ts', import.meta.url)),
      ],
    };
  }

  return {
    command: process.execPath,
    args: [fileURLToPath(new URL('./cli.js', import.meta.url))],
  };
};

const main = async (): Promise<void> => {
  const args = parseCliArgs(process.argv.slice(2));
  const config = await loadConfig(args.configPath);
  const server = serverCommand();
  const transport = new StdioClientTransport({
    command: server.command,
    args: [...server.args, '--config', config.configPath],
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stderr: 'inherit',
  });
  const client = new Client({
    name: 'bac-smoke-client',
    version: '0.0.0',
  });

  await client.connect(transport);
  const tools = await client.listTools();
  const recentThreads = await client.callTool({
    name: 'bac.recent_threads',
    arguments: {
      limit: 2,
    },
  });
  const workstream = await client.callTool({
    name: 'bac.workstream',
    arguments: {
      includeEvents: true,
    },
  });
  const contextPack = await client.callTool({
    name: 'bac.context_pack',
    arguments: {},
  });
  const search = await client.callTool({
    name: 'bac.search',
    arguments: {
      query: 'stdio context pack recall',
    },
  });
  const recall = await client.callTool({
    name: 'bac.recall',
    arguments: {
      query: 'browser-owned mcp server',
      topK: 3,
      project: 'SwitchBoard',
    },
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        tools: tools.tools.map((tool) => tool.name),
        recentThreads: recentThreads.structuredContent,
        workstream: workstream.structuredContent,
        contextPack: contextPack.structuredContent,
        search: search.structuredContent,
        recall: recall.structuredContent,
      },
      null,
      2,
    )}\n`,
  );

  await client.close();
};

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
