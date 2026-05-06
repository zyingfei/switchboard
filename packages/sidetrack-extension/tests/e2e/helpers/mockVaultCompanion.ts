import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowserContext, Route } from '@playwright/test';

import { buildAnchorFromTerm } from '../../../../sidetrack-companion/src/annotation/anchorBuilder.js';
import { ensureBridgeKey } from '../../../../sidetrack-companion/src/auth/bridgeKey.js';
import {
  CodingAttachTokenInvalidError,
  CodingSessionNotFoundError,
  createVaultWriter,
  type VaultWriter,
} from '../../../../sidetrack-companion/src/vault/writer.js';
import {
  listAnnotations,
  writeAnnotation,
} from '../../../../sidetrack-companion/src/vault/annotationStore.js';
import {
  annotationCreateSchema,
  annotationListQuerySchema,
  captureEventSchema,
  dispatchEventSchema,
  threadUpsertSchema,
  turnsQuerySchema,
  type DispatchEventRecord,
} from '../../../../sidetrack-companion/src/http/schemas.js';

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
  const bridgeKey = (await ensureBridgeKey(vaultPath)).key;
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

      if (route.request().method() === 'GET' && url.pathname === '/v1/settings') {
        await fulfillJson(route, 200, {
          data: {
            revision: 'rev_mock_settings',
            autoSendOptIn: { chatgpt: false, claude: false, gemini: false },
            defaultPacketKind: 'research',
            defaultDispatchTarget: 'chatgpt',
            screenShareSafeMode: false,
          },
        });
        return;
      }

      if (route.request().method() === 'POST' && url.pathname === '/v1/workstreams') {
        const result = await writer.createWorkstream(readJsonBody(route) as never, requestId);
        await fulfillJson(route, 201, { data: { ...result, requestId } });
        return;
      }

      if (
        route.request().method() === 'POST' &&
        url.pathname === '/v1/coding-sessions/attach-tokens'
      ) {
        const result = await writer.createCodingAttachToken(
          readJsonBody(route) as never,
          requestId,
        );
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

      if (route.request().method() === 'POST' && url.pathname === '/v1/events') {
        const input = captureEventSchema.parse(readJsonBody(route));
        const result = await writer.writeCaptureEvent(input, requestId);
        await fulfillJson(route, 201, { data: { ...result, requestId } });
        return;
      }

      if (route.request().method() === 'POST' && url.pathname === '/v1/threads') {
        const input = threadUpsertSchema.parse(readJsonBody(route));
        const result = await writer.upsertThread(input, requestId);
        await fulfillJson(route, 200, { data: { ...result, requestId } });
        return;
      }

      if (route.request().method() === 'GET' && url.pathname === '/v1/turns') {
        const threadUrl = url.searchParams.get('threadUrl');
        if (threadUrl === null) {
          await fulfillJson(
            route,
            400,
            problem(400, 'threadUrl query parameter is required', requestId),
          );
          return;
        }
        const query = turnsQuerySchema.parse({
          threadUrl,
          limit: url.searchParams.get('limit') ?? undefined,
          role: url.searchParams.get('role') ?? undefined,
        });
        const result = await writer.readRecentTurns(query);
        await fulfillJson(route, 200, { data: result });
        return;
      }

      if (route.request().method() === 'POST' && url.pathname === '/v1/dispatches') {
        const input = dispatchEventSchema.parse(readJsonBody(route));
        const createdAt = input.createdAt ?? new Date().toISOString();
        const body = input.body;
        const record: DispatchEventRecord = {
          ...input,
          bac_id:
            input.bac_id ??
            `bac_dispatch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          createdAt,
          redactionSummary: input.redactionSummary ?? { matched: 0, categories: [] },
          tokenEstimate: input.tokenEstimate ?? Math.ceil(body.length / 4),
          status: input.status,
        };
        const result = await writer.writeDispatchEvent(record, requestId);
        await fulfillJson(route, 201, { data: result });
        return;
      }

      if (route.request().method() === 'GET' && url.pathname === '/v1/dispatches') {
        const result = await writer.readDispatchEvents({
          limit: Number(url.searchParams.get('limit') ?? '25'),
          since: url.searchParams.get('since') ?? undefined,
        });
        await fulfillJson(route, 200, { data: result });
        return;
      }

      if (route.request().method() === 'POST' && url.pathname === '/v1/annotations') {
        const input = annotationCreateSchema.parse(readJsonBody(route));
        if ('term' in input) {
          // Term-form: mirror the real route — fetch the assistant
          // turns from the mock vault, build the anchor, then
          // writeAnnotation with the materialised anchor shape.
          // Returns structured per-call status (created /
          // anchor_failed) the same way the production route does.
          const threadUrl = input.url;
          if (threadUrl === undefined) {
            await fulfillJson(route, 200, {
              data: {
                status: 'validation_failed',
                reason: 'term_not_found',
                message: 'mockVaultCompanion requires url for term-form annotations.',
                occurrenceCount: 0,
              },
            });
            return;
          }
          const turns = await writer.readRecentTurns({
            threadUrl,
            limit: 50,
            role: 'assistant',
          });
          if (turns.length === 0) {
            await fulfillJson(route, 200, {
              data: {
                status: 'anchor_failed',
                reason: 'term_not_found',
                message: `No assistant turns found for ${threadUrl}.`,
                occurrenceCount: 0,
              },
            });
            return;
          }
          const turnText = turns
            .slice()
            .sort((left, right) => left.ordinal - right.ordinal)
            .map((turn) => turn.text)
            .join('\n\n');
          const anchorResult = buildAnchorFromTerm({
            turnText,
            term: input.term,
            ...(input.selectionHint === undefined ? {} : { selectionHint: input.selectionHint }),
          });
          if (!anchorResult.ok) {
            await fulfillJson(route, 200, {
              data: {
                status: 'anchor_failed',
                reason: anchorResult.reason,
                message: anchorResult.message,
                occurrenceCount: anchorResult.occurrenceCount,
                ...(anchorResult.suggestedSelectionHints === undefined
                  ? {}
                  : { suggestedSelectionHints: [...anchorResult.suggestedSelectionHints] }),
              },
            });
            return;
          }
          const created = await writeAnnotation(vaultPath, {
            url: threadUrl,
            pageTitle: input.pageTitle ?? threadUrl,
            anchor: anchorResult.anchor,
            note: input.note,
          });
          await fulfillJson(route, 201, {
            data: {
              status: 'created',
              annotationId: created.bac_id,
              occurrenceCount: anchorResult.occurrenceCount,
              annotation: created,
            },
          });
          return;
        }
        const result = await writeAnnotation(vaultPath, input);
        await fulfillJson(route, 201, { data: result });
        return;
      }

      if (route.request().method() === 'GET' && url.pathname === '/v1/annotations') {
        const query = annotationListQuerySchema.parse({
          url: url.searchParams.get('url') ?? undefined,
          includeDeleted: url.searchParams.get('includeDeleted') ?? undefined,
          limit: url.searchParams.get('limit') ?? undefined,
        });
        const result = await listAnnotations(vaultPath, {
          ...(query.url === undefined ? {} : { url: query.url }),
          includeDeleted: query.includeDeleted,
        });
        await fulfillJson(route, 200, { data: result.slice(0, query.limit) });
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
        problem(
          404,
          `Unhandled mock route: ${route.request().method()} ${url.pathname}`,
          requestId,
        ),
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
