import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  createServer as createNodeHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

export const sidetrackMcpHttpPath = '/mcp';
export const sidetrackMcpHttpPort = 8721;
export const mcpAuthenticationRequiredCode = -32001;

export const BRIDGE_KEY_GUIDANCE =
  'The bridge key lives at ~/.sidetrack-vault/_BAC/.config/bridge.key. ' +
  'Pass it via --mcp-auth-key <key> (or set SIDETRACK_MCP_AUTH_KEY in the environment).';

export interface StreamableHttpMcpServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly path?: string;
  /** Required. The streamable-HTTP transport refuses to start without a non-empty auth key. */
  readonly authKey: string;
  readonly createServer: () => McpServer;
}

export interface StartedStreamableHttpMcpServer {
  readonly url: string;
  readonly close: () => Promise<void>;
}

interface SessionEntry {
  readonly transport: StreamableHTTPServerTransport;
  readonly server: McpServer;
}

const MAX_BODY_BYTES = 1 * 1024 * 1024;

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const raw = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body exceeds 1 MiB.'));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
  });
  if (raw.length === 0) {
    return undefined;
  }
  return JSON.parse(raw) as unknown;
};

// Optional production allow-list of Sidetrack extension ids. Same
// semantics as the companion's gate (server.ts): when SIDETRACK_
// ALLOWED_EXTENSION_IDS is set, only the listed
// chrome-extension://<id> origins pass; when unset, every
// chrome-extension:// origin is accepted (dev mode).
const allowedExtensionIds = ((): readonly string[] => {
  const raw = process.env['SIDETRACK_ALLOWED_EXTENSION_IDS'];
  if (raw === undefined || raw.trim().length === 0) {
    return [];
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
})();

const isLoopbackOrigin = (origin: string): boolean => {
  if (origin.startsWith('chrome-extension://')) {
    if (allowedExtensionIds.length === 0) {
      return true;
    }
    const id = origin.slice('chrome-extension://'.length);
    return allowedExtensionIds.includes(id);
  }
  try {
    const parsed = new URL(origin);
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  } catch {
    return false;
  }
};

// DNS-rebinding defense: only accept Host headers that resolve to a loopback
// address. Absent/empty Host is also rejected so curl-style headerless
// requests from a remote machine cannot reach the server.
const LOOPBACK_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i;

const isLoopbackHost = (hostHeader: string | undefined): boolean => {
  if (typeof hostHeader !== 'string' || hostHeader.length === 0) {
    return false;
  }
  return LOOPBACK_HOST_RE.test(hostHeader.trim());
};

// Timing-safe token comparison. If the two values differ in length, we hash
// both with SHA-256 first so the buffers are always equal length — this
// avoids early exit while still comparing the actual secrets.
const timingSafeStringEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length === bufB.length) {
    return timingSafeEqual(bufA, bufB);
  }
  const hashA = createHash('sha256').update(bufA).digest();
  const hashB = createHash('sha256').update(bufB).digest();
  return timingSafeEqual(hashA, hashB);
};

const isAuthorized = (request: IncomingMessage, authKey: string): boolean => {
  const header = request.headers.authorization;
  if (typeof header !== 'string') {
    return false;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match !== null && timingSafeStringEqual(match[1] ?? '', authKey);
};

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  if (response.headersSent) {
    return;
  }
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(body)}\n`);
};

const closeHttpServer = (server: HttpServer): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });

export const startStreamableHttpMcpServer = async (
  options: StreamableHttpMcpServerOptions,
): Promise<StartedStreamableHttpMcpServer> => {
  // No insecure-by-default escape hatch: refuse to bind without a key.
  if (options.authKey.trim().length === 0) {
    throw new Error(
      `sidetrack-mcp streamable-HTTP transport requires an auth key. ${BRIDGE_KEY_GUIDANCE}`,
    );
  }

  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? sidetrackMcpHttpPort;
  const path = options.path ?? sidetrackMcpHttpPath;
  const sessions = new Map<string, SessionEntry>();

  const httpServer = createNodeHttpServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      sendJson(response, 500, {
        jsonrpc: '2.0',
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        id: null,
      });
    });
  });

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', `http://${host}:${String(port)}`);
    if (url.pathname !== path) {
      sendJson(response, 404, { error: `MCP endpoint is available at ${path}.` });
      return;
    }

    // DNS-rebinding defense: enforce that the Host header names a loopback
    // address. This prevents a page served from the internet from using
    // fetch() to reach the locally-bound server by guessing its port.
    if (!isLoopbackHost(request.headers.host)) {
      sendJson(response, 403, {
        jsonrpc: '2.0',
        error: { code: -32002, message: 'Host not allowed. Only loopback addresses are accepted.' },
        id: null,
      });
      return;
    }

    const origin = request.headers.origin;
    if (typeof origin === 'string' && origin.length > 0 && !isLoopbackOrigin(origin)) {
      sendJson(response, 403, {
        jsonrpc: '2.0',
        error: { code: -32002, message: 'Origin not allowed.' },
        id: null,
      });
      return;
    }

    if (!isAuthorized(request, options.authKey)) {
      sendJson(response, 401, {
        jsonrpc: '2.0',
        error: {
          code: mcpAuthenticationRequiredCode,
          message: 'Authentication required. Connect with Authorization: Bearer <bridge-key>.',
        },
        id: null,
      });
      return;
    }

    const method = request.method ?? 'GET';
    if (method !== 'POST' && method !== 'GET' && method !== 'DELETE') {
      response.writeHead(405, { allow: 'GET, POST, DELETE' });
      response.end();
      return;
    }

    const sessionHeader = request.headers['mcp-session-id'];
    const sessionId = typeof sessionHeader === 'string' ? sessionHeader : undefined;
    const body = method === 'POST' ? await readJsonBody(request) : undefined;

    if (sessionId !== undefined) {
      const entry = sessions.get(sessionId);
      if (entry === undefined) {
        sendJson(response, 404, {
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Unknown MCP-Session-Id.' },
          id: null,
        });
        return;
      }
      await entry.transport.handleRequest(request, response, body);
      return;
    }

    if (method !== 'POST' || !isInitializeRequest(body)) {
      sendJson(response, 400, {
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message:
            'No MCP-Session-Id header. The first request must be a POST with an "initialize" body.',
        },
        id: null,
      });
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newId) => {
        sessions.set(newId, { transport, server });
      },
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid !== undefined) {
        sessions.delete(sid);
      }
    };

    const server = options.createServer();
    // The SDK transport types `onclose` as a required () => void on the
    // Transport interface but the impl class has `onclose?: () => void`
    // — under exactOptionalPropertyTypes this looks like a mismatch even
    // though every concrete transport ships `onclose` as optional. Cast
    // through `unknown` rather than re-declaring the SDK shape.
    await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
    await transport.handleRequest(request, response, body);
  };

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const address = httpServer.address() as AddressInfo;
  const url = `http://${address.address}:${String(address.port)}${path}`;

  return {
    url,
    close: async () => {
      for (const entry of sessions.values()) {
        await entry.transport.close().catch(() => undefined);
      }
      sessions.clear();
      await closeHttpServer(httpServer);
    },
  };
};
