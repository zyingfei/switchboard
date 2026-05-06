#!/usr/bin/env node

import type { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { sidetrackToolNames } from './capabilities.js';
import { createSidetrackMcpServer, type CompanionWriteClient } from './server/mcpServer.js';
import {
  sidetrackMcpHttpPort,
  startStreamableHttpMcpServer,
} from './server/streamableHttpServer.js';
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
  readonly transport: 'stdio' | 'streamable-http';
  readonly vaultPath?: string;
  readonly companionUrl?: string;
  readonly bridgeKey?: string;
  readonly mcpAuthKey?: string;
  readonly host: string;
  readonly port: number;
}

export const renderHelp = (): string =>
  [
    'sidetrack-mcp',
    '',
    'MCP server for Sidetrack vault state. Read-only by default; pass',
    '--companion-url + --bridge-key to enable coding-session and dispatch',
    'write tools that let an agent self-register and request auto-approved dispatches.',
    '',
    'Usage:',
    '  sidetrack-mcp --help',
    '  sidetrack-mcp --version',
    '  sidetrack-mcp --list-tools',
    '  sidetrack-mcp --vault <path> [--companion-url <url> --bridge-key <key>]',
    '  sidetrack-mcp --transport streamable-http --vault <path> [--port 8721]',
    '                [--companion-url <url> --bridge-key <key>] [--mcp-auth-key <key>]',
    '',
    'Streamable HTTP endpoint defaults to http://127.0.0.1:8721/mcp. When an',
    'auth key is configured, send Authorization: Bearer <key> on every request.',
  ].join('\n');

const writeLine = (stream: Writable, text: string): void => {
  stream.write(`${text}\n`);
};

