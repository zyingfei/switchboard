import { appendFile, chmod, rename, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveUrlAttributionArmed } from '../attribution-v1/armedResolve.js';
import { titleForCanonicalUrl } from '../attribution-v1/emit.js';
import { bridgeKeysMatch, isBridgeKeyAccepted } from '../auth/bridgeKey.js';
import type { WorkstreamWriteTool } from '../auth/workstreamTrust.js';
import { SqliteConnectionsStore, type ConnectionsSnapshot } from '../connections/snapshot.js';
import { createRequestId } from '../domain/ids.js';
import {
  ENTITY_CONTENT_ENRICHED,
  gistLookupFromMerged,
  lookupGist,
  type GistLookup,
} from '../enrichment/contentEnrichment.js';
import { ENTITY_ENRICHMENT_RETRACTED } from '../enrichment/events.js';
import {
  ENTITY_TITLE_ENRICHED,
  enrichmentLookupFromMerged,
  lookupSynthesizedTitle,
  type EnrichmentLookup,
} from '../enrichment/titleEnrichment.js';
import {
  USER_FLOW_REJECTED,
  USER_ORGANIZED_ITEM,
  isUserOrganizedItemPayload,
} from '../feedback/events.js';
import { listPageEvidenceRecords } from '../page-evidence/store.js';
import { createEmbeddingCache, embedTextHash } from '../recall/embeddingCache.js';
import { RECALL_MODEL } from '../recall/modelManifest.js';
import { VECTOR_CORPUS_MODEL_KEY } from '../recall/vectorCorpus.js';
import { getOrBuildSemanticRecallPool } from '../recall/semanticRecallPool.js';
import { yieldToEventLoop } from '../runtime/eventLoopYield.js';
import {
  completeInflight,
  registerInflight,
  routeLabelFromPattern,
} from '../runtime/inflightRegistry.js';
import type { AcceptedEvent } from '../sync/causal.js';
import {
  appendAiLane,
  appendContentLane,
  contentLaneEnabled,
  type AppendContentLaneDeps,
  type ContentLaneStore,
} from '../tabsession/contentLane.js';
import { declineMemoryFromMerged, type DeclineLookup } from '../tabsession/declineMemory.js';
import { guessLanesEnabled } from '../tabsession/guessLanes.js';
import {
  applyLaneCorroboration,
  laneCorroborationEnabled,
} from '../tabsession/laneCorroboration.js';
import { applyLaneFallbackGuess } from '../tabsession/laneFallback.js';
import {
  laneOpportunityIdFor,
  lanePrequentialSummary,
  recordLanePredictions,
  type LanePredictionInput,
  type LanePrequentialSummary,
} from '../tabsession/lanePrequential.js';
import {
  appendPrototypeLane,
  type AppendPrototypeLaneDeps,
  type PrototypeLaneStore,
} from '../tabsession/prototypeLane.js';
import type { UrlResolutionResult } from '../tabsession/resolver.js';
import { BROWSER_TIMELINE_OBSERVED } from '../timeline/events.js';
import { boundArgsSummary, runWithAuditContext, type AuditContext } from '../vault/auditContext.js';
import {
  CodingAttachTokenInvalidError,
  CodingSessionNotFoundError,
  SettingsRevisionConflictError,
} from '../vault/writer.js';
import { VaultExportConfinementError, VaultUnavailableError } from './errors.js';
import { isModelHostPath, serveModelFile } from './modelHostRoute.js';
import { createProblem, type ValidationIssue } from './problem.js';
import {
  queueResolverCacheWrite,
  resolverCacheDeferEnabled,
  scheduleResolverCacheFlush,
} from './resolverCacheDefer.js';
import { scheduleReverseShadowFlush } from '../attribution-v1/reverseShadowDefer.js';

import {
  HttpRouteError,
  RESOLVER_SIGNAL_EVENT_TYPES,
  acquireResolveSlot,
  callerIdentities,
  callerIdentityFor,
  connectionsGraphSig,
  domainTombstoneSetFor,
  eventReadCoverageSig,
  eventStoreForContext,
  objectRecord,
  readBody,
  readEventsFromStoreOrLog,
  releaseResolveSlot,
  requireVaultRoot,
  resolveSwrCache,
} from './routeSupport.js';
import type {
  CallerIdentity,
  CompanionHttpConfig,
  HttpMethod,
  RouteDefinition,
} from './routeSupport.js';
import { urlWorkstreamLookupFromProjection } from './routes/entitiesRoutes.js';
import { isPrivacyEventType } from './routes/privacyRoutes.js';
import { loadEmbedderModule } from './routes/recallRoutes.js';
import {
  RESOLVER_EXPAND_EVENT_TYPES,
  armedResolveSig,
  eventCandidateCacheRevision,
  resolverCacheRevision,
  resolverExpandedCandidateUrlsForCanonicalUrls,
  resolverSignalEventsForCanonicalUrls,
  resolverSignalEventsForCanonicalUrlsIndexed,
  resolverTimelineEventsForCanonicalUrlsIndexed,
} from './routes/visitsRoutes.js';

import { systemRoutesA, systemRoutesB, systemRoutesC } from './routes/systemRoutes.js';
import { privacyRoutes } from './routes/privacyRoutes.js';
import { feedbackRoutes } from './routes/feedbackRoutes.js';
import { tabsessionRoutes } from './routes/tabsessionRoutes.js';
import { visitsRoutesA, visitsRoutesB } from './routes/visitsRoutes.js';
import { bucketsRoutes } from './routes/bucketsRoutes.js';
import { settingsRoutes } from './routes/settingsRoutes.js';
import { dispatchesRoutesA, dispatchesRoutesB } from './routes/dispatchesRoutes.js';
import { auditRoutes } from './routes/auditRoutes.js';
import { reviewsRoutes } from './routes/reviewsRoutes.js';
import { reviewDraftsRoutes } from './routes/reviewDraftsRoutes.js';
import { annotationsRoutes } from './routes/annotationsRoutes.js';
import { recallRoutesA, recallRoutesB, recallRoutesC } from './routes/recallRoutes.js';
import { pageContentRoutes } from './routes/pageContentRoutes.js';
import { modelRoutes } from './routes/modelRoutes.js';
import { enrichmentRoutes } from './routes/enrichmentRoutes.js';
import { entitiesRoutes } from './routes/entitiesRoutes.js';
import { threadSuggestionRoutes, threadsRoutesA } from './routes/threadsRoutes.js';
import { eventsRoutes } from './routes/eventsRoutes.js';
import { workstreamsRoutes } from './routes/workstreamsRoutes.js';
import { workstreamSuggestionsRoutes } from './routes/workstreamSuggestionsRoutes.js';
import { queueRoutes } from './routes/queueRoutes.js';
import { remindersRoutes } from './routes/remindersRoutes.js';
import { codingSessionsRoutes } from './routes/codingSessionsRoutes.js';
import { timelineRoutes } from './routes/timelineRoutes.js';
import { connectionsRoutes } from './routes/connectionsRoutes.js';

export { runIdempotent, connectionsGraphSig } from './routeSupport.js';
export type { CompanionHttpConfig } from './routeSupport.js';
export {
  buildReliabilityHealthSection,
  withReliabilityHealthSection,
  resetStatusCatchUpStateForTest,
} from './routes/systemRoutes.js';
export type {
  ReliabilityHealthSection,
  ConnectionsDoubleBufferHealth,
} from './routes/systemRoutes.js';

export interface StartedHttpServer {
  readonly server: Server;
  readonly port: number;
  readonly url: string;
  readonly close: () => Promise<void>;
}

type BunHeapSnapshot = {
  readonly version: number;
  readonly type: string;
  readonly nodes: readonly number[];
  readonly nodeClassNames: readonly string[];
  readonly edges: readonly number[];
  readonly edgeTypes: readonly string[];
  readonly edgeNames: readonly string[];
};

type BunRuntimeWithHeapSnapshot = {
  readonly Bun?: {
    readonly generateHeapSnapshot?: () => BunHeapSnapshot;
  };
};

const writeDebugHeapSnapshot = async (): Promise<string> => {
  const bunRuntime = globalThis as BunRuntimeWithHeapSnapshot;
  const generateHeapSnapshot = bunRuntime.Bun?.generateHeapSnapshot;
  if (generateHeapSnapshot === undefined) {
    throw new HttpRouteError(
      503,
      'HEAP_SNAPSHOT_UNAVAILABLE',
      'Bun heap snapshots are unavailable in this runtime.',
    );
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(tmpdir(), `heap-${String(process.pid)}-${ts}.heapsnapshot`);
  await writeFile(path, JSON.stringify(generateHeapSnapshot()), 'utf8');
  return path;
};

// SIDETRACK_HTTP_LOG=1 debug log. Records method + pathname + status +
// duration ONLY — never the query string, which carries PII (search
// terms, visited URLs). The file is created/kept at 0600 so a
// co-located user on the box can't read it. chmod runs once per process
// (best-effort): `appendFile`'s mode option only applies when it
// creates the file, so an existing 0644 log would otherwise stay
// world-readable.
const HTTP_DEBUG_LOG_PATH = '/tmp/sidetrack-http-debug.log';

// Rollover cap. The log is append-only and lived unbounded before this —
// 96 MB observed after 12 days of two companions sharing the path. One
// `.1` rollover bounds total disk at ~2x the cap while keeping the recent
// window an operator actually greps.
const HTTP_DEBUG_LOG_MAX_BYTES = 32 * 1024 * 1024;

let httpDebugLogModeEnsured = false;

const appendHttpDebugLine = async (line: string): Promise<void> => {
  try {
    const info = await stat(HTTP_DEBUG_LOG_PATH);
    if (info.size >= HTTP_DEBUG_LOG_MAX_BYTES) {
      // rename-then-append: another companion appending concurrently just
      // recreates the fresh file, so rotation never loses more than a line.
      await rename(HTTP_DEBUG_LOG_PATH, `${HTTP_DEBUG_LOG_PATH}.1`);
      httpDebugLogModeEnsured = false;
    }
  } catch {
    /* absent or unstattable — the append below creates it */
  }
  await appendFile(HTTP_DEBUG_LOG_PATH, line, { mode: 0o600 });
  if (!httpDebugLogModeEnsured) {
    httpDebugLogModeEnsured = true;
    await chmod(HTTP_DEBUG_LOG_PATH, 0o600).catch(() => undefined);
  }
};

const responseHeaders = {
  'access-control-allow-headers': 'content-type,x-bac-bridge-key,idempotency-key,if-none-match',
  'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'etag',
  'content-type': 'application/json; charset=utf-8',
};

const sendJson = (response: ServerResponse, status: number, value: unknown): void => {
  response.writeHead(status, responseHeaders);
  response.end(status === 204 ? '' : `${JSON.stringify(value)}\n`);
};

// Conditional-GET helper: hash the response body, compare against
// `If-None-Match`, return a body-less 304 if it matches. The companion
// still computes the response (existing in-memory memos / cachedRoute
// keep the work cheap), but skips wire-format JSON serialisation cost
// for the extension AND lets the extension's `loadX` cycle short-circuit
// without re-decoding + re-setting React state. Wired in the GET dispatch
// path below; non-GET methods pass straight through.
const ETAG_OK_STATUSES = new Set<number>([200]);

// `requestId` is generated per-request (used for log correlation), so
// it differs even when the underlying response state is unchanged.
// Strip it from the hash input so polled endpoints that embed it
// (e.g. /v1/version, /v1/status) still produce a stable ETag.
// Pattern handles both leading/trailing comma positions.
const REQUEST_ID_HASH_STRIP_RE = /,?"requestId":"[^"]*"|"requestId":"[^"]*",?/g;

// Body hash via FNV-1a 64-bit, computed inline. We deliberately do NOT
// use `node:crypto` here — `createHash('sha256')` on Bun's polyfill
// allocates a SubtleCrypto wrapper + a chain of helpers (TextEncoder,
// WeakMap, RegExp, MIMEParams) per call that JSC retains stubbornly.
// At hot-poll rates (~2 req/s × ~75% reaching this path) those wrappers
// accumulate into the millions before GC catches up — heap snapshots
// showed 1.18M SubtleCrypto instances after a few minutes, driving the
// physical footprint from ~1 GB → 4+ GB. ETag doesn't need crypto-grade
// collision resistance, just stable digesting; FNV-1a is allocation-free
// and produces a 16-hex-char fingerprint that's plenty for cache validation.
const FNV_OFFSET_64_LOW = 0xe6546b64 | 0;

const FNV_OFFSET_64_HIGH = 0xcbf29ce4 | 0;

const fnv1a64Hex = (input: string): string => {
  let lo = FNV_OFFSET_64_LOW;
  let hi = FNV_OFFSET_64_HIGH;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    // XOR low half with current byte.
    lo = (lo ^ code) | 0;
    // Multiply [hi:lo] by 1099511628211 = 0x100000001b3. Decompose into
    // two 32-bit chunks so we can stay in safe-integer arithmetic.
    // h * 0x100000001b3 = h * 0x1 0000 0000 + h * 0x1b3
    // Carry through both halves; mask to 32 bits each.
    const newLo = Math.imul(lo, 0x1b3) | 0;
    const carry = Math.floor(((lo >>> 0) * 0x1b3) / 0x100000000);
    const newHi = (Math.imul(hi, 0x1b3) + carry + (lo | 0)) | 0;
    lo = newLo;
    hi = newHi;
  }
  // 16 hex chars: 8 from high half, 8 from low half. Right-shift then
  // zero-pad to keep the same width regardless of leading zeros.
  const hiHex = (hi >>> 0).toString(16).padStart(8, '0');
  const loHex = (lo >>> 0).toString(16).padStart(8, '0');
  return `${hiHex}${loHex}`;
};

