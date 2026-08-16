// Shared HTTP route plumbing used by many domain route modules under
// src/http/routes/: the RouteDefinition/route-context types, HttpRouteError,
// request/response-shaping helpers (readBody, requireVaultRoot,
// requireIdempotencyKey, runIdempotent, mutationResponse, objectRecord), and
// a handful of cross-domain caches/semaphores (the generic TTL route cache,
// the resolve-SWR machinery, the domain-tombstone cache, the caller-identity
// registry, ...) that more than one route module needs. These carry no
// per-route business logic; they moved here — instead of staying "stateless
// helpers only" as first planned — because dependency analysis showed most
// of them are referenced by routes spread across most domains, so leaving
// them in server.ts would have forced the majority of routes to stay inline
// (the exact import cycle this module exists to break).
//
// Extracted verbatim from server.ts in stage S2 of the cost-of-change
// refactor; server.ts re-exports the names external modules already imported from it,
// so every existing `from './server.js'` import keeps working unchanged.

import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';

import { isAllowed, readTrust, type WorkstreamWriteTool } from '../auth/workstreamTrust.js';
import { SqliteConnectionsStore, type ConnectionsStore } from '../connections/snapshot.js';
import {
  USER_ENGAGEMENT_RELABELED,
  USER_FLOW_CONFIRMED,
  USER_FLOW_REJECTED,
  USER_ORGANIZED_ITEM,
  USER_REJECTED_RELATION,
  USER_SNIPPET_PROMOTED,
  USER_TOPIC_RENAMED,
} from '../feedback/events.js';
import type { InstallOptions, Installer } from '../install/index.js';
import type { BodyEvidenceLaneHealth } from '../page-evidence/bodyEvidenceLane.js';
import { buildDomainTombstoneSet, type DomainTombstoneSet } from '../privacy/domainTombstone.js';
import { readDomainTombstones } from '../privacy/domainTombstoneStore.js';
import type { RecallActivityTracker } from '../recall/activity.js';
import type { RecallLifecycle } from '../recall/lifecycle.js';
import type { BucketRegistry } from '../routing/registry.js';
import { type AcceptedEvent, type VersionVector, vectorFromEvents } from '../sync/causal.js';
import type { EventLog } from '../sync/eventLog.js';
import { eventStoreCoverageToken, getSharedEventStoreServeStale, type EventStore } from '../sync/eventStore.js';
import type { ProjectionChangeFeed } from '../sync/projectionChanges.js';
import type { ReplicaContext } from '../sync/replicaId.js';
import type { UpdateAdvisory } from '../system/versionCheck.js';
import type { ResourceReadinessWatchdogs } from '../system/resourceReadinessWatchdog.js';
import type { ConnectionsDiagnosticSnapshot } from '../system/workGraphHealth.js';
import type { AttributionPolicyMode, AttributionPolicyTelemetry } from '../tabsession/policy.js';
import {
  createEmptyUrlProjectionAccumulator,
  deserializeUrlProjection,
  foldEventIntoUrlProjectionAccumulator,
  projectUrls,
  type UrlProjection,
  urlProjectionFromAccumulator,
} from '../urls/projection.js';
import { currentAuditContext as currentAuditContextMut } from '../vault/auditContext.js';
import type { VaultChangeEvent } from '../vault/watcher.js';
import { createVaultWriter, type VaultWriter } from '../vault/writer.js';
import type { IdempotencyStore } from './idempotency.js';
import { ResolveSwrCache, type ResolveFreshness } from './resolveSwrCache.js';

// Stamps an outgoing event's baseVector to cover every prior event
// for the same aggregate. Without this every emit lands with
// baseVector:{} → every register/OR-Set candidate becomes
// causally concurrent with every prior write, mergeRegister
// returns `conflict` with N candidates, and the receiver picks
// the wrong one. This is the bug F11 closes.
//
// The vector is *only* over events that actually exist on this
// replica's merged log. That's correct: causal ordering is "what
// have I observed?" and all the local replica has observed is its
// merged log. For peer-imported events the deps were already on
// the wire.
export const baseVectorForAggregate = async (
  eventLog: EventLog,
  aggregateId: string,
): Promise<VersionVector> => vectorFromEvents(await eventLog.readByAggregate(aggregateId));

/** Serve-stale per-aggregate event read for request paths. The eventLog
 *  fallback is readMerged()+filter — a FULL-LOG materialization that
 *  measured 9.1s cold on an 866k-event vault, fired in bursts by every
 *  extension service-worker reconnect (one GET per thread/workstream
 *  projection). The typed store answers the same query in O(aggregate
 *  rows) via events_aggregate_idx. Zero-row store results fall back to
 *  the log: a just-created aggregate may not be ingested yet, and the
 *  serve-stale store must never turn "brand new" into "missing". */
export const readAggregateEventsServeStale = async (
  context: {
    readonly eventLog?: EventLog | undefined;
    readonly vaultRoot?: string | undefined;
  },
  aggregateId: string,
): Promise<readonly AcceptedEvent[]> => {
  if (context.vaultRoot !== undefined) {
    const store = await getSharedEventStoreServeStale(context.vaultRoot);
    if (store !== null) {
      const events = store.readByAggregate(aggregateId);
      if (events.length > 0) return events;
    }
  }
  if (context.eventLog === undefined) {
    // Same failure the pre-helper direct access produced — routes that
    // reach here are only ever wired with a live event log.
    throw new Error('readAggregateEventsServeStale: context has no eventLog');
  }
  return context.eventLog.readByAggregate(aggregateId);
};

