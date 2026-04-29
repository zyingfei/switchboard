import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowserContext, Route } from '@playwright/test';

import { ensureBridgeKey } from '../../../../sidetrack-companion/src/auth/bridgeKey.js';
import {
  CodingAttachTokenInvalidError,
  CodingSessionNotFoundError,
  createVaultWriter,
  type VaultWriter,
} from '../../../../sidetrack-companion/src/vault/writer.js';

export interface MockVaultCompanion {
  readonly bridgeKey: string;
  readonly port: number;
  readonly vaultPath: string;
  readonly writer: VaultWriter;
  readonly attach: (context: BrowserContext) => Promise<void>;
  readonly close: () => Promise<void>;
}

const readJsonBody = (route: Route): unknown => {
  const payload = route.request().postData();
  if (payload === null || payload.length === 0) {
    return {};
  }
  return JSON.parse(payload) as unknown;
};

const fulfillJson = async (route: Route, status: number, body: unknown): Promise<void> => {
  await route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: `${JSON.stringify(body)}\n`,
  });
};

const problem = (status: number, detail: string, requestId: string) => ({
  type: 'urn:problem:sidetrack:test-companion',
  title: detail,
  status,
  code: status === 401 ? 'UNAUTHORIZED' : status === 404 ? 'NOT_FOUND' : 'ERROR',
  correlationId: requestId,
  detail,
});

export const createMockVaultCompanion = async (port = 17373): Promise<MockVaultCompanion> => {
  const vaultPath = await mkdtemp(path.join(tmpdir(), 'sidetrack-extension-mock-companion-'));
  const bridgeKey = await ensureBridgeKey(vaultPath);
  const writer = createVaultWriter(vaultPath);
  let requestCounter = 0;
  const nextRequestId = (): string => `mock-companion-${String(++requestCounter)}`;

  const handle = async (route: Route): Promise<void> => {
    const url = new URL(route.request().url());
    if (url.origin !== `http://127.0.0.1:${String(port)}` || !url.pathname.startsWith('/v1/')) {
      await route.fallback();
      return;
    }

    const key = await route.request().headerValue('x-bac-bridge-key');
    const requestId = nextRequestId();
    if (key !== bridgeKey) {
      await fulfillJson(route, 401, problem(401, 'Bridge key missing or invalid.', requestId));
      return;
    }

    try {
      if (route.request().method() === 'GET' && url.pathname === '/v1/status') {
        await fulfillJson(route, 200, {
          data: { companion: 'running', vault: await writer.status(), requestId },
        });
        return;
      }

      if (route.request().method() === 'POST' && url.pathname === '/v1/workstreams') {
        const result = await writer.createWorkstream(readJsonBody(route) as never, requestId);
        await fulfillJson(route, 201, { data: { ...result, requestId } });
        return;
      }

      if (route.request().method() === 'POST' && url.pathname === '/v1/coding-sessions/attach-tokens') {
        const result = await writer.createCodingAttachToken(readJsonBody(route) as never, requestId);
        await fulfillJson(route, 201, { data: result });
        return;
      }

      if (route.request().method() === 'GET' && url.pathname === '/v1/coding-sessions') {
        const result = await writer.listCodingSessions({
          token: url.searchParams.get('token') ?? undefined,
          workstreamId: url.searchParams.get('workstreamId') ?? undefined,
        });
        await fulfillJson(route, 200, { data: result });
        return;
      }

      if (route.request().method() === 'POST' && url.pathname === '/v1/coding-sessions') {
        const result = await writer.registerCodingSession(readJsonBody(route) as never, requestId);
        await fulfillJson(route, 201, { data: result });
        return;
      }

      const deleteMatch = /^\/v1\/coding-sessions\/([A-Za-z0-9_-]+)$/u.exec(url.pathname);
      if (route.request().method() === 'DELETE' && deleteMatch !== null) {
        const result = await writer.detachCodingSession(deleteMatch[1], requestId);
        await fulfillJson(route, 200, { data: result });
        return;
      }

      await fulfillJson(
        route,
        404,
        problem(404, `Unhandled mock route: ${route.request().method()} ${url.pathname}`, requestId),
      );
    } catch (error) {
      if (error instanceof CodingAttachTokenInvalidError) {
        await fulfillJson(route, 410, problem(410, error.message, requestId));
        return;
      }
      if (error instanceof CodingSessionNotFoundError) {
        await fulfillJson(route, 404, problem(404, error.message, requestId));
        return;
      }
      throw error;
    }
  };

  return {
    bridgeKey,
    port,
    vaultPath,
    writer,
    async attach(context: BrowserContext) {
      await context.route(`http://127.0.0.1:${String(port)}/v1/**`, handle);
    },
    async close() {
      await rm(vaultPath, { recursive: true, force: true });
    },
  };
};