const computeBodyEtag = (status: number, value: unknown): string | null => {
  if (!ETAG_OK_STATUSES.has(status)) return null;
  const serialised = JSON.stringify(value).replace(REQUEST_ID_HASH_STRIP_RE, '');
  return `"b-${fnv1a64Hex(serialised)}"`;
};

const sendJsonWithEtag = (
  response: ServerResponse,
  status: number,
  value: unknown,
  etag: string,
): void => {
  response.writeHead(status, { ...responseHeaders, etag });
  response.end(status === 204 ? '' : `${JSON.stringify(value)}\n`);
};

const send304 = (response: ServerResponse, etag: string): void => {
  // 304 MUST NOT include a body. Surface ETag so the client can still
  // refresh its cached copy's validator if it doesn't already store it.
  response.writeHead(304, { ...responseHeaders, etag });
  response.end();
};

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

// Explicitly-public paths: reachable without the bridge key. Auth is
// evaluated BEFORE route matching (so an unauthenticated caller can't
// enumerate routes via 404-vs-401), which means this allowlist — not
// the per-route `authRequired: false` flag — is the source of truth for
// what an unauthenticated caller may reach. It MUST stay in sync with
// the pre-auth surface the extension relies on:
//   - /v1/version — the attach/identity probe pinned on first connect
//                   and compared on every poll (port-reuse detection).
//   - /v1/health  — the bare liveness probe.
// The debug/diagnostic routes (/debug/heap-snapshot, /debug/gc) are
// deliberately absent: they now require auth like every other route.
const PUBLIC_UNAUTHENTICATED_PATHS: ReadonlySet<string> = new Set(['/v1/version', '/v1/health']);

const isPublicUnauthenticatedPath = (method: string | undefined, pathname: string): boolean =>
  method === 'GET' && PUBLIC_UNAUTHENTICATED_PATHS.has(pathname);

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

// W4(b-lite) — semantic recall pool: lazy non-blocking refresh +
// read-only candidate expansion. NEVER runs in the materializer
// drain; the query path only READS the cached artifact (bounded
// latency); the build is fire-and-forget off the request path.
// Déjà-vu's semantic-recall-pool query fires this detached
// full-corpus re-embed (ONNX e5 sidecar). With a cold/warming
// embedder each attempt fails, persists nothing, and the NEXT Déjà-vu
// re-triggers it → query→rebuild→still-cold→rebuild, ~99% CPU in the
// embedder child (HTTP log stays fast — the work isn't on the request
// path). Two structural guards, mirroring /v1/recall/query's
// isVectorUsable: (1) don't kick unless the embedder is usable;
// (2) a cooldown so serial Déjà-vu auto-fires can't thrash a
// full-corpus re-embed even once warm. The pool is a background
// "Similar" nicety — ≤cooldown staleness is fine.
const SEMANTIC_REFRESH_COOLDOWN_MS = ((): number => {
  const raw = process.env['SIDETRACK_SEMANTIC_REFRESH_COOLDOWN_MS'];
  const n = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 300_000;
})();

let semanticRecallRefreshInFlight = false;

let semanticRecallLastRefreshMs = 0;

const kickSemanticRecallPoolRefresh = (vaultRoot: string, embedderUsable: boolean): void => {
  if (semanticRecallRefreshInFlight) return;
  if (!embedderUsable) return;
  if (Date.now() - semanticRecallLastRefreshMs < SEMANTIC_REFRESH_COOLDOWN_MS) return;
  semanticRecallRefreshInFlight = true;
  semanticRecallLastRefreshMs = Date.now();
  void (async () => {
    try {
      const records = await listPageEvidenceRecords(vaultRoot);
      // Embed CONTENT (keyphrases/entities/top-weighted terms) when
      // available, not URL identity. The previous shape
      // `[title, host, pathTokens]` was dominated by the host token
      // for any same-host-but-different-page set (every chatgpt.com
      // chat URL got cosine ≥ 0.92 to every other one regardless of
      // topic — 16% of pool edges were ≥ 0.99). Content-derived
      // tokens give the embedding actual topic signal; for records
      // without `content` (page-text auto-extract off — every chat
      // URL today, since chat-turn capture goes through a separate
      // pipeline), fall back to the URL-identity shape but drop the
      // bare host token so the embedding doesn't collapse to the
      // same-host vector. Chat-URL similarity becomes meaningful
      // once the chunk-text source is wired in (tracked separately).
      const items = records
        .map((r) => {
          const c = r.content;
          const contentTokens = c
            ? [
                ...c.keyphrases.slice(0, 20).map((k) => k.term),
                ...c.entities.slice(0, 20).map((e) => e.text),
                ...c.terms.slice(0, 30).map((t) => t.term),
              ]
            : [];
          const base = [r.metadata.title ?? '', ...(r.metadata.pathTokens ?? [])];
          // Host stays out of the embed input entirely — its
          // domination of cosine for same-host clusters was the
          // primary bug. The provenance still has host via pathTokens
          // upstream where it matters; recall similarity is about
          // topic, not URL structure.
          return {
            canonicalUrl: r.canonicalUrl,
            text: [...base, ...contentTokens]
              .filter((s) => s.length > 0)
              .join(' ')
              .trim(),
          };
        })
        .filter((i) => i.text.length > 0);
      if (items.length >= 2) {
        const { embed, MODEL_ID } = await loadEmbedderModule();
        await getOrBuildSemanticRecallPool(vaultRoot, { items, embed, modelId: MODEL_ID });
      }
    } catch {
      /* offline / embed unavailable — keep last good artifact */
    } finally {
      semanticRecallRefreshInFlight = false;
    }
  })();
};

const setCallerIdentity = (request: IncomingMessage, identity: CallerIdentity): void => {
  callerIdentities.set(request, identity);
};

// F02 systemic default-deny for MCP-key callers. Trust enforcement is
// per-tool-per-workstream, but only a HANDFUL of mutating routes call
// requireWorkstreamTrust — every OTHER mutating route was reachable by an
// mcp-key caller with zero trust check (self-granting via PUT /trust,
// deleting/renaming workstreams, mutating settings, writing annotations).
// The route-dispatch layer now DENIES any mutating method (POST/PUT/PATCH/
// DELETE) for an mcp caller UNLESS the route is in this explicit allowlist.
// GET/read routes stay open. Allowed routes STILL run their own
// requireWorkstreamTrust gate — the allowlist only decides which mutating
// routes an mcp caller may attempt at all; per-workstream trust is enforced
// inside the handler as before.
//
// The set is derived from the sanctioned workstream write tools
// (workstreamWriteTools): threads.move (POST /v1/threads + the thread
// archive/unarchive sub-routes), queue.create (POST /v1/queue),
// workstreams.bump (POST /v1/workstreams/:id/bump), workstreams.create
// (POST /v1/workstreams). Trust management (PUT/GET /trust), DELETE/PATCH
// workstream, PATCH settings, export, and annotation writes are NOT
// sanctioned MCP operations → they fall through to the default-deny.
const MCP_ALLOWED_MUTATING_ROUTES: readonly {
  readonly method: HttpMethod;
  readonly pattern: RegExp;
}[] = [
  // threads.move — a thread upsert that (re)assigns primaryWorkstreamId.
  { method: 'POST', pattern: /^\/v1\/threads$/ },
  // threads.archive / threads.unarchive.
  { method: 'POST', pattern: /^\/v1\/threads\/[A-Za-z0-9_-]+\/archive$/ },
  { method: 'POST', pattern: /^\/v1\/threads\/[A-Za-z0-9_-]+\/unarchive$/ },
  // queue.create.
  { method: 'POST', pattern: /^\/v1\/queue$/ },
  // workstreams.bump.
  { method: 'POST', pattern: /^\/v1\/workstreams\/[A-Za-z0-9_-]+\/bump$/ },
  // workstreams.create (child create is trust-gated on the parent inside
  // the handler; a top-level create passes trust but is still a
  // sanctioned tool, so it is allowed here).
  { method: 'POST', pattern: /^\/v1\/workstreams$/ },
];

const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Whether an mcp-key caller may attempt this route at all. Reads (and any
// non-mutating method) are always permitted; a mutating route is permitted
// only when it appears in the sanctioned allowlist above.
const isMcpAllowedRoute = (method: string | undefined, pathname: string): boolean => {
  if (method === undefined || !MUTATING_METHODS.has(method)) {
    return true;
  }
  return MCP_ALLOWED_MUTATING_ROUTES.some(
    (route) => route.method === method && route.pattern.test(pathname),
  );
};

const auditAgentLabel = (identity: CallerIdentity): string =>
  identity.callerClass === 'mcp'
    ? identity.clientName === undefined
      ? 'mcp'
      : `mcp:${identity.clientName}`
    : 'extension';

// The tool header is retained for LOGGING during the deprecation window
// only — enforcement no longer depends on it. Kept as a best-effort
// provenance hint (which tool a caller CLAIMS to be) even though the
// server derives the actual trust decision from the authenticating key.
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

// Parse the optional `titleHints` map (canonicalUrl → live page title) from a
// batch-resolve body. FROZEN CONTRACT validation, TOLERANT: string values,
// each ≤ 500 chars, at most 100 entries — invalid entries / shapes are dropped
// silently (never a 400). Returns an empty map for any non-object input so
// callers can `.get` unconditionally.
const TITLE_HINT_MAX_LEN = 500;

const TITLE_HINT_MAX_ENTRIES = 100;

const parseTitleHints = (raw: unknown): ReadonlyMap<string, string> => {
  const out = new Map<string, string>();
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [url, value] of Object.entries(raw as Record<string, unknown>)) {
    if (out.size >= TITLE_HINT_MAX_ENTRIES) break;
    if (typeof url !== 'string' || url.length === 0) continue;
    if (typeof value !== 'string' || value.length === 0 || value.length > TITLE_HINT_MAX_LEN) {
      continue;
    }
    out.set(url, value);
  }
  return out;
};

