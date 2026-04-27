import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { bridgeKeysMatch } from '../auth/bridgeKey.js';
import { createDispatchId, createRequestId, createReviewId } from '../domain/ids.js';
import { redact } from '../safety/redaction.js';
import { estimateTokens, tokenBudgetWarningThreshold } from '../safety/tokenBudget.js';
import type { VaultWriter } from '../vault/writer.js';
import type { IdempotencyStore } from './idempotency.js';
import type { ValidationIssue } from './problem.js';
import { createProblem } from './problem.js';
import {
  captureEventSchema,
  dispatchEventSchema,
  dispatchListQuerySchema,
  queueCreateSchema,
  reminderCreateSchema,
  reminderUpdateSchema,
  reviewEventSchema,
  reviewListQuerySchema,
  threadUpsertSchema,
  workstreamCreateSchema,
  workstreamUpdateSchema,
} from './schemas.js';

export interface CompanionHttpConfig {
  readonly bridgeKey: string;
  readonly vaultWriter: VaultWriter;
  readonly idempotencyStore?: IdempotencyStore;
}

export interface StartedHttpServer {
  readonly server: Server;
  readonly port: number;
  readonly url: string;
  readonly close: () => Promise<void>;
}

type HttpMethod = 'GET' | 'POST' | 'PATCH';

interface RouteMatch {
  readonly workstreamId?: string;
  readonly reminderId?: string;
}

interface RouteDefinition {
  readonly method: HttpMethod;
  readonly pattern: RegExp;
  readonly authRequired: boolean;
  readonly handle: (
    request: IncomingMessage,
    requestId: string,
    match: RouteMatch,
    context: CompanionHttpConfig,
  ) => Promise<readonly [number, unknown]>;
}

class HttpRouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    message?: string,
  ) {
    super(message ?? title);
  }
}

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const raw = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    request.on('data', (chunk: unknown) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buffer.length;
      if (size > 1024 * 1024) {
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
    return {};
  }

  return JSON.parse(raw) as unknown;
};

const responseHeaders = {
  'access-control-allow-headers': 'content-type,x-bac-bridge-key,idempotency-key',
  'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS',
  'access-control-allow-origin': '*',
  'content-type': 'application/json; charset=utf-8',
};

const sendJson = (response: ServerResponse, status: number, value: unknown): void => {
  response.writeHead(status, responseHeaders);
  response.end(status === 204 ? '' : `${JSON.stringify(value)}\n`);
};

const mutationResponse = (
  result: { readonly bac_id: string; readonly revision: string },
  requestId: string,
) => ({
  data: {
    ...result,
    requestId,
  },
});

const isAllowedOrigin = (origin: string | undefined): boolean => {
  if (origin === undefined) {
    return true;
  }

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

const isLocalHost = (host: string | undefined): boolean =>
  Boolean(host && /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/u.test(host));

const requireIdempotencyKey = (request: IncomingMessage): string => {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 8) {
    throw new HttpRouteError(
      400,
      'VALIDATION_ERROR',
      'Validation failed.',
      'Idempotency-Key header is required.',
    );
  }
  return key;
};

const runIdempotent = async (
  context: CompanionHttpConfig,
  route: string,
  key: string,
  operation: () => Promise<readonly [number, unknown]>,
): Promise<readonly [number, unknown]> => {
  const replay = await context.idempotencyStore?.read(route, key);
  if (replay !== undefined) {
    return [replay.status, replay.body];
  }

  const [status, body] = await operation();
  await context.idempotencyStore?.write(route, key, { status, body });
  return [status, body];
};

const getValidationIssues = (error: unknown): readonly ValidationIssue[] | undefined => {
  if (typeof error !== 'object' || error === null || !('issues' in error)) {
    return undefined;
  }

  const issues = error.issues;
  if (!Array.isArray(issues)) {
    return undefined;
  }

  const parsedIssues = issues
    .map((issue): ValidationIssue | null => {
      if (
        typeof issue !== 'object' ||
        issue === null ||
        !('message' in issue) ||
        !('path' in issue)
      ) {
        return null;
      }

      const record = issue as Record<string, unknown>;
      const message = record['message'];
      const path = record['path'];
      if (typeof message !== 'string' || !Array.isArray(path)) {
        return null;
      }

      return { message, path };
    })
    .filter((issue): issue is ValidationIssue => issue !== null);

  return parsedIssues.length === issues.length ? parsedIssues : undefined;
};

