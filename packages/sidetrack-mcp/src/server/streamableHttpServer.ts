import { randomUUID } from 'node:crypto';
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

export interface StreamableHttpMcpServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly path?: string;
  readonly authKey?: string;
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

const isLoopbackOrigin = (origin: string): boolean => {
  if (origin.startsWith('chrome-extension://')) {
    return true;
  }
  try {
    const parsed = new URL(origin);
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  } catch {
    return false;
  }
};

const isAuthorized = (request: IncomingMessage, authKey: string | undefined): boolean => {
  if (authKey === undefined || authKey.length === 0) {
    return true;
  }
  const header = request.headers.authorization;
  if (typeof header !== 'string') {
    return false;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match !== null && match[1] === authKey;
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
          message:
            'Authentication required. Connect with Authorization: Bearer <bridge-key>.',
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