const parseArgs = (argv: readonly string[]): ParsedArgs => {
  let vaultPath: string | undefined;
  let companionUrl: string | undefined;
  let bridgeKey: string | undefined;
  let mcpAuthKey: string | undefined;
  let transport: 'stdio' | 'streamable-http' = 'stdio';
  let host = '127.0.0.1';
  let port = sidetrackMcpHttpPort;

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--vault') {
      vaultPath = argv[index + 1];
      index += 1;
    } else if (argv[index] === '--transport') {
      const rawTransport = argv[index + 1];
      if (rawTransport !== 'stdio' && rawTransport !== 'streamable-http') {
        throw new Error('--transport must be either stdio or streamable-http.');
      }
      transport = rawTransport;
      index += 1;
    } else if (argv[index] === '--companion-url') {
      companionUrl = argv[index + 1];
      index += 1;
    } else if (argv[index] === '--bridge-key') {
      bridgeKey = argv[index + 1];
      index += 1;
    } else if (argv[index] === '--mcp-auth-key') {
      mcpAuthKey = argv[index + 1];
      index += 1;
    } else if (argv[index] === '--host') {
      host = argv[index + 1] ?? '';
      index += 1;
    } else if (argv[index] === '--port') {
      const rawPort = argv[index + 1];
      const parsedPort = rawPort === undefined ? Number.NaN : Number.parseInt(rawPort, 10);
      if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
        throw new Error('--port must be an integer from 1 to 65535.');
      }
      port = parsedPort;
      index += 1;
    }
  }

  return {
    help: argv.includes('--help') || argv.includes('-h'),
    version: argv.includes('--version'),
    listTools: argv.includes('--list-tools'),
    transport,
    host,
    port,
    ...(vaultPath === undefined ? {} : { vaultPath }),
    ...(companionUrl === undefined ? {} : { companionUrl }),
    ...(bridgeKey === undefined ? {} : { bridgeKey }),
    ...(mcpAuthKey === undefined ? {} : { mcpAuthKey }),
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
  const patch = async <TResult>(path: string, body: unknown): Promise<TResult> => {
    const response = await fetch(`${base}${path}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-bac-bridge-key': bridgeKey,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Companion ${path} failed (${String(response.status)}): ${detail}`);
    }
    return (await response.json()) as TResult;
  };
  const del = async <TResult>(path: string): Promise<TResult> => {
    const response = await fetch(`${base}${path}`, {
      method: 'DELETE',
      headers: { 'x-bac-bridge-key': bridgeKey },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Companion ${path} failed (${String(response.status)}): ${detail}`);
    }
    return (await response.json()) as TResult;
  };
  const getDataArray = async (
    path: string,
    params: URLSearchParams = new URLSearchParams(),
  ): Promise<readonly unknown[]> => {
    const suffix = params.toString().length === 0 ? '' : `?${params.toString()}`;
    const response = await fetch(`${base}${path}${suffix}`, {
      method: 'GET',
      headers: {
        'x-bac-bridge-key': bridgeKey,
      },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Companion ${path} failed (${String(response.status)}): ${detail}`);
    }
    const body = (await response.json()) as unknown;
    if (
      typeof body !== 'object' ||
      body === null ||
      !('data' in body) ||
      !Array.isArray((body as { readonly data?: unknown }).data)
    ) {
      throw new Error(`Companion ${path} did not return a data array.`);
    }
    return (body as { readonly data: readonly unknown[] }).data;
  };
  const getObject = async (path: string): Promise<Record<string, unknown>> => {
    const response = await fetch(`${base}${path}`, {
      method: 'GET',
      headers: { 'x-bac-bridge-key': bridgeKey },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Companion ${path} failed (${String(response.status)}): ${detail}`);
    }
    const body = (await response.json()) as unknown;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new Error(`Companion ${path} did not return an object.`);
    }
    return body as Record<string, unknown>;
  };
  const readList = (
    path: string,
    input: { readonly limit?: number; readonly since?: string },
  ): Promise<readonly unknown[]> => {
    const params = new URLSearchParams();
    if (input.limit !== undefined) {
      params.set('limit', String(input.limit));
    }
    if (input.since !== undefined) {
      params.set('since', input.since);
    }
    return getDataArray(path, params);
  };
  // Idempotency keys: same shape as the extension uses, so concurrent
  // moves/queue items don't double-write the vault.
  const idempotencyKey = (prefix: string, value: string): string =>
    `${prefix}-${value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 160)}`;

  return {
    async registerCodingSession(input) {
      const body = await post<{ readonly data?: Record<string, unknown> }>(
        '/v1/coding-sessions',
        input,
      );
      const data = body.data;
      if (typeof data?.['bac_id'] !== 'string') {
        throw new Error('Companion did not return bac_id for the registered coding session.');
      }
      return {
        bac_id: data['bac_id'],
        ...(typeof data['workstreamId'] === 'string' ? { workstreamId: data['workstreamId'] } : {}),
        ...(data['tool'] === 'claude_code' ||
        data['tool'] === 'codex' ||
        data['tool'] === 'cursor' ||
        data['tool'] === 'other'
          ? { tool: data['tool'] }
          : {}),
        ...(typeof data['cwd'] === 'string' ? { cwd: data['cwd'] } : {}),
        ...(typeof data['branch'] === 'string' ? { branch: data['branch'] } : {}),
        ...(typeof data['sessionId'] === 'string' ? { sessionId: data['sessionId'] } : {}),
        ...(typeof data['name'] === 'string' ? { name: data['name'] } : {}),
        ...(typeof data['resumeCommand'] === 'string'
          ? { resumeCommand: data['resumeCommand'] }
          : {}),
        ...(typeof data['attachedAt'] === 'string' ? { attachedAt: data['attachedAt'] } : {}),
        ...(typeof data['lastSeenAt'] === 'string' ? { lastSeenAt: data['lastSeenAt'] } : {}),
        ...(data['status'] === 'attached' || data['status'] === 'detached'
          ? { status: data['status'] }
          : {}),
      };
    },
    async requestDispatch(input) {
      const requestedAt = new Date().toISOString();
      const body = await post<{
        readonly data?: { readonly bac_id?: string; readonly status?: string };
      }>(
        '/v1/dispatches',
        {
          kind: 'coding',
          target: { provider: input.targetProvider, mode: input.mode },
          title: input.title,
          body: input.body,
          status: 'pending',
          ...(input.workstreamId === undefined ? {} : { workstreamId: input.workstreamId }),
          ...(input.sourceThreadId === undefined ? {} : { sourceThreadId: input.sourceThreadId }),
          mcpRequest: {
            codingSessionId: input.codingSessionId,
            approval: 'auto-approved',
            requestedAt,
          },
        },
        {
          'x-sidetrack-mcp-tool': 'sidetrack.dispatch.create',
          'idempotency-key': idempotencyKey(
            'mcp-dispatch',
            [
              input.codingSessionId,
              input.targetProvider,
              input.mode,
              input.workstreamId ?? '',
              input.sourceThreadId ?? '',
              input.title,
              input.body,
            ].join('-'),
          ),
        },
      );
      if (typeof body.data?.bac_id !== 'string') {
        throw new Error('Companion did not return bac_id for the requested dispatch.');
      }
      return {
        dispatchId: body.data.bac_id,
        approval: 'auto-approved',
        status: body.data.status ?? 'recorded',
        requestedAt,
      };
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
      }>('/v1/threads', upsert, { 'x-sidetrack-mcp-tool': 'sidetrack.threads.move' });
      if (typeof body.data?.bac_id !== 'string' || typeof body.data.revision !== 'string') {
        throw new Error('Companion did not return bac_id + revision for the moved thread.');
      }
      return { bac_id: body.data.bac_id, revision: body.data.revision };
    },
    async createQueueItem(input) {
      const body = await post<{
        readonly data?: { readonly bac_id?: string; readonly revision?: string };
      }>('/v1/queue', input, {
        'x-sidetrack-mcp-tool': 'sidetrack.queue.create',
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
    async createAnnotation(input) {
      const body = await post<{ readonly data?: Record<string, unknown> }>(
        '/v1/annotations',
        input,
        {
          'x-sidetrack-mcp-tool': 'sidetrack.annotations.create',
          'idempotency-key': idempotencyKey(
            'mcp-annotation',
            [
              input.url,
              input.pageTitle,
              input.term,
              input.selectionHint ?? '',
              input.note,
            ].join('-'),
          ),
        },
      );
      return body.data ?? {};
    },
    async bumpWorkstream(input) {
      const body = await post<{
        readonly data?: { readonly bac_id?: string; readonly revision?: string };
      }>(
        `/v1/workstreams/${encodeURIComponent(input.bac_id)}/bump`,
        {},
        {
          'x-sidetrack-mcp-tool': 'sidetrack.workstreams.bump',
        },
      );
      if (typeof body.data?.bac_id !== 'string' || typeof body.data.revision !== 'string') {
        throw new Error('Companion did not return bac_id + revision for bumped workstream.');
      }
      return { bac_id: body.data.bac_id, revision: body.data.revision };
    },
    async archiveThread(input) {
      const body = await post<{
        readonly data?: { readonly bac_id?: string; readonly revision?: string };
      }>(
        `/v1/threads/${encodeURIComponent(input.bac_id)}/archive`,
        {},
        {
          'x-sidetrack-mcp-tool': 'sidetrack.threads.archive',
        },
      );
      if (typeof body.data?.bac_id !== 'string' || typeof body.data.revision !== 'string') {
        throw new Error('Companion did not return bac_id + revision for archived thread.');
      }
      return { bac_id: body.data.bac_id, revision: body.data.revision };
    },
    async unarchiveThread(input) {
      const body = await post<{
        readonly data?: { readonly bac_id?: string; readonly revision?: string };
      }>(
        `/v1/threads/${encodeURIComponent(input.bac_id)}/unarchive`,
        {},
        {
          'x-sidetrack-mcp-tool': 'sidetrack.threads.unarchive',
        },
      );
      if (typeof body.data?.bac_id !== 'string' || typeof body.data.revision !== 'string') {
        throw new Error('Companion did not return bac_id + revision for unarchived thread.');
      }
      return { bac_id: body.data.bac_id, revision: body.data.revision };
    },
    async updateAnnotation(input) {
      const body = await patch<{ readonly data?: Record<string, unknown> }>(
        `/v1/annotations/${encodeURIComponent(input.bac_id)}`,
        { note: input.note },
      );
      return body.data ?? {};
    },
    async deleteAnnotation(input) {
      const body = await del<{ readonly data?: Record<string, unknown> }>(
        `/v1/annotations/${encodeURIComponent(input.bac_id)}`,
      );
      return body.data ?? {};
    },
    listDispatches: (input) => readList('/v1/dispatches', input),
    listAuditEvents: (input) => readList('/v1/audit', input),
    listAnnotations: (input) => {
      const params = new URLSearchParams();
      if (input.url !== undefined) {
        params.set('url', input.url);
      }
      if (input.limit !== undefined) {
        params.set('limit', String(input.limit));
      }
      return getDataArray('/v1/annotations', params);
    },
    readThreadMarkdown: (input) =>
      getObject(`/v1/threads/${encodeURIComponent(input.bac_id)}/markdown`),
    readWorkstreamMarkdown: (input) =>
      getObject(`/v1/workstreams/${encodeURIComponent(input.bac_id)}/markdown`),
    recall: (input) => {
      const params = new URLSearchParams({ q: input.query });
      if (input.limit !== undefined) {
        params.set('limit', String(input.limit));
      }
      if (input.workstreamId !== undefined) {
        params.set('workstreamId', input.workstreamId);
      }
      return getDataArray('/v1/recall/query', params);
    },
    suggestWorkstream: (input) => {
      const params = new URLSearchParams();
      if (input.limit !== undefined) {
        params.set('limit', String(input.limit));
      }
      return getDataArray(`/v1/suggestions/thread/${encodeURIComponent(input.threadId)}`, params);
    },
    exportSettings: () => getObject('/v1/settings/export'),
    async listBuckets() {
      const body = await getObject('/v1/buckets');
      const items = body['items'];
      if (!Array.isArray(items)) {
        throw new Error('Companion buckets response missing items array.');
      }
      return items as readonly unknown[];
    },
    systemHealth: () =>
      getObject('/v1/system/health').then((body) => {
        const data = body['data'];
        if (typeof data !== 'object' || data === null || Array.isArray(data)) {
          throw new Error('Companion health response missing data object.');
        }
        return data as Record<string, unknown>;
      }),
    systemUpdateCheck: () =>
      getObject('/v1/system/update-check').then((body) => {
        const data = body['data'];
        if (typeof data !== 'object' || data === null || Array.isArray(data)) {
          throw new Error('Companion update-check response missing data object.');
        }
        return data as Record<string, unknown>;
      }),
    async listWorkstreamNotes(input) {
      const response = await fetch(
        `${base}/v1/workstreams/${encodeURIComponent(input.workstreamId)}/linked-notes`,
        {
          method: 'GET',
          headers: {
            'x-bac-bridge-key': bridgeKey,
          },
        },
      );
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Companion linked-notes failed (${String(response.status)}): ${detail}`);
      }
      const body = (await response.json()) as unknown;
      if (
        typeof body !== 'object' ||
        body === null ||
        !('items' in body) ||
        !Array.isArray((body as { readonly items?: unknown }).items)
      ) {
        throw new Error('Companion linked-notes response missing items array.');
      }
      return (body as { readonly items: readonly unknown[] }).items;
    },
    async awaitCaptureForDispatch(input) {
      const url = new URL(
        `${base}/v1/dispatches/${encodeURIComponent(input.dispatchId)}/await-capture`,
      );
      if (input.timeoutMs !== undefined) {
        url.searchParams.set('timeoutMs', String(input.timeoutMs));
      }
      // Server caps at 120s; use a fetch timeout slightly above that
      // so a slow companion respond never produces an aborted-fetch
      // error before the server-side timeout fires.
      const fetchTimeoutMs = Math.min(125_000, (input.timeoutMs ?? 60_000) + 5_000);
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, fetchTimeoutMs);
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: { 'x-bac-bridge-key': bridgeKey },
          signal: controller.signal,
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          throw new Error(
            `Companion await-capture failed (${String(response.status)}): ${detail}`,
          );
        }
        const body = (await response.json()) as { readonly data?: unknown };
        if (typeof body.data !== 'object' || body.data === null || Array.isArray(body.data)) {
          throw new Error('Companion await-capture response missing data object.');
        }
        return body.data as Awaited<
          ReturnType<NonNullable<CompanionWriteClient['awaitCaptureForDispatch']>>
        >;
      } finally {
        clearTimeout(timer);
      }
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
    writeLine(streams.stdout, sidetrackToolNames.join('\n'));
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
  const vaultPath = args.vaultPath;
  const createServer = () =>
    createSidetrackMcpServer(new LiveVaultReader(vaultPath), companionClient);

  if (args.transport === 'streamable-http') {
    const authKey = args.mcpAuthKey ?? args.bridgeKey;
    const started = await startStreamableHttpMcpServer({
      host: args.host,
      port: args.port,
      ...(authKey === undefined ? {} : { authKey }),
      createServer,
    });
    writeLine(streams.stderr, `sidetrack-mcp streamable-http listening on ${started.url}`);
    return 0;
  }

  const server = createServer();
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
