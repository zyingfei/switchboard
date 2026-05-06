import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { buildAnchorFromTerm } from '../annotation/anchorBuilder.js';
import { isBridgeKeyAccepted, rotateBridgeKey } from '../auth/bridgeKey.js';
import {
  defaultAllowedTools,
  isAllowed,
  readTrust,
  writeTrust,
  type WorkstreamWriteTool,
} from '../auth/workstreamTrust.js';
import { createDispatchId, createRequestId, createReviewId } from '../domain/ids.js';
import { pickInstaller, type Installer, type InstallOptions } from '../install/index.js';
import { exportSettings } from '../portability/exportBundle.js';
import { importSettings } from '../portability/importBundle.js';
import type { RecallActivityTracker } from '../recall/activity.js';
import { embed, MODEL_ID } from '../recall/embedder.js';
import { CAPTURE_RECORDED } from '../recall/events.js';
import { THREAD_ARCHIVED, THREAD_UNARCHIVED, THREAD_UPSERTED } from '../threads/events.js';
import { projectThread } from '../threads/projection.js';
import { WORKSTREAM_UPSERTED } from '../workstreams/events.js';
import { projectWorkstream } from '../workstreams/projection.js';
import { QUEUE_CREATED } from '../queue/events.js';
import { projectQueueItem } from '../queue/projection.js';
import { DISPATCH_LINKED, DISPATCH_RECORDED } from '../dispatches/events.js';
import { projectDispatches } from '../dispatches/projection.js';
import {
  ANNOTATION_CREATED,
  ANNOTATION_DELETED,
  ANNOTATION_NOTE_SET,
} from '../annotations/events.js';
import { projectAnnotations } from '../annotations/projection.js';
import {
  appendEntry as appendEntryRaw,
  gcEntries as gcEntriesRaw,
  readIndex,
  tombstoneByThread as tombstoneByThreadRaw,
} from '../recall/indexFile.js';
import type { RecallLifecycle } from '../recall/lifecycle.js';
import { rank } from '../recall/ranker.js';
import { rebuildFromEventLog } from '../recall/rebuild.js';
import type { BucketRegistry } from '../routing/registry.js';
import { redact } from '../safety/redaction.js';
import { estimateTokens, tokenBudgetWarningThreshold } from '../safety/tokenBudget.js';
import { buildSignals, type BuildSignalsWorkstream } from '../suggestions/buildSignals.js';
import { scoreSuggestions } from '../suggestions/score.js';
import type { EventLog } from '../sync/eventLog.js';
import type { ProjectionChangeFeed } from '../sync/projectionChanges.js';
import type { TargetRef } from '../sync/causal.js';
import type { ReplicaContext } from '../sync/replicaId.js';

// Strip undefined keys produced by zod's `optional()` so the caller's
// `exactOptionalPropertyTypes` interfaces accept the value without
// complaining about `T | undefined` mismatches.
const compactTargetRef = (raw: Record<string, unknown> | undefined): TargetRef | undefined => {
  if (raw === undefined) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
};

// Spread-helper for the optional sync summary in /v1/system/health.
// Captures the replica context once so the inner closure doesn't
// need a non-null assertion.
const syncSummaryDeps = (
  replica: ReplicaContext | undefined,
  sync: CompanionHttpConfig['sync'],
): {
  syncSummary?: () => {
    replicaId: string;
    seq: number;
    relay?: { mode: 'local' | 'remote'; url: string };
  };
} =>
  replica === undefined
    ? {}
    : {
        syncSummary: () => ({
          replicaId: replica.replicaId,
          seq: replica.peekSeq(),
          ...(sync?.relay === undefined ? {} : { relay: sync.relay }),
        }),
      };
import { isReviewDraftEvent, projectReviewDraft } from '../review/projection.js';
import {
  deleteReviewDraft,
  listReviewDrafts,
  readReviewDraft,
  writeReviewDraft,
} from '../vault/reviewDrafts.js';
import { runAutoUpdate } from '../system/autoUpdate.js';
import { collectHealth, type CaptureWarningHealth, type HealthReport } from '../system/health.js';
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
  WorkstreamHasChildrenError,
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
  dispatchLinkRequestSchema,
  dispatchListQuerySchema,
  queueCreateSchema,
  reminderCreateSchema,
  reminderUpdateSchema,
  recallIndexSchema,
  recallGcSchema,
  recallQuerySchema,
  reviewDraftEventBatchSchema,
  reviewDraftListQuerySchema,
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
  readonly serviceInstallDefaults?: Omit<InstallOptions, 'vaultPath'>;
  readonly sync?: {
    readonly relay?: {
      readonly mode: 'local' | 'remote';
      readonly url: string;
    };
  };
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
  // Owns the recall index lifecycle (auto-rebuild on stale, status
  // surface for /v1/system/health). Optional so tests + legacy
  // call-sites that don't care about recall keep working — when
  // omitted, /v1/recall/rebuild falls back to direct rebuilder
  // calls and health reports `status: 'ready' | 'missing'` with no
  // background-rebuild affordance.
  readonly recallLifecycle?: RecallLifecycle;
  readonly recallActivity?: RecallActivityTracker;
  // Local replica identity + Lamport allocator used to stamp every
  // server-accepted event with `(replicaId, lamport)`. Optional so
  // legacy tests that build the HTTP server in isolation continue to
  // work; production startup always wires it in `runtime/companion.ts`.
  readonly replica?: ReplicaContext;
  // Per-replica event log used by the review-draft (and future)
  // CRDT projection routes. When unset those routes return 503.
  readonly eventLog?: EventLog;
  // Local monotonic projection-change feed. Browsers resume polling
  // with a numeric `sinceSeq` cursor; the counter never moves
  // backward and is independent of any host's wall clock.
  readonly projectionChanges?: ProjectionChangeFeed;
  // Set when the companion is also managing a sidetrack-mcp child.
  // Exposed via /v1/status so the side panel can build attach prompts
  // whose ?token=… matches whatever the running MCP server actually
  // accepts — without the user copying keys between two terminals.
  readonly mcp?: { readonly port: number; readonly authKey: string };
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

