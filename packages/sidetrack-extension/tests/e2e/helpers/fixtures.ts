import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface FixtureServer {
  readonly origin: string;
  readonly close: () => Promise<void>;
}

const packageRoot = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const repoRoot = path.resolve(packageRoot, '../..');
const fixtureRoot = path.join(repoRoot, 'poc/provider-capture/fixtures/provider-pages');

const fixturePath = (pathname: string): string => {
  const fileName = pathname === '/' ? 'chatgpt.html' : pathname.replace(/^\//u, '');
  return path.join(fixtureRoot, fileName);
};

const closeServer = async (server: Server): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
};

export const startProviderFixtureServer = async (): Promise<FixtureServer> => {
  return await new Promise((resolve, reject) => {
    const server = createServer(async (request, response) => {
      try {
        const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
        const html = await readFile(fixturePath(requestUrl.pathname), 'utf8');
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(html);
      } catch {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('not found');
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not resolve provider fixture server address.'));
        return;
      }
      resolve({
        origin: `http://127.0.0.1:${String(address.port)}`,
        close: () => closeServer(server),
      });
    });
    server.on('error', reject);
  });
};
