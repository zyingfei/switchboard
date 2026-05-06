#!/usr/bin/env node

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ensureMcpAuthKey } from './auth/mcpAuthKey.js';
import { pickInstaller } from './install/index.js';
import { startCompanion } from './runtime/companion.js';
import { startRelayServer } from './sync/relayServer.js';
import { COMPANION_VERSION } from './version.js';

export const companionVersion = COMPANION_VERSION;

export interface CliStreams {
  readonly stdout: Writable;
  readonly stderr: Writable;
}

interface ParsedArgs {
  readonly help: boolean;
  readonly version: boolean;
  readonly installService: boolean;
  readonly uninstallService: boolean;
  readonly serviceStatus: boolean;
  readonly allowAutoUpdate: boolean;
  readonly vaultPath?: string;
  readonly port: number;
  // Optional companion-managed Streamable HTTP MCP subprocess. When
  // both --mcp-port and --mcp-auth-key are set, the companion spawns
  // the sibling sidetrack-mcp CLI after its own HTTP server is up,
  // wires it to this companion's URL + bridge key, and tears it
  // down on parent exit. Lets the user run a single command instead
  // of two coordinated terminals.
  readonly mcpPort?: number;
  readonly mcpAuthKey?: string;
  readonly mcpBin?: string;
  // Optional cloud relay. When both --sync-relay and
  // --sync-rendezvous-secret are set, the companion connects to the
  // relay over WebSocket using end-to-end encrypted frames so peer
  // replicas can sync without a shared filesystem.
  readonly syncRelay?: string;
  readonly syncRendezvousSecret?: string;
  // Subcommand: `sidetrack-companion relay --port 8443` runs the
  // bundled relay server (no vault, no companion API).
  readonly relayMode: boolean;
  readonly relayPort?: number;
}

export const renderHelp = (): string =>
  [
    'sidetrack-companion',
    '',
    'Local Sidetrack companion process.',
    '',
    'Usage:',
    '  sidetrack-companion --help',
    '  sidetrack-companion --version',
    '  sidetrack-companion --install-service --vault <path> [--port 17373]',
    '  sidetrack-companion --uninstall-service',
    '  sidetrack-companion --service-status',
    '  sidetrack-companion --vault <path> [--port 17373] [--allow-auto-update]',
    '                      [--mcp-port <port> --mcp-auth-key <key>]',
    '                      [--mcp-bin <path>]',
    '                      [--sync-relay <wss://...> --sync-rendezvous-secret <base64url>]',
    '  sidetrack-companion relay [--relay-port 8443]',
    '',
    'Starts the localhost companion API and writes Sidetrack-owned files under _BAC/.',
    '',
    'When --mcp-port and --mcp-auth-key are both set, the companion also spawns',
    'the sibling sidetrack-mcp Streamable HTTP server pointed at itself. The MCP',
    "server shares the companion's lifetime; killing the companion kills it too.",
    'Override the binary path with --mcp-bin if the sibling layout differs',
    '(default: ../sidetrack-mcp/dist/cli.js relative to this CLI).',
    '',
    'Sync relay (optional, end-to-end encrypted):',
    '  --sync-relay <wss://...>          WebSocket URL of a sidetrack relay.',
    '  --sync-rendezvous-secret <bytes>  Base64url-encoded shared secret.',
    "                                    Paste the SAME secret into every replica that should",
    "                                    sync. The relay never sees plaintext — peers decrypt",
    "                                    via the secret-derived AEAD key locally.",
    '',
    'Relay subcommand:',
    '  sidetrack-companion relay [--relay-port 8443]',
    '    Run the bundled relay server. Stateless ring-buffer fanout; restart wipes',
    '    every rendezvous. Front with a TLS reverse proxy for wss:// access.',
  ].join('\n');

const writeLine = (stream: Writable, text: string): void => {
  stream.write(`${text}\n`);
};

