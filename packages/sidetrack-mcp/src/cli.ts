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
): CompanionWriteClient => {
  const base = companionUrl.replace(/\/$/, '');
  const post = async <TResult>(
    path: string,
    body: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<TResult> => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bac-bridge-key': bridgeKey,
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Companion ${path} failed (${String(response.status)}): ${detail}`);
    }
    return (await response.json()) as TResult;
  };
  // Idempotency keys: same shape as the extension uses, so concurrent
  // moves/queue items don't double-write the vault.
  const idempotencyKey = (prefix: string, value: string): string =>
    `${prefix}-${value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 160)}`;

  return {
    async registerCodingSession(input) {
      const body = await post<{ readonly data?: { readonly bac_id?: string } }>(
        '/v1/coding-sessions',
        input,
      );
      if (typeof body.data?.bac_id !== 'string') {
        throw new Error('Companion did not return bac_id for the registered coding session.');
      }
      return { bac_id: body.data.bac_id };
    },
    async moveThread(input) {
      // Companion expects a full ThreadUpsert; an MCP move only knows
      // the threadId, so we look up the existing thread first via the
      // dispatch ledger isn't right — instead, we POST the partial
      // upsert and let the companion's vault writer fill in the rest
      // from its current snapshot. The companion handles this by
      // merging on bac_id.
      const upsert = {
        bac_id: input.threadId,
        ...(input.workstreamId === undefined
          ? { primaryWorkstreamId: null }
          : { primaryWorkstreamId: input.workstreamId }),
      };
      const body = await post<{
        readonly data?: { readonly bac_id?: string; readonly revision?: string };
      }>('/v1/threads', upsert);
      if (typeof body.data?.bac_id !== 'string' || typeof body.data.revision !== 'string') {
        throw new Error('Companion did not return bac_id + revision for the moved thread.');
      }
      return { bac_id: body.data.bac_id, revision: body.data.revision };
    },
    async createQueueItem(input) {
      const body = await post<{
        readonly data?: { readonly bac_id?: string; readonly revision?: string };
      }>('/v1/queue', input, {
        'idempotency-key': idempotencyKey(
          'mcp-queue',
          `${input.scope}-${input.targetId ?? 'global'}-${input.text}`,
        ),
      });
      if (typeof body.data?.bac_id !== 'string' || typeof body.data.revision !== 'string') {
        throw new Error('Companion did not return bac_id + revision for the queued item.');
      }
      return { bac_id: body.data.bac_id, revision: body.data.revision };
    },
  };
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