// Content-lane (guess lane 7) deps, assembled ONCE per batch-resolve request so
// the store handle + embedder state are read a single time and shared across
// every URL in the batch. Reuses the ALREADY-OPEN /v2 recall store via
// peekRecallV2Store (undefined when no /v2 query has opened it yet — the lane
// then degrades to a typed-empty 'recall store unavailable', never opening a
// second connection). The embed fn routes through the recall embedder lazily
// (kept out of the static import graph — statusContract ban) and is only ever
// invoked inside the content lane's bounded Promise.race. No-op returning
// content-lane-off deps when either flag is off.
const buildContentLaneDeps = async (
  context: CompanionHttpConfig,
  vaultRoot: string,
): Promise<AppendContentLaneDeps> => {
  const guessOn = guessLanesEnabled();
  if (!guessOn || !contentLaneEnabled()) {
    return { store: undefined, embedderUsable: false, guessLanesEnabled: guessOn };
  }
  let store: ContentLaneStore | undefined;
  try {
    const { peekRecallV2Store, warmRecallV2Store } = await import('../recall-v2/pipeline.js');
    // peekRecallV2Store returns the cached handle only — never opens a new one.
    store = (await peekRecallV2Store(vaultRoot)) as ContentLaneStore | undefined;
    if (store === undefined) {
      // NOBODY ELSE OPENS IT FOR US. The only opener is POST /v2/recall (the
      // Related strip), so after every companion restart the content and AI
      // lanes report "recall store unavailable" until the panel happens to fire
      // a /v2 query — an unbounded window in which the two lanes that depend on
      // page CONTENT are silently dead. Observed repeatedly on 2026-07-28.
      //
      // Warm it in the BACKGROUND: open only, no backfill (that is the ~7000-row
      // loop that starves /v1/status), and deliberately not awaited. This
      // resolve still returns a typed-empty lane; the next one finds a handle.
      warmRecallV2Store(vaultRoot);
    }
  } catch {
    store = undefined;
  }
  const embedderState = context.getEmbedderStatus?.()?.state;
  const embedderUsable = embedderState === 'ready' || embedderState === 'disabled';
  // E2 — the lane's query embed consults the SHARED (model, sha256(text))
  // cache before paying for an ONNX pass. This is the same file the
  // visit-similarity materializer and the recall-v2 chunk backfill write, so a
  // query whose exact text has been embedded anywhere on this machine is free,
  // and it survives restarts (contentLane's own LRU does not — its emptiness
  // after a restart is part of the §G2 seam).
  //
  // READ-THROUGH ONLY, deliberately. A `put` rewrites the whole cache file;
  // at full corpus that is ~97MB, and doing it once per resolved URL would put
  // exactly the kind of unbounded I/O back on the request path that the resolve
  // work keeps taking off it. The lane's bounded in-process LRU stays the write
  // side for query vectors. Documented in the substrate map as the boundary.
  const embed = embedderUsable
    ? async (text: string): Promise<Float32Array | undefined> => {
        try {
          const cached = await createEmbeddingCache(vaultRoot, RECALL_MODEL.embeddingDim).getMany(
            VECTOR_CORPUS_MODEL_KEY,
            [embedTextHash(text)],
          );
          const hit = cached.get(embedTextHash(text));
          if (hit !== undefined) return hit;
        } catch {
          /* cache is an optimisation — fall through to a real embed */
        }
        try {
          const { embed: embedFn } = await import('../recall/embedder.js');
          const [vec] = await embedFn([text]);
          return vec;
        } catch {
          return undefined;
        }
      }
    : undefined;
  // Authoritative neighbor-URL → workstream lookup for the lane's join (see
  // urlWorkstreamLookupFromProjection for the full WHY). Undefined on a
  // non-sqlite store — the lane then keeps its snapshot-join fallback.
  const lookupWorkstreamByUrl = await urlWorkstreamLookupFromProjection(context);
  return {
    store,
    ...(embed === undefined ? {} : { embed }),
    embedderUsable,
    guessLanesEnabled: guessOn,
    ...(lookupWorkstreamByUrl === undefined ? {} : { lookupWorkstreamByUrl }),
  };
};

// ---- the decision loop's serve-time context (review E1 + E6) -----------
//
// Two folded lookups the lane seam needs, loaded ONCE per batch:
//   - declines: the user's "Not in any stream" answers. Consulted by BOTH the
//     lane-fallback (never guess on a page the user refused) and the
//     corroboration promotion (a refusal vetoes it).
//   - calibration: each lane's MEASURED precision@1, the evidence the
//     promotion self-gates on. Absent ⇒ no promotion, by design.
//
// NO EXTRA SCAN. The declines fold from the `merged` array this route has
// ALREADY read (memoized on the same log signature the enrichment folds use),
// not from a second readMerged — the batch path's one-scan promise is
// load-bearing and asserted by visitsRoutes.test.ts. The caller must therefore
// pass an array that includes USER_ORGANIZED_ITEM; both branches do (see the
// typed reads above). The calibration is a file read and is only paid when the
// promotion flag that consumes it is actually on.
//
// Both degrade to null on any failure: the fallback then behaves exactly as it
// did before this feature, and the promotion refuses — the safe direction.
interface LaneDecisionContext {
  readonly declines: DeclineLookup | null;
  readonly calibration: LanePrequentialSummary | null;
}

const laneDecisionContextFor = async (
  vaultRoot: string,
  mergedEvents: readonly AcceptedEvent[],
  logSignature: string,
): Promise<LaneDecisionContext> => {
  let declines: DeclineLookup | null = null;
  try {
    declines = declineMemoryFromMerged(vaultRoot, logSignature, mergedEvents);
  } catch {
    declines = null;
  }
  const calibration = laneCorroborationEnabled()
    ? await lanePrequentialSummary(vaultRoot).catch(() => null)
    : null;
  return { declines, calibration };
};

// The two decision-layer transforms, in the order they must run: DECIDE first
// (corroboration may promote a held pick), then FALL BACK (only reachable when
// fusion produced nothing at all). Their trigger conditions are disjoint on
// `gate.reason`, so the order cannot change an outcome — it is written this way
// because that is the order a reader should understand them in.
//
// Both run on the SERVED copy, after the resolver-cache write, exactly like the
// lanes they read. Nothing either produces is persisted or replayed.
const applyLaneDecisions = (
  result: UrlResolutionResult,
  canonicalUrl: string,
  laneContext: LaneDecisionContext,
): UrlResolutionResult =>
  applyLaneFallbackGuess(
    applyLaneCorroboration(result, {
      canonicalUrl,
      calibration: laneContext.calibration,
      declines: laneContext.declines,
    }),
    { canonicalUrl, declines: laneContext.declines },
  );

// Fire-and-forget the prequential prediction append. Deliberately NOT awaited on
// the response path: it is a measurement, and a slow or failing disk must cost
// a data point rather than a resolve. One write per batch (see
// recordLanePredictions), not one per URL.
const recordLanePredictionsBestEffort = (
  vaultRoot: string,
  entries: readonly LanePredictionInput[],
  requestId: string,
): void => {
  if (entries.length === 0) return;
  void recordLanePredictions(vaultRoot, entries).catch((error: unknown) => {
    // PII-free: counts and error class only, never URLs or workstream ids.
    console.warn('[lane-prequential]', {
      requestId,
      operation: 'lane-prequential.prediction-record',
      outcome: 'error',
      opportunityCount: entries.length,
      errorCategory: error instanceof Error ? error.name : 'unknown',
    });
  });
};

const privacyEventsFrom = (events: readonly import('../sync/causal.js').AcceptedEvent[]) =>
  events.filter((event) => isPrivacyEventType(event.type));

// Bound for the BROWSER_TIMELINE_OBSERVED window fed to candidate generation
// (perf/event-candidate-resolve) — mirrors the resolver hub-subgraph budgets
// (SIDETRACK_RESOLVER_SUBGRAPH_NODE_BUDGET etc., connections/snapshot.ts):
// generateCandidates needs BREADTH (same-domain / opener-chain / navigation-
// chain discovery across many URLs, not just the target's own events), so it
// cannot be made a by-URL indexed read the way the target's own signal/
// timeline events were — but it does not need the vault's ENTIRE
// BROWSER_TIMELINE_OBSERVED history either. Most-recent-N is a reasonable,
// honestly-bounded proxy (browsing-candidate relevance is recency-biased in
// practice) and caps the worst case instead of leaving it open-ended. `0` is
// the kill switch — falls back to the prior unbounded type-scoped read.
const RESOLVER_CANDIDATE_TIMELINE_WINDOW_ENV = 'SIDETRACK_RESOLVER_CANDIDATE_TIMELINE_WINDOW';
const DEFAULT_RESOLVER_CANDIDATE_TIMELINE_WINDOW = 20_000;
const resolverCandidateTimelineWindow = (): number => {
  const raw = process.env[RESOLVER_CANDIDATE_TIMELINE_WINDOW_ENV];
  if (raw === undefined || raw.length === 0) return DEFAULT_RESOLVER_CANDIDATE_TIMELINE_WINDOW;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.floor(parsed)
    : DEFAULT_RESOLVER_CANDIDATE_TIMELINE_WINDOW;
};

// The timeline events fed to resolverExpandedCandidateUrlsForCanonicalUrls.
// Indexed + bounded when the typed store is available (readMostRecentByType,
// events_type_accepted_at_idx — O(window) instead of O(all
// BROWSER_TIMELINE_OBSERVED-ever)); the store-unavailable path falls back to
// filtering the `merged` array, which is ONLY safe because `merged` still
// carries the wide RESOLVER_EXPAND_EVENT_TYPES list whenever the store is
// null (see the merged read above) — that branch selection and this one must
// stay in lockstep. `0` (kill switch) with the store available still reads
// indexed, just type-scoped + unbounded (forEachChunkOfTypes), NOT a
// merged-filter — `merged` no longer carries BROWSER_TIMELINE_OBSERVED at
// all once the store is up, so filtering it here would silently return
// nothing.
const timelineEventsForCandidateGeneration = async (
  typedEventStore: Awaited<ReturnType<typeof eventStoreForContext>>,
  merged: readonly AcceptedEvent[],
): Promise<readonly AcceptedEvent[]> => {
  if (typedEventStore === null) {
    return merged.filter((event) => event.type === BROWSER_TIMELINE_OBSERVED);
  }
  const window = resolverCandidateTimelineWindow();
  if (window <= 0) {
    const events: AcceptedEvent[] = [];
    await typedEventStore.forEachChunkOfTypes(
      [BROWSER_TIMELINE_OBSERVED],
      (chunk) => {
        events.push(...chunk);
      },
      2000,
    );
    return events;
  }
  return typedEventStore.readMostRecentByType(BROWSER_TIMELINE_OBSERVED, window);
};