const parsePortArg = (raw: string | undefined, flag: string): number => {
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${flag} must be an integer from 1 to 65535.`);
  }
  return parsed;
};

const parseArgs = (argv: readonly string[]): ParsedArgs => {
  let vaultPath: string | undefined;
  let port = 17373;
  let mcpPort: number | undefined;
  let mcpAuthKey: string | undefined;
  let mcpBin: string | undefined;
  let syncRelay: string | undefined;
  let syncRendezvousSecret: string | undefined;
  let relayPort: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--vault') {
      vaultPath = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--port') {
      port = parsePortArg(argv[index + 1], '--port');
      index += 1;
      continue;
    }

    if (arg === '--mcp-port') {
      mcpPort = parsePortArg(argv[index + 1], '--mcp-port');
      index += 1;
      continue;
    }

    if (arg === '--mcp-auth-key') {
      const value = argv[index + 1];
      if (value === undefined || value.length === 0) {
        throw new Error('--mcp-auth-key requires a non-empty value.');
      }
      mcpAuthKey = value;
      index += 1;
      continue;
    }

    if (arg === '--mcp-bin') {
      const value = argv[index + 1];
      if (value === undefined || value.length === 0) {
        throw new Error('--mcp-bin requires a non-empty path.');
      }
      mcpBin = value;
      index += 1;
      continue;
    }

    if (arg === '--sync-relay') {
      const value = argv[index + 1];
      if (value === undefined || value.length === 0) {
        throw new Error('--sync-relay requires a non-empty URL.');
      }
      syncRelay = value;
      index += 1;
      continue;
    }

    if (arg === '--sync-rendezvous-secret') {
      const value = argv[index + 1];
      if (value === undefined || value.length === 0) {
        throw new Error('--sync-rendezvous-secret requires a non-empty value.');
      }
      syncRendezvousSecret = value;
      index += 1;
      continue;
    }

    if (arg === '--relay-port') {
      relayPort = parsePortArg(argv[index + 1], '--relay-port');
      index += 1;
      continue;
    }
  }

  const parsed: ParsedArgs = {
    help: argv.includes('--help') || argv.includes('-h'),
    version: argv.includes('--version'),
    installService: argv.includes('--install-service'),
    uninstallService: argv.includes('--uninstall-service'),
    serviceStatus: argv.includes('--service-status'),
    allowAutoUpdate: argv.includes('--allow-auto-update'),
    relayMode: argv.includes('relay'),
    port,
    ...(mcpPort === undefined ? {} : { mcpPort }),
    ...(mcpAuthKey === undefined ? {} : { mcpAuthKey }),
    ...(mcpBin === undefined ? {} : { mcpBin }),
    ...(syncRelay === undefined ? {} : { syncRelay }),
    ...(syncRendezvousSecret === undefined ? {} : { syncRendezvousSecret }),
    ...(relayPort === undefined ? {} : { relayPort }),
  };

  return vaultPath === undefined ? parsed : { ...parsed, vaultPath };
};

// Spawn the sibling sidetrack-mcp CLI and stream its output through
// the companion's stdio so the user sees a single combined log. The
// child is killed when the companion process exits.
const spawnMcpServer = (input: {
  readonly mcpBin: string;
  readonly mcpPort: number;
  readonly mcpAuthKey: string;
  readonly vaultPath: string;
  readonly companionUrl: string;
  readonly bridgeKey: string;
  readonly stdout: Writable;
  readonly stderr: Writable;
}): ChildProcess => {
  const args = [
    input.mcpBin,
    '--transport',
    'streamable-http',
    '--vault',
    input.vaultPath,
    '--port',
    String(input.mcpPort),
    '--companion-url',
    input.companionUrl,
    '--bridge-key',
    input.bridgeKey,
    '--mcp-auth-key',
    input.mcpAuthKey,
  ];
  const child = spawn(process.execPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    input.stdout.write(`[mcp] ${chunk.toString('utf8')}`);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    input.stderr.write(`[mcp] ${chunk.toString('utf8')}`);
  });
  child.on('exit', (code, signal) => {
    input.stderr.write(
      `[mcp] sidetrack-mcp exited (code=${String(code)}, signal=${String(signal)}).\n`,
    );
  });
  return child;
};

const resolveDefaultMcpBin = (): string => {
  // Resolve relative to this CLI's compiled location:
  //   packages/sidetrack-companion/dist/cli.js
  // → ../../sidetrack-mcp/dist/cli.js
  const here = fileURLToPath(import.meta.url);
  return resolve(dirname(here), '../../sidetrack-mcp/dist/cli.js');
};

export const runCli = async (argv: readonly string[], streams: CliStreams): Promise<number> => {
  const args = parseArgs(argv);

  if (args.version) {
    writeLine(streams.stdout, companionVersion);
    return 0;
  }

  if (args.help) {
    writeLine(streams.stdout, renderHelp());
    return 0;
  }

  if (args.relayMode) {
    const port = args.relayPort ?? 8443;
    const relay = await startRelayServer({ port });
    writeLine(
      streams.stdout,
      `sidetrack-relay listening on http://${relay.host}:${String(relay.port)} (use a TLS reverse proxy for wss://)`,
    );
    return await new Promise<number>((resolve) => {
      const shutdown = (signal: string) => {
        writeLine(streams.stdout, `[relay] received ${signal}, shutting down`);
        void relay.close().then(() => {
          resolve(0);
        });
      };
      process.once('SIGINT', () => {
        shutdown('SIGINT');
      });
      process.once('SIGTERM', () => {
        shutdown('SIGTERM');
      });
    });
  }

  if (args.serviceStatus) {
    const status = await pickInstaller().status();
    writeLine(
      streams.stdout,
      `service ${status.installed ? 'installed' : 'not installed'}; ${status.running ? 'running' : 'not running'} (${status.platform})`,
    );
    if (status.path !== undefined) {
      writeLine(streams.stdout, `path ${status.path}`);
    }
    return 0;
  }

  if (args.uninstallService) {
    await pickInstaller().uninstall();
    writeLine(streams.stdout, 'sidetrack companion service uninstalled');
    return 0;
  }

  if (args.vaultPath === undefined || args.vaultPath.length === 0) {
    writeLine(streams.stderr, 'Missing required --vault <path>.');
    writeLine(streams.stderr, renderHelp());
    return 2;
  }

  if (args.installService) {
    const result = await pickInstaller().install({
      vaultPath: args.vaultPath,
      port: args.port,
      ...(process.argv[1] === undefined ? {} : { companionBin: process.argv[1] }),
    });
    writeLine(streams.stdout, `sidetrack companion service installed (${result.platform})`);
    writeLine(streams.stdout, `path ${result.path}`);
    return result.installed ? 0 : 1;
  }

  // Resolve MCP auth key BEFORE starting the companion HTTP server,
  // so /v1/status returns the same key the MCP child will be running
  // with. Explicit --mcp-auth-key wins (useful for testing); otherwise
  // we ensure the persistent key on disk and reuse it across restarts.
  let resolvedMcpAuthKey: string | undefined = args.mcpAuthKey;
  let mcpAuthKeyPath: string | undefined;
  let mcpAuthKeyCreated = false;
  if (args.mcpPort !== undefined && resolvedMcpAuthKey === undefined) {
    const ensured = await ensureMcpAuthKey(args.vaultPath);
    resolvedMcpAuthKey = ensured.key;
    mcpAuthKeyPath = ensured.path;
    mcpAuthKeyCreated = ensured.created;
  }

  const runtime = await startCompanion({
    vaultPath: args.vaultPath,
    port: args.port,
    allowAutoUpdate: args.allowAutoUpdate,
    ...(args.mcpPort !== undefined && resolvedMcpAuthKey !== undefined
      ? { mcp: { port: args.mcpPort, authKey: resolvedMcpAuthKey } }
      : {}),
    ...(args.syncRelay !== undefined && args.syncRendezvousSecret !== undefined
      ? {
          relay: {
            url: args.syncRelay,
            rendezvousSecret: args.syncRendezvousSecret,
          },
        }
      : {}),
  });

  writeLine(streams.stdout, `sidetrack-companion listening on ${runtime.url}`);
  writeLine(streams.stdout, `vault           ${runtime.vaultPath}`);
  writeLine(streams.stdout, `bridge key file ${runtime.bridgeKeyPath}`);
  writeLine(streams.stdout, `replica id      ${runtime.replicaId}${runtime.replicaIdCreated ? ' (new)' : ''}`);
  if (args.syncRelay !== undefined && args.syncRendezvousSecret !== undefined) {
    writeLine(streams.stdout, `sync relay      ${args.syncRelay} (e2e-encrypted via rendezvous secret)`);
  }
  writeLine(streams.stdout, `auto-update     ${args.allowAutoUpdate ? 'enabled' : 'disabled'}`);
  if (runtime.bridgeKeyCreated) {
    // First run for this vault — print the key once so the user can
    // paste it into the side panel without going to the file system.
    // Subsequent runs reuse the file; we only point at the path.
    writeLine(streams.stdout, '');
    writeLine(
      streams.stdout,
      'A new bridge key was generated. Paste this into the side panel:',
    );
    writeLine(streams.stdout, `Settings → Companion bridge key → ${runtime.bridgeKey}`);
    writeLine(streams.stdout, '');
    writeLine(
      streams.stdout,
      `(The key is saved to ${runtime.bridgeKeyPath} — \`cat\` it any time you need to recover it.)`,
    );
  } else {
    writeLine(
      streams.stdout,
      `(Reusing the existing key. Run \`cat ${runtime.bridgeKeyPath}\` to copy it again.)`,
    );
  }

  if (args.mcpPort !== undefined && resolvedMcpAuthKey !== undefined) {
    const mcpBin = args.mcpBin ?? resolveDefaultMcpBin();
    if (!existsSync(mcpBin)) {
      writeLine(
        streams.stderr,
        `--mcp-port set but sidetrack-mcp CLI not found at ${mcpBin}. Build it (npm --prefix packages/sidetrack-mcp run build) or pass --mcp-bin <path>.`,
      );
      await runtime.close();
      return 1;
    }
    const child = spawnMcpServer({
      mcpBin,
      mcpPort: args.mcpPort,
      mcpAuthKey: resolvedMcpAuthKey,
      vaultPath: args.vaultPath,
      companionUrl: runtime.url,
      bridgeKey: runtime.bridgeKey,
      stdout: streams.stdout,
      stderr: streams.stderr,
    });
    writeLine(
      streams.stdout,
      `mcp http       http://127.0.0.1:${String(args.mcpPort)}/mcp (managed by companion)`,
    );
    if (mcpAuthKeyPath !== undefined) {
      const keyOrigin = mcpAuthKeyCreated ? 'generated' : 'reused';
      writeLine(
        streams.stdout,
        `mcp auth key   ${keyOrigin} (${mcpAuthKeyPath}). The side panel reads this from /v1/status.`,
      );
    } else {
      writeLine(
        streams.stdout,
        'mcp auth key   provided via --mcp-auth-key (skip the side-panel prompt regen if you change it).',
      );
    }
    const shutdown = (signal: NodeJS.Signals): void => {
      child.kill(signal);
      void runtime.close().finally(() => {
        process.exit(0);
      });
    };
    process.once('SIGINT', () => {
      shutdown('SIGINT');
    });
    process.once('SIGTERM', () => {
      shutdown('SIGTERM');
    });
  }
  return 0;
};

const entrypointPath = process.argv[1];

if (entrypointPath !== undefined && import.meta.url === pathToFileURL(entrypointPath).href) {
  runCli(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
  })
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'Unknown error'}\n`);
      process.exitCode = 1;
    });
}
