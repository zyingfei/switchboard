import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { bridgeKeysMatch } from '../auth/bridgeKey.js';
import { createDispatchId, createRequestId, createReviewId } from '../domain/ids.js';
import { embed, MODEL_ID } from '../recall/embedder.js';
import { appendEntry, readIndex } from '../recall/indexFile.js';
import { rank } from '../recall/ranker.js';
import { rebuildFromEventLog } from '../recall/rebuild.js';
import { redact } from '../safety/redaction.js';
import { estimateTokens, tokenBudgetWarningThreshold } from '../safety/tokenBudget.js';
import { buildSignals, type BuildSignalsWorkstream } from '../suggestions/buildSignals.js';
import { scoreSuggestions } from '../suggestions/score.js';
import { listAnnotations, writeAnnotation } from '../vault/annotationStore.js';
import { scanVaultForLinkedNotes } from '../vault/linkback.js';
import {
  CodingAttachTokenInvalidError,
  CodingSessionNotFoundError,
  SettingsRevisionConflictError,
  type VaultWriter,
} from '../vault/writer.js';
import type { IdempotencyStore } from './idempotency.js';
import type { ValidationIssue } from './problem.js';
import { createProblem } from './problem.js';
import {
  annotationCreateSchema,
  annotationListQuerySchema,
  auditListQuerySchema,
  captureEventSchema,
  codingAttachTokenCreateSchema,
  codingSessionListQuerySchema,
  codingSessionRegisterSchema,
  dispatchEventSchema,
  dispatchListQuerySchema,
  queueCreateSchema,
  reminderCreateSchema,
  reminderUpdateSchema,
  recallIndexSchema,
  recallQuerySchema,
  reviewEventSchema,
  reviewListQuerySchema,
  settingsPatchSchema,
  suggestionQuerySchema,
  threadUpsertSchema,
  turnsQuerySchema,
  workstreamCreateSchema,
  workstreamUpdateSchema,
} from './schemas.js';

export interface CompanionHttpConfig {
  readonly bridgeKey: string;
  readonly vaultWriter: VaultWriter;
  readonly vaultRoot?: string;
  readonly idempotencyStore?: IdempotencyStore;
}