// SWR serve-key for a batch-resolve item. Namespaced `|batch` (distinct from
// the GET route's `|?dryRun=…` query) because the batch path reads a
// different subgraph shape; the `visres:` prefix keeps invalidateResolveCaches
// purging it on user decisions.
const batchResolveSwrKey = (canonicalUrl: string): string => `visres:${canonicalUrl}|batch`;

// Background refresh for a single stale batch item: recompute via the
// canonical single-URL subgraph + signal events (identical to what the GET
// /v1/visits/:url/resolve route and cacheResolverResult persist for one URL).
// Best-effort; failures leave the stale entry in place until the next request.
const buildBatchResolveRefresh =
  (
    context: CompanionHttpConfig,
    sqliteStore: SqliteConnectionsStore,
    canonicalUrl: string,
    snapshotRevision: string | undefined,
  ) =>
  async (): Promise<readonly [number, unknown]> => {
    const snapshot = await sqliteStore.readResolverSubgraphForUrl(canonicalUrl);
    if (snapshot === null) return [409, { error: 'CONNECTIONS_SNAPSHOT_MISSING' }];
    const merged = await readEventsFromStoreOrLog(
      context,
      context.eventLog!,
      (event) => event.type === USER_FLOW_REJECTED || event.type === USER_ORGANIZED_ITEM,
      RESOLVER_SIGNAL_EVENT_TYPES,
    );
    const result = await resolveUrlAttributionArmed({
      vaultRoot: requireVaultRoot(context),
      canonicalUrl,
      snapshot,
      events: resolverSignalEventsForCanonicalUrls(merged, [canonicalUrl]),
      // F1 privacy gate (mirrors the GET + batch inline paths).
      tombstones: await domainTombstoneSetFor(context),
      useEventCandidateSimilarity: false,
    });
    // Keep the sqlite per-revision cache warm too so a same-revision GET hits.
    // Arm + state-aware key (F3/F4) so this warm-write matches the GET route's
    // read key and a stale-arm/stale-state entry is never served.
    if (snapshotRevision !== undefined) {
      await sqliteStore.cacheResolverResult(
        canonicalUrl,
        await resolverCacheRevision(snapshotRevision, requireVaultRoot(context)),
        result,
      );
    }
    return [200, result];
  };

// Serve a batch item from the SWR cache if a (possibly-stale) entry exists,
// enqueuing a bounded single-URL background refresh when the graph sig has
// moved. Returns undefined for a true-cold item so the batch loop computes it
// inline in the existing batched path. The gated build keeps background
// resolves under the shared resolve-concurrency dial.
const serveStaleBatchItem = (
  context: CompanionHttpConfig,
  sqliteStore: SqliteConnectionsStore,
  canonicalUrl: string,
  graphSig: string,
  snapshotRevision: string | undefined,
): UrlResolutionResult | undefined => {
  const refresh = buildBatchResolveRefresh(context, sqliteStore, canonicalUrl, snapshotRevision);
  const gatedRefresh = async (): Promise<readonly [number, unknown]> => {
    await acquireResolveSlot();
    try {
      return await refresh();
    } finally {
      releaseResolveSlot();
    }
  };
  const served = resolveSwrCache.serveStaleOnly(
    batchResolveSwrKey(canonicalUrl),
    graphSig,
    gatedRefresh,
  );
  if (served === undefined) return undefined;
  // The cached SWR value is a `[200, UrlResolutionResult]` tuple (see
  // primeBatchSwrEntry / buildBatchResolveRefresh); unwrap it back to the raw
  // result the batch response embeds. The freshness marker is per-item and not
  // surfaced in the batch response body (additive field is on the single-item
  // routes); the batch already tolerates ≤TTL staleness by contract.
  return served.result[1] as UrlResolutionResult;
};

// Seed the SWR cache from a batch item that resolved inline, storing the
// `[200, result]` tuple shape the refresh/serve path expects.
const primeBatchSwrEntry = (
  canonicalUrl: string,
  graphSig: string,
  result: UrlResolutionResult,
): void => {
  resolveSwrCache.prime(batchResolveSwrKey(canonicalUrl), graphSig, [200, result]);
};

// ---- content-lane join-snapshot memo (perf/event-candidate-resolve) ----
//
// On an all-cache-hit batch (misses.length === 0 ⇒ missedSnapshot === null)
// the content-lane join below used to call sqliteStore.readResolverSubgraph
// ForUrls(uniqueUrls) UNCONDITIONALLY — the exact "subgraph read on an
// all-hit batch" item 4 forbids, and the single biggest cost measured on a
// warm re-poll (350ms-10s+ under load; the resolver hub-subgraph traversal
// budgets from perf/resolver-subgraph-budget cap it, but capped still means
// "walk up to 1200 nodes / 4000 edges", not "free"). The panel re-polls the
// SAME small visible-tab URL set every few seconds, so this is memoizable:
// `readResolverSubgraphForUrls`'s answer for a given URL set is a pure
// function of `snapshotRevision` — the SAME trust boundary the resolver
// cache itself already relies on (its entries are keyed on nothing but
// snapshotRevision + arm/state) — so reusing a memoized snapshot across
// requests is exactly as fresh as re-reading, never stale. Revision-gated,
// not TTL-gated: a stale revision is simply never a hit.
const JOIN_SNAPSHOT_MEMO_CAP = 32;
const joinSnapshotMemo = new Map<
  string,
  { readonly revision: string; readonly snapshot: ConnectionsSnapshot }
>();
const joinSnapshotMemoKey = (urls: readonly string[]): string =>
  [...new Set(urls)].sort().join('\u0000');
const memoizedJoinSnapshot = async (
  sqliteStore: SqliteConnectionsStore,
  snapshotRevision: string,
  urls: readonly string[],
): Promise<ConnectionsSnapshot | null> => {
  const key = joinSnapshotMemoKey(urls);
  const cached = joinSnapshotMemo.get(key);
  if (cached !== undefined && cached.revision === snapshotRevision) return cached.snapshot;
  const snapshot = await sqliteStore.readResolverSubgraphForUrls(urls);
  if (snapshot !== null) {
    if (joinSnapshotMemo.size >= JOIN_SNAPSHOT_MEMO_CAP && !joinSnapshotMemo.has(key)) {
      const oldestKey = joinSnapshotMemo.keys().next().value;
      if (oldestKey !== undefined) joinSnapshotMemo.delete(oldestKey);
    }
    joinSnapshotMemo.set(key, { revision: snapshotRevision, snapshot });
  }
  return snapshot;
};

// ---- the single decoration seam (stage S3) -----------------------------
//
// Every result this route serves — resolver-cache hit, SWR-stale, or
// freshly computed, on EITHER store path below — gets the SAME query-time
// treatment: the content lane (7), the ai lane (8), and the decision layer
// over them (corroboration promotion + lane-fallback guess). Before this
// seam existed the two terminals each carried their own copy of that
// per-URL sequence, so a cross-cutting addition (a ninth lane, another
// decision-layer transform) had two edit sites to keep in sync — and the
// guess-lane extras append had a documented history of landing in one and
// being missed in the other. Both terminals now call this ONE function,
// immediately before they build the response tuple, so a future per-result
// field is a single edit here.
//
// Callers keep their OWN decision about whether to invoke it at all — the
// sqlite path's `guessLanesEnabled && contentLaneEnabled()` gate stays at
// that call site, not inside this function — and their own `joinSnapshot` /
// lane-decision context. Only the per-URL BODY is shared.
// `appendContentLane` / `appendAiLane` / `applyLaneDecisions` are themselves
// idempotent no-ops when their flags are off or `lanes` is absent, so this
// function degrades exactly the way the two inline copies it replaces
// already did.
// Prototype-lane (guess lane 9) deps, DERIVED from the content-lane deps
// rather than assembled independently — the underlying store handle, embed
// fn and embedder-usable flag are the SAME already-open /v2 recall store the
// content/AI lanes use (see recall-v2/store/sqlite.ts: prototype_vec lives
// in the same database as docs_vec). Casting `store` to the narrower
// PrototypeLaneStore shape is safe: the concrete SqliteRecallStore
// implements both, and the cast is exactly the ContentLaneStore precedent
// (peekRecallV2Store returns RecallStore; call sites narrow to the subset
// they need). No second store handle is opened.
const prototypeLaneDepsFromContent = (
  contentDeps: AppendContentLaneDeps,
): AppendPrototypeLaneDeps => ({
  store: contentDeps.store as unknown as PrototypeLaneStore | undefined,
  ...(contentDeps.embed === undefined ? {} : { embed: contentDeps.embed }),
  embedderUsable: contentDeps.embedderUsable,
  guessLanesEnabled: contentDeps.guessLanesEnabled,
});

const finalizeBatchResolveResults = async (
  results: Record<string, UrlResolutionResult>,
  urls: readonly string[],
  joinSnapshot: ConnectionsSnapshot,
  contentDeps: AppendContentLaneDeps,
  laneContext: LaneDecisionContext,
  titleHints: ReadonlyMap<string, string>,
  synthesizedTitleFor: (canonicalUrl: string) => string | undefined,
  gistFor: (canonicalUrl: string) => string | undefined,
): Promise<void> => {
  const prototypeDeps = prototypeLaneDepsFromContent(contentDeps);
  for (const canonicalUrl of urls) {
    // Two lanes per URL now (content + ai), each a vector KNN plus an FTS
    // query plus a workstream join — all synchronous sqlite. This loop runs
    // for EVERY url in the batch including cache hits, so it is the longest
    // uninterrupted stretch in the route.
    await yieldToEventLoop();
    const title =
      titleHints.get(canonicalUrl) ??
      titleForCanonicalUrl(joinSnapshot, canonicalUrl, synthesizedTitleFor(canonicalUrl)) ??
      null;
    const gist = gistFor(canonicalUrl) ?? null;
    results[canonicalUrl] = await appendContentLane(
      results[canonicalUrl]!,
      { canonicalUrl, snapshot: joinSnapshot, title, gist },
      contentDeps,
    );
    // PHASE BREAK: lane 7 -> lane 8. Each lane is an independent KNN + FTS +
    // workstream join; running both without a break makes one URL cost two
    // full lane computations in a single tick, and the measured
    // `content-lane batch=1 dur=966ms` diag says that pair is ~1s of the
    // route on its own. buildContentLane also yields BETWEEN its own phases
    // now (contentLane.ts) — this break is the one it cannot make for itself.
    await yieldToEventLoop();
    // Lane 8, same inputs, gist-only query — see appendAiLane.
    results[canonicalUrl] = await appendAiLane(
      results[canonicalUrl]!,
      { canonicalUrl, snapshot: joinSnapshot, title, gist },
      contentDeps,
    );
    // PHASE BREAK: lane 8 -> lane 9. Same discipline as the break above —
    // the prototype lane is a single KNN + O(hits) group-by, cheap, but the
    // break keeps this loop's per-URL cost from compounding into one
    // uninterruptible tick across a whole batch.
    await yieldToEventLoop();
    // Lane 9 — pure vector match against offline-generated prototypes. NO
    // LLM call on this path (see prototypeLane.ts's header).
    results[canonicalUrl] = await appendPrototypeLane(
      results[canonicalUrl]!,
      { title, gist },
      prototypeDeps,
    );
    // The decision layer over the lanes just appended: the corroboration
    // promotion (flagged OFF by default) and the lane-fallback guess, both
    // decline-vetoed. See applyLaneDecisions — and note that, exactly like
    // the lanes themselves, this runs AFTER the resolver-cache write, so
    // nothing it produces is ever persisted.
    results[canonicalUrl] = applyLaneDecisions(results[canonicalUrl]!, canonicalUrl, laneContext);
  }
};

