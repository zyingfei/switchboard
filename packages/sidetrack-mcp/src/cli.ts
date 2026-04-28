#!/usr/bin/env node

import type { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { m1ReadToolNames } from './capabilities.js';
import { createSidetrackMcpServer, type CompanionWriteClient } from './server/mcpServer.js';
import { LiveVaultReader } from './vault/liveVaultReader.js';

export const mcpVersion = '0.0.0';

export interface CliStreams {
  readonly stdout: Writable;
  readonly stderr: Writable;
}

interface ParsedArgs {
  readonly help: boolean;
  readonly version: boolean;
  readonly listTools: boolean;
  readonly vaultPath?: string;
  readonly companionUrl?: string;
  readonly bridgeKey?: string;
}

export const renderHelp = (): string =>
  [
    'sidetrack-mcp',
    '',
    'MCP server for Sidetrack vault state. Read-only by default; pass',
    '--companion-url + --bridge-key to enable the bac.coding_session_register',
    'write tool that lets a coding agent self-register against a workstream.',
    '',
    'Usage:',
    '  sidetrack-mcp --help',
    '  sidetrack-mcp --version',
    '  sidetrack-mcp --list-tools',
    '  sidetrack-mcp --vault <path> [--companion-url <url> --bridge-key <key>]',
  ].join('\n');

const writeLine = (stream: Writable, text: string): void => {
  stream.write(`${text}\n`);
};

const parseArgs = (argv: readonly string[]): ParsedArgs => {
  let vaultPath: string | undefined;
  let companionUrl: string | undefined;
  let bridgeKey: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--vault') {
      vaultPath = argv[index + 1];
      index += 1;
    } else if (argv[index] === '--companion-url') {
      companionUrl = argv[index + 1];
      index += 1;
    } else if (argv[index] === '--bridge-key') {
      bridgeKey = argv[index + 1];
      index += 1;
    }
  }

  return {
    help: argv.includes('--help') || argv.includes('-h'),
    version: argv.includes('--version'),
    listTools: argv.includes('--list-tools'),
    ...(vaultPath === undefined ? {} : { vaultPath }),
    ...(companionUrl === undefined ? {} : { companionUrl }),
    ...(bridgeKey === undefined ? {} : { bridgeKey }),
  };
};

const createCompanionWriteClient = (
  companionUrl: string,
  bridgeKey: string,
): CompanionWriteClient => ({
  async registerCodingSession(input) {
    const response = await fetch(`${companionUrl.replace(/\/$/, '')}/v1/coding-sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Companion register failed (${String(response.status)}): ${detail}`);
    }
    const body = (await response.json()) as { readonly data?: { readonly bac_id?: string } };
    if (typeof body.data?.bac_id !== 'string') {
      throw new Error('Companion did not return bac_id for the registered coding session.');
    }
    return { bac_id: body.data.bac_id };
  },
});

export const runCli = async (argv: readonly string[], streams: CliStreams): Promise<number> => {
  const args = parseArgs(argv);

  if (args.version) {
    writeLine(streams.stdout, mcpVersion);
    return 0;
  }

  if (args.listTools) {
    writeLine(streams.stdout, m1ReadToolNames.join('\n'));
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

  if (
    (args.companionUrl === undefined) !== (args.bridgeKey === undefined) ||
    args.companionUrl?.length === 0 ||
    args.bridgeKey?.length === 0
  ) {
    writeLine(streams.stderr, '--companion-url and --bridge-key must be supplied together.');
    return 2;
  }

  const companionClient =
    args.companionUrl !== undefined && args.bridgeKey !== undefined
      ? createCompanionWriteClient(args.companionUrl, args.bridgeKey)
      : undefined;
  const server = createSidetrackMcpServer(new LiveVaultReader(args.vaultPath), companionClient);
  await server.connect(new StdioServerTransport());
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