export interface CompanionHttpConfig {
  readonly bridgeKey: string;
  // F02 — the MCP-scoped bridge key (mcp.key). When set, the sidetrack-mcp
  // process authenticates its companion calls with THIS key instead of the
  // extension bridge key. The auth gate accepts both keys but classifies
  // the caller by which one matched: an mcpBridgeKey match is an `mcp`
  // caller (subject to workstream-trust enforcement on every write route);
  // a bridgeKey match is the `extension` surface (exempt). Optional so
  // legacy runtimes / tests that never wire an MCP key keep working — when
  // unset, every caller is classified `extension` (pre-F02 behaviour).
  readonly mcpBridgeKey?: string;
  readonly vaultWriter: VaultWriter;
  readonly vaultRoot?: string;
  readonly serviceInstaller?: Installer;
  readonly serviceInstallDefaults?: Omit<InstallOptions, 'vaultPath'>;
  // Real service liveness probe (F28 health honesty). When wired, the
  // health surface reports `service.running` from actual process
  // liveness (launchctl / systemctl) instead of inferring it from plist
  // existence. Optional so legacy/test call-sites fall back to the
  // installer's plist-existence heuristic. Must be bounded + never throw.
  readonly serviceLiveness?: () => Promise<'running' | 'not-running' | 'unknown'>;
  // Liveness edges (F28). Synchronous, side-effect-free getters wired by
  // the runtime when it manages the corresponding subsystem; the health
  // surface surfaces a silently-dead ranker refresh / MCP child.
  readonly rankerHealth?: () => import('../system/health.js').RankerRefreshHealth;
  readonly mcpChildHealth?: () => import('../system/health.js').McpChildHealth;
  // P1 resource/readiness budgets. Runtime-owned, synchronous O(1) getter:
  // samples process RSS and reads the already-recorded boot phase timings.
  // It must never start work, scan the vault, or await I/O on the health path.
  readonly getResourceReadinessWatchdogs?: () => ResourceReadinessWatchdogs;
  readonly sync?: {
    readonly relay?: {
      readonly mode: 'local' | 'remote';
      readonly url: string;
    };
    // Per-request status getter exposing the relay transport's
    // current connection state. Health reads this so the side
    // panel can distinguish "companion up, peer sync paused"
    // from "companion up, sync healthy" — the user-perceptible
    // signal for T6.7.b. Returns null when the runtime has no
    // outbound transport wired (no --sync-relay/--sync-relay-local).
    readonly getRelayStatus?: () => {
      readonly connected: boolean;
      readonly lastConnectedAtMs?: number;
      readonly lastDisconnectedAtMs?: number;
      readonly consecutiveFailures: number;
      readonly pendingPublishes: number;
      // Stage 5 polish — peer-event throughput counters. Optional so
      // older runtimes that haven't shipped the relay change yet keep
      // working against the new server typing.
      readonly eventsIn?: number;
      readonly eventsOut?: number;
      readonly lastInboundAtMs?: number;
      readonly lastOutboundAtMs?: number;
      readonly byReplica?: readonly {
        readonly replicaId: string;
        readonly eventsIn: number;
        readonly eventsOut: number;
        readonly lastInboundAtMs?: number;
        readonly lastOutboundAtMs?: number;
      }[];
    } | null;
  };
  readonly updateChecker?: () => Promise<UpdateAdvisory>;
  readonly idempotencyStore?: IdempotencyStore;
  readonly allowAutoUpdate?: boolean;
  readonly startedAt?: Date;
  readonly bucketRegistry?: BucketRegistry;
  // Stage 4 — pluggable collector framework. When wired, the side
  // panel's Collectors section reads loaded manifests, capability
  // gate states, and quarantine counts via /v1/collectors. The
  // POST /v1/collectors/{id}/replay route triggers a manual replay.
  // When omitted (e.g. in tests), both routes return 503.
  // The LoadedCollector return shape is widened to `unknown` here so
  // the HTTP context doesn't have to mirror exactOptionalPropertyTypes
  // mismatches against the framework's internal types. The route
  // handler defensively extracts only the fields it serializes.
  readonly collectorFramework?: {
    readonly loadedCollectors: () => readonly unknown[];
    readonly quarantineCountFor: (collectorId: string) => Promise<number>;
    readonly replayCollector: (collectorId: string) => Promise<{
      readonly scanned: number;
      readonly promoted: number;
      readonly stillQuarantined: number;
    }>;
    // Per-(collector_id, capability) gate state. Used by the GET
    // /v1/collectors route to surface granted/revoked/pending state
    // alongside each capability declaration. The capability arg is
    // 'reads-paths' | 'reads-env' | 'reads-network'.
    readonly resolveGate?: (
      collectorId: string,
      capability: 'reads-paths' | 'reads-env' | 'reads-network',
    ) => 'granted' | 'revoked' | 'pending';
    readonly lastPromotedAtFor?: (collectorId: string) => string | null;
  };
  readonly vaultChanges?: {
    readonly subscribe: (listener: (event: VaultChangeEvent) => void) => () => void;
    /** Live count of attached subscribers — surfaced on /v1/status so a
     *  leaking SSE consumer (subscriptions that outlive their socket)
     *  is observable instead of silent. */
    readonly subscriberCount: () => number;
  };
  readonly hygieneStatus?: {
    lastIdempotencyGcAt?: string;
    lastAuditRetentionAt?: string;
    lastDerivedRevisionGcAt?: string;
    lastVacuumAt?: string;
    lastVacuumDurationMs?: number;
    lastEventSealAt?: string;
    lastEventSealSealedCount?: number;
    lastEventSealErrorCount?: number;
    lastSealIntegrityAt?: string;
    lastSealIntegrityMatches?: number;
    lastSealIntegrityStoreDrift?: number;
    lastSealIntegrityAlarmCount?: number;
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
  // Sync Contract v1: per-materializer health source. /v1/system/health
  // surfaces this under `sync.materializers` so the side panel +
  // operator can see when a materializer is degraded or failed even
  // though the event log appears converged. Gate L1-G9.
  readonly syncMaterializerHealth?: () => Record<
    string,
    {
      readonly status: 'healthy' | 'busy' | 'degraded' | 'failed';
      readonly lastSuccessAt: string | null;
      readonly lastError: string | null;
      readonly pending: boolean;
    }
  >;
  // Live connections materializer diagnostic state that is not persisted
  // in diagnostics/latest.json, surfaced under /v1/system/health
  // workGraph.candidates. Optional because route tests often run
  // without the runtime materializer.
  readonly connectionsDiagnostics?: () => ConnectionsDiagnosticSnapshot;
  // Local monotonic projection-change feed. Browsers resume polling
  // with a numeric `sinceSeq` cursor; the counter never moves
  // backward and is independent of any host's wall clock.
  readonly projectionChanges?: ProjectionChangeFeed;
  // Set when the companion is also managing a sidetrack-mcp child.
  // Exposed via /v1/status so the side panel can build attach prompts
  // whose ?token=… matches whatever the running MCP server actually
  // accepts — without the user copying keys between two terminals.
  readonly mcp?: { readonly port: number; readonly authKey: string };
  // Sync Contract v1 / Class F — edge-event import path for plugin-
  // originated events whose dot is allocated by the edge replica
  // (timeline observations + future passive surfaces). Closes over
  // both `eventLog.importPeerEvent` AND `runner.onAcceptedEvent` so
  // the runner sees every accepted edge event symmetrically with
  // relay-imported peer events. Optional so legacy tests work; when
  // unset the timeline events route returns 503.
  readonly importEdgeEvent?: (
    event: import('../sync/causal.js').AcceptedEvent,
  ) => Promise<{ imported: boolean }>;
  // P2 — batched edge-event ingest: ONE readMerged + dedupe + shard
  // write for the whole flush instead of ~3 whole-log scans/event.
  // Returns per-clientEventId imported flags (false ⇒ duplicate).
  readonly importEdgeEvents?: (
    events: readonly import('../sync/causal.js').AcceptedEvent[],
  ) => Promise<readonly { readonly clientEventId: string; readonly imported: boolean }[]>;
  // Batched timeline ingest: ONE readMerged dedupe for the whole
  // POST + per-event contract-runner dispatch. Used by
  // POST /v1/timeline/events; when unset the route falls back to the
  // per-event importEdgeEvent path.
  readonly importTimelineEvents?: (
    events: readonly import('../sync/causal.js').AcceptedEvent[],
  ) => Promise<readonly { readonly clientEventId: string; readonly imported: boolean }[]>;
  // Optional timeline projection store, exposing read access for
  // the GET /v1/timeline route. When unset that route returns 503.
  readonly timelineStore?: import('../timeline/projection.js').TimelineStore;
  // Connections graph snapshot store. When unset, GET /v1/connections
  // and its sibling routes return 503.
  readonly connectionsStore?: import('../connections/snapshot.js').ConnectionsStore;
  // Optional synchronous refresh hook for operator-triggered model
  // changes such as forced ranker retraining. Runtime wiring points
  // this at the connections materializer catchUp path.
  readonly refreshConnections?: () => Promise<void>;
  // Event-loop stall snapshot. /v1/status surfaces it so operators
  // can diagnose API stalls without re-running the companion under
  // a profiler. The getter MUST be synchronous + side-effect-free
  // (it reads a perf_hooks histogram). When omitted the field is
  // simply absent from /v1/status — tests don't need it.
  readonly getEventLoopSnapshot?: () => import('../runtime/eventLoopMonitor.js').EventLoopSnapshot;
  // Embedder sidecar status — drives /v1/status.recall.vectorState.
  // Like getEventLoopSnapshot it MUST be synchronous + side-effect-
  // free; reads cached state, never blocks on a spawn/warmup. When
  // omitted (test mode / in-process embedder) /status reports
  // \`vectorState: 'disabled'\`.
  readonly getEmbedderStatus?: () => {
    readonly state: 'disabled' | 'cold' | 'warming' | 'ready' | 'failed';
    readonly lastError?: string;
  };
  // Background page-evidence embedding lane health — surfaced on
  // /v1/status.pageEvidenceEmbedLane so an INERT lane (the 90-min soak
  // failure: the lane silently embedded nothing while the backlog sat
  // full) is visible in minutes, not hours. Synchronous + side-effect-
  // free (reads in-memory counters). Absent when the lane is disabled →
  // /status omits the field.
  readonly getBackgroundEmbeddingLaneHealth?: () => import('../page-evidence/backgroundEmbeddingLane.js').BackgroundEmbeddingLaneHealth;
  // R3 durable body-evidence queue + off-serving worker health. Synchronous
  // cached counters only: /status must never scan the queue/corpus itself.
  readonly getBodyEvidenceLaneHealth?: () => BodyEvidenceLaneHealth;
  // Bounded event-store catch-up trigger. Wired by the runtime to
  // getCaughtUpSharedEventStore(vaultRoot). /v1/status kicks this in the
  // BACKGROUND (single-flight) and returns immediately with `catchingUp: true`
  // rather than awaiting it inline: on a large vault after idle the JSONL
  // catch-up can run 40s+ and, since it holds the single Bun loop, would
  // freeze EVERY endpoint (even /v1/version). Must resolve when the store is
  // current and reject/throw only on genuine failure. Optional so route-only
  // tests and event-store-disabled runtimes keep working (field absent ⇒
  // /status never reports catchingUp).
  readonly eventStoreCatchUp?: () => Promise<void>;
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

interface RouteMatch {
  readonly workstreamId?: string;
  readonly tabSessionId?: string;
  readonly reminderId?: string;
  readonly codingSessionId?: string;
  readonly threadId?: string;
  readonly annotationId?: string;
  readonly bacId?: string;
  readonly connectionsNodeId?: string;
  readonly connectionsEdgeId?: string;
  readonly collectorId?: string;
  readonly canonicalUrl?: string;
  readonly modelOrg?: string;
  readonly modelRepo?: string;
  // URL-encoded entity name (GET /v1/entities/{name}). Encoded because entity
  // names carry spaces, slashes and punctuation straight from a model's prose.
  readonly entityName?: string;
}

export interface RouteDefinition {
  readonly method: HttpMethod;
  readonly pattern: RegExp;
  // Documents intent only. The request handler enforces auth BEFORE
  // route matching against PUBLIC_UNAUTHENTICATED_PATHS, not this flag —
  // so an unauthenticated caller can't enumerate routes by status code.
  // Keep it accurate (true for anything not on that allowlist) so it
  // stays a reliable audit reference.
  readonly authRequired: boolean;
  readonly handle: (
    request: IncomingMessage,
    requestId: string,
    match: RouteMatch,
    context: CompanionHttpConfig,
  ) => Promise<readonly [number, unknown]>;
}

export class HttpRouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    message?: string,
  ) {
    super(message ?? title);
  }
}