export interface StartedHttpServer {
  readonly server: Server;
  readonly port: number;
  readonly url: string;
  readonly close: () => Promise<void>;
}

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface RouteMatch {
  readonly workstreamId?: string;
  readonly reminderId?: string;
  readonly codingSessionId?: string;
  readonly threadId?: string;
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

const requireVaultRoot = (context: CompanionHttpConfig): string => {
  if (context.vaultRoot === undefined) {
    throw new Error('Vault root is unavailable.');
  }
  return context.vaultRoot;
};

const recallIndexPath = (vaultRoot: string): string => join(vaultRoot, '_BAC', 'recall', 'index.bin');

const readWorkstreamThreadIds = async (
  vaultRoot: string,
  workstreamId: string,
): Promise<ReadonlySet<string>> => {
  const root = join(vaultRoot, '_BAC', 'threads');
  const names = await readdir(root).catch(() => []);
  const ids = new Set<string>();
  for (const name of names.filter((candidate) => candidate.endsWith('.json'))) {
    try {
      const parsed = JSON.parse(await readFile(join(root, name), 'utf8')) as {
        readonly bac_id?: unknown;
        readonly primaryWorkstreamId?: unknown;
      };
      if (parsed.primaryWorkstreamId === workstreamId && typeof parsed.bac_id === 'string') {
        ids.add(parsed.bac_id);
      }
    } catch {
      // Ignore malformed thread records; recall filtering is best-effort.
    }
  }
  return ids;
};

const readWorkstreams = async (vaultRoot: string): Promise<readonly BuildSignalsWorkstream[]> => {
  const root = join(vaultRoot, '_BAC', 'workstreams');
  const names = await readdir(root).catch(() => []);
  const workstreams: BuildSignalsWorkstream[] = [];
  for (const name of names.filter((candidate) => candidate.endsWith('.json'))) {
    try {
      const parsed = JSON.parse(await readFile(join(root, name), 'utf8')) as {
        readonly bac_id?: unknown;
        readonly title?: unknown;
        readonly description?: unknown;
      };
      if (typeof parsed.bac_id === 'string' && typeof parsed.title === 'string') {
        workstreams.push({
          id: parsed.bac_id,
          title: parsed.title,
          ...(typeof parsed.description === 'string' ? { description: parsed.description } : {}),
        });
      }
    } catch {
      // Ignore malformed workstream records.
    }
  }
  return workstreams;
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
    method: 'GET',
    pattern: /^\/v1\/settings$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => [
      200,
      { data: await context.vaultWriter.readSettings() },
    ],
  },
  {
    method: 'PATCH',
    pattern: /^\/v1\/settings$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const input = settingsPatchSchema.parse(await readBody(request));
      return [200, { data: await context.vaultWriter.updateSettings(input, input.revision) }];
    },
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
    method: 'GET',
    pattern: /^\/v1\/audit$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const query = auditListQuerySchema.parse({
        limit: url.searchParams.get('limit') ?? undefined,
        since: url.searchParams.get('since') ?? undefined,
      });
      return [200, { data: await context.vaultWriter.readAuditEvents(query) }];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/turns$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const threadUrl = url.searchParams.get('threadUrl');
      if (threadUrl === null) {
        return [
          400,
          createProblem({
            title: 'threadUrl query parameter is required',
            status: 400,
            code: 'MISSING_PARAMETER',
            correlationId: createRequestId(),
            detail: 'GET /v1/turns requires a threadUrl query parameter.',
          }),
        ];
      }
      const query = turnsQuerySchema.parse({
        threadUrl,
        limit: url.searchParams.get('limit') ?? undefined,
        role: url.searchParams.get('role') ?? undefined,
      });
      return [200, { data: await context.vaultWriter.readRecentTurns(query) }];
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
    pattern: /^\/v1\/annotations$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      if (context.vaultRoot === undefined) {
        throw new Error('Vault root is unavailable.');
      }
      const vaultRoot = context.vaultRoot;
      const idempotencyKey = requireIdempotencyKey(request);
      return await runIdempotent(context, 'createAnnotation', idempotencyKey, async () => {
        const input = annotationCreateSchema.parse(await readBody(request));
        return [201, { data: await writeAnnotation(vaultRoot, input) }];
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/annotations$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      if (context.vaultRoot === undefined) {
        throw new Error('Vault root is unavailable.');
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const query = annotationListQuerySchema.parse({
        url: url.searchParams.get('url') ?? undefined,
        limit: url.searchParams.get('limit') ?? undefined,
      });
      const annotations = await listAnnotations(context.vaultRoot, {
        ...(query.url === undefined ? {} : { url: query.url }),
      });
      return [200, { data: annotations.slice(0, query.limit) }];
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/recall\/index$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      const input = recallIndexSchema.parse(await readBody(request));
      const vectors = await embed(input.items.map((item) => item.text));
      for (let index = 0; index < input.items.length; index += 1) {
        const item = input.items[index];
        const embedding = vectors[index];
        if (item !== undefined && embedding !== undefined) {
          await appendEntry(
            recallIndexPath(vaultRoot),
            {
              id: item.id,
              threadId: item.threadId,
              capturedAt: item.capturedAt,
              embedding,
            },
            MODEL_ID,
          );
        }
      }
      return [202, { data: { indexed: input.items.length } }];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/recall\/query$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const rawQ = url.searchParams.get('q');
      if (rawQ === null) {
        return [
          400,
          createProblem({
            title: 'q query parameter is required',
            status: 400,
            code: 'MISSING_PARAMETER',
            correlationId: createRequestId(),
            detail: 'GET /v1/recall/query requires a q query parameter.',
          }),
        ];
      }
      const query = recallQuerySchema.parse({
        q: rawQ,
        limit: url.searchParams.get('limit') ?? undefined,
        workstreamId: url.searchParams.get('workstreamId') ?? undefined,
      });
      const index = await readIndex(recallIndexPath(vaultRoot));
      if (index === null) {
        return [200, { data: [] }];
      }
      const [queryEmbedding] = await embed([query.q]);
      const threadIds =
        query.workstreamId === undefined
          ? undefined
          : await readWorkstreamThreadIds(vaultRoot, query.workstreamId);
      return [
        200,
        {
          data: rank(queryEmbedding ?? new Float32Array(384), index.items, new Date(), {
            limit: query.limit,
            ...(threadIds === undefined
              ? {}
              : { workstreamMembership: (threadId: string) => threadIds.has(threadId) }),
          }),
        },
      ];
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/recall\/rebuild$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      return [
        202,
        { data: await rebuildFromEventLog(vaultRoot, join(vaultRoot, '_BAC', 'events')) },
      ];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/suggestions\/thread\/(?<threadId>[A-Za-z0-9_-]+)$/,
    authRequired: true,
    handle: async (request, _requestId, match, context) => {
      const vaultRoot = requireVaultRoot(context);
      if (match.threadId === undefined) {
        throw new Error('Missing threadId path parameter.');
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const query = suggestionQuerySchema.parse({
        limit: url.searchParams.get('limit') ?? undefined,
      });
      const workstreams = await readWorkstreams(vaultRoot);
      const signals = await buildSignals(vaultRoot, match.threadId, workstreams);
      const threshold = Number.parseFloat(process.env['SIDETRACK_SUGGEST_THRESHOLD'] ?? '0.55');
      const suggestions = scoreSuggestions(
        {
          thread: { id: match.threadId },
          workstreams,
          signals,
        },
        { threshold: Number.isFinite(threshold) ? threshold : 0.55 },
      ).slice(0, query.limit);
      return [200, { data: suggestions }];
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
    method: 'GET',
    pattern: /^\/v1\/workstreams\/(?<workstreamId>[A-Za-z0-9_-]+)\/linked-notes$/,
    authRequired: true,
    handle: async (_request, _requestId, match, context) => {
      if (match.workstreamId === undefined) {
        throw new Error('Missing workstreamId path parameter.');
      }
      if (context.vaultRoot === undefined) {
        throw new Error('Vault root is unavailable.');
      }
      const notes = await scanVaultForLinkedNotes(context.vaultRoot);
      return [
        200,
        { items: notes.filter((note) => note.workstreamId === match.workstreamId) },
      ];
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
  {
    method: 'POST',
    pattern: /^\/v1\/coding-sessions\/attach-tokens$/,
    authRequired: true,
    handle: async (request, requestId, _match, context) => {
      const input = codingAttachTokenCreateSchema.parse(await readBody(request));
      const result = await context.vaultWriter.createCodingAttachToken(input, requestId);
      return [201, { data: result }];
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/coding-sessions$/,
    authRequired: true,
    handle: async (request, requestId, _match, context) => {
      const input = codingSessionRegisterSchema.parse(await readBody(request));
      const result = await context.vaultWriter.registerCodingSession(input, requestId);
      return [201, { data: result }];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/coding-sessions$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const query = codingSessionListQuerySchema.parse({
        token: url.searchParams.get('token') ?? undefined,
        workstreamId: url.searchParams.get('workstreamId') ?? undefined,
      });
      return [200, { data: await context.vaultWriter.listCodingSessions(query) }];
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/v1\/coding-sessions\/(?<codingSessionId>[A-Za-z0-9_-]+)$/,
    authRequired: true,
    handle: async (_request, requestId, match, context) => {
      if (match.codingSessionId === undefined) {
        throw new Error('Missing codingSessionId path parameter.');
      }
      const result = await context.vaultWriter.detachCodingSession(
        match.codingSessionId,
        requestId,
      );
      return [200, { data: result }];
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
    const settingsRevisionConflict = error instanceof SettingsRevisionConflictError;
    const codingTokenInvalid = error instanceof CodingAttachTokenInvalidError;
    const codingSessionNotFound = error instanceof CodingSessionNotFoundError;
    const vaultUnavailable =
      error instanceof Error && error.message === 'Vault path is unavailable.';
    const status =
      routeError?.status ??
      (settingsRevisionConflict
        ? 409
        : codingTokenInvalid
          ? 410
          : codingSessionNotFound
            ? 404
            : issues === undefined
              ? vaultUnavailable
                ? 503
                : 500
              : 400);
    const detail = error instanceof Error ? error.message : undefined;
    sendJson(
      response,
      status,
      createProblem({
        status,
        code:
          routeError?.code ??
          (settingsRevisionConflict
            ? 'REVISION_CONFLICT'
            : codingTokenInvalid
              ? 'ATTACH_TOKEN_INVALID'
              : codingSessionNotFound
                ? 'CODING_SESSION_NOT_FOUND'
                : issues === undefined
                  ? vaultUnavailable
                    ? 'VAULT_UNAVAILABLE'
                    : 'INTERNAL_ERROR'
                  : 'VALIDATION_ERROR'),
        title:
          routeError?.title ??
          (issues === undefined
            ? settingsRevisionConflict
              ? 'Settings revision conflict.'
              : codingTokenInvalid
                ? 'Attach token invalid or expired.'
                : codingSessionNotFound
                  ? 'Coding session not found.'
                  : vaultUnavailable
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
