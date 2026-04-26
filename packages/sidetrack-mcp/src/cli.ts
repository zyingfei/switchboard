#!/usr/bin/env node

import type { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { m1ReadToolNames } from './capabilities.js';
import { createSidetrackMcpServer } from './server/mcpServer.js';
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
}

export const renderHelp = (): string =>
  [
    'sidetrack-mcp',
    '',
    'Read-only MCP server for Sidetrack vault state.',
    '',
    'Usage:',
    '  sidetrack-mcp --help',
    '  sidetrack-mcp --version',
    '  sidetrack-mcp --list-tools',
    '  sidetrack-mcp --vault <path>',
    '',
    'Starts a read-only stdio MCP server over the Sidetrack _BAC vault files.',
  ].join('\n');

const writeLine = (stream: Writable, text: string): void => {
  stream.write(`${text}\n`);
};

const parseArgs = (argv: readonly string[]): ParsedArgs => {
  let vaultPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--vault') {
      vaultPath = argv[index + 1];
      index += 1;
    }
  }

  const parsed: ParsedArgs = {
    help: argv.includes('--help') || argv.includes('-h'),
    version: argv.includes('--version'),
    listTools: argv.includes('--list-tools'),
  };

  return vaultPath === undefined ? parsed : { ...parsed, vaultPath };
};

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

  const server = createSidetrackMcpServer(new LiveVaultReader(args.vaultPath));
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
