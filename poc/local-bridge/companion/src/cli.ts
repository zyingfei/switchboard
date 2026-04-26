import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { ensureBridgeKey, keyfilePath } from './auth/keyfile';
import { BridgeRuntime } from './runtime';
import { HttpTransportServer } from './transport/http';
import { NativeMessagingTransportServer } from './transport/nm';

const usage = `BAC local bridge companion

Usage:
  npm start -- --vault /path/to/vault [--port 17875]
  npm start -- --vault /path/to/vault --nm

Options:
  --vault <path>             Vault root folder
  --port <number>            HTTP localhost port, default 17875
  --nm                       Use Native Messaging stdio transport
  --allowed-extension-id ID  Optional Native Messaging extension-id gate
`;

export const parseCliArgs = (argv: string[]): {
  readonly vaultPath: string;
  readonly port: number;
  readonly nm: boolean;
  readonly allowedExtensionId?: string;
  readonly help: boolean;
} => {
  const { values } = parseArgs({
    args: argv,
    options: {
      vault: { type: 'string' },
      port: { type: 'string' },
      nm: { type: 'boolean' },
      'allowed-extension-id': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    return { vaultPath: '', port: 17875, nm: false, help: true };
  }
  if (!values.vault) {
    throw new Error('Missing required --vault <path>');
  }
  return {
    vaultPath: path.resolve(values.vault),
    port: Number.parseInt(values.port ?? '17875', 10),
    nm: values.nm ?? false,
    allowedExtensionId: values['allowed-extension-id'],
    help: false,
  };
};

const main = async (): Promise<void> => {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    process.stderr.write(usage);
    return;
  }
  await mkdir(args.vaultPath, { recursive: true });
  const runtime = new BridgeRuntime(args.vaultPath, args.nm ? 'nativeMessaging' : 'http');
  const key = args.nm ? undefined : await ensureBridgeKey(args.vaultPath);
  const transport = args.nm
    ? new NativeMessagingTransportServer(runtime, args.allowedExtensionId)
    : new HttpTransportServer(runtime, key ?? '', args.port);

  const shutdown = async (): Promise<void> => {
    runtime.stopTick();
    await transport.stop().catch(() => undefined);
  };
  process.on('SIGINT', () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0));
  });

  await transport.start();
  process.stderr.write(
    args.nm
      ? `BAC local bridge native host started for ${args.vaultPath}\n`
      : `BAC local bridge listening on http://127.0.0.1:${args.port}\n`,
  );
  if (key) {
    process.stderr.write(`Bridge key: ${keyfilePath(args.vaultPath)}\n`);
  }
};

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