// Optional allow-list of specific Sidetrack extension ids. When the
// env var is set (production deploy), only the listed
// chrome-extension://<id> origins pass; when unset, every
// chrome-extension:// origin is accepted (dev mode — the unpacked
// extension's auto-generated id changes on each load). Comma-
// separated values, case-sensitive, no scheme prefix:
//   SIDETRACK_ALLOWED_EXTENSION_IDS=abcdef…,123456…
const allowedExtensionIds = ((): readonly string[] => {
  const raw = process.env['SIDETRACK_ALLOWED_EXTENSION_IDS'];
  if (raw === undefined || raw.trim().length === 0) {
    return [];
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
})();

const isAllowedOrigin = (origin: string | undefined): boolean => {
  if (origin === undefined) {
    return true;
  }

  if (origin.startsWith('chrome-extension://')) {
    if (allowedExtensionIds.length === 0) {
      return true;
    }
    const id = origin.slice('chrome-extension://'.length);
    return allowedExtensionIds.includes(id);
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
  // Optional validator for the cached response body. When the
  // underlying record the cache refers to no longer exists in the
  // vault (e.g. the operator purged a dispatch JSONL line), the
  // 24h-TTL'd idempotency entry would otherwise serve a dead
  // reference forever — the agent's retry would receive a record-id
  // that no other read endpoint can find. validateReplay returns
  // false in that case so we fall through to the fresh-create path
  // and overwrite the cache with a new, valid response.
  validateReplay?: (cached: unknown) => Promise<boolean>,
): Promise<readonly [number, unknown]> => {
  const replay = await context.idempotencyStore?.read(route, key);
  if (replay !== undefined) {
    if (validateReplay === undefined || (await validateReplay(replay.body))) {
      return [replay.status, replay.body];
    }
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

const buildServiceInstallOptions = (context: CompanionHttpConfig): InstallOptions => {
  const defaults = context.serviceInstallDefaults;
  return {
    vaultPath: requireVaultRoot(context),
    port: defaults?.port ?? 17373,
    ...(defaults?.companionCommand === undefined
      ? {}
      : { companionCommand: defaults.companionCommand }),
    ...(defaults?.companionBin === undefined ? {} : { companionBin: defaults.companionBin }),
    ...(defaults?.mcpPort === undefined ? {} : { mcpPort: defaults.mcpPort }),
    ...(defaults?.mcpBin === undefined ? {} : { mcpBin: defaults.mcpBin }),
    ...(defaults?.syncRelayLocalPort === undefined
      ? {}
      : { syncRelayLocalPort: defaults.syncRelayLocalPort }),
    ...(defaults?.syncRelay === undefined ? {} : { syncRelay: defaults.syncRelay }),
  };
};

const recallIndexPath = (vaultRoot: string): string =>
  join(vaultRoot, '_BAC', 'recall', 'index.bin');

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
    [
      'sidetrack.threads.move',
      'sidetrack.queue.create',
      'sidetrack.workstreams.bump',
      'sidetrack.threads.archive',
      'sidetrack.threads.unarchive',
    ] as const
  ).find((tool) => tool === value);
};

const directorySize = async (path: string): Promise<number> => {
  const info = await stat(path);
  if (!info.isDirectory()) {
    return info.size;
  }
  const names = await readdir(path).catch(() => []);
  const sizes = await Promise.all(
    names.map((name) => directorySize(join(path, name)).catch(() => 0)),
  );
  return sizes.reduce((sum, size) => sum + size, 0);
};

const isSelectorCanary = (value: unknown): value is 'ok' | 'warning' | 'failed' =>
  value === 'ok' || value === 'warning' || value === 'failed';

const firstCaptureWarningMessage = (value: unknown): string | undefined => {
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const message = (item as { readonly message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return undefined;
};

const captureHealthSummary = async (vaultRoot: string): Promise<HealthReport['capture']> => {
  const root = join(vaultRoot, '_BAC', 'events');
  const names = await readdir(root).catch(() => []);
  const last: Record<string, string | null> = {};
  const providerRows = new Map<
    string,
    {
      provider: string;
      lastCaptureAt: string | null;
      lastStatus: 'ok' | 'warning' | 'failed' | null;
      ok24h: number;
      warn24h: number;
      fail24h: number;
      warning?: string;
    }
  >();
  const recentWarnings: CaptureWarningHealth[] = [];
  const since24h = Date.now() - 24 * 60 * 60 * 1000;
  for (const name of names
    .filter((candidate) => candidate.endsWith('.jsonl'))
    .sort()
    .reverse()
    .slice(0, 14)) {
    const raw = await readFile(join(root, name), 'utf8').catch(() => '');
    for (const line of raw.split('\n')) {
      try {
        const event = JSON.parse(line) as {
          readonly provider?: unknown;
          readonly capturedAt?: unknown;
          readonly selectorCanary?: unknown;
          readonly warnings?: unknown;
        };
        if (typeof event.provider === 'string' && typeof event.capturedAt === 'string') {
          const existing = last[event.provider];
          if (existing === undefined || existing === null || existing < event.capturedAt) {
            last[event.provider] = event.capturedAt;
          }
          const current = providerRows.get(event.provider) ?? {
            provider: event.provider,
            lastCaptureAt: null,
            lastStatus: null,
            ok24h: 0,
            warn24h: 0,
            fail24h: 0,
          };
          const selectorCanary = isSelectorCanary(event.selectorCanary)
            ? event.selectorCanary
            : null;
          const capturedMillis = Date.parse(event.capturedAt);
          if (
            !Number.isNaN(capturedMillis) &&
            capturedMillis >= since24h &&
            selectorCanary !== null
          ) {
            if (selectorCanary === 'ok') current.ok24h += 1;
            if (selectorCanary === 'warning') current.warn24h += 1;
            if (selectorCanary === 'failed') current.fail24h += 1;
          }
          if (current.lastCaptureAt === null || current.lastCaptureAt < event.capturedAt) {
            current.lastCaptureAt = event.capturedAt;
            current.lastStatus = selectorCanary;
            const warning = firstCaptureWarningMessage(event.warnings);
            if (warning !== undefined) {
              current.warning = warning;
            } else if (selectorCanary === 'warning') {
              current.warning = 'Selector canary warning.';
            } else if (selectorCanary === 'failed') {
              current.warning = 'Selector canary failed.';
            } else {
              delete current.warning;
            }
          }
          if (selectorCanary === 'warning' || selectorCanary === 'failed') {
            recentWarnings.push({
              provider: event.provider,
              capturedAt: event.capturedAt,
              code: `selector_${selectorCanary}`,
              message:
                selectorCanary === 'failed'
                  ? 'Selector canary failed.'
                  : 'Selector canary warning.',
              severity: 'warning',
            });
          }
          if (Array.isArray(event.warnings)) {
            for (const item of event.warnings) {
              if (typeof item !== 'object' || item === null) continue;
              const warning = item as {
                readonly code?: unknown;
                readonly message?: unknown;
                readonly severity?: unknown;
              };
              if (
                typeof warning.code === 'string' &&
                typeof warning.message === 'string' &&
                (warning.severity === 'info' || warning.severity === 'warning')
              ) {
                recentWarnings.push({
                  provider: event.provider,
                  capturedAt: event.capturedAt,
                  code: warning.code,
                  message: warning.message,
                  severity: warning.severity,
                });
              }
            }
          }
          providerRows.set(event.provider, current);
        }
      } catch {
        // Ignore malformed event-log rows for health reporting.
      }
    }
  }
  return {
    lastByProvider: last,
    queueDepthHint: null,
    droppedHint: null,
    providers: [...providerRows.values()].sort((left, right) =>
      (right.lastCaptureAt ?? '').localeCompare(left.lastCaptureAt ?? ''),
    ),
    recentWarnings: recentWarnings
      .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))
      .slice(0, 10),
  };
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

interface ThreadMetadata {
  readonly bac_id: string;
  readonly title?: string;
  readonly threadUrl?: string;
  readonly provider?: string;
}

// Cheap thread-record fetch for await-capture enrichment. Returns
// just the fields the MCP outputSchema needs; full reads go through
// the live vault reader.
const readThreadMetadata = async (
  vaultRoot: string,
  threadId: string,
): Promise<ThreadMetadata | null> => {
  try {
    const raw = await readFile(join(vaultRoot, '_BAC', 'threads', `${threadId}.json`), 'utf8');
    const parsed = JSON.parse(raw) as {
      readonly bac_id?: unknown;
      readonly title?: unknown;
      readonly threadUrl?: unknown;
      readonly provider?: unknown;
    };
    if (typeof parsed.bac_id !== 'string') {
      return null;
    }
    return {
      bac_id: parsed.bac_id,
      ...(typeof parsed.title === 'string' ? { title: parsed.title } : {}),
      ...(typeof parsed.threadUrl === 'string' ? { threadUrl: parsed.threadUrl } : {}),
      ...(typeof parsed.provider === 'string' ? { provider: parsed.provider } : {}),
    };
  } catch {
    return null;
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
    JSON.parse(
      await readFile(join(vaultRoot, '_BAC', 'threads', `${bacId}.json`), 'utf8'),
    ) as unknown,
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
      typeof existing['lastSeenAt'] === 'string'
        ? existing['lastSeenAt']
        : new Date().toISOString(),
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
    handle: async (_request, requestId, _match, context) => {
      // When the companion manages an MCP child, probe its /mcp
      // endpoint so the side panel knows whether restart/config
      // changes succeeded. Distinguishes three states the user
      // cares about:
      //   reachable=false                    — process not listening
      //   reachable=true, authAccepted=false — listening but our
      //                                        auth key is stale
      //   reachable=true, authAccepted=true  — fully healthy
      // Probe is a TCP-cheap GET with a 1s timeout — slow enough
      // to detect a wedged process, fast enough to not stall
      // /v1/status during normal polling.
      let mcpHealth:
        | {
            reachable: boolean;
            authAccepted: boolean;
            status: 'ok' | 'auth_failed' | 'unreachable';
            checkedAt: string;
            detail?: string;
          }
        | undefined;
      if (context.mcp !== undefined) {
        const checkedAt = new Date().toISOString();
        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort();
        }, 1000);
        try {
          const probe = await fetch(`http://127.0.0.1:${String(context.mcp.port)}/mcp`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${context.mcp.authKey}` },
            signal: controller.signal,
          });
          // 401 means a process is listening but doesn't accept
          // our key — surface as auth_failed so the side panel
          // can prompt the user to regenerate or re-paste.
          // Anything else that completed the round-trip counts as
          // ok; the MCP server returns 400 or 405 for the bare
          // GET, which still proves auth was accepted.
          if (probe.status === 401 || probe.status === 403) {
            mcpHealth = {
              reachable: true,
              authAccepted: false,
              status: 'auth_failed',
              checkedAt,
              detail: `http ${String(probe.status)}`,
            };
          } else {
            mcpHealth = {
              reachable: true,
              authAccepted: true,
              status: 'ok',
              checkedAt,
              detail: `http ${String(probe.status)}`,
            };
          }
        } catch (error) {
          mcpHealth = {
            reachable: false,
            authAccepted: false,
            status: 'unreachable',
            checkedAt,
            detail: error instanceof Error ? error.message : String(error),
          };
        } finally {
          clearTimeout(timer);
        }
      }
      return [
        200,
        {
          data: {
            companion: 'running',
            vault: await context.vaultWriter.status(),
            // P1-review: vaultRoot lets the side panel build Codex
            // MCP config snippets without asking the user to paste
            // the absolute vault path. Only included when the
            // companion was started with one (test mode passes
            // undefined).
            ...(context.vaultRoot === undefined ? {} : { vaultRoot: context.vaultRoot }),
            ...(context.mcp === undefined
              ? {}
              : {
                  mcp: {
                    port: context.mcp.port,
                    authKey: context.mcp.authKey,
                    url: `http://127.0.0.1:${String(context.mcp.port)}/mcp`,
                    ...(mcpHealth === undefined ? {} : { health: mcpHealth }),
                  },
                }),
            requestId,
          },
        },
      ];
    },
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
    method: 'POST',
    pattern: /^\/v1\/system\/install-service$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => [
      200,
      {
        data: await (context.serviceInstaller ?? pickInstaller()).install(
          buildServiceInstallOptions(context),
        ),
      },
    ],
  },
  {
    method: 'POST',
    pattern: /^\/v1\/system\/uninstall-service$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => {
      const installer = context.serviceInstaller ?? pickInstaller();
      await installer.uninstall();
      return [200, { data: await installer.status() }];
    },
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
            captureSummary: () => captureHealthSummary(vaultRoot),
            recallSummary: async () => {
              const [index, info, lifecycleReport] = await Promise.all([
                readIndex(indexPath),
                stat(indexPath).catch(() => undefined),
                context.recallLifecycle?.report() ?? Promise.resolve(undefined),
              ]);
              const indexExists = index !== null;
              return {
                indexExists,
                entryCount: index?.items.length ?? null,
                modelId: index?.modelId ?? null,
                sizeBytes: info?.size ?? null,
                // Lifecycle fields are optional so legacy callers
                // (no recallLifecycle injected) keep the old shape.
                ...(lifecycleReport === undefined
                  ? {}
                  : {
                      status: lifecycleReport.status,
                      eventTurnCount: lifecycleReport.eventTurnCount,
                      currentModelId: lifecycleReport.currentModelId,
                      companionVersion: lifecycleReport.companionVersion,
                      lastRebuildAt: lifecycleReport.lastRebuildAt,
                      lastRebuildIndexed: lifecycleReport.lastRebuildIndexed,
                      lastError: lifecycleReport.lastError,
                      rebuildEmbedded: lifecycleReport.rebuildEmbedded,
                      rebuildTotal: lifecycleReport.rebuildTotal,
                      embedderDevice: lifecycleReport.embedderDevice,
                      embedderAccelerator: lifecycleReport.embedderAccelerator,
                      drift: lifecycleReport.drift,
                    }),
                ...(context.recallActivity === undefined
                  ? {}
                  : { activity: context.recallActivity.report() }),
              };
            },
            serviceStatus: async () => {
              const status = await (context.serviceInstaller ?? pickInstaller()).status();
              return { installed: status.installed, running: status.running };
            },
            ...syncSummaryDeps(context.replica, context.sync),
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
      { items: (await context.bucketRegistry?.readBuckets()) ?? [] },
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
      return await runIdempotent(
        context,
        'recordDispatch',
        idempotencyKey,
        async () => {
          const input = dispatchEventSchema.parse(await readBody(request));
          const writer = await writerForBucket(context, {
            provider: input.target.provider,
            ...(input.workstreamId === undefined ? {} : { workstreamId: input.workstreamId }),
          });
          const redaction = redact(input.body);
          const tokenEstimate = estimateTokens(redaction.output);
          const dispatchEvent = {
            ...input,
            bac_id: input.bac_id ?? createDispatchId(),
            body: redaction.output,
            createdAt: input.createdAt ?? new Date().toISOString(),
            redactionSummary: {
              matched: redaction.matched,
              categories: [...redaction.categories],
            },
            tokenEstimate,
          };
          const result = await writer.writeDispatchEvent(dispatchEvent, requestId);
          if (context.eventLog !== undefined) {
            await context.eventLog
              .appendClient({
                clientEventId: idempotencyKey,
                aggregateId: dispatchEvent.bac_id,
                type: DISPATCH_RECORDED,
                payload: {
                  bac_id: dispatchEvent.bac_id,
                  target: { provider: dispatchEvent.target.provider },
                  ...(dispatchEvent.workstreamId === undefined
                    ? {}
                    : { workstreamId: dispatchEvent.workstreamId }),
                  createdAt: dispatchEvent.createdAt,
                  body: dispatchEvent.body,
                },
                baseVector: {},
              })
              .catch(() => undefined);
          }
          return [
            201,
            {
              data: result,
              ...(tokenEstimate > tokenBudgetWarningThreshold
                ? { warnings: ['token-budget-exceeded'] }
                : {}),
            },
          ];
        },
        async (cached) => {
          // Self-heal dead idempotent references: the 24h cache TTL
          // outlives the underlying JSONL record when an operator
          // purges, prunes, or retention-rotates it. If the cached
          // dispatch's bac_id is no longer in the vault, the agent
          // should get a fresh dispatch (and the cache overwrite
          // updates the entry to the new id).
          const cachedRecord = cached as { readonly data?: { readonly bac_id?: unknown } };
          const bacId = cachedRecord.data?.bac_id;
          if (typeof bacId !== 'string' || bacId.length === 0) {
            return false;
          }
          // readDispatchEvents reads the most-recent 100 days of
          // dispatch JSONL files, which is more than the 24h cache
          // TTL covers. If the dispatch is anywhere in that window,
          // the cached response is still valid.
          const events = await context.vaultWriter.readDispatchEvents({ limit: 1000 });
          return events.some((event) => event.bac_id === bacId);
        },
      );
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
    // Dispatch ↔ thread link table (Phase 3 of the spec-aligned
    // refactor). Replaces the extension-only chrome.storage map.
    // Idempotent on (dispatchId, threadId) pair: re-linking to the
    // same thread is a no-op; re-linking to a different thread
    // appends a new row and the latest one wins on read.
    method: 'POST',
    pattern: /^\/v1\/dispatches\/(?<bacId>[A-Za-z0-9_-]+)\/link$/,
    authRequired: true,
    handle: async (request, requestId, match, context) => {
      if (match.bacId === undefined) {
        throw new Error('Missing dispatch bacId path parameter.');
      }
      const body = dispatchLinkRequestSchema.parse(await readBody(request));
      const record = await context.vaultWriter.linkDispatchToThread(
        { dispatchId: match.bacId, threadId: body.threadId },
        requestId,
      );
      if (context.eventLog !== undefined) {
        await context.eventLog
          .appendClient({
            clientEventId: requestId,
            aggregateId: match.bacId,
            type: DISPATCH_LINKED,
            payload: { dispatchId: match.bacId, threadId: body.threadId },
            baseVector: {},
          })
          .catch(() => undefined);
      }
      return [200, { data: record }];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/dispatches\/projection$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => {
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      const merged = await context.eventLog.readMerged();
      const dispatchEvents = merged.filter(
        (event) => event.type === DISPATCH_RECORDED || event.type === DISPATCH_LINKED,
      );
      return [200, { data: projectDispatches(dispatchEvents) }];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/dispatches\/(?<bacId>[A-Za-z0-9_-]+)\/link$/,
    authRequired: true,
    handle: async (_request, _requestId, match, context) => {
      if (match.bacId === undefined) {
        throw new Error('Missing dispatch bacId path parameter.');
      }
      const link = await context.vaultWriter.readLinkForDispatch(match.bacId);
      return [
        200,
        {
          data: link ?? { dispatchId: match.bacId, threadId: null, linkedAt: null },
        },
      ];
    },
  },
  {
    // Long-poll for dispatch capture. Resolves when the link table
    // has a record for this dispatchId, or after timeoutMs (default
    // 60s, capped at 120s). Subscribes to vaultChanges if available
    // so the wait is event-driven; falls back to a 1s polling loop
    // when no watcher is wired.
    method: 'GET',
    pattern: /^\/v1\/dispatches\/(?<bacId>[A-Za-z0-9_-]+)\/await-capture$/,
    authRequired: true,
    handle: async (request, _requestId, match, context) => {
      if (match.bacId === undefined) {
        throw new Error('Missing dispatch bacId path parameter.');
      }
      const dispatchId = match.bacId;
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const rawTimeout = url.searchParams.get('timeoutMs');
      const requested = rawTimeout === null ? 60_000 : Number.parseInt(rawTimeout, 10);
      const timeoutMs =
        Number.isFinite(requested) && requested > 0 ? Math.min(requested, 120_000) : 60_000;
      const vaultRoot = context.vaultRoot;

      const includeTurn = url.searchParams.get('includeLatestAssistantTurn') !== 'false';

      const buildResponse = async (
        link: Awaited<ReturnType<typeof context.vaultWriter.readLinkForDispatch>>,
      ) => {
        if (link === null) {
          return {
            dispatchId,
            matched: false,
            reason: 'timeout' as const,
          };
        }
        const meta =
          vaultRoot === undefined ? null : await readThreadMetadata(vaultRoot, link.threadId);
        // Phase-5-review: always surface `thread.threadId` plus a
        // `resources` URI map so the model can navigate without
        // remembering URI templates from prompt boilerplate.
        // threadUrl/title/provider attach when the thread record is
        // present in the vault; missing ones drop quietly so a thread
        // captured-but-not-yet-flushed still produces a useful payload.
        // Sanitize provider: the captured-thread schema accepts a
        // wider enum (`unknown`, `codex`, …) than the dispatch
        // target enum (chatgpt | claude | gemini). The MCP
        // await_capture outputSchema only declares the dispatch
        // target enum, so anything outside that set drops out
        // rather than surfacing as a schema-violating value.
        const dispatchTargetProviders = ['chatgpt', 'claude', 'gemini'] as const;
        const sanitizedProvider = dispatchTargetProviders.find(
          (candidate) => candidate === meta?.provider,
        );
        const thread = {
          threadId: link.threadId,
          ...(meta?.threadUrl === undefined ? {} : { threadUrl: meta.threadUrl }),
          ...(meta?.title === undefined ? {} : { title: meta.title }),
          ...(sanitizedProvider === undefined ? {} : { provider: sanitizedProvider }),
        };
        const resources = {
          dispatch: `sidetrack://dispatch/${dispatchId}`,
          thread: `sidetrack://thread/${link.threadId}`,
          turns: `sidetrack://thread/${link.threadId}/turns`,
          markdown: `sidetrack://thread/${link.threadId}/markdown`,
          annotations: `sidetrack://thread/${link.threadId}/annotations`,
        };
        // Latest assistant turn — read once now so the model doesn't
        // have to make a follow-up call. Best-effort: a missing
        // threadUrl or empty turn list both reduce to "no latestAssistantTurn".
        let latestAssistantTurn: { ordinal: number; text: string; capturedAt: string } | undefined;
        if (includeTurn && meta?.threadUrl !== undefined) {
          try {
            const turns = await context.vaultWriter.readRecentTurns({
              threadUrl: meta.threadUrl,
              limit: 5,
              role: 'assistant',
            });
            const latest = turns.slice().sort((left, right) => right.ordinal - left.ordinal)[0];
            if (latest !== undefined) {
              latestAssistantTurn = {
                ordinal: latest.ordinal,
                text: latest.text,
                capturedAt: latest.capturedAt,
              };
            }
          } catch {
            // best-effort
          }
        }
        return {
          dispatchId,
          matched: true,
          linkedAt: link.linkedAt,
          thread,
          resources,
          ...(latestAssistantTurn === undefined ? {} : { latestAssistantTurn }),
          reason: 'matched' as const,
        };
      };

      const initial = await context.vaultWriter.readLinkForDispatch(dispatchId);
      if (initial !== null) {
        return [200, { data: await buildResponse(initial) }];
      }

      const result = await new Promise<
        Awaited<ReturnType<typeof context.vaultWriter.readLinkForDispatch>>
      >((resolve) => {
        const timer = setTimeout(() => {
          unsubscribe();
          clearInterval(poll);
          resolve(null);
        }, timeoutMs);
        const poll = setInterval(() => {
          void context.vaultWriter.readLinkForDispatch(dispatchId).then((link) => {
            if (link !== null) {
              clearTimeout(timer);
              clearInterval(poll);
              unsubscribe();
              resolve(link);
            }
          });
        }, 1000);
        const unsubscribe =
          context.vaultChanges?.subscribe((event) => {
            if (event.relPath.startsWith('_BAC/dispatch-links/')) {
              void context.vaultWriter.readLinkForDispatch(dispatchId).then((link) => {
                if (link !== null) {
                  clearTimeout(timer);
                  clearInterval(poll);
                  unsubscribe();
                  resolve(link);
                }
              });
            }
          }) ?? (() => undefined);
      });

      return [200, { data: await buildResponse(result) }];
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
    // Review-draft summary listing. Returns items newer than ?since
    // (ms epoch). Browsers use this for cold-start reconciliation
    // when the SSE stream isn't connected.
    method: 'GET',
    pattern: /^\/v1\/review-drafts$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const query = reviewDraftListQuerySchema.parse({
        since: url.searchParams.get('since') ?? undefined,
      });
      const items = await listReviewDrafts(vaultRoot, query.since ?? null);
      return [200, { items }];
    },
  },
  {
    // Cursor-shaped change feed. Browsers poll with ?since=<cursor>
    // and pass back the returned `cursor` on the next call. The
    // cursor is the stringified value of a per-companion monotonic
    // counter — never a wall-clock timestamp — so a peer with a
    // skewed clock can't push the cursor "into the future" and hide
    // subsequent normal-time edits.
    method: 'GET',
    pattern: /^\/v1\/review-drafts\/changes$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const sinceParam = url.searchParams.get('since') ?? undefined;
      const sinceSeq = sinceParam === undefined ? 0 : Number.parseInt(sinceParam, 10);
      const safeSince = Number.isFinite(sinceSeq) && sinceSeq >= 0 ? sinceSeq : 0;
      // Preferred path: read from the local monotonic change feed.
      if (context.projectionChanges !== undefined) {
        const result = await context.projectionChanges.readSince(safeSince);
        const filtered = result.changed.filter((change) => change.aggregate === 'review-draft');
        return [
          200,
          {
            cursor: String(result.cursor),
            changed: filtered.map((change) => ({
              threadId: change.aggregateId,
              vector: change.vector,
              kind: change.kind,
              localWrittenAtMs: change.localWrittenAtMs,
            })),
          },
        ];
      }
      // Legacy fallback for tests that don't wire a feed: scan the
      // projection directory. Cursor here is best-effort and may not
      // be monotonic across hosts; documented as such.
      const items = await listReviewDrafts(vaultRoot, null);
      return [
        200,
        {
          cursor: '0',
          changed: items.map((item) => ({
            threadId: item.threadId,
            vector: item.vector,
            updatedAtMs: item.updatedAtMs,
          })),
        },
      ];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/review-drafts\/(?<bacId>[A-Za-z0-9_-]+)$/,
    authRequired: true,
    handle: async (_request, _requestId, match, context) => {
      if (match.bacId === undefined) {
        throw new Error('Missing threadId path parameter.');
      }
      const vaultRoot = requireVaultRoot(context);
      const projection = await readReviewDraft(vaultRoot, match.bacId);
      if (projection === null) {
        throw new HttpRouteError(404, 'NOT_FOUND', 'Review draft not found.');
      }
      return [200, { data: projection }];
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/review-drafts\/(?<bacId>[A-Za-z0-9_-]+)\/events$/,
    authRequired: true,
    handle: async (request, _requestId, match, context) => {
      const threadId = match.bacId;
      if (threadId === undefined) {
        throw new Error('Missing threadId path parameter.');
      }
      const vaultRoot = requireVaultRoot(context);
      const eventLog = context.eventLog;
      if (eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      const idempotencyKey = requireIdempotencyKey(request);
      return await runIdempotent(context, 'reviewDraftEvent', idempotencyKey, async () => {
        const body = await readBody(request);
        const input = reviewDraftEventBatchSchema.parse(body);
        // Stamp each event with the URL threadId as the aggregateId so
        // the projection layer can fetch by aggregate. Clients don't
        // repeat threadId in every payload; they pass it once via the
        // path parameter.
        const accepted = [];
        for (const incoming of input.events) {
          const target = compactTargetRef(incoming.target);
          const event = await eventLog.appendClient({
            clientEventId: incoming.clientEventId,
            aggregateId: threadId,
            type: incoming.type,
            payload: incoming.payload ?? {},
            baseVector: incoming.baseVector ?? {},
            ...(incoming.clientDeps === undefined ? {} : { clientDeps: incoming.clientDeps }),
            ...(target === undefined ? {} : { target }),
          });
          accepted.push(event);
        }
        // Recompute the projection from the merged log so concurrent
        // peer events are reflected too. Phase D may hoist this onto
        // a background projector; for M2 the recompute cost is tiny
        // (one thread's events).
        const reviewEvents = await eventLog.readByAggregate(threadId);
        const threadUrl =
          input.threadUrl ?? (await readReviewDraft(vaultRoot, threadId))?.threadUrl ?? '';
        const projection = projectReviewDraft(threadId, threadUrl, reviewEvents);
        if (projection.discarded) {
          await deleteReviewDraft(vaultRoot, threadId);
        } else {
          await writeReviewDraft(vaultRoot, threadId, projection);
        }
        await context.projectionChanges
          ?.appendChange({
            aggregate: 'review-draft',
            aggregateId: threadId,
            relPath: `_BAC/review-drafts/${threadId}.json`,
            vector: projection.vector,
            kind: projection.discarded ? 'delete' : 'upsert',
          })
          .catch(() => undefined);
        return [200, { data: { accepted, projection } }];
      });
    },
  },
  {
    // Event-sourced delete. Direct unlink is unsafe in a CRDT
    // system: prior events still live in the log, so a rebuild (or
    // a peer that only saw the unaccompanied delete) would
    // resurrect the draft. Instead the route appends a
    // `review-draft.discarded` event whose `baseVector` covers
    // every prior event we've observed; the projection collapses to
    // the discarded state, and the file delete becomes a side
    // effect.
    method: 'DELETE',
    pattern: /^\/v1\/review-drafts\/(?<bacId>[A-Za-z0-9_-]+)$/,
    authRequired: true,
    handle: async (request, requestId, match, context) => {
      const threadId = match.bacId;
      if (threadId === undefined) {
        throw new Error('Missing threadId path parameter.');
      }
      const vaultRoot = requireVaultRoot(context);
      const eventLog = context.eventLog;
      if (eventLog === undefined) {
        // Legacy callers without an eventLog wired (tests) fall back
        // to the direct unlink so we keep their behaviour.
        await deleteReviewDraft(vaultRoot, threadId);
        return [204, undefined];
      }
      // Read the current projection so the discard event observes
      // every prior event for this thread. baseVector === current
      // projection's vector.
      const priorEvents = await eventLog.readByAggregate(threadId);
      const priorReviewEvents = priorEvents.filter((event) => isReviewDraftEvent(event));
      const priorProjection = projectReviewDraft(threadId, '', priorReviewEvents);
      await eventLog.appendClient({
        clientEventId: requestId,
        aggregateId: threadId,
        type: 'review-draft.discarded',
        payload: { reason: 'deleted-via-http' },
        baseVector: priorProjection.vector,
      });
      // Recompute and persist the new projection (collapsed to
      // discarded). If the projection function returns null we
      // delete the file; otherwise we write the tombstoned
      // projection so peers still see the vector advance.
      const merged = await eventLog.readByAggregate(threadId);
      const reviewEvents = merged.filter((event) => isReviewDraftEvent(event));
      const projection = projectReviewDraft(threadId, '', reviewEvents);
      if (projection.discarded) {
        await deleteReviewDraft(vaultRoot, threadId);
      } else {
        await writeReviewDraft(vaultRoot, threadId, projection);
      }
      await context.projectionChanges
        ?.appendChange({
          aggregate: 'review-draft',
          aggregateId: threadId,
          relPath: `_BAC/review-drafts/${threadId}.json`,
          vector: projection.vector,
          kind: projection.discarded ? 'delete' : 'upsert',
        })
        .catch(() => undefined);
      return [204, undefined];
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
        // Term-form (Phase 4): companion fetches the thread's assistant
        // turns and builds the anchor server-side. Anchor-form (DOM-
        // driven): caller already serialised the anchor; pass through
        // unchanged.
        if ('term' in input) {
          // Resolve threadUrl + pageTitle from the thread record when
          // the caller passed `threadId`. This is the path
          // sidetrack.dispatch.await_capture flows into — agents pass
          // threadId, the companion looks up everything else.
          let threadUrl: string | undefined = input.url;
          let pageTitle: string | undefined = input.pageTitle;
          if (input.threadId !== undefined) {
            const meta = await readThreadMetadata(vaultRoot, input.threadId);
            if (meta === null) {
              return [
                200,
                {
                  data: {
                    status: 'anchor_failed' as const,
                    reason: 'thread_not_found' as const,
                    message: `Thread ${input.threadId} not found in the vault.`,
                    occurrenceCount: 0,
                  },
                },
              ];
            }
            threadUrl = meta.threadUrl ?? threadUrl;
            pageTitle = pageTitle ?? meta.title;
          }
          if (threadUrl === undefined) {
            return [
              200,
              {
                data: {
                  status: 'validation_failed' as const,
                  reason: 'thread_url_unresolved' as const,
                  message: 'No threadUrl could be resolved from threadId / url.',
                  occurrenceCount: 0,
                },
              },
            ];
          }
          pageTitle ??= threadUrl;
          const allTurns = await context.vaultWriter.readRecentTurns({
            threadUrl,
            limit: 50,
            role: 'assistant',
          });
          if (allTurns.length === 0) {
            return [
              200,
              {
                data: {
                  status: 'anchor_failed' as const,
                  reason: 'no_assistant_turns' as const,
                  message: `No assistant turns found for ${threadUrl}; capture the thread first.`,
                  occurrenceCount: 0,
                },
              },
            ];
          }
          // sourceTurn selects which captured turn the anchor is
          // built against. Defaults to the latest assistant turn —
          // matches the post-dispatch flow where the agent annotates
          // a fresh answer.
          const sortedAsc = allTurns.slice().sort((left, right) => left.ordinal - right.ordinal);
          const sourceTurn = input.sourceTurn ?? 'assistant_latest';
          let turnText: string;
          if (sourceTurn === 'assistant_all') {
            turnText = sortedAsc.map((turn) => turn.text).join('\n\n');
          } else if (sourceTurn === 'assistant_latest') {
            const last = sortedAsc[sortedAsc.length - 1];
            turnText = last?.text ?? '';
          } else {
            const picked = sortedAsc.find((turn) => turn.ordinal === sourceTurn.ordinal);
            if (picked === undefined) {
              return [
                200,
                {
                  data: {
                    status: 'validation_failed' as const,
                    reason: 'invalid_ordinal' as const,
                    message: `Thread has no assistant turn at ordinal ${String(sourceTurn.ordinal)}.`,
                    occurrenceCount: 0,
                  },
                },
              ];
            }
            turnText = picked.text;
          }
          // anchorPolicy fields can each be undefined under
          // exactOptionalPropertyTypes; strip undefined before
          // passing down. Defaults live in buildAnchorFromTerm.
          const policy = input.anchorPolicy;
          const cleanedPolicy =
            policy === undefined
              ? undefined
              : {
                  ...(policy.repeatedTerm === undefined
                    ? {}
                    : { repeatedTerm: policy.repeatedTerm }),
                  ...(policy.shortTermMinLength === undefined
                    ? {}
                    : { shortTermMinLength: policy.shortTermMinLength }),
                };
          const result = buildAnchorFromTerm({
            turnText,
            term: input.term,
            ...(input.selectionHint === undefined ? {} : { selectionHint: input.selectionHint }),
            ...(cleanedPolicy === undefined ? {} : { policy: cleanedPolicy }),
          });
          if (!result.ok) {
            // Structured failure — surfaced as 200 + a `data` block
            // the MCP create_batch tool maps to a per-item retry-able
            // status. Throwing 400 forces the agent to handle a
            // protocol-level error; structured returns let the model
            // self-correct against the same envelope shape as a
            // success.
            return [
              200,
              {
                data: {
                  status: 'anchor_failed' as const,
                  reason: result.reason,
                  message: result.message,
                  occurrenceCount: result.occurrenceCount,
                  ...(result.suggestedSelectionHints === undefined
                    ? {}
                    : { suggestedSelectionHints: [...result.suggestedSelectionHints] }),
                },
              },
            ];
          }
          const annotationUrl = input.url ?? threadUrl;
          const created = await writeAnnotation(vaultRoot, {
            url: annotationUrl,
            pageTitle,
            anchor: result.anchor,
            note: input.note,
          });
          if (context.eventLog !== undefined) {
            await context.eventLog
              .appendClient({
                clientEventId: `${idempotencyKey}.term`,
                aggregateId: created.bac_id,
                type: ANNOTATION_CREATED,
                payload: {
                  bac_id: created.bac_id,
                  url: annotationUrl,
                  anchor: result.anchor,
                  note: input.note,
                  pageTitle,
                },
                baseVector: {},
              })
              .catch(() => undefined);
          }
          // totalForThread/totalForUrl: total non-deleted
          // annotations now associated with this URL. Lets the
          // model report a final count without summing per-batch
          // createdCount across multiple calls (the only fully
          // accurate way to know "how many annotations exist").
          const totalForUrl = (await listAnnotations(vaultRoot, { url: annotationUrl })).length;
          return [
            201,
            {
              data: {
                status: 'created' as const,
                annotationId: created.bac_id,
                occurrenceCount: result.occurrenceCount,
                annotation: created,
                totalForUrl,
              },
            },
          ];
        }
        const result = await writeAnnotation(vaultRoot, input);
        if (context.eventLog !== undefined) {
          await context.eventLog
            .appendClient({
              clientEventId: idempotencyKey,
              aggregateId: result.bac_id,
              type: ANNOTATION_CREATED,
              payload: {
                bac_id: result.bac_id,
                url: input.url,
                anchor: input.anchor,
                note: input.note,
                pageTitle: input.pageTitle,
              },
              baseVector: {},
            })
            .catch(() => undefined);
        }
        return [201, { data: result }];
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
    handle: async (request, requestId, match, context) => {
      if (match.annotationId === undefined) {
        throw new Error('Missing annotationId path parameter.');
      }
      const input = annotationUpdateSchema.parse(await readBody(request));
      const updated = await updateAnnotation(requireVaultRoot(context), match.annotationId, input);
      if (context.eventLog !== undefined && typeof input.note === 'string') {
        await context.eventLog
          .appendClient({
            clientEventId: requestId,
            aggregateId: match.annotationId,
            type: ANNOTATION_NOTE_SET,
            payload: { bac_id: match.annotationId, note: input.note },
            baseVector: {},
          })
          .catch(() => undefined);
      }
      return [200, { data: updated }];
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/v1\/annotations\/(?<annotationId>[A-Za-z0-9_-]+)$/,
    authRequired: true,
    handle: async (_request, requestId, match, context) => {
      if (match.annotationId === undefined) {
        throw new Error('Missing annotationId path parameter.');
      }
      const result = await softDeleteAnnotation(requireVaultRoot(context), match.annotationId);
      if (context.eventLog !== undefined && context.replica !== undefined) {
        await context.eventLog
          .appendClient({
            clientEventId: `annotation-delete:${context.replica.replicaId}:${match.annotationId}:${requestId}`,
            aggregateId: match.annotationId,
            type: ANNOTATION_DELETED,
            payload: { bac_id: match.annotationId },
            baseVector: {},
          })
          .catch(() => undefined);
      }
      return [200, { data: result }];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/annotations\/projection$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => {
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      const merged = await context.eventLog.readMerged();
      const annotationEvents = merged.filter(
        (event) =>
          event.type === ANNOTATION_CREATED ||
          event.type === ANNOTATION_NOTE_SET ||
          event.type === ANNOTATION_DELETED,
      );
      return [200, { data: projectAnnotations(annotationEvents) }];
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
      let indexed = 0;
      const indexedThreadIds: string[] = [];
      for (let index = 0; index < input.items.length; index += 1) {
        const item = input.items[index];
        const embedding = vectors[index];
        if (item === undefined || embedding === undefined) continue;
        const entry = {
          id: item.id,
          threadId: item.threadId,
          capturedAt: item.capturedAt,
          embedding,
        };
        if (context.recallLifecycle !== undefined) {
          await context.recallLifecycle.appendEntry(entry);
        } else {
          await appendEntryRaw(recallIndexPath(vaultRoot), entry, MODEL_ID);
        }
        indexed += 1;
        indexedThreadIds.push(item.threadId);
      }
      context.recallActivity?.recordIncrementalIndex({
        count: indexed,
        threadIds: indexedThreadIds,
      });
      return [202, { data: { indexed } }];
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
      const ranked = rank(queryEmbedding ?? new Float32Array(384), index.items, new Date(), {
        limit: query.limit,
        ...(threadIds === undefined
          ? {}
          : { workstreamMembership: (threadId: string) => threadIds.has(threadId) }),
      });
      // Enrich each result with the thread title + canonical URL so
      // the side panel can render meaningful labels and the SW proxy
      // can dedup across stale duplicate bac_ids that point at the
      // same chat URL. The cost is O(limit) tiny JSON reads —
      // acceptable because the limit is clamped at 50.
      // Snippet remains absent for now (would need an index format
      // bump to store per-turn text without re-reading event logs).
      const meta = new Map<string, { title: string; threadUrl: string }>();
      const enriched = await Promise.all(
        ranked.map(async (item) => {
          let info = meta.get(item.threadId);
          if (info === undefined) {
            try {
              const threadFile = await readFile(
                join(vaultRoot, '_BAC', 'threads', `${item.threadId}.json`),
                'utf8',
              );
              const parsed = JSON.parse(threadFile) as {
                readonly title?: unknown;
                readonly threadUrl?: unknown;
              };
              info = {
                title: typeof parsed.title === 'string' ? parsed.title : '',
                threadUrl: typeof parsed.threadUrl === 'string' ? parsed.threadUrl : '',
              };
            } catch {
              info = { title: '', threadUrl: '' };
            }
            meta.set(item.threadId, info);
          }
          const additions: Record<string, string> = {};
          if (info.title.length > 0) additions['title'] = info.title;
          if (info.threadUrl.length > 0) additions['threadUrl'] = info.threadUrl;
          return Object.keys(additions).length > 0 ? { ...item, ...additions } : item;
        }),
      );
      context.recallActivity?.recordQuery({
        queryLength: query.q.length,
        resultCount: enriched.length,
      });
      return [200, { data: enriched }];
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/recall\/rebuild$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      // Prefer the lifecycle path so the manual button + auto-rebuild
      // share the same scheduler (one rebuild at a time, status flips
      // to "rebuilding" in /v1/system/health, errors are captured).
      // Fall back to the direct rebuilder for legacy callers that
      // didn't inject a lifecycle.
      //
      // Critical: do NOT await the rebuild here. The first rebuild
      // downloads the embedder model (~30MB) and embeds every turn
      // — that can take minutes. Holding the request open until it
      // finishes causes Chrome's fetch to time out with "Failed to
      // fetch" and the user thinks the rebuild errored when it's
      // actually still chugging along. Returning 202 + the current
      // status lets the side-panel pill + Health card poll
      // /v1/system/health to track progress.
      if (context.recallLifecycle !== undefined) {
        context.recallLifecycle.scheduleRebuild('manual');
        const report = await context.recallLifecycle.report();
        return [
          202,
          {
            data: {
              accepted: true,
              status: report.status,
              entryCount: report.entryCount,
              eventTurnCount: report.eventTurnCount,
              lastRebuildAt: report.lastRebuildAt,
              lastError: report.lastError,
            },
          },
        ];
      }
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
      const validIds = new Set(input.validIds);
      const data =
        context.recallLifecycle !== undefined
          ? await context.recallLifecycle.gcEntries(validIds)
          : await gcEntriesRaw(recallIndexPath(requireVaultRoot(context)), validIds);
      return [200, { data }];
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
        threshold: url.searchParams.get('threshold') ?? undefined,
      });
      const workstreams = await readWorkstreams(vaultRoot);
      const signals = await buildSignals(vaultRoot, match.threadId, workstreams);
      // Threshold precedence: per-request param wins, then env var,
      // then a permissive default (0.25). The pre-fix value (0.55)
      // was calibrated for richly-populated workstreams where the
      // 0.5*vector term dominated; with the cold-start title-
      // embedding fallback and the asymmetric ws→thread containment
      // signal, real positive matches typically score 0.25–0.45,
      // so 0.25 surfaces them without a flood of noise.
      const envThreshold = Number.parseFloat(process.env['SIDETRACK_SUGGEST_THRESHOLD'] ?? '');
      const defaultThreshold = Number.isFinite(envThreshold) ? envThreshold : 0.25;
      const threshold = query.threshold ?? defaultThreshold;
      const suggestions = scoreSuggestions(
        {
          thread: { id: match.threadId },
          workstreams,
          signals,
        },
        { threshold },
      ).slice(0, query.limit);
      context.recallActivity?.recordSuggestion({
        threadId: match.threadId,
        resultCount: suggestions.length,
      });
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
        // Mirror the capture as a `capture.recorded` AcceptedEvent
        // in the per-replica log so peers see it via sync. The
        // legacy `_BAC/events/` write above stays for back-compat
        // (older readers, the existing rebuild path); rebuild dedups
        // by bac_id when both sources hold the same capture.
        if (context.eventLog !== undefined) {
          await context.eventLog
            .appendClient({
              clientEventId: idempotencyKey,
              aggregateId: result.bac_id,
              type: CAPTURE_RECORDED,
              payload: {
                bac_id: result.bac_id,
                ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
                threadUrl: input.threadUrl,
                provider: input.provider,
                capturedAt: input.capturedAt,
                turns: input.turns.map((turn) => ({
                  ordinal: turn.ordinal,
                  role: turn.role,
                  text: turn.text,
                  capturedAt: turn.capturedAt,
                })),
              },
              baseVector: {},
            })
            .catch(() => undefined);
        }
        // Auto-index every turn so /v1/recall/query can find the
        // capture without waiting for a manual rebuild. The lifecycle
        // mutex serialises this against any in-flight rebuild.
        if (context.recallLifecycle !== undefined) {
          const threadId = result.bac_id;
          const turns: {
            readonly id: string;
            readonly threadId: string;
            readonly capturedAt: string;
            readonly text: string;
          }[] = [];
          input.turns.forEach((turn) => {
            if (turn.text.trim().length === 0) return;
            turns.push({
              id: `${threadId}:${String(turn.ordinal)}`,
              threadId,
              capturedAt: turn.capturedAt,
              text: turn.text,
            });
          });
          if (turns.length > 0) {
            // Schedule on the lifecycle mutex but don't block the
            // POST response — capture latency stays bounded by the
            // vault write, not the embedder cost.
            void context.recallLifecycle.appendCaptureTurns(turns).catch(() => {
              // Auto-index is best-effort; if embedding fails the
              // event log is still authoritative and a manual rebuild
              // catches up.
            });
          }
        }
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
      if (tool === 'sidetrack.threads.move') {
        await requireWorkstreamTrust(context, input.primaryWorkstreamId, tool);
      }
      const result = await context.vaultWriter.upsertThread(input, requestId);
      // Mirror the upsert as a `thread.upserted` AcceptedEvent so
      // peers see thread state via sync. The legacy thread.json
      // write above is the immediate read source for callers that
      // don't yet consume the projection.
      if (context.eventLog !== undefined) {
        await context.eventLog
          .appendClient({
            clientEventId: requestId,
            aggregateId: result.bac_id,
            type: THREAD_UPSERTED,
            payload: {
              bac_id: result.bac_id,
              provider: input.provider,
              threadUrl: input.threadUrl,
              title: input.title,
              lastSeenAt: input.lastSeenAt,
              ...(input.status === undefined ? {} : { status: input.status }),
              ...(input.primaryWorkstreamId === undefined
                ? {}
                : { primaryWorkstreamId: input.primaryWorkstreamId }),
              ...(input.tags === undefined ? {} : { tags: input.tags }),
              ...(input.trackingMode === undefined ? {} : { trackingMode: input.trackingMode }),
            },
            baseVector: {},
          })
          .catch(() => undefined);
      }
      return [200, mutationResponse(result, requestId)];
    },
  },
  {
    // Read the causal projection for a thread. Optional: existing
    // callers continue to read `_BAC/threads/<bac_id>.json` via
    // markdown / list endpoints. This endpoint exposes register
    // status + conflict candidates so a side panel can render a
    // picker for two replicas that touched the same thread.
    method: 'GET',
    pattern: /^\/v1\/threads\/(?<bacId>[A-Za-z0-9_-]+)\/projection$/,
    authRequired: true,
    handle: async (_request, _requestId, match, context) => {
      if (match.bacId === undefined) {
        throw new Error('Missing bacId path parameter.');
      }
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      const events = await context.eventLog.readByAggregate(match.bacId);
      const projection = projectThread(match.bacId, events);
      return [200, { data: projection }];
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
      const vaultRoot = requireVaultRoot(context);
      if (mcpToolHeader(_request) === 'sidetrack.threads.archive') {
        await requireWorkstreamTrust(
          context,
          await readThreadWorkstreamId(vaultRoot, match.bacId),
          'sidetrack.threads.archive',
        );
      }
      const result = await context.vaultWriter.archiveThread(match.bacId, requestId);
      // Mirror as a thread.archived event so peers see the status
      // change via sync. clientEventId is deterministic per
      // (replica, thread) so a duplicate archive call collapses on
      // the eventLog's idempotency check.
      if (context.eventLog !== undefined && context.replica !== undefined) {
        await context.eventLog
          .appendClient({
            clientEventId: `thread-archive:${context.replica.replicaId}:${match.bacId}`,
            aggregateId: match.bacId,
            type: THREAD_ARCHIVED,
            payload: { bac_id: match.bacId },
            baseVector: {},
          })
          .catch(() => undefined);
      }
      // Tombstone every recall index entry for this thread so
      // /v1/recall/query stops returning rows from archived threads.
      // OR-Set semantics: rows stay on disk with tombstoned=true; a
      // future replica merging an older un-archived write won't
      // resurrect them. Best-effort — a missing index file is a
      // benign no-op (tombstoneByThread returns 0).
      const lifecycle = context.recallLifecycle;
      const tombstoneByThread =
        lifecycle === undefined
          ? (threadId: string) => tombstoneByThreadRaw(recallIndexPath(vaultRoot), threadId)
          : (threadId: string) => lifecycle.tombstoneByThread(threadId);
      await tombstoneByThread(match.bacId).catch(() => {
        /* index optional; archive succeeds regardless */
      });
      return [200, mutationResponse(result, requestId)];
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
      if (mcpToolHeader(_request) === 'sidetrack.threads.unarchive') {
        await requireWorkstreamTrust(
          context,
          await readThreadWorkstreamId(requireVaultRoot(context), match.bacId),
          'sidetrack.threads.unarchive',
        );
      }
      const result = await context.vaultWriter.unarchiveThread(match.bacId, requestId);
      if (context.eventLog !== undefined && context.replica !== undefined) {
        await context.eventLog
          .appendClient({
            clientEventId: `thread-unarchive:${context.replica.replicaId}:${match.bacId}:${requestId}`,
            aggregateId: match.bacId,
            type: THREAD_UNARCHIVED,
            payload: { bac_id: match.bacId },
            baseVector: {},
          })
          .catch(() => undefined);
      }
      // We deliberately do NOT clear the recall-index tombstones on
      // unarchive — an OR-Set tombstone is permanent (the lifecycle's
      // incremental indexer will write fresh, untombstoned rows for
      // any new captures on this thread).
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
      if (context.eventLog !== undefined) {
        await context.eventLog
          .appendClient({
            clientEventId: requestId,
            aggregateId: result.bac_id,
            type: WORKSTREAM_UPSERTED,
            payload: {
              bac_id: result.bac_id,
              title: input.title,
              ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
              ...(input.privacy === undefined ? {} : { privacy: input.privacy }),
              ...(input.screenShareSensitive === undefined
                ? {}
                : { screenShareSensitive: input.screenShareSensitive }),
              ...(input.tags === undefined ? {} : { tags: input.tags }),
              ...(input.children === undefined ? {} : { children: input.children }),
              ...(input.checklist === undefined ? {} : { checklist: input.checklist }),
              ...(input.description === undefined ? {} : { description: input.description }),
            },
            baseVector: {},
          })
          .catch(() => undefined);
      }
      return [201, mutationResponse(result, requestId)];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/workstreams\/(?<bacId>[A-Za-z0-9_-]+)\/projection$/,
    authRequired: true,
    handle: async (_request, _requestId, match, context) => {
      if (match.bacId === undefined) {
        throw new Error('Missing bacId path parameter.');
      }
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      const events = await context.eventLog.readByAggregate(match.bacId);
      const projection = projectWorkstream(match.bacId, events);
      return [200, { data: projection }];
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
            // Fresh workstreams (no explicit record on disk) default
            // to allowing every write tool — matches isAllowed's
            // allow-by-default semantic so the side panel renders
            // all toggles ON before the user has touched the section.
            allowedTools:
              record === undefined ? [...defaultAllowedTools()] : [...record.allowedTools],
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
      if (mcpToolHeader(_request) === 'sidetrack.workstreams.bump') {
        await requireWorkstreamTrust(context, match.bacId, 'sidetrack.workstreams.bump');
      }
      return [
        200,
        mutationResponse(
          await context.vaultWriter.bumpWorkstream(match.bacId, requestId),
          requestId,
        ),
      ];
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
      // PATCH semantics: the input is a delta. Re-read the full
      // record after the vault write so the emitted event carries a
      // complete snapshot. Per-field registers (a finer CRDT) are
      // documented as future work; for now a full-snapshot register
      // matches the existing vault semantics.
      if (context.eventLog !== undefined) {
        const vaultRoot = requireVaultRoot(context);
        try {
          const raw = await readFile(
            join(vaultRoot, '_BAC', 'workstreams', `${match.workstreamId}.json`),
            'utf8',
          );
          const record = JSON.parse(raw) as Record<string, unknown>;
          if (typeof record['bac_id'] === 'string' && typeof record['title'] === 'string') {
            await context.eventLog.appendClient({
              clientEventId: requestId,
              aggregateId: match.workstreamId,
              type: WORKSTREAM_UPSERTED,
              payload: {
                bac_id: record['bac_id'],
                title: record['title'],
                ...(typeof record['parentId'] === 'string' ? { parentId: record['parentId'] } : {}),
                ...(typeof record['privacy'] === 'string' ? { privacy: record['privacy'] } : {}),
                ...(Array.isArray(record['tags']) ? { tags: record['tags'] } : {}),
                ...(typeof record['description'] === 'string'
                  ? { description: record['description'] }
                  : {}),
              },
              baseVector: {},
            });
          }
        } catch {
          // Best effort — the vault write succeeded regardless.
        }
      }
      return [200, mutationResponse(result, requestId)];
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/v1\/workstreams\/(?<workstreamId>[A-Za-z0-9_-]+)$/,
    authRequired: true,
    handle: async (_request, requestId, match, context) => {
      if (match.workstreamId === undefined) {
        throw new Error('Missing workstreamId path parameter.');
      }
      try {
        const result = await context.vaultWriter.deleteWorkstream(match.workstreamId, requestId);
        return [
          200,
          {
            data: {
              bac_id: result.bac_id,
              detachedThreadIds: result.detachedThreadIds,
            },
            requestId,
          },
        ];
      } catch (error) {
        if (error instanceof WorkstreamHasChildrenError) {
          throw new HttpRouteError(
            409,
            'WORKSTREAM_HAS_CHILDREN',
            `Cannot delete — ${String(error.childCount)} child workstream(s) remain. Detach or delete children first.`,
          );
        }
        throw error;
      }
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
      return [200, { items: notes.filter((note) => note.workstreamId === match.workstreamId) }];
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
        if (tool === 'sidetrack.queue.create' && input.scope === 'workstream') {
          await requireWorkstreamTrust(context, input.targetId, tool);
        }
        const result = await context.vaultWriter.createQueueItem(input, requestId);
        if (context.eventLog !== undefined) {
          await context.eventLog
            .appendClient({
              clientEventId: idempotencyKey,
              aggregateId: result.bac_id,
              type: QUEUE_CREATED,
              payload: {
                bac_id: result.bac_id,
                text: input.text,
                scope: input.scope,
                ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
                ...(input.status === undefined ? {} : { status: input.status }),
              },
              baseVector: {},
            })
            .catch(() => undefined);
        }
        return [201, mutationResponse(result, requestId)];
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/queue\/(?<bacId>[A-Za-z0-9_-]+)\/projection$/,
    authRequired: true,
    handle: async (_request, _requestId, match, context) => {
      if (match.bacId === undefined) {
        throw new Error('Missing bacId path parameter.');
      }
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      const events = await context.eventLog.readByAggregate(match.bacId);
      return [200, { data: projectQueueItem(match.bacId, events) }];
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
