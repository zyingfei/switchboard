import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { isBridgeKeyAccepted, rotateBridgeKey } from '../auth/bridgeKey.js';
import {
  isAllowed,
  readTrust,
  writeTrust,
  type WorkstreamWriteTool,
} from '../auth/workstreamTrust.js';
import { createDispatchId, createRequestId, createReviewId } from '../domain/ids.js';
import { pickInstaller, type Installer } from '../install/index.js';
import { exportSettings } from '../portability/exportBundle.js';
import { importSettings } from '../portability/importBundle.js';
import { embed, MODEL_ID } from '../recall/embedder.js';
import { appendEntry, gcEntries, readIndex } from '../recall/indexFile.js';
import { rank } from '../recall/ranker.js';
import { rebuildFromEventLog } from '../recall/rebuild.js';
import type { BucketRegistry } from '../routing/registry.js';
import { redact } from '../safety/redaction.js';
import { estimateTokens, tokenBudgetWarningThreshold } from '../safety/tokenBudget.js';
import { buildSignals, type BuildSignalsWorkstream } from '../suggestions/buildSignals.js';
import { scoreSuggestions } from '../suggestions/score.js';
import { runAutoUpdate } from '../system/autoUpdate.js';
import { collectHealth } from '../system/health.js';
import { checkLatestVersion, type UpdateAdvisory } from '../system/versionCheck.js';
import {
  listAnnotations,
  softDeleteAnnotation,
  updateAnnotation,
  writeAnnotation,
} from '../vault/annotationStore.js';
import { scanVaultForLinkedNotes } from '../vault/linkback.js';
import type { VaultChangeEvent } from '../vault/watcher.js';
import {
  CodingAttachTokenInvalidError,
  CodingSessionNotFoundError,
  SettingsRevisionConflictError,
  createVaultWriter,
  type VaultWriter,
} from '../vault/writer.js';
import type { IdempotencyStore } from './idempotency.js';
import type { ValidationIssue } from './problem.js';
import { createProblem } from './problem.js';
import {
  annotationCreateSchema,
  annotationListQuerySchema,
  annotationUpdateSchema,
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
  recallGcSchema,
  recallQuerySchema,
  reviewEventSchema,
  reviewListQuerySchema,
  settingsPatchSchema,
  suggestionQuerySchema,
  threadUpsertSchema,
  turnsQuerySchema,
  workstreamCreateSchema,
  workstreamUpdateSchema,
  autoUpdateSchema,
  bucketsPutSchema,
  workstreamTrustPutSchema,
} from './schemas.js';

export interface CompanionHttpConfig {
  readonly bridgeKey: string;
  readonly vaultWriter: VaultWriter;
  readonly vaultRoot?: string;
  readonly serviceInstaller?: Installer;
  readonly updateChecker?: () => Promise<UpdateAdvisory>;
  readonly idempotencyStore?: IdempotencyStore;
  readonly allowAutoUpdate?: boolean;
  readonly startedAt?: Date;
  readonly bucketRegistry?: BucketRegistry;
  readonly vaultChanges?: {
    readonly subscribe: (listener: (event: VaultChangeEvent) => void) => () => void;
  };
  readonly hygieneStatus?: {
    lastIdempotencyGcAt?: string;
    lastAuditRetentionAt?: string;
  };
}

export interface StartedHttpServer {
  readonly server: Server;
  readonly port: number;
  readonly url: string;
  readonly close: () => Promise<void>;
}

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