// Stamp one durable, opaque opportunity id onto every result that contains at
// least one real lane prediction, and build the matching append inputs. This
// runs after the query-time lane decoration but outside its feature gate, so
// the six structural lanes still get an attributable opportunity when the
// content lane is disabled. Repeated polls over an unchanged dependency + top
// picks derive the same id; lanePrequential's reader deduplicates them.
const stampLanePredictionOpportunities = (
  results: Record<string, UrlResolutionResult>,
  urls: readonly string[],
): readonly LanePredictionInput[] => {
  const predictions: LanePredictionInput[] = [];
  for (const canonicalUrl of urls) {
    const result = results[canonicalUrl];
    if (result === undefined) continue;
    const opportunityId = laneOpportunityIdFor({
      canonicalUrl,
      dependencyKey: result.reasons.dependencyKey,
      lanes: result.lanes,
    });
    if (opportunityId === undefined) {
      predictions.push({ canonicalUrl, lanes: result.lanes });
      continue;
    }
    results[canonicalUrl] = { ...result, servedOpportunityId: opportunityId };
    predictions.push({ canonicalUrl, lanes: result.lanes, opportunityId });
  }
  return predictions;
};

// ---- the single unconditional response boundary (stage S5) ------------
//
// Both batch-resolve terminals below — the SqliteConnectionsStore path and
// the plain-store fallback — build their 200 response ONLY through this
// function. It is UNCONDITIONAL by design: no feature-flag gating anywhere
// in it, unlike finalizeBatchResolveResults (the flag-gated per-URL lane
// seam above, which callers still invoke themselves, on their own gate,
// BEFORE reaching this boundary). A cross-cutting per-result wire field
// that must apply regardless of guessLanesEnabled / contentLaneEnabled, or
// a new top-level response field (today there is exactly one:
// snapshotRevision), is therefore a single edit site here instead of two.
//
// Reproduces both terminals' prior top-level shape exactly — `results` is
// passed straight through as `data.results` (same reference, no copy), and
// `snapshotRevision` is included only when defined, matching the
// `...(snapshotRevision === undefined ? {} : { snapshotRevision })` spread
// each terminal built inline before this extraction.
const buildBatchResolveResponse = (
  results: Record<string, UrlResolutionResult>,
  snapshotRevision: string | undefined,
): readonly [
  200,
  { data: { results: Record<string, UrlResolutionResult> }; snapshotRevision?: string },
] => [
  200,
  {
    data: { results },
    ...(snapshotRevision === undefined ? {} : { snapshotRevision }),
  },
];