export const readBody = async (request: IncomingMessage): Promise<unknown> => {
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

export const mutationResponse = (
  result: { readonly bac_id: string; readonly revision: string },
  requestId: string,
) => ({
  data: {
    ...result,
    requestId,
  },
});

export const requireIdempotencyKey = (request: IncomingMessage): string => {
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

// In-flight dedupe: concurrent requests with the same (route, key)
// share the first caller's promise instead of each running the full
// operation. The map is keyed by "${route} ${key}" so a single module-
// scope instance is safe across all routes. Entries are removed on
// settle (finally) so the map cannot grow without bound.
const runIdempotentInFlight = new Map<string, Promise<readonly [number, unknown]>>();

export const runIdempotent = async (
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
  const inflightKey = `${route} ${key}`;
  const existing = runIdempotentInFlight.get(inflightKey);
  if (existing !== undefined) {
    return existing;
  }

  const promise = (async (): Promise<readonly [number, unknown]> => {
    const replay = await context.idempotencyStore?.read(route, key);
    if (replay !== undefined) {
      if (validateReplay === undefined || (await validateReplay(replay.body))) {
        return [replay.status, replay.body];
      }
    }

    const [status, body] = await operation();
    await context.idempotencyStore?.write(route, key, { status, body });
    return [status, body];
  })();

  runIdempotentInFlight.set(inflightKey, promise);
  // Suppress the unhandled-rejection warning on the cleanup promise: the
  // original `promise` rejection is handled by callers who await it; the
  // `.finally()` derivative just removes the map entry and must not surface
  // as a second unhandled rejection.
  void promise
    .finally(() => {
      runIdempotentInFlight.delete(inflightKey);
    })
    .catch(() => undefined);
  return promise;
};

export const requireVaultRoot = (context: CompanionHttpConfig): string => {
  if (context.vaultRoot === undefined) {
    throw new Error('Vault root is unavailable.');
  }
  return context.vaultRoot;
};

// Domain-tombstone privacy gate. Read boundaries (timeline, recall-v2,
// connections snapshot, context pack) call this to get a compiled
// matcher that excludes purged domains. Cached with a short TTL +
// in-flight coalescing so a burst of serve calls shares one disk read;
// the tombstone write path invalidates the cache immediately so a purge
// takes effect on the next serve without waiting out the TTL. An empty
// / unavailable vault ⇒ an empty set (nothing hidden).
const DOMAIN_TOMBSTONE_CACHE_TTL_MS = 5_000;

let cachedDomainTombstoneSet: { value: DomainTombstoneSet; expiresAtMs: number } | null = null;

let domainTombstoneInFlight: Promise<DomainTombstoneSet> | null = null;

export const invalidateDomainTombstoneCache = (): void => {
  cachedDomainTombstoneSet = null;
};

export const domainTombstoneSetFor = async (
  context: CompanionHttpConfig,
): Promise<DomainTombstoneSet> => {
  if (context.vaultRoot === undefined) return buildDomainTombstoneSet([]);
  const now = Date.now();
  if (cachedDomainTombstoneSet !== null && cachedDomainTombstoneSet.expiresAtMs > now) {
    return cachedDomainTombstoneSet.value;
  }
  if (domainTombstoneInFlight !== null) return domainTombstoneInFlight;
  const vaultRoot = context.vaultRoot;
  domainTombstoneInFlight = (async (): Promise<DomainTombstoneSet> => {
    try {
      const set = buildDomainTombstoneSet(await readDomainTombstones(vaultRoot));
      cachedDomainTombstoneSet = {
        value: set,
        expiresAtMs: Date.now() + DOMAIN_TOMBSTONE_CACHE_TTL_MS,
      };
      return set;
    } catch {
      // Fail toward "nothing hidden" on a read error — the tombstone is
      // durably in the event log, and a stale empty set never leaks MORE
      // than an intact list would suppress. It just under-hides until the
      // next successful read; a privacy gate must not throw on the hot
      // serve path.
      return buildDomainTombstoneSet([]);
    } finally {
      domainTombstoneInFlight = null;
    }
  })();
  return domainTombstoneInFlight;
};

export const recallIndexPath = (vaultRoot: string): string =>
  join(vaultRoot, '_BAC', 'recall', 'index.bin');

export const readVaultMarkdown = async (
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

export const writerForBucket = async (
  context: CompanionHttpConfig,
  input: { readonly workstreamId?: string; readonly provider?: string; readonly url?: string },
): Promise<VaultWriter> => {
  const bucket = await context.bucketRegistry?.pickBucket(input);
  return bucket === undefined || bucket.vaultRoot === context.vaultRoot
    ? context.vaultWriter
    : createVaultWriter(bucket.vaultRoot);
};

// F02 — server-derived caller identity. The auth gate classifies each
// request by WHICH key authenticated (extension bridge key vs MCP key)
// and stashes the verdict here, keyed by the request object. Trust
// enforcement + audit provenance read this — never the voluntary
// `x-sidetrack-mcp-tool` header, which a caller could simply omit to
// slip past the gate. A WeakMap so entries are collected with the
// request and never leak across requests.
type CallerClass = 'extension' | 'mcp';

export interface CallerIdentity {
  readonly callerClass: CallerClass;
  // Best-effort client name for `mcp:<client-name>` audit provenance,
  // sourced from the (still-honoured, LOGGING-only) tool header's
  // namespace or a client hint. Undefined ⇒ 'mcp' with no sub-name.
  readonly clientName?: string;
}

export const callerIdentities = new WeakMap<IncomingMessage, CallerIdentity>();

// Default to `extension` when unclassified: legacy runtimes / tests that
// never wire an MCP key see the pre-F02 exempt behaviour, and a request
// that somehow reached a handler without passing the auth gate is treated
// as the least-privileged-surprise (extension) rather than crashing.
export const callerIdentityFor = (request: IncomingMessage): CallerIdentity =>
  callerIdentities.get(request) ?? { callerClass: 'extension' };

// Enforce per-workstream MCP write trust. Enforcement is driven by the
// SERVER-DERIVED caller class, NOT the voluntary tool header. The full
// model is TWO layers: (1) the route-dispatch layer default-denies any
// mutating route for an mcp caller unless it is on the sanctioned
// MCP_ALLOWED_MUTATING_ROUTES allowlist (isMcpAllowedRoute); (2) this
// function is the second layer, called INSIDE each allowlisted write
// handler to gate the specific workstream on its granted tool set. An
// mcp caller that reaches this function has already passed the allowlist;
// here it still needs explicit per-workstream trust for the tool. The
// extension surface (user's own bridge key) is exempt from both layers.
// Also refines the ambient audit context so the resulting audit line
// records the tool + workstream scope + that trust mode was active.
export const requireWorkstreamTrust = async (
  context: CompanionHttpConfig,
  request: IncomingMessage,
  workstreamId: string | undefined,
  tool: WorkstreamWriteTool,
): Promise<void> => {
  const identity = callerIdentityFor(request);
  recordAuditTool(tool, workstreamId ?? null);
  if (identity.callerClass !== 'mcp') {
    // Extension surface: exempt from the trust gate.
    return;
  }
  recordAuditTrustModeActive();
  if (workstreamId === undefined || context.vaultRoot === undefined) {
    return;
  }
  if (!isAllowed(workstreamId, tool, await readTrust(context.vaultRoot))) {
    throw new HttpRouteError(
      403,
      'WORKSTREAM_NOT_TRUSTED',
      'Workstream has not granted this MCP write tool.',
      `${tool} is not trusted for workstream ${workstreamId}. Grant it via the workstream's ` +
        `Trust panel in the side panel, or PUT /v1/workstreams/${workstreamId}/trust with ` +
        `allowedTools including "${tool}". (Per-call approval prompts are planned for P2.)`,
    );
  }
};

// Refine the ambient audit context with the tool + scope for the
// current write. No-op when no context is bound (direct writer use).
const recordAuditTool = (tool: string, scope: string | null): void => {
  const ctx = currentAuditContextMut();
  if (ctx === undefined) return;
  ctx.tool = tool;
  ctx.scope = scope;
};

const recordAuditTrustModeActive = (): void => {
  const ctx = currentAuditContextMut();
  if (ctx !== undefined) ctx.trustModeActive = true;
};

// Resolve-cache signature. Like statSig but the mtime is floored to
// RESOLVE_SIG_BUCKET_MS. The visres:/tabres: dry-run resolve caches
// keyed on raw statSig(current.json) NEVER hit under load: ambient
// observation (esp. now the content script injects on all pages)
// drives frequent materializer drains that rewrite current.json, so
// the raw mtime rotates the key on essentially every request and the
// SAME url is recomputed (full PPR+cluster+ranker) 30+×/min → 99%
// CPU, /status starvation (the recurring resolve-flood). Bucketing
// the mtime collapses a burst of rewrites to one key so the 30s TTL
// actually applies, while still rotating within one bucket of a real
// change (≤bucket dry-run-preview staleness — the documented
// "contextual, staleness acceptable" tradeoff); `size` still catches
// length-changing rewrites and user mutations call
// invalidateResolveCaches() for immediate freshness. Companion-side
// so it holds regardless of which extension build is loaded.
const RESOLVE_SIG_BUCKET_MS = ((): number => {
  const raw = process.env['SIDETRACK_RESOLVE_SIG_BUCKET_MS'];
  const n = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 15_000;
})();

const resolveSig = async (path: string): Promise<string> => {
  try {
    const s = await stat(path);
    const bucket =
      RESOLVE_SIG_BUCKET_MS > 0 ? Math.floor(s.mtimeMs / RESOLVE_SIG_BUCKET_MS) : s.mtimeMs;
    return `${String(bucket)}:${String(s.size)}`;
  } catch {
    return 'absent';
  }
};

const sqliteSig = async (store: SqliteConnectionsStore): Promise<string> => {
  // Mirror resolveSig's mtime bucketing for the SQLite path. Keying on
  // the RAW snapshotRevision (a hash of updatedAt+counts that advances on
  // EVERY drain) busted the resolve-cache on every drain, so the panel's
  // per-revision re-resolves never hit cache and turned into a
  // self-perpetuating flood that pegged the companion under live
  // browsing. Bucket `updatedAt` so a burst of drains within one bucket
  // collapses to a single key (the documented "≤bucket dry-run-preview
  // staleness acceptable" tradeoff); user mutations call
  // invalidateResolveCaches() for immediate freshness.
  //
  // W2 (window-poverty fix) — the term after the bucket was
  // `nodeCount:edgeCount`, which oscillated on window-poor snapshot renders
  // (Pass-7 dropped/restored ~20k↔74k similarity edges when endpoint
  // timeline-visit nodes fell out of window) and busted the SWR cache on
  // ~35/40 drains → the chronic slow-resolve tail. Rekey on the SERVED
  // visit-similarity revision id + the eligible-corpus signature (both STABLE
  // across benign node-count fluctuations — they advance only when the
  // similarity corpus content actually changes, now that W1 makes the corpus
  // path-independent) PLUS a stable NON-similarity structural discriminator:
  // `nodeCount:nonSimilarityEdgeCount`. The non-similarity term is edgeCount
  // minus the oscillating similarity family (visit_resembles_visit /
  // closest_visit), recomputed on every write path (full + scoped-delta), so
  // it rotates on a REAL non-similarity graph mutation (a new
  // thread_references_url / attribution / topic / organized-item edge) that
  // lands in the same mtime bucket without moving the similarity revision —
  // which the pure similarity-revision term would silently swallow (a
  // missed-bust of up to one ROUTE_CACHE_TTL_MS window). It does NOT oscillate
  // on the Pass-7 similarity flux the similarity terms already absorb, so it
  // reintroduces no false busts. `nodeCount` is included as a coarse node-set
  // discriminator (stable once W1 stabilizes the timeline-visit node set). Fall
  // back to nodeCount:edgeCount for pre-W2 snapshots that carry neither the
  // similarity revision nor the non-sim count (the fields are absent until the
  // first post-deploy drain writes them — one benign rotation, not a mass
  // bust). The bucket (mtime) term is retained so invalidateResolveCaches() +
  // user mutations still force freshness.
  const m = await store.readSnapshotMetadata();
  if (m === null) return 'none';
  const updatedMs = Date.parse(m.updatedAt);
  const bucket =
    RESOLVE_SIG_BUCKET_MS > 0 && Number.isFinite(updatedMs)
      ? Math.floor(updatedMs / RESOLVE_SIG_BUCKET_MS)
      : Number.isFinite(updatedMs)
        ? updatedMs
        : (m.snapshotRevision ?? 'none');
  // The non-similarity structural term: prefer the persisted
  // nonSimilarityEdgeCount, falling back to raw edgeCount only for pre-W2
  // snapshots that predate the field.
  const nonSimEdgeTerm = String(m.nonSimilarityEdgeCount ?? m.edgeCount);
  const graphTerm =
    m.visitSimilarityRevisionId !== undefined
      ? `${m.visitSimilarityRevisionId}:${m.similarityCorpusSignature ?? 'nocorpus'}:${String(m.nodeCount)}:${nonSimEdgeTerm}`
      : (m.snapshotRevision ?? `${String(m.nodeCount)}:${String(m.edgeCount)}`);
  return `${String(bucket)}:${graphTerm}`;
};

export const connectionsGraphSig = async (
  store: ConnectionsStore,
  jsonPath: string,
): Promise<string> =>
  store instanceof SqliteConnectionsStore ? await sqliteSig(store) : await resolveSig(jsonPath);

// Generic stat-fingerprint + TTL + in-flight-dedupe cache for the
// remaining uncached GET resolver/projection endpoints the extension
// polls (tabsessions/visits resolve — ~4x/min PER visible card ×
// many cards, each readCurrent 14MB + readMerged + resolve ~1s;
// workstreams/projections — readMerged + project, polled by
// refreshCachedWorkstreams). Same rationale + tradeoff as the
// connections/suggestions caches: graph-exact via current.json stat,
// event-log-derived parts ≤TTL stale (W2b "contextual" stance).
export const ROUTE_CACHE_TTL_MS = ((): number => {
  const raw = process.env['SIDETRACK_ROUTE_CACHE_TTL_MS'];
  const n = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 300_000;
})();

interface RouteCacheEntry {
  readonly result: readonly [number, unknown];
  readonly computedAtMs: number;
}

export const routeCache = new Map<string, RouteCacheEntry>();

export const routeInFlight = new Map<string, Promise<readonly [number, unknown]>>();

// Hard concurrency cap on the expensive resolve build (readCurrent
// ~14MB + readMerged + PPR/cluster/ranker ≈ 0.5–3 s of CPU each).
// cachedRoute's in-flight map only dedupes the SAME key; a flooding
// client (the recurring resolve-flood) requests MANY distinct
// urls/tab-sessions, so without a cross-key cap N concurrent builds
// peg every core and starve /status. This bounds resolver CPU to
// RESOLVE_MAX_CONCURRENCY computes regardless of request rate or
// which extension build is loaded — excess requests queue (each
// build is short; cache hits don't take a slot). /status and other
// endpoints are NOT wrapped, so the companion stays responsive even
// while resolves are queued. A permit is handed directly to the next
// waiter on release so the cap is never exceeded.
const RESOLVE_MAX_CONCURRENCY = ((): number => {
  const raw = process.env['SIDETRACK_RESOLVE_MAX_CONCURRENCY'];
  const n = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2;
})();

let resolvePermits = RESOLVE_MAX_CONCURRENCY;

const resolveWaiters: Array<() => void> = [];

export const acquireResolveSlot = (): Promise<void> =>
  new Promise<void>((resolve) => {
    if (resolvePermits > 0) {
      resolvePermits -= 1;
      resolve();
    } else {
      resolveWaiters.push(resolve);
    }
  });

export const releaseResolveSlot = (): void => {
  const next = resolveWaiters.shift();
  if (next !== undefined) {
    next();
  } else {
    resolvePermits += 1;
  }
};

// Stale-while-revalidate cache for the dry-run resolve family
// (tabsessions/:id/resolve, visits/:url/resolve, and the per-item path of
// visits/batch-resolve). See resolveSwrCache.ts for the full rationale. The
// short version: the previous cache keyed each entry on the graph sig, so
// EVERY drain (~1/min) evicted the whole visible set → the extension's ~15s
// poll recomputed ~20 cards cold (5-13s each) concurrently on the single Bun
// loop → convoy → 45s client timeouts. The SWR cache keys per URL+query
// (sig-independent for the serve decision), serves the slightly-stale value
// INSTANTLY — exactly what the panel already displays between its own polls —
// and refreshes the stale key in the background under a small concurrency
// bound so a drain can never convoy the loop.
//
// TTL + max-entries reuse the existing resolve env knobs. The background
// refresh concurrency reuses RESOLVE_MAX_CONCURRENCY so the total inline +
// background resolve CPU stays bounded by the same operator dial.
export const resolveSwrCache = new ResolveSwrCache({
  ttlMs: ROUTE_CACHE_TTL_MS,
  maxBackgroundRefresh: RESOLVE_MAX_CONCURRENCY,
  maxEntries: 256,
  now: () => Date.now(),
});

// Merge the additive `resolveFreshness` field into a served resolve body.
// Additive only — nothing consumes it yet; the UI can later surface a
// "refreshing…" affordance for stale-revalidating responses. Non-200 and
// non-object bodies pass through untouched (freeze-safe).
const withResolveFreshness = (
  result: readonly [number, unknown],
  freshness: ResolveFreshness,
): readonly [number, unknown] => {
  if (result[0] !== 200) return result;
  const body = result[1];
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return result;
  return [200, { ...(body as Record<string, unknown>), resolveFreshness: freshness }];
};

// Serve a dry-run resolve through the SWR cache. `serveKey` is per-URL+query
// (NOT sig-keyed); `sig` is the current graph signature the entry is checked
// against. Cold/TTL-expired builds run inline under the resolve concurrency
// slot so a first-ever burst still can't peg every core; the SWR cache's own
// bounded background lane handles stale refreshes.
export const serveResolveSwr = async (
  serveKey: string,
  sig: string,
  build: () => Promise<readonly [number, unknown]>,
): Promise<readonly [number, unknown]> => {
  const gatedBuild = async (): Promise<readonly [number, unknown]> => {
    await acquireResolveSlot();
    try {
      return await build();
    } finally {
      releaseResolveSlot();
    }
  };
  const served = await resolveSwrCache.serve(serveKey, sig, gatedBuild);
  return withResolveFreshness(served.result, served.freshness);
};

// The suggestion-resolve caches (visres:/tabres:) are keyed on the
// connections snapshot, deliberately NOT the event log (see the statSig
// note — seq advances every flush, so seq-keying never hits). But an
// explicit user attribution/ignore decision MUST take effect at once,
// and the resolver fuses graph signals so one decision can shift other
// suggestions too. Purge both resolve caches on every user decision.
// This is rare (a few/session), so it does NOT reintroduce the
// per-flush cache-busting the snapshot keying avoids.
export const invalidateResolveCaches = (): void => {
  for (const key of [...routeCache.keys()]) {
    if (key.startsWith('visres:') || key.startsWith('tabres:')) routeCache.delete(key);
  }
  for (const key of [...routeInFlight.keys()]) {
    if (key.startsWith('visres:') || key.startsWith('tabres:')) routeInFlight.delete(key);
  }
  resolveSwrCache.invalidate((key) => key.startsWith('visres:') || key.startsWith('tabres:'));
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
export const readThreadMetadata = async (
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

export const objectRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export const optionalAttributionPolicyMode = (
  value: unknown,
  fieldName: string,
): AttributionPolicyMode | undefined => {
  if (value === undefined) return undefined;
  if (value === 'conservative' || value === 'balanced' || value === 'aggressive') return value;
  throw new HttpRouteError(
    400,
    'VALIDATION_ERROR',
    'Validation failed.',
    `${fieldName} must be conservative, balanced, or aggressive when provided.`,
  );
};

export const optionalAttributionPolicyTelemetry = (
  value: unknown,
  fieldName: string,
): AttributionPolicyTelemetry | undefined => {
  if (value === undefined) return undefined;
  const record = objectRecord(value);
  if (record === undefined) {
    throw new HttpRouteError(
      400,
      'VALIDATION_ERROR',
      'Validation failed.',
      `${fieldName} must be an object when provided.`,
    );
  }
  const rawRegret = record['regretRateBySource'];
  if (rawRegret === undefined) return {};
  const regretRecord = objectRecord(rawRegret);
  if (regretRecord === undefined) {
    throw new HttpRouteError(
      400,
      'VALIDATION_ERROR',
      'Validation failed.',
      `${fieldName}.regretRateBySource must be an object when provided.`,
    );
  }
  const regretRateBySource: NonNullable<AttributionPolicyTelemetry['regretRateBySource']> = {};
  for (const source of ['ppr', 'similarity', 'cluster'] as const) {
    const rawRate = regretRecord[source];
    if (rawRate === undefined) continue;
    if (typeof rawRate !== 'number' || !Number.isFinite(rawRate) || rawRate < 0 || rawRate > 1) {
      throw new HttpRouteError(
        400,
        'VALIDATION_ERROR',
        'Validation failed.',
        `${fieldName}.regretRateBySource.${source} must be a number between 0 and 1.`,
      );
    }
    regretRateBySource[source] = rawRate;
  }
  return { regretRateBySource };
};

// `types`, when provided, restricts the store scan to those event types
// at the SQL level (events_type_idx via forEachChunkOfTypes) — O(matching
// rows) instead of O(all 370K events). The predicate still runs to refine
// (e.g. by canonicalUrl / tabSession). EVERY type the predicate can
// accept MUST be in `types` or matching events are missed. Without a hint
// this falls back to a full forEachChunk scan (legacy callers). This
// scan was ~4s per fresh /resolve on a real vault and, serialized across
// a burst of fresh navigations, starved /v1/status past its 45s budget.
export const readEventsFromStoreOrLog = async (
  context: CompanionHttpConfig,
  eventLog: EventLog,
  predicate: (event: AcceptedEvent) => boolean,
  types?: readonly string[],
): Promise<readonly AcceptedEvent[]> => {
  if (context.vaultRoot === undefined) {
    return (await eventLog.readMerged()).filter(predicate);
  }
  // SERVE-STALE: every caller of this helper is a route handler, and no
  // route may await a JSONL catch-up pass (measured 30-70s post-boot while
  // the event loop sat idle — the recurring busy-banner). The store is read
  // as-is; the kicked background pass freshens it for later requests.
  const store = await getSharedEventStoreServeStale(context.vaultRoot);
  if (store === null) return (await eventLog.readMerged()).filter(predicate);
  const events: AcceptedEvent[] = [];
  const collect = (chunk: readonly AcceptedEvent[]): void => {
    for (const event of chunk) {
      if (predicate(event)) events.push(event);
    }
  };
  if (types !== undefined && types.length > 0) {
    await store.forEachChunkOfTypes(types, collect, 2000);
  } else {
    await store.forEachChunk(collect, 2000);
  }
  return events;
};

// The shared typed event store for this context's vault, or null when
// disabled/unavailable — the SAME store-vs-log gate readEventsFromStoreOrLog
// uses internally. Exposed for callers that need to make a STRUCTURAL
// decision (which event types to even ask for) based on store availability,
// not just read through it — see server.ts's batch-resolve route: when the
// store is available, per-URL signal/timeline events come from an indexed
// by-URL read instead of a type-scoped window read, so the window read's
// type list can drop the (often largest) type entirely; when it is NOT
// available, the window read is the only source and must keep the full type
// list for the JS-filter fallback to stay correct.
export const eventStoreForContext = async (context: {
  readonly vaultRoot?: string | undefined;
}): Promise<EventStore | null> => {
  if (context.vaultRoot === undefined) return null;
  return await getSharedEventStoreServeStale(context.vaultRoot);
};

// Coverage token matching readEventsFromStoreOrLog's read path. Callers that
// MEMOIZE a fold over events returned by that helper MUST key the memo on
// this — the store's own watermark token when the store served the read, the
// log signature only on the log fallback. Keying a store-read fold on
// logSignature() caches it under shard appends the (possibly stale) store
// never ingested, and the memo then keeps serving the stale fold after
// catch-up lands — the memo-poisoning shape this repo has already hit once.
export const eventReadCoverageSig = async (
  context: CompanionHttpConfig,
  eventLog: EventLog,
): Promise<string> => {
  if (context.vaultRoot === undefined) return eventLog.logSignature();
  const store = await getSharedEventStoreServeStale(context.vaultRoot);
  return store === null ? eventLog.logSignature() : eventStoreCoverageToken(store);
};

// Type hints for the readEventsFromStoreOrLog callers (must list every
// type the corresponding predicate can match).
export const RESOLVER_SIGNAL_EVENT_TYPES = [USER_FLOW_REJECTED, USER_ORGANIZED_ITEM] as const;

// The bootstrap RECONSTRUCTS positives from historical explicit feedback only.
// It deliberately does NOT read recall.served/recall.action: the served+action
// snapshot-join path is the per-drain child's job (P1a), and feeding the
// thousands of historical recall.served impressions into the build here is both
// wasted work (their only actions are non-trainable click/open) and a ~44s
// single-tick freeze (synchronous feature extraction over every served set).
export const RANKER_BOOTSTRAP_FEEDBACK_EVENT_TYPES = [
  USER_FLOW_CONFIRMED,
  USER_FLOW_REJECTED,
  USER_ORGANIZED_ITEM,
  USER_SNIPPET_PROMOTED,
] as const;

export const FEEDBACK_EVENT_TYPE_LIST = [
  USER_ORGANIZED_ITEM,
  USER_ENGAGEMENT_RELABELED,
  USER_FLOW_CONFIRMED,
  USER_FLOW_REJECTED,
  USER_TOPIC_RENAMED,
  USER_SNIPPET_PROMOTED,
  // Collect-store-only: included so the typed feedback read is complete
  // (the event-store index filters by type). projectFeedback ignores it —
  // no serving consumer applies it yet (Move 2b, deferred behind the freeze).
  USER_REJECTED_RELATION,
] as const;

// Signature-keyed projection caches. The /v1/visits and /v1/tabsessions
// endpoints are polled frequently; without this each poll re-projected
// ~every event (full readMerged() materialization + a full fold), which
// (measured) churned ~860MB of RSS and kept the readMerged memo warm so
// its idle TTL never fired. Keyed by the cheap log signature: on an
// unchanged log we return the cached projection WITHOUT touching
// readMerged()/the store, so the memo idles out and no garbage is
// produced. Any shard append/add changes the signature → recompute.
// Bounded: one entry per vaultRoot, holding the aggregated projection
// (far smaller than the raw log).
const urlProjectionCache = new Map<string, { sig: string; proj: UrlProjection }>();

export const projectUrlsFromStoreOrLog = async (
  context: CompanionHttpConfig,
  eventLog: EventLog,
): Promise<UrlProjection> => {
  const key = context.vaultRoot ?? '<none>';
  // Resolve the store FIRST (serve-stale — no route awaits a catch-up pass)
  // so the memo can be keyed by what the fold will ACTUALLY see: the store's
  // own watermark token. Keying a stale fold on logSignature() would cache
  // it under appends the fold never saw and keep serving it after catch-up
  // lands. Log-fallback path keeps the log signature, as before.
  const store =
    context.vaultRoot === undefined
      ? null
      : await getSharedEventStoreServeStale(context.vaultRoot);
  const sig = store === null ? await eventLog.logSignature() : eventStoreCoverageToken(store);
  const cached = urlProjectionCache.get(key);
  if (cached !== undefined && cached.sig === sig) return cached.proj;
  let proj: UrlProjection;
  if (store === null) {
    proj = projectUrls(await eventLog.readMerged());
  } else {
    const accumulator = createEmptyUrlProjectionAccumulator();
    await store.forEachChunk((chunk) => {
      for (const event of chunk) foldEventIntoUrlProjectionAccumulator(accumulator, event);
    }, 2000);
    proj = urlProjectionFromAccumulator(accumulator);
  }
  urlProjectionCache.set(key, { sig, proj });
  return proj;
};

export const isFeedbackEventType = (
  value: unknown,
): value is
  | typeof USER_ORGANIZED_ITEM
  | typeof USER_ENGAGEMENT_RELABELED
  | typeof USER_FLOW_CONFIRMED
  | typeof USER_FLOW_REJECTED
  | typeof USER_TOPIC_RENAMED
  | typeof USER_SNIPPET_PROMOTED
  | typeof USER_REJECTED_RELATION =>
  value === USER_ORGANIZED_ITEM ||
  value === USER_ENGAGEMENT_RELABELED ||
  value === USER_FLOW_CONFIRMED ||
  value === USER_FLOW_REJECTED ||
  value === USER_TOPIC_RENAMED ||
  value === USER_SNIPPET_PROMOTED ||
  value === USER_REJECTED_RELATION;

export const aggregateIdForFeedbackEvent = (
  type: string,
  payload: Record<string, unknown>,
): string => {
  if (type === USER_ORGANIZED_ITEM) {
    return `feedback:${String(payload['itemKind'])}:${String(payload['itemId'])}`;
  }
  if (type === USER_ENGAGEMENT_RELABELED) {
    return `feedback:engagement:${String(payload['visitId'])}`;
  }
  if (type === USER_FLOW_CONFIRMED || type === USER_FLOW_REJECTED) {
    return `feedback:flow:${String(payload['relationKind'])}:${String(payload['fromId'])}:${String(
      payload['toId'],
    )}`;
  }
  if (type === USER_TOPIC_RENAMED) {
    return `feedback:topic:${String(payload['topicId'])}`;
  }
  if (type === USER_SNIPPET_PROMOTED) {
    return `feedback:snippet:${String(payload['snippetId'])}`;
  }
  if (type === USER_REJECTED_RELATION) {
    // Keyed on the unordered page pair so repeated rejections of the same two
    // pages collapse to one aggregate (last-write-wins), independent of which
    // page was the anchor when the assertion was made.
    const [a, b] = [String(payload['fromRef']), String(payload['toRef'])].sort();
    return `feedback:rejected-relation:${a}:${b}`;
  }
  return 'feedback:unknown';
};

// Stage 5.2 R2 — snapshot-first projection lookup. HTTP routes prefer the
// committed snapshot's embedded projection so reads don't pay the cost of
// projectUrls(merged) / projectTabSessions(merged) on every request. Falls
// back to re-deriving from the event log only when the snapshot is null
// (cold start before first reconciliation) or doesn't yet carry the
// projection field (loading a pre-R1 snapshot from disk).
export const loadUrlProjection = async (
  context: CompanionHttpConfig,
  eventLog: EventLog,
): Promise<{ projection: UrlProjection; snapshotRevision: string | null }> => {
  if (context.connectionsStore instanceof SqliteConnectionsStore) {
    const metadata = await context.connectionsStore.readSnapshotMetadata();
    if (metadata?.urlProjection !== undefined) {
      return {
        projection: deserializeUrlProjection(metadata.urlProjection),
        snapshotRevision: metadata.snapshotRevision ?? null,
      };
    }
  }
  const snapshot = await context.connectionsStore?.readCurrent();
  if (snapshot?.urlProjection !== undefined) {
    return {
      projection: deserializeUrlProjection(snapshot.urlProjection),
      snapshotRevision: snapshot.snapshotRevision ?? null,
    };
  }
  return {
    projection: await projectUrlsFromStoreOrLog(context, eventLog),
    snapshotRevision: snapshot?.snapshotRevision ?? null,
  };
};
