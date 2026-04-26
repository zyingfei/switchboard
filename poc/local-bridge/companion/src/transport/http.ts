import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { isAuthorized } from '../auth/keyfile';
import type { BridgeEvent, TransportServer } from '../model';
import { readErrorMessage } from '../model';
import type { BridgeRuntime } from '../runtime';

const readBody = async (request: IncomingMessage): Promise<unknown> =>
  await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('error', reject);
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw) as unknown);
      } catch (error) {
        reject(error);
      }
    });
  });

const sendJson = (response: ServerResponse, statusCode: number, value: unknown): void => {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type,x-bac-bridge-key',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  });
  response.end(`${JSON.stringify(value)}\n`);
};

const isLocalHost = (host: string | undefined): boolean =>
  Boolean(host && /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/u.test(host));

const isAllowedOrigin = (origin: string | undefined): boolean =>
  !origin || origin.startsWith('chrome-extension://') || /^http:\/\/(127\.0\.0\.1|localhost)(?::\d+)?$/u.test(origin);

const authHeader = (request: IncomingMessage): string | undefined => {
  const header = request.headers['x-bac-bridge-key'];
  return Array.isArray(header) ? header[0] : header;
};

export class HttpTransportServer implements TransportServer {
  private server: Server | undefined;
  private actualPort: number | undefined;

  constructor(
    private readonly runtime: BridgeRuntime,
    private readonly key: string,
    private readonly port: number,
  ) {}

  get url(): string {
    return `http://127.0.0.1:${this.actualPort ?? this.port}`;
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.route(request, response);
    });
    await new Promise<void>((resolve) => {
      this.server?.listen(this.port, '127.0.0.1', () => {
        const address = this.server?.address();
        this.actualPort = typeof address === 'object' && address ? address.port : this.port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    this.server = undefined;
  }

  private authorized(request: IncomingMessage): boolean {
    return isAuthorized(this.key, authHeader(request));
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method === 'OPTIONS') {
        sendJson(response, 204, {});
        return;
      }
      if (!isLocalHost(request.headers.host) || !isAllowedOrigin(request.headers.origin)) {
        sendJson(response, 403, { ok: false, error: 'Rejected non-local bridge request' });
        return;
      }
      const url = new URL(request.url ?? '/', this.url);
      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, { ok: true, transport: 'http' });
        return;
      }
      if (!this.authorized(request)) {
        sendJson(response, 401, { ok: false, error: 'Unauthorized bridge request' });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/status') {
        sendJson(response, 200, this.runtime.status());
        return;
      }
      if (request.method === 'POST' && url.pathname === '/events') {
        const body = await readBody(request);
        const event = body as BridgeEvent;
        const outcome = await this.runtime.writeEvent(event);
        sendJson(response, 200, { ok: true, outcome, status: this.runtime.status() });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/tick/start') {
        const body = await readBody(request) as { intervalMs?: unknown };
        const intervalMs = typeof body.intervalMs === 'number' ? body.intervalMs : 1_000;
        this.runtime.startTick(intervalMs);
        sendJson(response, 200, this.runtime.status());
        return;
      }
      if (request.method === 'POST' && url.pathname === '/tick/stop') {
        this.runtime.stopTick();
        sendJson(response, 200, this.runtime.status());
        return;
      }
      sendJson(response, 404, { ok: false, error: 'Unknown bridge route' });
    } catch (error) {
      sendJson(response, 500, { ok: false, error: readErrorMessage(error) });
    }
  }
}