interface RouteMatch {
  readonly workstreamId?: string;
  readonly reminderId?: string;
  readonly codingSessionId?: string;
  readonly threadId?: string;
  readonly annotationId?: string;
  readonly bacId?: string;
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
  'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
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

const readVaultMarkdown = async (
  vaultRoot: string,
  kind: 'threads' | 'workstreams',
  bacId: string,
): Promise<{ readonly path: string; readonly content: string }> => {
  const path = join(vaultRoot, '_BAC', kind, `${bacId}.md`);
  const info = await stat(path);
  // Raw Markdown reads are capped at 10 MiB because coding agents have token
  // budgets and this endpoint returns the body verbatim.
  if (info.size > 10 * 1024 * 1024) {
    throw new HttpRouteError(413, 'PAYLOAD_TOO_LARGE', 'Markdown file is too large.');
  }
  return { path, content: await readFile(path, 'utf8') };
};

const writerForBucket = async (
  context: CompanionHttpConfig,
  input: { readonly workstreamId?: string; readonly provider?: string; readonly url?: string },
): Promise<VaultWriter> => {
  const bucket = await context.bucketRegistry?.pickBucket(input);
  return bucket === undefined || bucket.vaultRoot === context.vaultRoot
    ? context.vaultWriter
    : createVaultWriter(bucket.vaultRoot);
};

const requireWorkstreamTrust = async (
  context: CompanionHttpConfig,
  workstreamId: string | undefined,
  tool: WorkstreamWriteTool,
): Promise<void> => {
  if (workstreamId === undefined || context.vaultRoot === undefined) {
    return;
  }
  if (!isAllowed(workstreamId, tool, await readTrust(context.vaultRoot))) {
    throw new HttpRouteError(
      403,
      'WORKSTREAM_NOT_TRUSTED',
      'Workstream has not trusted this MCP write tool.',
      `${tool} is not allowed for workstream ${workstreamId}.`,
    );
  }
};

const mcpToolHeader = (request: IncomingMessage): WorkstreamWriteTool | undefined => {
  const value = request.headers['x-sidetrack-mcp-tool'];
  if (typeof value !== 'string') {
    return undefined;
  }
  return (
    ['bac.move_item', 'bac.queue_item', 'bac.bump_workstream', 'bac.archive_thread', 'bac.unarchive_thread'] as const
  ).find((tool) => tool === value);
};

const directorySize = async (path: string): Promise<number> => {
  const info = await stat(path);
  if (!info.isDirectory()) {
    return info.size;
  }
  const names = await readdir(path).catch(() => []);
  const sizes = await Promise.all(names.map((name) => directorySize(join(path, name)).catch(() => 0)));
  return sizes.reduce((sum, size) => sum + size, 0);
};

const recentCaptureByProvider = async (
  vaultRoot: string,
): Promise<Record<string, string | null>> => {
  const root = join(vaultRoot, '_BAC', 'events');
  const names = await readdir(root).catch(() => []);
  const last: Record<string, string | null> = {};
  for (const name of names.filter((candidate) => candidate.endsWith('.jsonl')).sort().reverse().slice(0, 14)) {
    const raw = await readFile(join(root, name), 'utf8').catch(() => '');
    for (const line of raw.split('\n')) {
      try {
        const event = JSON.parse(line) as { readonly provider?: unknown; readonly capturedAt?: unknown };
        if (typeof event.provider === 'string' && typeof event.capturedAt === 'string') {
          const existing = last[event.provider];
          if (existing === undefined || existing === null || existing < event.capturedAt) {
            last[event.provider] = event.capturedAt;
          }
        }
      } catch {
        // Ignore malformed event-log rows for health reporting.
      }
    }
  }
  return last;
};

const readThreadWorkstreamId = async (
  vaultRoot: string,
  threadId: string,
): Promise<string | undefined> => {
  try {
    const parsed = JSON.parse(
      await readFile(join(vaultRoot, '_BAC', 'threads', `${threadId}.json`), 'utf8'),
    ) as { readonly primaryWorkstreamId?: unknown };
    return typeof parsed.primaryWorkstreamId === 'string' ? parsed.primaryWorkstreamId : undefined;
  } catch {
    return undefined;
  }
};

const objectRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const parseThreadUpsertBody = async (vaultRoot: string, body: unknown) => {
  const full = threadUpsertSchema.safeParse(body);
  if (full.success) {
    return full.data;
  }
  const record = objectRecord(body);
  const bacId = record?.['bac_id'];
  if (typeof bacId !== 'string') {
    return threadUpsertSchema.parse(body);
  }
  const existing = objectRecord(
    JSON.parse(await readFile(join(vaultRoot, '_BAC', 'threads', `${bacId}.json`), 'utf8')) as unknown,
  );
  if (existing === undefined) {
    return threadUpsertSchema.parse(body);
  }
  const rawWorkstreamId = record?.['primaryWorkstreamId'];
  return threadUpsertSchema.parse({
    ...existing,
    bac_id: bacId,
    ...(rawWorkstreamId === null
      ? { primaryWorkstreamId: undefined }
      : typeof rawWorkstreamId === 'string'
        ? { primaryWorkstreamId: rawWorkstreamId }
        : {}),
    lastSeenAt:
      typeof existing['lastSeenAt'] === 'string' ? existing['lastSeenAt'] : new Date().toISOString(),
    title: typeof existing['title'] === 'string' ? existing['title'] : bacId,
  });
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
    pattern: /^\/v1\/vault\/changes$/,
    authRequired: true,
    handle: () => Promise.resolve([500, { data: { error: 'stream route was not intercepted' } }]),
  },
  {
    method: 'GET',
    pattern: /^\/v1\/system\/service-status$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => [
      200,
      { data: await (context.serviceInstaller ?? pickInstaller()).status() },
    ],
  },
  {
    method: 'GET',
    pattern: /^\/v1\/system\/update-check$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => [
      200,
      { data: await (context.updateChecker ?? (() => checkLatestVersion('0.0.0')))() },
    ],
  },
  {
    method: 'POST',
    pattern: /^\/v1\/system\/auto-update$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      if (context.allowAutoUpdate !== true) {
        throw new HttpRouteError(
          403,
          'AUTO_UPDATE_DISABLED',
          'Auto-update is disabled.',
          'Start the companion with --allow-auto-update before invoking this endpoint.',
        );
      }
      const input = autoUpdateSchema.parse(await readBody(request));
      return [
        200,
        {
          data: await runAutoUpdate({
            confirm: input.confirm,
            currentVersion: '0.0.0',
          }),
        },
      ];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/system\/health$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      const indexPath = recallIndexPath(vaultRoot);
      return [
        200,
        {
          data: await collectHealth({
            startedAt: context.startedAt ?? new Date(),
            vaultRoot,
            vaultWritable: async () => {
              try {
                await access(vaultRoot);
                return true;
              } catch {
                return false;
              }
            },
            vaultSizeBytes: () => directorySize(join(vaultRoot, '_BAC')).catch(() => null),
            captureSummary: async () => ({
              lastByProvider: await recentCaptureByProvider(vaultRoot),
              queueDepthHint: null,
              droppedHint: null,
            }),
            recallSummary: async () => {
              const [index, info] = await Promise.all([
                readIndex(indexPath),
                stat(indexPath).catch(() => undefined),
              ]);
              return {
                indexExists: index !== null,
                entryCount: index?.items.length ?? null,
                modelId: index?.modelId ?? null,
                sizeBytes: info?.size ?? null,
              };
            },
            serviceStatus: async () => {
              const status = await (context.serviceInstaller ?? pickInstaller()).status();
              return { installed: status.installed, running: status.running };
            },
          }),
        },
      ];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/system\/hygiene-status$/,
    authRequired: true,
    handle: (_request, _requestId, _match, context) =>
      Promise.resolve([200, { data: context.hygieneStatus ?? {} }]),
  },
  {
    method: 'POST',
    pattern: /^\/v1\/auth\/rotate-bridge-key$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => [
      200,
      { data: await rotateBridgeKey(requireVaultRoot(context), context.bridgeKey) },
    ],
  },
  {
    method: 'GET',
    pattern: /^\/v1\/buckets$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => [
      200,
      { items: await context.bucketRegistry?.readBuckets() ?? [] },
    ],
  },
  {
    method: 'PUT',
    pattern: /^\/v1\/buckets$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      if (context.bucketRegistry === undefined) {
        throw new Error('Bucket registry is unavailable.');
      }
      const input = bucketsPutSchema.parse(await readBody(request));
      await context.bucketRegistry.writeBuckets(input.buckets);
      return [200, { items: await context.bucketRegistry.readBuckets() }];
    },
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
    method: 'GET',
    pattern: /^\/v1\/settings\/export$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => [
      200,
      await exportSettings(requireVaultRoot(context)),
    ],
  },
  {
    method: 'POST',
    pattern: /^\/v1\/settings\/import$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => [
      200,
      { data: await importSettings(requireVaultRoot(context), await readBody(request)) },
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
        const writer = await writerForBucket(context, {
          provider: input.target.provider,
          ...(input.workstreamId === undefined ? {} : { workstreamId: input.workstreamId }),
        });
        const redaction = redact(input.body);
        const tokenEstimate = estimateTokens(redaction.output);
        const result = await writer.writeDispatchEvent(
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
        includeDeleted: url.searchParams.get('includeDeleted') ?? undefined,
        limit: url.searchParams.get('limit') ?? undefined,
      });
      const annotations = await listAnnotations(context.vaultRoot, {
        ...(query.url === undefined ? {} : { url: query.url }),
        includeDeleted: query.includeDeleted,
      });
      return [200, { data: annotations.slice(0, query.limit) }];
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/v1\/annotations\/(?<annotationId>[A-Za-z0-9_-]+)$/,
    authRequired: true,
    handle: async (request, _requestId, match, context) => {
      if (match.annotationId === undefined) {
        throw new Error('Missing annotationId path parameter.');
      }
      const input = annotationUpdateSchema.parse(await readBody(request));
      return [
        200,
        { data: await updateAnnotation(requireVaultRoot(context), match.annotationId, input) },
      ];
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/v1\/annotations\/(?<annotationId>[A-Za-z0-9_-]+)$/,
    authRequired: true,
    handle: async (_request, _requestId, match, context) => {
      if (match.annotationId === undefined) {
        throw new Error('Missing annotationId path parameter.');
      }
      return [200, { data: await softDeleteAnnotation(requireVaultRoot(context), match.annotationId) }];
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
    method: 'POST',
    pattern: /^\/v1\/recall\/gc$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const input = recallGcSchema.parse(await readBody(request));
      return [
        200,
        { data: await gcEntries(recallIndexPath(requireVaultRoot(context)), new Set(input.validIds)) },
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
        const writer = await writerForBucket(context, {
          provider: input.provider,
          url: input.threadUrl,
        });
        const result = await writer.writeCaptureEvent(input, requestId);
        return [201, mutationResponse(result, requestId)];
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/threads$/,
    authRequired: true,
    handle: async (request, requestId, _match, context) => {
      const input = await parseThreadUpsertBody(requireVaultRoot(context), await readBody(request));
      const tool = mcpToolHeader(request);
      if (tool === 'bac.move_item') {
        await requireWorkstreamTrust(context, input.primaryWorkstreamId, tool);
      }
      const result = await context.vaultWriter.upsertThread(input, requestId);
      return [200, mutationResponse(result, requestId)];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/threads\/(?<bacId>[A-Za-z0-9_-]+)\/markdown$/,
    authRequired: true,
    handle: async (_request, _requestId, match, context) => {
      if (match.bacId === undefined) {
        throw new Error('Missing bacId path parameter.');
      }
      return [200, await readVaultMarkdown(requireVaultRoot(context), 'threads', match.bacId)];
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/threads\/(?<bacId>[A-Za-z0-9_-]+)\/archive$/,
    authRequired: true,
    handle: async (_request, requestId, match, context) => {
      if (match.bacId === undefined) {
        throw new Error('Missing bacId path parameter.');
      }
      if (mcpToolHeader(_request) === 'bac.archive_thread') {
        await requireWorkstreamTrust(
          context,
          await readThreadWorkstreamId(requireVaultRoot(context), match.bacId),
          'bac.archive_thread',
        );
      }
      return [200, mutationResponse(await context.vaultWriter.archiveThread(match.bacId, requestId), requestId)];
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/threads\/(?<bacId>[A-Za-z0-9_-]+)\/unarchive$/,
    authRequired: true,
    handle: async (_request, requestId, match, context) => {
      if (match.bacId === undefined) {
        throw new Error('Missing bacId path parameter.');
      }
      if (mcpToolHeader(_request) === 'bac.unarchive_thread') {
        await requireWorkstreamTrust(
          context,
          await readThreadWorkstreamId(requireVaultRoot(context), match.bacId),
          'bac.unarchive_thread',
        );
      }
      return [200, mutationResponse(await context.vaultWriter.unarchiveThread(match.bacId, requestId), requestId)];
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
    method: 'GET',
    pattern: /^\/v1\/workstreams\/(?<bacId>[A-Za-z0-9_-]+)\/markdown$/,
    authRequired: true,
    handle: async (_request, _requestId, match, context) => {
      if (match.bacId === undefined) {
        throw new Error('Missing bacId path parameter.');
      }
      return [200, await readVaultMarkdown(requireVaultRoot(context), 'workstreams', match.bacId)];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/workstreams\/(?<workstreamId>[A-Za-z0-9_-]+)\/trust$/,
    authRequired: true,
    handle: async (_request, _requestId, match, context) => {
      if (match.workstreamId === undefined) {
        throw new Error('Missing workstreamId path parameter.');
      }
      const record = (await readTrust(requireVaultRoot(context))).find(
        (item) => item.workstreamId === match.workstreamId,
      );
      return [
        200,
        {
          data: {
            workstreamId: match.workstreamId,
            allowedTools: record === undefined ? [] : [...record.allowedTools],
          },
        },
      ];
    },
  },
  {
    method: 'PUT',
    pattern: /^\/v1\/workstreams\/(?<workstreamId>[A-Za-z0-9_-]+)\/trust$/,
    authRequired: true,
    handle: async (request, _requestId, match, context) => {
      if (match.workstreamId === undefined) {
        throw new Error('Missing workstreamId path parameter.');
      }
      const input = workstreamTrustPutSchema.parse(await readBody(request));
      const vaultRoot = requireVaultRoot(context);
      const current = await readTrust(vaultRoot);
      await writeTrust(vaultRoot, [
        ...current.filter((record) => record.workstreamId !== match.workstreamId),
        { workstreamId: match.workstreamId, allowedTools: new Set(input.allowedTools) },
      ]);
      return [
        200,
        { data: { workstreamId: match.workstreamId, allowedTools: input.allowedTools } },
      ];
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/workstreams\/(?<bacId>[A-Za-z0-9_-]+)\/bump$/,
    authRequired: true,
    handle: async (_request, requestId, match, context) => {
      if (match.bacId === undefined) {
        throw new Error('Missing bacId path parameter.');
      }
      if (mcpToolHeader(_request) === 'bac.bump_workstream') {
        await requireWorkstreamTrust(context, match.bacId, 'bac.bump_workstream');
      }
      return [200, mutationResponse(await context.vaultWriter.bumpWorkstream(match.bacId, requestId), requestId)];
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
        const tool = mcpToolHeader(request);
        if (tool === 'bac.queue_item' && input.scope === 'workstream') {
          await requireWorkstreamTrust(context, input.targetId, tool);
        }
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
    if (
      typeof actualKey !== 'string' ||
      !(await isBridgeKeyAccepted(context.vaultRoot, context.bridgeKey, actualKey))
    ) {
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

  if (method === 'GET' && url.pathname === '/v1/vault/changes') {
    response.writeHead(200, {
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
    });
    response.write(': sidetrack vault changes connected\n\n');
    const heartbeat = setInterval(() => {
      response.write(': heartbeat\n\n');
    }, 25_000);
    const unsubscribe =
      context.vaultChanges?.subscribe((event) => {
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      }) ?? (() => undefined);
    request.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      response.end();
    });
    return;
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