const routes: readonly RouteDefinition[] = [
  {
    method: 'GET',
    pattern: /^\/v1\/health$/,
    authRequired: false,
    handle: (_request, requestId) => Promise.resolve([200, { status: 'ok', requestId }]),
  },
  {
    method: 'GET',
    pattern: /^\/v1\/status$/,
    authRequired: true,
    handle: async (_request, requestId, _match, context) => [
      200,
      { data: { companion: 'running', vault: await context.vaultWriter.status(), requestId } },
    ],
  },
  {
    method: 'POST',
    pattern: /^\/v1\/dispatches$/,
    authRequired: true,
    handle: async (request, requestId, _match, context) => {
      const idempotencyKey = requireIdempotencyKey(request);
      return await runIdempotent(context, 'recordDispatch', idempotencyKey, async () => {
        const input = dispatchEventSchema.parse(await readBody(request));
        const redaction = redact(input.body);
        const tokenEstimate = estimateTokens(redaction.output);
        const result = await context.vaultWriter.writeDispatchEvent(
          {
            ...input,
            bac_id: input.bac_id ?? createDispatchId(),
            body: redaction.output,
            createdAt: input.createdAt ?? new Date().toISOString(),
            redactionSummary: {
              matched: redaction.matched,
              categories: [...redaction.categories],
            },
            tokenEstimate,
          },
          requestId,
        );
        return [
          201,
          {
            data: result,
            ...(tokenEstimate > tokenBudgetWarningThreshold
              ? { warnings: ['token-budget-exceeded'] }
              : {}),
          },
        ];
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/dispatches$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const query = dispatchListQuerySchema.parse({
        limit: url.searchParams.get('limit') ?? undefined,
        since: url.searchParams.get('since') ?? undefined,
      });
      return [200, { data: await context.vaultWriter.readDispatchEvents(query) }];
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/reviews$/,
    authRequired: true,
    handle: async (request, requestId, _match, context) => {
      const idempotencyKey = requireIdempotencyKey(request);
      return await runIdempotent(context, 'recordReview', idempotencyKey, async () => {
        const input = reviewEventSchema.parse(await readBody(request));
        const result = await context.vaultWriter.writeReviewEvent(
          {
            ...input,
            bac_id: input.bac_id ?? createReviewId(),
            createdAt: input.createdAt ?? new Date().toISOString(),
          },
          requestId,
        );
        return [201, { data: result }];
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/reviews$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const query = reviewListQuerySchema.parse({
        limit: url.searchParams.get('limit') ?? undefined,
        since: url.searchParams.get('since') ?? undefined,
        threadId: url.searchParams.get('threadId') ?? undefined,
      });
      return [200, { data: await context.vaultWriter.readReviewEvents(query) }];
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/events$/,
    authRequired: true,
    handle: async (request, requestId, _match, context) => {
      const idempotencyKey = requireIdempotencyKey(request);
      return await runIdempotent(context, 'appendEvent', idempotencyKey, async () => {
        const input = captureEventSchema.parse(await readBody(request));
        const result = await context.vaultWriter.writeCaptureEvent(input, requestId);
        return [201, mutationResponse(result, requestId)];
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/threads$/,
    authRequired: true,
    handle: async (request, requestId, _match, context) => {
      const input = threadUpsertSchema.parse(await readBody(request));
      const result = await context.vaultWriter.upsertThread(input, requestId);
      return [200, mutationResponse(result, requestId)];
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/workstreams$/,
    authRequired: true,
    handle: async (request, requestId, _match, context) => {
      const input = workstreamCreateSchema.parse(await readBody(request));
      const result = await context.vaultWriter.createWorkstream(input, requestId);
      return [201, mutationResponse(result, requestId)];
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/v1\/workstreams\/(?<workstreamId>[A-Za-z0-9_-]+)$/,
    authRequired: true,
    handle: async (request, requestId, match, context) => {
      if (match.workstreamId === undefined) {
        throw new Error('Missing workstreamId path parameter.');
      }
      const input = workstreamUpdateSchema.parse(await readBody(request));
      const result = await context.vaultWriter.updateWorkstream(
        match.workstreamId,
        input,
        requestId,
      );
      return [200, mutationResponse(result, requestId)];
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/queue$/,
    authRequired: true,
    handle: async (request, requestId, _match, context) => {
      const idempotencyKey = requireIdempotencyKey(request);
      return await runIdempotent(context, 'createQueueItem', idempotencyKey, async () => {
        const input = queueCreateSchema.parse(await readBody(request));
        const result = await context.vaultWriter.createQueueItem(input, requestId);
        return [201, mutationResponse(result, requestId)];
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/reminders$/,
    authRequired: true,
    handle: async (request, requestId, _match, context) => {
      const input = reminderCreateSchema.parse(await readBody(request));
      const result = await context.vaultWriter.createReminder(input, requestId);
      return [201, mutationResponse(result, requestId)];
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/v1\/reminders\/(?<reminderId>[A-Za-z0-9_-]+)$/,
    authRequired: true,
    handle: async (request, requestId, match, context) => {
      if (match.reminderId === undefined) {
        throw new Error('Missing reminderId path parameter.');
      }
      const input = reminderUpdateSchema.parse(await readBody(request));
      const result = await context.vaultWriter.updateReminder(match.reminderId, input, requestId);
      return [200, mutationResponse(result, requestId)];
    },
  },
];

export const createCompanionHttpServer = (context: CompanionHttpConfig): Server =>
  createServer((request, response) => {
    void handleRequest(request, response, context);
  });

export const handleRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  context: CompanionHttpConfig,
): Promise<void> => {
  const requestId = createRequestId();
  const method = request.method;

  if (method === 'OPTIONS') {
    sendJson(response, 204, {});
    return;
  }

  const url = request.url === undefined ? undefined : new URL(request.url, 'http://127.0.0.1');
  const route = routes.find((candidate) => {
    if (candidate.method !== method || url === undefined) {
      return false;
    }
    return candidate.pattern.test(url.pathname);
  });

  if (url === undefined || route === undefined) {
    sendJson(
      response,
      404,
      createProblem({
        status: 404,
        code: 'NOT_FOUND',
        title: 'Not found',
        correlationId: requestId,
      }),
    );
    return;
  }

  if (!isLocalHost(request.headers.host) || !isAllowedOrigin(request.headers.origin)) {
    sendJson(
      response,
      403,
      createProblem({
        status: 403,
        code: 'LOOPBACK_ONLY',
        title: 'Only loopback origins are accepted.',
        correlationId: requestId,
      }),
    );
    return;
  }

  if (route.authRequired) {
    const actualKey = request.headers['x-bac-bridge-key'];
    if (typeof actualKey !== 'string' || !bridgeKeysMatch(context.bridgeKey, actualKey)) {
      sendJson(
        response,
        401,
        createProblem({
          status: 401,
          code: 'AUTHENTICATION_FAILED',
          title: 'Bridge key missing or invalid.',
          correlationId: requestId,
        }),
      );
      return;
    }
  }

  try {
    const match = route.pattern.exec(url.pathname);
    const [status, body] = await route.handle(request, requestId, match?.groups ?? {}, context);
    sendJson(response, status, body);
  } catch (error) {
    const issues = getValidationIssues(error);
    const routeError = error instanceof HttpRouteError ? error : undefined;
    const vaultUnavailable =
      error instanceof Error && error.message === 'Vault path is unavailable.';
    const status =
      routeError?.status ?? (issues === undefined ? (vaultUnavailable ? 503 : 500) : 400);
    const detail = error instanceof Error ? error.message : undefined;
    sendJson(
      response,
      status,
      createProblem({
        status,
        code:
          routeError?.code ??
          (issues === undefined
            ? vaultUnavailable
              ? 'VAULT_UNAVAILABLE'
              : 'INTERNAL_ERROR'
            : 'VALIDATION_ERROR'),
        title:
          routeError?.title ??
          (issues === undefined
            ? vaultUnavailable
              ? 'Vault path is unavailable.'
              : 'Internal companion error.'
            : 'Validation failed.'),
        correlationId: requestId,
        ...(detail === undefined ? {} : { detail }),
        ...(issues === undefined ? {} : { issues }),
      }),
    );
  }
};

export const startHttpServer = async (server: Server, port: number): Promise<StartedHttpServer> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      const actualPort = typeof address === 'object' && address !== null ? address.port : port;
      resolve({
        server,
        port: actualPort,
        url: `http://127.0.0.1:${String(actualPort)}`,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) => {
              if (error !== undefined) {
                closeReject(error);
                return;
              }
              closeResolve();
            });
          }),
      });
    });
  });
