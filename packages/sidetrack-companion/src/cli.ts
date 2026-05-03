#!/usr/bin/env node

import type { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { startCompanion } from './runtime/companion.js';

export const companionVersion = '0.0.0';

export interface CliStreams {
  readonly stdout: Writable;
  readonly stderr: Writable;
}

interface ParsedArgs {
  readonly help: boolean;
  readonly version: boolean;
  readonly vaultPath?: string;
  readonly port: number;
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
    '  sidetrack-companion --vault <path> [--port 17373]',
    '',
    'Starts the localhost companion API and writes Sidetrack-owned files under _BAC/.',
  ].join('\n');

const writeLine = (stream: Writable, text: string): void => {
  stream.write(`${text}\n`);
};

const parseArgs = (argv: readonly string[]): ParsedArgs => {
  let vaultPath: string | undefined;
  let port = 17373;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--vault') {
      vaultPath = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--port') {
      const rawPort = argv[index + 1];
      const parsedPort = rawPort === undefined ? Number.NaN : Number.parseInt(rawPort, 10);
      if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
        throw new Error('--port must be an integer from 1 to 65535.');
      }
      port = parsedPort;
      index += 1;
    }
  }

  const parsed: ParsedArgs = {
    help: argv.includes('--help') || argv.includes('-h'),
    version: argv.includes('--version'),
    port,
  };

  return vaultPath === undefined ? parsed : { ...parsed, vaultPath };
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

  if (args.vaultPath === undefined || args.vaultPath.length === 0) {
    writeLine(streams.stderr, 'Missing required --vault <path>.');
    writeLine(streams.stderr, renderHelp());
    return 2;
  }

  const runtime = await startCompanion({
    vaultPath: args.vaultPath,
    port: args.port,
  });

  writeLine(streams.stdout, `sidetrack-companion listening on ${runtime.url}`);
  writeLine(streams.stdout, `vault           ${runtime.vaultPath}`);
  writeLine(streams.stdout, `bridge key file ${runtime.bridgeKeyPath}`);
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
