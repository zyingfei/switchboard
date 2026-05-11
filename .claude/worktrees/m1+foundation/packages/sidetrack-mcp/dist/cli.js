#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { m1ReadToolNames } from './capabilities.js';
import { createSidetrackMcpServer } from './server/mcpServer.js';
import { sidetrackMcpWebSocketPort, startWebSocketMcpServer } from './server/websocketServer.js';
import { LiveVaultReader } from './vault/liveVaultReader.js';
export const mcpVersion = '0.0.0';
export const renderHelp = () => [
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
    '  sidetrack-mcp --transport websocket --vault <path> [--port 8721]',
    '                [--companion-url <url> --bridge-key <key>] [--mcp-auth-key <key>]',
    '',
    'WebSocket endpoint defaults to ws://127.0.0.1:8721/mcp. When an auth key',
    'is configured, connect with ?token=<key> or Sec-WebSocket-Protocol: bearer.<key>.',
].join('\n');
const writeLine = (stream, text) => {
    stream.write(`${text}\n`);
};
const parseArgs = (argv) => {
    let vaultPath;
    let companionUrl;
    let bridgeKey;
    let mcpAuthKey;
    let transport = 'stdio';
    let host = '127.0.0.1';
    let port = sidetrackMcpWebSocketPort;
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === '--vault') {
            vaultPath = argv[index + 1];
            index += 1;
        }
        else if (argv[index] === '--transport') {
            const rawTransport = argv[index + 1];
            if (rawTransport !== 'stdio' && rawTransport !== 'websocket') {
                throw new Error('--transport must be either stdio or websocket.');
            }
            transport = rawTransport;
            index += 1;
        }
        else if (argv[index] === '--companion-url') {
            companionUrl = argv[index + 1];
            index += 1;
        }
        else if (argv[index] === '--bridge-key') {
            bridgeKey = argv[index + 1];
            index += 1;
        }
        else if (argv[index] === '--mcp-auth-key') {
            mcpAuthKey = argv[index + 1];
            index += 1;
        }
        else if (argv[index] === '--host') {
            host = argv[index + 1] ?? '';
            index += 1;
        }
        else if (argv[index] === '--port') {
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
const createCompanionWriteClient = (companionUrl, bridgeKey) => {
    const base = companionUrl.replace(/\/$/, '');
    const post = async (path, body, extraHeaders = {}) => {
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
        return (await response.json());
    };
    const patch = async (path, body) => {
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
        return (await response.json());
    };
    const del = async (path) => {
        const response = await fetch(`${base}${path}`, {
            method: 'DELETE',
            headers: { 'x-bac-bridge-key': bridgeKey },
        });
        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`Companion ${path} failed (${String(response.status)}): ${detail}`);
        }
        return (await response.json());
    };
    const getDataArray = async (path, params = new URLSearchParams()) => {
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
        const body = (await response.json());
        if (typeof body !== 'object' ||
            body === null ||
            !('data' in body) ||
            !Array.isArray(body.data)) {
            throw new Error(`Companion ${path} did not return a data array.`);
        }
        return body.data;
    };
    const getObject = async (path) => {
        const response = await fetch(`${base}${path}`, {
            method: 'GET',
            headers: { 'x-bac-bridge-key': bridgeKey },
        });
        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`Companion ${path} failed (${String(response.status)}): ${detail}`);
        }
        const body = (await response.json());
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
            throw new Error(`Companion ${path} did not return an object.`);
        }
        return body;
    };
    const readList = (path, input) => {
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
    const idempotencyKey = (prefix, value) => `${prefix}-${value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 160)}`;
    return {
        async registerCodingSession(input) {
            const body = await post('/v1/coding-sessions', input);
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
            const body = await post('/v1/threads', upsert, { 'x-sidetrack-mcp-tool': 'bac.move_item' });
            if (typeof body.data?.bac_id !== 'string' || typeof body.data.revision !== 'string') {
                throw new Error('Companion did not return bac_id + revision for the moved thread.');
            }
            return { bac_id: body.data.bac_id, revision: body.data.revision };
        },
        async createQueueItem(input) {
            const body = await post('/v1/queue', input, {
                'x-sidetrack-mcp-tool': 'bac.queue_item',
                'idempotency-key': idempotencyKey('mcp-queue', `${input.scope}-${input.targetId ?? 'global'}-${input.text}`),
            });
            if (typeof body.data?.bac_id !== 'string' || typeof body.data.revision !== 'string') {
                throw new Error('Companion did not return bac_id + revision for the queued item.');
            }
            return { bac_id: body.data.bac_id, revision: body.data.revision };
        },
        async bumpWorkstream(input) {
            const body = await post(`/v1/workstreams/${encodeURIComponent(input.bac_id)}/bump`, {}, {
                'x-sidetrack-mcp-tool': 'bac.bump_workstream',
            });
            if (typeof body.data?.bac_id !== 'string' || typeof body.data.revision !== 'string') {
                throw new Error('Companion did not return bac_id + revision for bumped workstream.');
            }
            return { bac_id: body.data.bac_id, revision: body.data.revision };
        },
        async archiveThread(input) {
            const body = await post(`/v1/threads/${encodeURIComponent(input.bac_id)}/archive`, {}, {
                'x-sidetrack-mcp-tool': 'bac.archive_thread',
            });
            if (typeof body.data?.bac_id !== 'string' || typeof body.data.revision !== 'string') {
                throw new Error('Companion did not return bac_id + revision for archived thread.');
            }
            return { bac_id: body.data.bac_id, revision: body.data.revision };
        },
        async unarchiveThread(input) {
            const body = await post(`/v1/threads/${encodeURIComponent(input.bac_id)}/unarchive`, {}, {
                'x-sidetrack-mcp-tool': 'bac.unarchive_thread',
            });
            if (typeof body.data?.bac_id !== 'string' || typeof body.data.revision !== 'string') {
                throw new Error('Companion did not return bac_id + revision for unarchived thread.');
            }
            return { bac_id: body.data.bac_id, revision: body.data.revision };
        },
        async updateAnnotation(input) {
            const body = await patch(`/v1/annotations/${encodeURIComponent(input.bac_id)}`, { note: input.note });
            return body.data ?? {};
        },
        async deleteAnnotation(input) {
            const body = await del(`/v1/annotations/${encodeURIComponent(input.bac_id)}`);
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
        readThreadMarkdown: (input) => getObject(`/v1/threads/${encodeURIComponent(input.bac_id)}/markdown`),
        readWorkstreamMarkdown: (input) => getObject(`/v1/workstreams/${encodeURIComponent(input.bac_id)}/markdown`),
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
            return items;
        },
        systemHealth: () => getObject('/v1/system/health').then((body) => {
            const data = body['data'];
            if (typeof data !== 'object' || data === null || Array.isArray(data)) {
                throw new Error('Companion health response missing data object.');
            }
            return data;
        }),
        systemUpdateCheck: () => getObject('/v1/system/update-check').then((body) => {
            const data = body['data'];
            if (typeof data !== 'object' || data === null || Array.isArray(data)) {
                throw new Error('Companion update-check response missing data object.');
            }
            return data;
        }),
        async listWorkstreamNotes(input) {
            const response = await fetch(`${base}/v1/workstreams/${encodeURIComponent(input.workstreamId)}/linked-notes`, {
                method: 'GET',
                headers: {
                    'x-bac-bridge-key': bridgeKey,
                },
            });
            if (!response.ok) {
                const detail = await response.text().catch(() => '');
                throw new Error(`Companion linked-notes failed (${String(response.status)}): ${detail}`);
            }
            const body = (await response.json());
            if (typeof body !== 'object' ||
                body === null ||
                !('items' in body) ||
                !Array.isArray(body.items)) {
                throw new Error('Companion linked-notes response missing items array.');
            }
            return body.items;
        },
    };
};
export const runCli = async (argv, streams) => {
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
    if ((args.companionUrl === undefined) !== (args.bridgeKey === undefined) ||
        args.companionUrl?.length === 0 ||
        args.bridgeKey?.length === 0) {
        writeLine(streams.stderr, '--companion-url and --bridge-key must be supplied together.');
        return 2;
    }
    const companionClient = args.companionUrl !== undefined && args.bridgeKey !== undefined
        ? createCompanionWriteClient(args.companionUrl, args.bridgeKey)
        : undefined;
    const vaultPath = args.vaultPath;
    const createServer = () => createSidetrackMcpServer(new LiveVaultReader(vaultPath), companionClient);
    if (args.transport === 'websocket') {
        const authKey = args.mcpAuthKey ?? args.bridgeKey;
        const started = await startWebSocketMcpServer({
            host: args.host,
            port: args.port,
            ...(authKey === undefined ? {} : { authKey }),
            createServer,
        });
        writeLine(streams.stderr, `sidetrack-mcp websocket listening on ${started.url}`);
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
        .catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : 'Unknown error'}\n`);
        process.exitCode = 1;
    });
}
//# sourceMappingURL=cli.js.map