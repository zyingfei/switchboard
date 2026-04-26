import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfig, parseCliArgs, printUsage } from './config';
import { BacRuntime } from './runtime';
import { createBacServer } from './server';

const main = async (): Promise<void> => {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const config = await loadConfig(args.configPath);
  const runtime = new BacRuntime(config);
  await runtime.readRuntimeData();

  const server = createBacServer(runtime);
  const transport = new StdioServerTransport();

  const shutdown = async (): Promise<void> => {
    await server.close().catch(() => undefined);
    await runtime.close().catch(() => undefined);
  };

  process.on('SIGINT', () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0));
  });

  await server.connect(transport);
};

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