export const routes: readonly RouteDefinition[] = [
  ...(process.env['DEBUG_HEAP_SNAPSHOT'] === '1'
    ? [
        {
          method: 'POST' as const,
          pattern: /^\/debug\/heap-snapshot$/,
          // Diagnostic route: dumps a full heap snapshot to disk. Auth
          // required — it must never be an unauthenticated data-leak
          // vector even when DEBUG_HEAP_SNAPSHOT=1 is set.
          authRequired: true,
          handle: async () => {
            const path = await writeDebugHeapSnapshot();
            return [201, { data: { path } }] as const;
          },
        },
        {
          method: 'POST' as const,
          pattern: /^\/debug\/gc$/,
          // Diagnostic route: forces a GC. Auth required.
          authRequired: true,
          handle: async () => {
            const before = process.memoryUsage().rss;
            (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun?.gc?.(true);
            await new Promise((resolve) => setTimeout(resolve, 300));
            const after = process.memoryUsage().rss;
            return [
              200,
              {
                data: {
                  rssBeforeMb: Math.round(before / 1048576),
                  rssAfterMb: Math.round(after / 1048576),
                  freedMb: Math.round((before - after) / 1048576),
                },
              },
            ] as const;
          },
        },
      ]
    : []),
  ...systemRoutesA,
  ...privacyRoutes,
  ...feedbackRoutes,
  ...tabsessionRoutes,
  ...visitsRoutesA,
  {
    method: 'POST',
    pattern: /^\/v1\/visits\/batch-resolve$/u,
    authRequired: true,
    handle: async (request, requestId, _match, context) => {
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      if (context.connectionsStore === undefined) {
        throw new HttpRouteError(503, 'CONNECTIONS_NOT_WIRED', 'Connections is not configured.');
      }
      const body = objectRecord(await readBody(request));
      const canonicalUrls = body?.['canonicalUrls'];
      if (
        !Array.isArray(canonicalUrls) ||
        canonicalUrls.length === 0 ||
        !canonicalUrls.every((item): item is string => typeof item === 'string' && item.length > 0)
      ) {
        throw new HttpRouteError(
          400,
          'VALIDATION_ERROR',
          'Validation failed.',
          'Body must contain canonicalUrls as a non-empty string array.',
        );
      }
      const uniqueUrls = [...new Set(canonicalUrls)];
      const eventCandidateUrls = body?.['eventCandidateUrls'];
      if (
        eventCandidateUrls !== undefined &&
        (!Array.isArray(eventCandidateUrls) ||
          !eventCandidateUrls.every(
            (item): item is string => typeof item === 'string' && item.length > 0,
          ))
      ) {
        throw new HttpRouteError(
          400,
          'VALIDATION_ERROR',
          'Validation failed.',
          'eventCandidateUrls must be a string array when provided.',
        );
      }
      const eventCandidateTargetSet = new Set(
        (Array.isArray(eventCandidateUrls) ? eventCandidateUrls : []).filter((candidateUrl) =>
          uniqueUrls.includes(candidateUrl),
        ),
      );
      // Optional per-URL live page titles from the panel (canonicalUrl → title).
      // FROZEN CONTRACT: string values, each ≤ 500 chars, max 100 entries;
      // INVALID SHAPES ARE IGNORED SILENTLY (never a 400 — additive + tolerant).
      const titleHints = parseTitleHints(body?.['titleHints']);
      // Title enrichment (url kind): the panel's on-device synthesized titles
      // are the LAST-resort title fallback for a junk-titled visit — parallel
      // to titleHints, only ever filling where a real title is absent. The
      // lookup is folded from the SAME merged log each resolver path already
      // reads (see the `mergedForEnrichment` assignments below), so it adds no
      // extra readMerged; `synthesizedTitleFor` reads a mutable lookup handle
      // that is populated once merged is in hand. null lookup (flag off) ⇒
      // undefined ⇒ prior behavior.
      let enrichmentLookup: EnrichmentLookup | null = null;
      const synthesizedTitleFor = (canonicalUrl: string): string | undefined =>
        lookupSynthesizedTitle(enrichmentLookup, 'url', canonicalUrl);
      // Content enrichment (url kind): the panel's on-device gist for a visit.
      // Folded from the SAME merged log as the title lookup (no extra scan);
      // populated once merged is in hand (parallel to enrichmentLookup). The
      // content lane uses the RESOLVED page's own gist in its embed/FTS text
      // when present (gist beats title+url tokens). null (flag off) ⇒ undefined
      // ⇒ prior behavior.
      let gistLookup: GistLookup | null = null;
      const gistFor = (canonicalUrl: string): string | undefined =>
        lookupGist(gistLookup, 'url', canonicalUrl);
      const sqliteStore =
        context.connectionsStore instanceof SqliteConnectionsStore
          ? context.connectionsStore
          : null;
      if (sqliteStore !== null) {
        const metadata = await sqliteStore.readSnapshotMetadata();
        if (metadata === null) {
          throw new HttpRouteError(
            409,
            'CONNECTIONS_SNAPSHOT_MISSING',
            'Connections snapshot is not ready.',
          );
        }
        const snapshotRevision = metadata.snapshotRevision;
        // Current graph sig for the SWR staleness check (per-URL, sig-checked
        // separately — mirrors the GET resolve routes so a drain serves the
        // stale item instantly + refreshes in the background instead of
        // recomputing the whole visible set cold on the single loop). Arm +
        // state-aware (F4) so a vote-arm state drain / flip busts the SWR entry.
        const batchGraphSig = await armedResolveSig(
          await connectionsGraphSig(
            sqliteStore,
            join(requireVaultRoot(context), '_BAC', 'connections', 'current.json'),
          ),
          requireVaultRoot(context),
        );
        const results: Record<string, UrlResolutionResult> = {};
        const misses: string[] = [];
        // Arm + state-aware resolver-cache key (F3/F4), computed ONCE per batch
        // (the arm + state revision are request-constant) so every per-URL
        // read/write matches the GET route's key and a v1<->vote flip / state
        // drain busts the persisted cache.
        const batchCacheRevision =
          snapshotRevision === undefined
            ? undefined
            : await resolverCacheRevision(snapshotRevision, requireVaultRoot(context));
        // Event-candidate cache-key fold (perf/event-candidate-resolve). Same
        // (visit_id, revision) table as the plain resolver cache, but the
        // revision additionally folds a stable hash of THIS batch's
        // eventCandidateUrls — see eventCandidateCacheRevision's doc comment
        // for why that's a correct, cheap-to-compute discriminator. Computed
        // once per batch (request-constant), reused for every event-candidate
        // target below. undefined when there is nothing to fold (no
        // event-candidate targets, or the batch has no cache revision at all
        // — connections snapshot not sqlite-backed).
        const batchEventCandidateCacheRevision =
          batchCacheRevision === undefined || eventCandidateTargetSet.size === 0
            ? undefined
            : eventCandidateCacheRevision(batchCacheRevision, [...eventCandidateTargetSet]);
        // F1 privacy gate: the served tombstone set, loaded once for the batch.
        const batchTombstones = await domainTombstoneSetFor(context);
        for (const canonicalUrl of uniqueUrls) {
          if (eventCandidateTargetSet.has(canonicalUrl)) {
            // Same candidate SET (this batch's eventCandidateUrls) as a prior
            // resolve of this URL ⇒ same folded key ⇒ legitimate cache hit,
            // skipping merged/subgraph reads entirely for this URL (item 4).
            // A changed set ⇒ different key ⇒ miss, exactly like a brand-new
            // URL — no SWR-stale fallback here (event-candidate resolves are
            // deliberately never served merely-stale; see primeBatchSwrEntry's
            // exclusion below).
            if (batchEventCandidateCacheRevision !== undefined) {
              const cached = await sqliteStore.getCachedResolverResult(
                canonicalUrl,
                batchEventCandidateCacheRevision,
              );
              if (cached !== null) {
                results[canonicalUrl] = cached as UrlResolutionResult;
                continue;
              }
            }
            misses.push(canonicalUrl);
            continue;
          }
          if (batchCacheRevision !== undefined) {
            const cached = await sqliteStore.getCachedResolverResult(
              canonicalUrl,
              batchCacheRevision,
            );
            if (cached !== null) {
              results[canonicalUrl] = cached as UrlResolutionResult;
              continue;
            }
          }
          // SWR: a prior compute exists but the graph sig has moved. Serve the
          // stale value INSTANTLY (exactly what the panel already displays
          // between polls) and refresh THIS item in the background via the
          // canonical single-URL resolve, instead of recomputing inline in the
          // convoy. Truly-cold items still fall through to `misses`.
          const stale = serveStaleBatchItem(
            context,
            sqliteStore,
            canonicalUrl,
            batchGraphSig,
            snapshotRevision,
          );
          if (stale !== undefined) {
            results[canonicalUrl] = stale;
            continue;
          }
          misses.push(canonicalUrl);
        }
        // Index-backed (perf/event-candidate-resolve, coordinator-flagged
        // profiling finding): checked ONCE so the read below can decide its
        // OWN type list, not just how each URL's events get filtered
        // afterward. Live `sample` profiling during a real browsing burst
        // showed 10-12s single ticks dominated by sqlite3_step/VdbeExec/
        // BtreeFinishMoveto — the WINDOW READ itself (materializing +
        // JSON-decoding every matching row, most of them
        // BROWSER_TIMELINE_OBSERVED) was the multi-second cost, not the JS
        // filter that used to run after it. When the typed store is
        // available, per-URL signal/timeline events now come from
        // resolverSignalEventsForCanonicalUrlsIndexed /
        // resolverTimelineEventsForCanonicalUrlsIndexed (by-URL indexed,
        // above) and the candidate-generation timeline input comes from
        // timelineEventsForCandidateGeneration (bounded, below) — NEITHER
        // needs BROWSER_TIMELINE_OBSERVED or USER_FLOW_REJECTED in `merged`
        // anymore, so the window read can drop straight to the same cheap
        // enrichment-only type list the all-cache-hit branch already used.
        // Store unavailable is the ONE case that still needs the wide read:
        // the *Indexed helpers fall back to JS-filtering `merged` itself
        // then, so `merged` must carry the full type list for that fallback
        // to stay correct.
        const typedEventStore = await eventStoreForContext(context);
        // When every URL was a resolver-cache hit there is no attribution work
        // to do — but the CONTENT lane still runs (it is decoupled from that
        // cache by design and recomputes at query time), and it needs the gist.
        // Reading NOTHING here used to fold an empty gist lookup and memoize it
        // under the real log signature, so a page whose gist the user had just
        // generated contributed nothing to any guess.
        //
        // So this branch still reads — but ONLY the enrichment types, through
        // events_type_idx. Those events are sparse, it stays a SINGLE read (the
        // batch path's one-scan promise is load-bearing; this route has a
        // history of per-request full scans costing tens of seconds), and it is
        // strictly cheaper than the miss path's resolver-expand read.
        const merged =
          misses.length === 0 || typedEventStore !== null
            ? await readEventsFromStoreOrLog(
                context,
                context.eventLog,
                (event) =>
                  event.type === ENTITY_TITLE_ENRICHED ||
                  event.type === ENTITY_CONTENT_ENRICHED ||
                  event.type === ENTITY_ENRICHMENT_RETRACTED ||
                  // Decline memory (review E6) folds from THIS array. Omitting
                  // the type here would fold an empty decline set and memoize
                  // it under the real log signature — the same silent
                  // half-applied fold the enrichment types above were added to
                  // prevent — and the lane-fallback would resume guessing on
                  // pages the user refused. Sparse family, typed index read,
                  // still ONE scan.
                  event.type === USER_ORGANIZED_ITEM,
                [
                  ENTITY_TITLE_ENRICHED,
                  ENTITY_CONTENT_ENRICHED,
                  ENTITY_ENRICHMENT_RETRACTED,
                  USER_ORGANIZED_ITEM,
                ],
              )
            : await readEventsFromStoreOrLog(
                context,
                context.eventLog,
                (event) =>
                  event.type === BROWSER_TIMELINE_OBSERVED ||
                  event.type === USER_FLOW_REJECTED ||
                  event.type === USER_ORGANIZED_ITEM ||
                  event.type === ENTITY_TITLE_ENRICHED ||
                  event.type === ENTITY_CONTENT_ENRICHED ||
                  // Retractions travel WITH the enrichments they withdraw.
                  // Dropping them here would fold a retracted title/gist back
                  // into serving on the batch path only — the exact silent
                  // half-applied delete this event type exists to prevent.
                  event.type === ENTITY_ENRICHMENT_RETRACTED,
                [
                  ...RESOLVER_EXPAND_EVENT_TYPES,
                  ENTITY_TITLE_ENRICHED,
                  ENTITY_CONTENT_ENRICHED,
                  ENTITY_ENRICHMENT_RETRACTED,
                ],
              );
        // Fold enrichment from the merged events just read (no extra scan),
        // memoized on the READ's coverage token — the events came from the
        // serve-stale store, so keying this fold on logSignature() would
        // cache a stale fold under appends it never saw. When misses === 0
        // the convoy was all cache/stale hits and no fresh title lane is
        // computed, so an empty fold is correct — those served results
        // already carry their cached title lane. Both families (title +
        // content/gist) fold from the same merged events.
        const batchEnrichSig = await eventReadCoverageSig(context, context.eventLog);
        enrichmentLookup = enrichmentLookupFromMerged(
          requireVaultRoot(context),
          batchEnrichSig,
          merged,
        );
        // Folds from `merged`, which now always carries the enrichment types —
        // see the read above for why the all-cache-hit branch cannot be [].
        gistLookup = gistLookupFromMerged(requireVaultRoot(context), batchEnrichSig, merged);
        // Gated on MISSED event-candidate targets, not just eventCandidate
        // TargetSet.size — a target whose folded cache entry already hit
        // (see the classification loop above) never reaches `misses`, and
        // must not pay for a timeline read it has no use for (item 4: an
        // all-hit batch pays zero merged/subgraph reads).
        const missedEventCandidateTargets = misses.filter((canonicalUrl) =>
          eventCandidateTargetSet.has(canonicalUrl),
        );
        const expandedCandidateUrlsByTarget =
          missedEventCandidateTargets.length === 0
            ? new Map<string, readonly string[]>()
            : resolverExpandedCandidateUrlsForCanonicalUrls(
                await timelineEventsForCandidateGeneration(typedEventStore, merged),
                missedEventCandidateTargets,
              );
        const expandedCandidateUrls = [
          ...new Set(
            [...expandedCandidateUrlsByTarget.values()].flatMap((candidateUrls) => candidateUrls),
          ),
        ];
        // PERF (2026-08-16) — VERIFIED single pin for the whole misses loop
        // below: this is the ONLY sqlite-metadata-deriving read
        // (readResolverSubgraphForUrls -> #readMetadata -> the write_seq
        // self-heal at snapshot.ts's #selfHealProjections) on this code path
        // for the entire request. `missedSnapshot` is one object reference,
        // reused verbatim by every URL in the misses loop below (the `const
        // snapshot = missedSnapshot;` inside it) AND by finalizeBatchResolveResults's
        // `joinSnapshot` fallback — nothing in either per-URL loop calls
        // readSnapshotMetadata/readCurrent/any other subgraph read, so
        // write_seq cannot advance (and re-trigger self-heal) mid-request.
        // The reverse-shadow deferral (reverseShadowDefer.ts) does not change
        // this: its deferred job reuses this SAME captured snapshot object,
        // it never re-reads metadata. No separate pin needed.
        const missedSnapshot =
          misses.length === 0
            ? null
            : await sqliteStore.readResolverSubgraphForUrls([...misses, ...expandedCandidateUrls]);
        if (misses.length > 0 && missedSnapshot === null) {
          throw new HttpRouteError(
            409,
            'CONNECTIONS_SNAPSHOT_MISSING',
            'Connections snapshot is not ready.',
          );
        }
        // Index-backed (perf/event-candidate-resolve): O(matching rows) via
        // events_resolver_url_idx / events_type_idx when the typed store is
        // available, falling back to the JS filter over `merged` otherwise —
        // see resolverSignalEventsForCanonicalUrlsIndexed's doc comment.
        // Gated on misses.length: an all-cache-hit batch must not pay the
        // (small but real, unlike the old free JS-filter-of-nothing) typed
        // USER_FLOW_REJECTED read this now does (item 4).
        const missedEvents =
          misses.length === 0
            ? []
            : await resolverSignalEventsForCanonicalUrlsIndexed(
                requireVaultRoot(context),
                merged,
                misses,
              );
        for (const canonicalUrl of misses) {
          // BREATHE BETWEEN URLS. Everything below — the resolver, the lane
          // joins, the resolver-cache write — is SYNCHRONOUS sqlite on the
          // thread that serves HTTP (bun:sqlite has no async API). Native
          // sampling during one batch-resolve put ~90% of main-thread samples
          // inside sqlite3: VdbeExec, BtreeTableMoveto, FTS, BtreeInsert.
          //
          // With N urls per batch those runs concatenate into a single
          // uninterruptible tick, so /v1/status, /v1/page-content and every
          // other request queue behind the whole batch — measured 425 stalls
          // in one run, p95 6.4s, max 89.7s, which is exactly the "Companion
          // did not respond within 15s" the panel reports.
          //
          // Yielding does NOT reduce the work; it caps how long any one tick
          // holds the loop, so P99 becomes "slowest single URL" instead of
          // "whole batch". Same reasoning, and the same helper, as the
          // reconcile's phase yields (connectionsMaterializer.ts) — the
          // lower-risk first step before moving sqlite off-thread entirely.
          await yieldToEventLoop();
          const snapshot = missedSnapshot;
          if (snapshot === null) {
            throw new HttpRouteError(
              409,
              'CONNECTIONS_SNAPSHOT_MISSING',
              'Connections snapshot is not ready.',
            );
          }
          const expandEventCandidates = eventCandidateTargetSet.has(canonicalUrl);
          const expandedForTarget = expandedCandidateUrlsByTarget.get(canonicalUrl) ?? [];
          // Index-backed (perf/event-candidate-resolve): these used to be two
          // O(merged) JS filters PER event-candidate URL — on a real vault
          // `merged` is hundreds of thousands of events, so with N
          // event-candidate URLs in one batch that was N full scans back to
          // back. The SIGNAL half is a filter over `missedEvents` (already
          // fetched once for the whole batch, above — it already contains
          // every USER_FLOW_REJECTED event AND every USER_ORGANIZED_ITEM
          // event for every miss URL including this one, so no second sqlite
          // read is needed). The TIMELINE half genuinely needs its own read
          // (missedEvents never carries BROWSER_TIMELINE_OBSERVED) — O(matching
          // rows) via events_resolver_url_idx when the typed store is
          // available (falls back to the identical JS filter over `merged`
          // otherwise — see resolverTimelineEventsForCanonicalUrlsIndexed's
          // doc comment).
          const resolverEvents = expandEventCandidates
            ? [
                ...missedEvents.filter(
                  (event) =>
                    event.type === USER_FLOW_REJECTED ||
                    (event.type === USER_ORGANIZED_ITEM &&
                      isUserOrganizedItemPayload(event.payload) &&
                      event.payload.itemId === canonicalUrl),
                ),
                ...(await resolverTimelineEventsForCanonicalUrlsIndexed(
                  requireVaultRoot(context),
                  merged,
                  new Set([canonicalUrl, ...expandedForTarget]),
                )),
              ]
            : missedEvents;
          const synthesizedForMiss = synthesizedTitleFor(canonicalUrl);
          // PHASE BREAK: events-prep -> resolve. Keeps "slowest single URL"
          // from meaning "prep AND resolve back to back" even now that prep
          // is index-backed (a yield still caps how long one URL's sqlite
          // reads can hold the loop before the resolver's own reads start).
          await yieldToEventLoop();
          const result = await resolveUrlAttributionArmed({
            vaultRoot: requireVaultRoot(context),
            canonicalUrl,
            snapshot,
            events: resolverEvents,
            tombstones: batchTombstones,
            ...(titleHints.has(canonicalUrl) ? { titleHint: titleHints.get(canonicalUrl)! } : {}),
            ...(synthesizedForMiss === undefined ? {} : { synthesizedTitle: synthesizedForMiss }),
            ...(expandEventCandidates ? {} : { useEventCandidateSimilarity: false }),
          });
          results[canonicalUrl] = result;
          // Event-candidate results now cache too (perf/event-candidate-
          // resolve) — under the FOLDED revision (batchEventCandidateCache
          // Revision), never the plain batchCacheRevision, so a changed
          // candidate set can never collide with or shadow a differently-
          // computed entry. SWR priming stays excluded for these (see the
          // comment at primeBatchSwrEntry below) — only the persisted sqlite
          // cache backs event-candidate re-resolves.
          const cacheRevisionForWrite = expandEventCandidates
            ? batchEventCandidateCacheRevision
            : batchCacheRevision;
          if (cacheRevisionForWrite !== undefined) {
            // Cache the SIX-lane result only. The content lane (lane 7) is
            // query-time + titleHint-dependent, so it is appended to the served
            // copy AFTER the cache read/write (see the final pass below) and is
            // never persisted — a titleHint change never stales the cache.
            //
            // DEFERRED OFF THE REQUEST PATH (SIDETRACK_RESOLVER_CACHE_DEFER,
            // default ON). This INSERT is the sqlite3BtreeInsert frame that
            // showed up in the native `sample` of a live batch-resolve — a
            // WRITE inside a read request, once per resolved URL, synchronous
            // because bun:sqlite has no async API. Queuing it costs a Map set;
            // the HTTP dispatch drains the queue AFTER the response is written
            // (see resolverCacheDefer.ts for the full safety argument: this
            // request serves from its own in-memory `results`, never reads the
            // entry back, and the key already folds arm + state revision so a
            // late landing under a superseded key is inert).
            if (resolverCacheDeferEnabled()) {
              // LATE-BOUND, not captured. The thunk re-reads
              // `context.connectionsStore` on the FLUSH tick, so the write goes
              // through whatever store — and therefore whatever sqlite handle —
              // is live when it actually happens. A queued write can drain on
              // the far side of a connections-generation publish, and a handle
              // captured here would by then name a file the publish may have
              // unlinked, which bun:sqlite reports as "disk I/O error" (neither
              // a lock nor corruption, so nothing retries it).
              queueResolverCacheWrite(
                () => {
                  const live = context.connectionsStore;
                  return live instanceof SqliteConnectionsStore
                    ? async (visitId, revision, value): Promise<void> =>
                        await live.cacheResolverResult(visitId, revision, value)
                    : null;
                },
                canonicalUrl,
                cacheRevisionForWrite,
                result,
              );
            } else {
              await sqliteStore.cacheResolverResult(canonicalUrl, cacheRevisionForWrite, result);
            }
            // Seed the SWR cache so a later drain can serve this item stale +
            // refresh in the background rather than recomputing it inline in
            // the next convoy. eventCandidate items are intentionally excluded
            // — they resolve fresh from the SWR's perspective (a graph-sig
            // move never serves them merely-stale); the folded resolver-cache
            // entry written just above is what makes a REPEAT request with
            // the SAME candidate set fast, not the SWR layer.
            if (!expandEventCandidates) {
              primeBatchSwrEntry(canonicalUrl, batchGraphSig, result);
            }
          }
        }
        // Content lane (lane 7) — appended query-time to EVERY served result
        // (cache hit, SWR stale, and fresh compute alike), decoupled from the
        // resolver cache. Deps (recall store handle + embedder) are read once
        // for the whole batch. Snapshot for the workstream join: reuse the
        // resolver subgraph already loaded for the misses; when the batch was
        // all cache/stale hits (no misses ⇒ no subgraph) load the subgraph for
        // the queried URLs once. No-op when guess lanes / the content lane are
        // off (the results keep their six-lane arrays untouched).
        const contentDeps = await buildContentLaneDeps(context, requireVaultRoot(context));
        if (contentDeps.guessLanesEnabled && contentLaneEnabled()) {
          const contentStartMs = Date.now();
          // Decision-layer context (declines + lane calibration), folded once
          // for the whole batch from the events already read — see
          // laneDecisionContextFor.
          const laneContext = await laneDecisionContextFor(
            requireVaultRoot(context),
            merged,
            batchEnrichSig,
          );
          // Memoized (perf/event-candidate-resolve, item 4): on an all-hit
          // batch missedSnapshot is null, so this used to be an UNCONDITIONAL
          // fresh subgraph read on every warm poll — see memoizedJoinSnapshot's
          // doc comment for why reusing a revision-gated memo here is exactly
          // as fresh as re-reading.
          const joinSnapshot =
            missedSnapshot ??
            (Object.keys(results).length > 0
              ? snapshotRevision === undefined
                ? await sqliteStore.readResolverSubgraphForUrls(uniqueUrls)
                : await memoizedJoinSnapshot(sqliteStore, snapshotRevision, uniqueUrls)
              : null);
          // Single finalize seam (stage S3): every served result — cache hit,
          // SWR stale, fresh compute alike — flows through the SAME function
          // the plain-store fallback path below calls. See
          // finalizeBatchResolveResults.
          if (joinSnapshot !== null) {
            await finalizeBatchResolveResults(
              results,
              Object.keys(results),
              joinSnapshot,
              contentDeps,
              laneContext,
              titleHints,
              synthesizedTitleFor,
              gistFor,
            );
          }
          // One-line timing diag (SIDETRACK_HTTP_LOG=1): the whole content-lane
          // pass duration + how many URLs it decorated — so the ≤~50ms indexed /
          // ≤~450ms embed-race budget is observable on the box, PII-free.
          if (process.env['SIDETRACK_HTTP_LOG'] === '1') {
            const durMs = Date.now() - contentStartMs;
            await appendHttpDebugLine(
              `content-lane batch=${String(Object.keys(results).length)} dur=${String(durMs)}ms\n`,
            ).catch(() => undefined);
          }
        }
        // Unconditional serve-opportunity seam. Even when content/AI lanes are
        // disabled, the six structural lanes can carry real predictions and
        // need the same durable identity on the wire + in the append log.
        const predictions = stampLanePredictionOpportunities(results, Object.keys(results));
        recordLanePredictionsBestEffort(requireVaultRoot(context), predictions, requestId);
        return buildBatchResolveResponse(results, snapshotRevision);
      }
      const snapshot = await context.connectionsStore.readCurrent();
      if (snapshot === null) {
        throw new HttpRouteError(
          409,
          'CONNECTIONS_SNAPSHOT_MISSING',
          'Connections snapshot is not ready.',
        );
      }
      const snapshotRevision = snapshot.snapshotRevision;
      const results: Record<string, UrlResolutionResult> = {};
      const merged = await context.eventLog.readMerged();
      // Fold enrichment from the full merged log just read (no extra scan).
      // Both families (title + content/gist) fold from the same merged log.
      const fallbackEnrichSig = await context.eventLog.logSignature();
      enrichmentLookup = enrichmentLookupFromMerged(
        requireVaultRoot(context),
        fallbackEnrichSig,
        merged,
      );
      gistLookup = gistLookupFromMerged(requireVaultRoot(context), fallbackEnrichSig, merged);
      const fallbackTombstones = await domainTombstoneSetFor(context);
      const contentDeps = await buildContentLaneDeps(context, requireVaultRoot(context));
      // Decision-layer context — see the sqlite-store path above. Same call,
      // same position, so the two batch-resolve paths decide and measure
      // identically.
      const fallbackLaneContext = await laneDecisionContextFor(
        requireVaultRoot(context),
        merged,
        fallbackEnrichSig,
      );
      for (const canonicalUrl of uniqueUrls) {
        const synthesizedForUrl = synthesizedTitleFor(canonicalUrl);
        results[canonicalUrl] = await resolveUrlAttributionArmed({
          vaultRoot: requireVaultRoot(context),
          canonicalUrl,
          snapshot,
          events: merged,
          tombstones: fallbackTombstones,
          ...(titleHints.has(canonicalUrl) ? { titleHint: titleHints.get(canonicalUrl)! } : {}),
          ...(synthesizedForUrl === undefined ? {} : { synthesizedTitle: synthesizedForUrl }),
        });
      }
      // Single finalize seam (stage S3): every served result flows through
      // the SAME function the sqlite-store path above calls. See
      // finalizeBatchResolveResults.
      await finalizeBatchResolveResults(
        results,
        uniqueUrls,
        snapshot,
        contentDeps,
        fallbackLaneContext,
        titleHints,
        synthesizedTitleFor,
        gistFor,
      );
      const fallbackPredictions = stampLanePredictionOpportunities(results, uniqueUrls);
      recordLanePredictionsBestEffort(requireVaultRoot(context), fallbackPredictions, requestId);
      return buildBatchResolveResponse(results, snapshotRevision);
    },
  },
  ...visitsRoutesB,
  ...systemRoutesB,
  ...bucketsRoutes,
  ...settingsRoutes,
  ...dispatchesRoutesA,
  ...auditRoutes,
  ...reviewsRoutes,
  ...reviewDraftsRoutes,
  ...annotationsRoutes,
  ...dispatchesRoutesB,
  ...recallRoutesA,
  ...pageContentRoutes,
  ...recallRoutesB,
  ...modelRoutes,
  ...enrichmentRoutes,
  ...entitiesRoutes,
  ...recallRoutesC,
  ...threadSuggestionRoutes,
  ...eventsRoutes,
  ...threadsRoutesA,
  ...workstreamsRoutes,
  ...workstreamSuggestionsRoutes,
  ...queueRoutes,
  ...remindersRoutes,
  ...codingSessionsRoutes,
  ...timelineRoutes,
  ...connectionsRoutes,
  ...systemRoutesC,
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

  // Host/origin loopback gate FIRST — before any route work or auth,
  // so an off-loopback caller learns nothing about the surface.
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

  const url = request.url === undefined ? undefined : new URL(request.url, 'http://127.0.0.1');
  if (url === undefined) {
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

  // Model-host interception — BEFORE the auth gate and the JSON route
  // dispatch. This route is UNAUTHENTICATED by design (transformers.js'
  // internal fetch cannot carry the bridge-key header; the exposure is
  // loopback-only + non-secret public model weights — see modelHostRoute.ts
  // for the full posture) AND it STREAMS large files, which the JSON route
  // dispatch (in-memory body only) cannot do. It sits after the loopback gate
  // above, so it inherits the same off-loopback rejection every route gets.
  // GET/HEAD only; serveModelFile writes a 405 for anything else and confines
  // reads to the models directory (path-traversal defense inside).
  if ((method === 'GET' || method === 'HEAD') && isModelHostPath(url.pathname)) {
    await serveModelFile(request, response);
    return;
  }

  // Auth gate BEFORE route matching. Everything except the explicit
  // public allowlist requires the bridge key — including unknown paths,
  // which return the auth error (not a 404), so an unauthenticated
  // caller can't enumerate the route table by probing status codes.
  // Debug/diagnostic routes are NOT in the allowlist, so they now
  // require auth like every other route.
  //
  // F02 — the companion accepts TWO keys and classifies the caller by
  // which one authenticated:
  //   - the extension bridge key  → `extension` (the user's surface, exempt
  //     from workstream-trust enforcement — every route open).
  //   - the MCP key (mcpBridgeKey) → `mcp`. An mcp caller is default-DENIED
  //     any mutating route (POST/PUT/PATCH/DELETE) unless the route is on the
  //     sanctioned MCP_ALLOWED_MUTATING_ROUTES allowlist (enforced below at
  //     dispatch via isMcpAllowedRoute); reads stay open. Allowlisted write
  //     routes STILL run requireWorkstreamTrust for per-workstream, per-tool
  //     trust. The MCP key is checked FIRST so an mcp-key caller is never
  //     mis-classified as the extension. When no MCP key is wired, only the
  //     bridge-key path exists (pre-F02 behaviour).
  if (!isPublicUnauthenticatedPath(method, url.pathname)) {
    const actualKey = request.headers['x-bac-bridge-key'];
    const isMcpKey =
      typeof actualKey === 'string' &&
      context.mcpBridgeKey !== undefined &&
      bridgeKeysMatch(context.mcpBridgeKey, actualKey);
    const accepted =
      typeof actualKey === 'string' &&
      (isMcpKey || (await isBridgeKeyAccepted(context.vaultRoot, context.bridgeKey, actualKey)));
    if (!accepted) {
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
    // The tool header is honoured for LOGGING only (deprecation window):
    // it seeds the audit `tool` hint + the mcp client-name, but the trust
    // decision is derived from the authenticating key above, never here.
    // Honoured for LOGGING only: `x-sidetrack-mcp-client` names the MCP
    // client (e.g. 'codex', 'claude_code') for `mcp:<client-name>` audit
    // provenance; `x-sidetrack-mcp-tool` is the legacy tool hint. Neither
    // influences the trust decision (derived from the key above).
    const clientHeader = request.headers['x-sidetrack-mcp-client'];
    const clientName =
      typeof clientHeader === 'string' && clientHeader.length > 0 ? clientHeader : undefined;
    // Touch the tool header so it stays a live (logging-only) surface
    // during the deprecation window; the value is not load-bearing.
    void mcpToolHeader(request);
    setCallerIdentity(
      request,
      isMcpKey
        ? { callerClass: 'mcp', ...(clientName === undefined ? {} : { clientName }) }
        : { callerClass: 'extension' },
    );
  }

  const route = routes.find((candidate) => {
    if (candidate.method !== method) {
      return false;
    }
    return candidate.pattern.test(url.pathname);
  });

  if (route === undefined) {
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

  // Debug-only request log (SIDETRACK_HTTP_LOG=1): ground-truth of
  // what the extension actually polls + per-request latency. Written
  // to a file because the screen-session pty isn't capturable.
  // Fire-and-forget; zero overhead when the env is unset. Declared OUT
  // of the try/catch below so error paths (4xx/5xx) can log their status
  // too — otherwise `grep ' 500 '` on the debug log finds nothing while
  // the endpoint is live-500ing (busy/locked), which hid a real bug.
  const httpLog = process.env['SIDETRACK_HTTP_LOG'] === '1';
  const httpLogStartedMs = httpLog ? Date.now() : 0;
  const logHttp = (statusForLog: number): void => {
    if (!httpLog) return;
    // pathname ONLY — url.search is deliberately omitted (PII).
    void appendHttpDebugLine(
      `${new Date().toISOString()} ${method ?? 'UNKNOWN'} ${url.pathname} ${String(statusForLog)} ${String(Date.now() - httpLogStartedMs)}ms\n`,
    ).catch(() => undefined);
  };

  // STALL ATTRIBUTION (always on, not debug-gated — an operator does not get to
  // reproduce a stall on demand, so the field has to already be in the log).
  // The event-loop watchdog could only ever say `[api.stall]
  // eventLoopBlockedMs=3008` — never WHICH route held the thread — so every
  // stall investigation in this repo began by guessing the endpoint.
  // Registering here and completing in the `finally` below lets the monitor
  // name the routes that were still running when it noticed the block.
  //
  // PLACEMENT is deliberate: this is after the 404, the model-host stream and
  // the /v1/vault/changes SSE early-returns, so only DISPATCHED JSON routes are
  // tracked. The SSE connection in particular is open for the entire session —
  // tracking it would make it permanently the longest-running request and it
  // would head every suspect list forever, drowning the actual culprit.
  //
  // The recorded string is the route PATTERN from the matched route table entry
  // — `POST:/v1/visits/batch-resolve`, `GET:/v1/visits/{canonicalUrl}/resolve` —
  // NOT url.pathname. The http-log line above strips url.search for PII; for
  // the resolve routes the PATHNAME ITSELF carries the encoded canonical URL,
  // so a stall line built from it would leak browsing history into a log the
  // user is asked to paste. The pattern cannot.
  const inflightId = registerInflight(routeLabelFromPattern(route.method, route.pattern));

  try {
    const match = route.pattern.exec(url.pathname);
    // F02 systemic default-deny. An mcp-key caller may only reach a
    // mutating route that is on the sanctioned allowlist; every other
    // mutating route (trust management, workstream delete/patch, settings
    // patch, export, annotation writes) is refused here — BEFORE the
    // handler runs — so an mcp caller can never self-grant, delete, or
    // otherwise escalate through an ungated route. Reads are unaffected.
    if (
      callerIdentityFor(request).callerClass === 'mcp' &&
      !isMcpAllowedRoute(method, url.pathname)
    ) {
      throw new HttpRouteError(
        403,
        'MCP_OPERATION_NOT_ALLOWED',
        'This operation is not available to MCP callers.',
        'This operation is not available to MCP callers. Only sanctioned workstream ' +
          'write tools (thread move/archive/unarchive, queue create, workstream ' +
          'bump/create) are reachable with an MCP key; trust management, workstream ' +
          'delete/edit, settings, export, and annotation writes require the ' +
          "extension's own bridge key.",
      );
    }
    // F02 — bind the base audit provenance for the request so any vault
    // write it triggers records the caller class. The trust gate refines
    // this (tool / scope / trustModeActive) when it runs. Only mutating
    // methods write audit lines, so reads skip the wrapper. argsSummary
    // is the method + pathname (never query/body — no full payloads).
    const auditBase: AuditContext = {
      agent: auditAgentLabel(callerIdentityFor(request)),
      tool: null,
      scope: null,
      trustModeActive: false,
      argsSummary: boundArgsSummary(`${method ?? 'UNKNOWN'} ${url.pathname}`),
    };
    const runHandler = (): Promise<readonly [number, unknown]> =>
      route.handle(request, requestId, match?.groups ?? {}, context);
    const [status, body] =
      method === 'GET' ? await runHandler() : await runWithAuditContext(auditBase, runHandler);
    // Conditional GET / response ETag. Restricted to GET because
    // mutations (POST/PATCH/PUT/DELETE) have side effects we can't
    // skip even if a duplicate request's response matches; the
    // idempotency-key path already covers replay safety for those.
    if (method === 'GET') {
      const etag = computeBodyEtag(status, body);
      if (etag !== null) {
        const ifNoneMatch = request.headers['if-none-match'];
        const incoming = Array.isArray(ifNoneMatch) ? ifNoneMatch[0] : ifNoneMatch;
        if (typeof incoming === 'string' && incoming === etag) {
          logHttp(304);
          send304(response, etag);
          return;
        }
        logHttp(status);
        sendJsonWithEtag(response, status, body, etag);
        return;
      }
    }
    logHttp(status);
    sendJson(response, status, body);
  } catch (error) {
    const issues = getValidationIssues(error);
    const routeError = error instanceof HttpRouteError ? error : undefined;
    const settingsRevisionConflict = error instanceof SettingsRevisionConflictError;
    const codingTokenInvalid = error instanceof CodingAttachTokenInvalidError;
    const codingSessionNotFound = error instanceof CodingSessionNotFoundError;
    const vaultUnavailable = VaultUnavailableError.matches(error);
    const exportConfinement = VaultExportConfinementError.matches(error);
    const status =
      routeError?.status ??
      (settingsRevisionConflict
        ? 409
        : codingTokenInvalid
          ? 410
          : codingSessionNotFound
            ? 404
            : exportConfinement
              ? 400
              : issues === undefined
                ? vaultUnavailable
                  ? 503
                  : 500
                : 400);
    const detail = error instanceof Error ? error.message : undefined;
    if (status === 500 && error instanceof Error) {
      // eslint-disable-next-line no-console
      console.error(`[http-500] ${method} ${url.pathname}${url.search} req=${requestId}`, error);
    }
    // Record the error response status too (4xx/5xx). Without this the
    // debug log only ever shows 2xx, so a live 500 storm (e.g. "database
    // is locked") is invisible to `grep ' 500 ' /tmp/sidetrack-http-debug.log`.
    logHttp(status);
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
                : exportConfinement
                  ? 'EXPORT_PATH_REJECTED'
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
                  : exportConfinement
                    ? 'Export path rejected.'
                    : vaultUnavailable
                      ? 'Vault path is unavailable.'
                      : 'Internal companion error.'
            : 'Validation failed.'),
        correlationId: requestId,
        ...(detail === undefined ? {} : { detail }),
        ...(issues === undefined ? {} : { issues }),
      }),
    );
  } finally {
    completeInflight(inflightId);
    // AFTER the response — both branches above have already called sendJson /
    // send304 by the time this runs, so the queued resolver-cache upserts drain
    // on a tick the client is no longer waiting on. This is the PRIMARY drain
    // trigger (resolverCacheDefer's own fallback timer exists only for a
    // companion that goes completely idle with a queued write). No-op, and no
    // scheduling at all, when the queue is empty — which is every request that
    // is not a batch-resolve with fresh misses.
    scheduleResolverCacheFlush();
    // Same reasoning, same AFTER-the-response trigger point, for the
    // reverse-shadow queue (reverseShadowDefer.ts) — the incumbent-resolver
    // re-run that used to happen inline per miss URL now runs here instead.
    // No-op when the shadow flag is off or the batch had zero misses.
    scheduleReverseShadowFlush();
  }
};

const randomLoopbackPort = (): number => 30_000 + Math.floor(Math.random() * 20_000);

export const startHttpServer = async (server: Server, port: number): Promise<StartedHttpServer> =>
  new Promise((resolve, reject) => {
    let attempts = 0;
    const requestedEphemeral = port === 0;
    const listen = (): void => {
      const targetPort = requestedEphemeral ? randomLoopbackPort() : port;
      const onError = (error: Error & { readonly code?: string }): void => {
        server.off('listening', onListening);
        if (requestedEphemeral && error.code === 'EADDRINUSE' && attempts < 20) {
          attempts += 1;
          listen();
          return;
        }
        reject(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        const address = server.address();
        const actualPort =
          typeof address === 'object' && address !== null ? address.port : targetPort;
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
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(targetPort, '127.0.0.1');
    };
    listen();
  });
