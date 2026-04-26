import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { appendUnderHeading } from '../../../src/obsidian/headingPatch';
import { setFrontmatterField } from '../../../src/obsidian/frontmatter';
import type { FrontmatterValue, VaultFileSummary } from '../../../src/obsidian/model';

export interface FixtureObsidianServer {
  url: string;
  apiKey: string;
  read(path: string): string | undefined;
  list(): VaultFileSummary[];
  close(): Promise<void>;
}

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
};

const send = (
  response: ServerResponse,
  status: number,
  body: string,
  contentType = 'text/plain; charset=utf-8',
): void => {
  response.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Operation, Target-Type, Target, Create-Target-If-Missing',
    'Access-Control-Allow-Methods': 'GET, PUT, PATCH, DELETE, OPTIONS',
    'Content-Type': contentType,
  });
  response.end(body);
};

const decodeVaultPath = (pathname: string): string =>
  pathname
    .replace(/^\/vault\/?/u, '')
    .split('/')
    .filter(Boolean)
    .map((part) => decodeURIComponent(part))
    .join('/');

export const startFixtureObsidianServer = async (
  apiKey = 'test-key',
): Promise<FixtureObsidianServer> => {
  const files = new Map<string, string>();
  const server = createServer(async (request, response) => {
    if (request.method === 'OPTIONS') {
      send(response, 204, '');
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') {
      send(
        response,
        200,
        JSON.stringify({
          service: 'Obsidian Local REST API Fixture',
          version: 'fixture-0.1.0',
        }),
        'application/json',
      );
      return;
    }
    if (request.headers.authorization !== `Bearer ${apiKey}`) {
      send(response, 401, 'Unauthorized');
      return;
    }
    if (!url.pathname.startsWith('/vault/')) {
      send(response, 404, 'Not found');
      return;
    }

    const vaultPath = decodeVaultPath(url.pathname);
    if (request.method === 'GET' && vaultPath === '') {
      const summaries = Array.from(files.entries()).map(([path, content]) => ({
        path,
        type: 'file' as const,
        size: Buffer.byteLength(content, 'utf8'),
      }));
      send(response, 200, JSON.stringify({ files: summaries }), 'application/json');
      return;
    }
    if (request.method === 'GET') {
      const content = files.get(vaultPath);
      if (content === undefined) {
        send(response, 404, 'Missing file');
        return;
      }
      send(response, 200, content, vaultPath.endsWith('.json') ? 'application/json' : 'text/plain; charset=utf-8');
      return;
    }
    if (request.method === 'PUT') {
      files.set(vaultPath, await readBody(request));
      send(response, 204, '');
      return;
    }
    if (request.method === 'DELETE') {
      files.delete(vaultPath);
      send(response, 204, '');
      return;
    }
    if (request.method === 'PATCH') {
      const current = files.get(vaultPath);
      if (current === undefined) {
        send(response, 404, 'Missing file');
        return;
      }
      const targetType = String(request.headers['target-type'] ?? '');
      const target = String(request.headers.target ?? '');
      const contentType = String(request.headers['content-type'] ?? '');
      const body = await readBody(request);
      if (targetType === 'frontmatter') {
        if (contentType !== 'application/json') {
          send(
            response,
            400,
            JSON.stringify({
              errorCode: 40012,
              message: 'Unknown or invalid Content-Type specified in Content-Type header.',
            }),
            'application/json',
          );
          return;
        }
        files.set(vaultPath, setFrontmatterField(current, target, JSON.parse(body) as FrontmatterValue));
        send(response, 204, '');
        return;
      }
      if (targetType === 'heading') {
        if (contentType !== 'text/markdown') {
          send(
            response,
            400,
            JSON.stringify({
              errorCode: 40012,
              message: 'Unknown or invalid Content-Type specified in Content-Type header.',
            }),
            'application/json',
          );
          return;
        }
        files.set(vaultPath, appendUnderHeading(current, target, body));
        send(response, 204, '');
        return;
      }
      send(response, 400, 'Unsupported PATCH target');
      return;
    }
    send(response, 405, 'Unsupported method');
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not start fixture server');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    apiKey,
    read(path) {
      return files.get(path);
    },
    list() {
      return Array.from(files.entries()).map(([path, content]) => ({
        path,
        type: 'file',
        size: Buffer.byteLength(content, 'utf8'),
      }));
    },
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
};
