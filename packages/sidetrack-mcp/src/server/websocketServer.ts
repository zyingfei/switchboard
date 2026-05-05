import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessageSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

export const sidetrackMcpWebSocketPath = '/mcp';
export const sidetrackMcpWebSocketPort = 8721;
export const mcpAuthenticationRequiredCode = -32001;

export interface WebSocketMcpServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly path?: string;
  readonly authKey?: string;
  readonly createServer: () => McpServer;
}

export interface StartedWebSocketMcpServer {
  readonly url: string;
  readonly close: () => Promise<void>;
}

const rawDataToText = (data: RawData): string => {
  if (typeof data === 'string') {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  return Buffer.from(data).toString('utf8');
};

const requestProtocols = (request: IncomingMessage): readonly string[] => {
  const raw = request.headers['sec-websocket-protocol'];
  if (typeof raw !== 'string') {
    return [];
  }
  return raw
    .split(',')
    .map((protocol) => protocol.trim())
    .filter((protocol) => protocol.length > 0);
};

const requestToken = (request: IncomingMessage): string | undefined => {
  const url = new URL(request.url ?? '/', 'ws://127.0.0.1');
  return url.searchParams.get('token') ?? undefined;
};

const isAuthorized = (request: IncomingMessage, authKey: string | undefined): boolean => {
  if (authKey === undefined || authKey.length === 0) {
    return true;
  }
  if (requestToken(request) === authKey) {
    return true;
  }
  return requestProtocols(request).some((protocol) => protocol === `bearer.${authKey}`);
};

const sendAuthenticationError = (socket: WebSocket): void => {
  socket.send(
    JSON.stringify({
      jsonrpc: '2.0',
      error: {
        code: mcpAuthenticationRequiredCode,
        message:
          'Authentication required. Copy the Sidetrack bridge key from the Settings panel and connect with ?token=<bridge-key> or Sec-WebSocket-Protocol: bearer.<bridge-key>.',
      },
    }),
  );
};

class WebSocketServerTransport implements Transport {
  readonly sessionId = randomUUID();
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(private readonly socket: WebSocket) {}

  start(): Promise<void> {
    this.socket.on('message', (data) => {
      try {
        const parsed = JSONRPCMessageSchema.parse(JSON.parse(rawDataToText(data)));
        this.onmessage?.(parsed);
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.socket.on('error', (error) => {
      this.onerror?.(error);
    });
    this.socket.on('close', () => {
      this.onclose?.();
    });
    return Promise.resolve();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    void options;
    await new Promise<void>((resolve, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket transport is not open.'));
        return;
      }
      this.socket.send(JSON.stringify(message), (error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
  }

  close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) {
      return Promise.resolve();
    }
    this.socket.close();
    return Promise.resolve();
  }
}

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

export const startWebSocketMcpServer = async (
  options: WebSocketMcpServerOptions,
): Promise<StartedWebSocketMcpServer> => {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? sidetrackMcpWebSocketPort;
  const path = options.path ?? sidetrackMcpWebSocketPath;
  const activeServers = new Set<McpServer>();

  const httpServer = createServer((_request, response) => {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(`${JSON.stringify({ error: 'MCP WebSocket endpoint is available at /mcp.' })}\n`);
  });
  const webSocketServer = new WebSocketServer({
    noServer: true,
    handleProtocols(protocols) {
      if (protocols.has('mcp')) {
        return 'mcp';
      }
      for (const protocol of protocols) {
        if (protocol.startsWith('bearer.')) {
          return protocol;
        }
      }
      return false;
    },
  });

  httpServer.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? '/', `ws://${host}:${String(port)}`);
    if (url.pathname !== path) {
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit('connection', webSocket, request);
    });
  });

  webSocketServer.on('connection', (socket, request) => {
    if (!isAuthorized(request, options.authKey)) {
      sendAuthenticationError(socket);
      socket.close(1008, 'authentication required');
      return;
    }

    const transport = new WebSocketServerTransport(socket);
    const mcpServer = options.createServer();
    activeServers.add(mcpServer);
    const remove = (): void => {
      activeServers.delete(mcpServer);
    };
    socket.on('close', remove);
    void mcpServer.connect(transport).catch((error: unknown) => {
      transport.onerror?.(error instanceof Error ? error : new Error(String(error)));
      socket.close(1011, 'MCP server error');
      remove();
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const address = httpServer.address() as AddressInfo;
  const url = `ws://${address.address}:${String(address.port)}${path}`;

  return {
    url,
    close: async () => {
      await Promise.all([...activeServers].map((server) => server.close()));
      await new Promise<void>((resolve) => {
        webSocketServer.close(() => {
          resolve();
        });
      });
      await closeHttpServer(httpServer);
    },
  };
};
