import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  access,
  appendFile,
  chmod,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';

import { buildAnchorFromTerm } from '../annotation/anchorBuilder.js';
import { bridgeKeysMatch, isBridgeKeyAccepted, rotateBridgeKey } from '../auth/bridgeKey.js';
import {
  boundArgsSummary,
  currentAuditContext as currentAuditContextMut,
  runWithAuditContext,
  type AuditContext,
} from '../vault/auditContext.js';
import { BROWSER_TIMELINE_OBSERVED, isBrowserTimelineObservedPayload } from '../timeline/events.js';
import { sanitizeTimelinePayload } from '../timeline/sanitize.js';
import {
  ENGAGEMENT_INTERVAL_OBSERVED,
  ENGAGEMENT_SESSION_AGGREGATED,
  isEngagementIntervalObservedPayload,
  isEngagementSessionAggregatedPayload,
} from '../engagement/events.js';
import {
  SELECTION_COPIED,
  SELECTION_PASTED,
  isSelectionCopiedPayload,
  isSelectionPastedPayload,
} from '../snippets/events.js';
import {
  VISUAL_FINGERPRINT_OBSERVED,
  isVisualFingerprintObservedPayload,
} from '../visual/events.js';
import { NAVIGATION_COMMITTED, isNavigationCommittedPayload } from '../navigation/events.js';
import {
  defaultAllowedTools,
  isAllowed,
  readTrust,
  writeTrust,
  type WorkstreamWriteTool,
} from '../auth/workstreamTrust.js';
import { createDispatchId, createRequestId, createReviewId } from '../domain/ids.js';
import { pickInstaller, type Installer, type InstallOptions } from '../install/index.js';
import { probeServiceLiveness } from '../install/launchd.js';
import { exportSettings } from '../portability/exportBundle.js';
import { importSettings } from '../portability/importBundle.js';
import type { RecallActivityTracker } from '../recall/activity.js';
// /v1/status availability contract (statusContract.test.ts): the
// embedder module must NOT be in this file's static import graph —
// even its import cost is unbounded (transformers/ONNX init), and
// /status has to answer during cold start. Recall call sites load it
// lazily through this memoized dynamic import instead.
type EmbedderModule = typeof import('../recall/embedder.js');
let embedderModulePromise: Promise<EmbedderModule> | null = null;
const loadEmbedderModule = (): Promise<EmbedderModule> =>
  (embedderModulePromise ??= import('../recall/embedder.js'));
import {
  expandSemanticByQuery,
  expandSemanticRecallCandidates,
  getOrBuildSemanticRecallPool,
  getSemanticRecallPoolMigrationStatus,
  readSemanticRecallPool,
  readSemanticRecallVectorStore,
} from '../recall/semanticRecallPool.js';
import {
  CAPTURE_RECORDED,
  RECALL_ACTION,
  RECALL_SERVED,
  isRecallActionPayload,
  type RecallServedPayload,
} from '../recall/events.js';
import { getModelCacheStatus } from '../recall/modelCache.js';
import {
  PAGE_CONTENT_EXTRACTED,
  PAGE_CONTENT_TOMBSTONED,
  type PageContentExtractedPayload,
  type PageContentTombstonedPayload,
} from '../page-content/types.js';
import {
  completeExtractedPageEvidenceEmbedding,
  listPageEvidenceRecords,
  readPageEvidence,
  readPageEvidenceMap,
  writeExtractedPageEvidenceFast,
  writeExtractedPageEvidence,
} from '../page-evidence/store.js';
import { queryTimelineVisits } from '../page-evidence/timelineRecall.js';
import { runRecallWithShadow as runRecallV2 } from '../recall-v2/pipeline.js';
import {
  type PageEvidenceExtractedEventPayload,
  type PageEvidenceExtractedRequest,
  type PageEvidenceRecord,
} from '../page-evidence/types.js';
import { PAGE_EVIDENCE_EXTRACTED } from '../page-evidence/events.js';
import {
  canonicalizePageUrl,
  pageContentCoverageCounts,
  queryPageContent,
  readPageContentCoverage,
  readPageContentCoverageMap,
  scanForOverCollapsedPageContent,
  type OverCollapsedRecord,
  writePageContentExtracted,
  writePageContentTombstoned,
} from '../page-content/store.js';
import { gcInventoryCached } from '../gc/plan.js';
import { readHealthHistory } from '../connections/healthHistory.js';
import { THREAD_ARCHIVED, THREAD_UNARCHIVED, THREAD_UPSERTED } from '../threads/events.js';
import { projectThread } from '../threads/projection.js';
import { WORKSTREAM_DELETED, WORKSTREAM_UPSERTED } from '../workstreams/events.js';
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
  isPrivacyGateFlippedPayload,
  isPrivacyPermissionGrantedPayload,
  isPrivacyPermissionRevokedPayload,
  PRIVACY_GATE_FLIPPED,
  PRIVACY_PERMISSION_GRANTED,
  PRIVACY_PERMISSION_REVOKED,
} from '../privacy/events.js';
import {
  USER_ENGAGEMENT_RELABELED,
  USER_FLOW_CONFIRMED,
  USER_FLOW_REJECTED,
  USER_ORGANIZED_ITEM,
  USER_SNIPPET_PROMOTED,
  USER_TOPIC_RENAMED,
  isUserEngagementRelabeledPayload,
  isUserFlowConfirmedPayload,
  isUserFlowRejectedPayload,
  isUserOrganizedItemPayload,
  isUserSnippetPromotedPayload,
  isUserTopicRenamedPayload,
} from '../feedback/events.js';
import { projectFeedback } from '../feedback/projection.js';
import { projectPrivacy } from '../privacy/projection.js';
import {
  createEmptyTabSessionProjectionAccumulator,
  deserializeTabSessionProjection,
  foldEventIntoTabSessionProjectionAccumulator,
  projectTabSessions,
  serializeTabSessionProjection,
  tabSessionProjectionFromAccumulator,
  tabSessionInbox,
  type TabSessionProjection,
} from '../tabsession/projection.js';
import { overlayUrlAttributionOntoTabSessions } from '../tabsession/urlAttributionOverlay.js';
import { autoApplyTabSessionAttribution } from '../tabsession/autoApply.js';
import type { AttributionPolicyMode, AttributionPolicyTelemetry } from '../tabsession/policy.js';
import {
  resolveAttribution,
  resolveThreadAttribution,
  resolveUrlAttribution,
  type UrlResolutionResult,
} from '../tabsession/resolver.js';
import {
  createEmptyUrlProjectionAccumulator,
  deserializeUrlProjection,
  foldEventIntoUrlProjectionAccumulator,
  projectUrls,
  serializeUrlProjection,
  urlInbox,
  urlProjectionFromAccumulator,
  type UrlProjection,
} from '../urls/projection.js';
import { autoApplyUrlAttribution } from '../urls/autoApply.js';
import { URL_IGNORED } from '../urls/events.js';
import {
  appendEntry as appendEntryRaw,
  gcEntries as gcEntriesRaw,
  readIndex,
  tombstoneByThread as tombstoneByThreadRaw,
  upsertEntries as upsertEntriesRaw,
} from '../recall/indexFile.js';
import type { RecallLifecycle } from '../recall/lifecycle.js';
import { buildLexicalIndex, rank, rankHybrid, type HybridLexicalIndex } from '../recall/ranker.js';
import { generateCandidates } from '../ranker/candidates.js';
import type { BucketRegistry } from '../routing/registry.js';
import { redact } from '../safety/redaction.js';
import { estimateTokens, tokenThresholdForProvider } from '../safety/tokenBudget.js';
import { applyFeedbackOverlayToSnapshot } from '../connections/feedbackOverlay.js';
import { SqliteConnectionsStore, type ConnectionsStore } from '../connections/snapshot.js';
import { overlayTopicRevisionOnSnapshot } from '../connections/topicSnapshotOverlay.js';
import { createTopicRevisionStore } from '../producers/topic-revision.js';
import {
  eventStoreEnabled,
  getCaughtUpSharedEventStore,
  getSharedEventStore,
} from '../sync/eventStore.js';
import { getEventLaneHealth } from '../sync/eventLaneHealth.js';
import type { EventLog } from '../sync/eventLog.js';
import type { ProjectionChangeFeed } from '../sync/projectionChanges.js';
import {
  vectorFromEvents,
  type AcceptedEvent,
  type TargetRef,
  type VersionVector,
} from '../sync/causal.js';
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
  syncMaterializerHealth?: CompanionHttpConfig['syncMaterializerHealth'],
): {
  syncSummary?: () => {
    replicaId: string;
    seq: number;
    relay?: {
      readonly mode: 'local' | 'remote';
      readonly url: string;
      readonly connected?: boolean;
      readonly lastConnectedAtMs?: number;
      readonly lastDisconnectedAtMs?: number;
      readonly consecutiveFailures?: number;
      readonly pendingPublishes?: number;
    };
    materializers?: Record<
      string,
      {
        readonly status: 'healthy' | 'busy' | 'degraded' | 'failed';
        readonly lastSuccessAt: string | null;
        readonly lastError: string | null;
        readonly pending: boolean;
      }
    >;
  };
} =>
  replica === undefined
    ? {}
    : {
        syncSummary: () => {
          // Splice live transport status into the relay block so
          // the side panel can render relay_disconnected without
          // hitting a separate endpoint. Only present when both
          // (a) relay is configured AND (b) the runtime exposed
          // a getRelayStatus closure (production wiring does;
          // tests that pass --sync-relay-local without a live
          // transport may not).
          const relayBase = sync?.relay;
          const materializers = syncMaterializerHealth?.();
          const materializersBlock =
            materializers === undefined || Object.keys(materializers).length === 0
              ? {}
              : { materializers };
          if (relayBase === undefined) {
            return {
              replicaId: replica.replicaId,
              seq: replica.peekSeq(),
              ...materializersBlock,
            };
          }
          const live = sync?.getRelayStatus?.() ?? null;
          return {
            replicaId: replica.replicaId,
            seq: replica.peekSeq(),
            relay: {
              ...relayBase,
              ...(live === null
                ? {}
                : {
                    connected: live.connected,
                    consecutiveFailures: live.consecutiveFailures,
                    pendingPublishes: live.pendingPublishes,
                    ...(live.lastConnectedAtMs === undefined
                      ? {}
                      : { lastConnectedAtMs: live.lastConnectedAtMs }),
                    ...(live.lastDisconnectedAtMs === undefined
                      ? {}
                      : { lastDisconnectedAtMs: live.lastDisconnectedAtMs }),
                    // Stage 5 polish — peer-event throughput. Older
                    // runtimes that haven't been recompiled won't have
                    // these fields; guard via undefined.
                    ...(live.eventsIn === undefined ? {} : { eventsIn: live.eventsIn }),
                    ...(live.eventsOut === undefined ? {} : { eventsOut: live.eventsOut }),
                    ...(live.lastInboundAtMs === undefined
                      ? {}
                      : { lastInboundAtMs: live.lastInboundAtMs }),
                    ...(live.lastOutboundAtMs === undefined
                      ? {}
                      : { lastOutboundAtMs: live.lastOutboundAtMs }),
                    ...(live.byReplica === undefined ? {} : { byReplica: live.byReplica }),
                  }),
            },
            ...materializersBlock,
          };
        },
      };
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
const baseVectorForAggregate = async (
  eventLog: EventLog,
  aggregateId: string,
): Promise<VersionVector> => vectorFromEvents(await eventLog.readByAggregate(aggregateId));

import { isReviewDraftEvent, projectReviewDraft } from '../review/projection.js';
import {
  deleteReviewDraft,
  listReviewDrafts,
  readReviewDraft,
  writeReviewDraft,
} from '../vault/reviewDrafts.js';
import { runAutoUpdate } from '../system/autoUpdate.js';
import {
  collectHealth,
  resolveServiceRunning,
  type CaptureWarningHealth,
  type HealthReport,
} from '../system/health.js';
import {
  collectWorkGraphHealth,
  type ConnectionsDiagnosticSnapshot,
} from '../system/workGraphHealth.js';
import {
  isWorkGraphHealthArtifactFresh,
  readWorkGraphHealthArtifact,
} from '../system/workGraphHealthArtifact.js';
import { checkLatestVersion, type UpdateAdvisory } from '../system/versionCheck.js';
import { COMPANION_VERSION } from '../version.js';
import { maybeRetrainClosestVisitRanker, runMaybeRetrainInWorker } from '../ranker/retrain.js';
import { runRecallImpressionBootstrap } from '../ranker/impressionBootstrap.js';
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
import { VaultExportConfinementError, VaultUnavailableError } from './errors.js';
import type { IdempotencyStore } from './idempotency.js';
import type { ValidationIssue } from './problem.js';
import { createProblem } from './problem.js';
import {
  annotationCreateSchema,
  annotationListQuerySchema,
  annotationUpdateSchema,
  auditEventSchema,
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
  recallV2RequestSchema,
  pageContentCoverageQuerySchema,
  pageContentExtractedSchema,
  pageEvidenceExtractedSchema,
  pageContentTombstonedSchema,
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
  workstreamExportSchema,
  autoUpdateSchema,
  bucketsPutSchema,
  workstreamTrustPutSchema,
} from './schemas.js';

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
}

interface RouteDefinition {
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
let httpDebugLogModeEnsured = false;
const appendHttpDebugLine = async (line: string): Promise<void> => {
  await appendFile(HTTP_DEBUG_LOG_PATH, line, { mode: 0o600 });
  if (!httpDebugLogModeEnsured) {
    httpDebugLogModeEnsured = true;
    await chmod(HTTP_DEBUG_LOG_PATH, 0o600).catch(() => undefined);
  }
};

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
  const hiHex = ((hi >>> 0).toString(16)).padStart(8, '0');
  const loHex = ((lo >>> 0).toString(16)).padStart(8, '0');
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

// Lexical-index cache for /v1/recall/query. Building the MiniSearch
// index over every chunk on each request is wasteful — it only
// changes when the on-disk index file changes. Keyed by index path
// + mtime; a write through upsertEntries / rebuildFromEventLog
// updates the file mtime and invalidates the cache on the next
// query.
interface LexicalCacheEntry {
  readonly mtimeMs: number;
  readonly entryCount: number;
  readonly index: HybridLexicalIndex;
}
const lexicalIndexCache = new Map<string, LexicalCacheEntry>();

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

interface ThreadSuggestionTarget {
  readonly threadId: string;
  readonly providerThreadId?: string;
  readonly threadUrl?: string;
}

const readThreadSuggestionTarget = async (
  vaultRoot: string,
  requestedThreadId: string,
): Promise<ThreadSuggestionTarget> => {
  const root = join(vaultRoot, '_BAC', 'threads');
  const names = await readdir(root).catch(() => []);
  for (const name of names.filter((candidate) => candidate.endsWith('.json'))) {
    try {
      const parsed = JSON.parse(await readFile(join(root, name), 'utf8')) as {
        readonly bac_id?: unknown;
        readonly threadId?: unknown;
        readonly threadUrl?: unknown;
      };
      const bacId = typeof parsed.bac_id === 'string' ? parsed.bac_id : undefined;
      const providerThreadId = typeof parsed.threadId === 'string' ? parsed.threadId : undefined;
      if (bacId === requestedThreadId || providerThreadId === requestedThreadId) {
        return {
          threadId: bacId ?? requestedThreadId,
          ...(providerThreadId === undefined ? {} : { providerThreadId }),
          ...(typeof parsed.threadUrl === 'string' ? { threadUrl: parsed.threadUrl } : {}),
        };
      }
    } catch {
      // Ignore malformed thread records.
    }
  }
  return { threadId: requestedThreadId };
};

// Loose URL-shape check: rejects strings that won't parse as a URL
// before we hand them to `canonicalizePageUrl` (which throws). The
// concrete defect that surfaced this in dogfood: some materializer
// path emitted `timeline-visit` nodes whose id was the visit instance
// id (`timeline-visit:visit_<ts>_<hash>`) with no `metadata.canonicalUrl`,
// so the existing "slice off the prefix" fallback returned the visit
// id itself — which `new URL(...)` rejects with ERR_INVALID_URL,
// 500-ing the whole /v1/connections endpoint.
const looksLikeUrl = (s: string): boolean => {
  if (s.length === 0) return false;
  // Require a scheme separator. Everything we actually want here
  // (http, https, chrome-extension, file, about, moz-extension, …)
  // has `://` or `:`; `visit_<ts>_<hash>` has neither.
  return s.includes('://') || /^[a-z][a-z0-9+.-]*:/i.test(s);
};

const deriveTimelineVisitUrl = (node: {
  readonly id: string;
  readonly metadata: { readonly canonicalUrl?: unknown };
}): string | undefined => {
  const fromMeta = node.metadata.canonicalUrl;
  if (typeof fromMeta === 'string' && looksLikeUrl(fromMeta)) return fromMeta;
  if (node.id.startsWith('timeline-visit:')) {
    const sliced = node.id.slice('timeline-visit:'.length);
    if (looksLikeUrl(sliced)) return sliced;
  }
  return undefined;
};

const applyPageContentCoverageToSnapshot = async (
  vaultRoot: string,
  snapshot: import('../connections/snapshot.js').ConnectionsSnapshot,
): Promise<import('../connections/snapshot.js').ConnectionsSnapshot> => {
  const timelineUrls = snapshot.nodes
    .filter((node) => node.kind === 'timeline-visit')
    .map((node) => deriveTimelineVisitUrl(node) ?? '')
    .filter((url) => url.length > 0);
  if (timelineUrls.length === 0) return snapshot;
  const coverageByUrl = await readPageContentCoverageMap(vaultRoot, timelineUrls);
  return {
    ...snapshot,
    nodes: snapshot.nodes.map((node) => {
      if (node.kind !== 'timeline-visit') return node;
      const canonicalUrl = deriveTimelineVisitUrl(node);
      if (canonicalUrl === undefined) return node;
      const coverage = coverageByUrl.get(canonicalizePageUrl(canonicalUrl));
      if (coverage === undefined) return node;
      return {
        ...node,
        metadata: {
          ...node.metadata,
          pageContent: {
            state: coverage.state,
            ...(coverage.quality === undefined ? {} : { quality: coverage.quality }),
            ...(coverage.lastIndexedAt === undefined
              ? {}
              : { lastIndexedAt: coverage.lastIndexedAt }),
            ...(coverage.extractionSource === undefined
              ? {}
              : { extractionSource: coverage.extractionSource }),
            ...(coverage.chunkCount === undefined ? {} : { chunkCount: coverage.chunkCount }),
            ...(coverage.indexedCharCount === undefined
              ? {}
              : { indexedCharCount: coverage.indexedCharCount }),
            ...(coverage.error === undefined ? {} : { error: coverage.error }),
          },
        },
      };
    }),
  };
};

const trimTrailingUrlSlash = (value: string): string =>
  value.length > 0 ? value.replace(/\/+$/u, '') : value;

const metadataString = (
  metadata: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | undefined => {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
};

const addNodeAnchorAlias = (
  aliases: Map<string, string>,
  alias: string | undefined,
  targetNodeId: string,
): void => {
  if (alias === undefined || alias.length === 0) return;
  if (!aliases.has(alias)) aliases.set(alias, targetNodeId);
  const trimmed = trimTrailingUrlSlash(alias);
  if (trimmed.length > 0 && !aliases.has(trimmed)) aliases.set(trimmed, targetNodeId);
};

const resolveConnectionsNodeId = (
  snapshot: import('../connections/snapshot.js').ConnectionsSnapshot,
  nodeId: string,
): string => {
  if (snapshot.nodes.some((node) => node.id === nodeId)) return nodeId;

  const aliases = new Map<string, string>();
  for (const node of snapshot.nodes) {
    addNodeAnchorAlias(aliases, node.id, node.id);
    const canonicalUrl = metadataString(node.metadata, ['canonicalUrl', 'url', 'latestUrl']);
    if (canonicalUrl !== undefined) {
      if (node.kind === 'timeline-visit') {
        addNodeAnchorAlias(aliases, `timeline-visit:${canonicalUrl}`, node.id);
        addNodeAnchorAlias(aliases, canonicalUrl, node.id);
      }
    }
    addNodeAnchorAlias(aliases, metadataString(node.metadata, ['timelineVisitId']), node.id);
  }

  return aliases.get(nodeId) ?? aliases.get(trimTrailingUrlSlash(nodeId)) ?? nodeId;
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

const compactPageContentExtractedPayload = (
  payload: ReturnType<typeof pageContentExtractedSchema.parse>,
): PageContentExtractedPayload => ({
  payloadVersion: payload.payloadVersion,
  canonicalUrl: payload.canonicalUrl,
  url: payload.url,
  ...(payload.title === undefined ? {} : { title: payload.title }),
  ...(payload.provider === undefined ? {} : { provider: payload.provider }),
  extractedAt: payload.extractedAt,
  extractionSource: payload.extractionSource,
  extractionPolicy: {
    trigger: payload.extractionPolicy.trigger,
    ...(payload.extractionPolicy.workstreamId === undefined
      ? {}
      : { workstreamId: payload.extractionPolicy.workstreamId }),
    ...(payload.extractionPolicy.domainPolicyId === undefined
      ? {}
      : { domainPolicyId: payload.extractionPolicy.domainPolicyId }),
  },
  quality: payload.quality,
  qualitySignals: {
    extractedWordCount: payload.qualitySignals.extractedWordCount,
    contentToDomRatio: payload.qualitySignals.contentToDomRatio,
    boilerplateFraction: payload.qualitySignals.boilerplateFraction,
    extractionStrategy: payload.qualitySignals.extractionStrategy,
    ...(payload.qualitySignals.headingSignatureHash === undefined
      ? {}
      : { headingSignatureHash: payload.qualitySignals.headingSignatureHash }),
  },
  content: {
    text: payload.content.text,
    ...(payload.content.markdown === undefined ? {} : { markdown: payload.content.markdown }),
    contentHash: payload.content.contentHash,
    charCount: payload.content.charCount,
  },
  ...(payload.redaction === undefined
    ? {}
    : {
        redaction: {
          applied: payload.redaction.applied,
          rules: payload.redaction.rules,
        },
      }),
  ...(payload.dimensions === undefined ? {} : { dimensions: payload.dimensions }),
});

const compactPageEvidenceExtractedPayload = (
  payload: ReturnType<typeof pageEvidenceExtractedSchema.parse>,
): PageEvidenceExtractedRequest => ({
  ...compactPageContentExtractedPayload(payload),
  storageMode: payload.storageMode,
});

const pageEvidenceExtractedEventPayload = (
  evidence: PageEvidenceRecord,
  request: PageEvidenceExtractedRequest,
): PageEvidenceExtractedEventPayload => ({
  payloadVersion: 1,
  canonicalUrl: evidence.canonicalUrl,
  evidenceRevision: evidence.evidenceRevision,
  semanticFeatureRevision: evidence.semanticFeatureRevision,
  behaviorMetadataRevision: evidence.behaviorMetadataRevision,
  evidenceTier: evidence.evidenceTier,
  ...(evidence.content?.contentHash === undefined
    ? {}
    : { contentHash: evidence.content.contentHash }),
  storageMode: request.storageMode,
  versions: evidence.versions,
  ...(evidence.content?.quality === undefined ? {} : { quality: evidence.content.quality }),
  termCount: evidence.content?.terms.length ?? 0,
  keyphraseCount: evidence.content?.keyphrases.length ?? 0,
  entityCount: evidence.content?.entities.length ?? 0,
  ...(evidence.content?.docEmbeddingRef === undefined
    ? {}
    : {
        vectorRef: {
          modelId: evidence.content.docEmbeddingRef.modelId,
          modelVersion: evidence.content.docEmbeddingRef.modelVersion,
          dimensions: evidence.content.docEmbeddingRef.dimensions,
        },
      }),
  ...(evidence.content?.embeddingState === undefined
    ? {}
    : { embeddingState: evidence.content.embeddingState }),
  trigger: request.extractionPolicy.trigger,
});

const pageEvidenceSummaryPayload = (evidence: PageEvidenceRecord): Record<string, unknown> => ({
  tier: evidence.evidenceTier,
  evidenceRevision: evidence.evidenceRevision,
  semanticFeatureRevision: evidence.semanticFeatureRevision,
  updatedAt: evidence.updatedAt,
  termCount: evidence.content?.terms.length ?? 0,
  keyphraseCount: evidence.content?.keyphrases.length ?? 0,
  entityCount: evidence.content?.entities.length ?? 0,
  ...(evidence.content?.quality === undefined ? {} : { quality: evidence.content.quality }),
  ...(evidence.content?.docEmbeddingRef === undefined
    ? {}
    : {
        vector: {
          modelId: evidence.content.docEmbeddingRef.modelId,
          modelVersion: evidence.content.docEmbeddingRef.modelVersion,
          dimensions: evidence.content.docEmbeddingRef.dimensions,
        },
      }),
});

const compactPageContentTombstonedPayload = (
  payload: ReturnType<typeof pageContentTombstonedSchema.parse>,
): PageContentTombstonedPayload => ({
  payloadVersion: payload.payloadVersion,
  canonicalUrl: payload.canonicalUrl,
  tombstonedAt: payload.tombstonedAt,
  reason: payload.reason,
  ...(payload.contentHash === undefined ? {} : { contentHash: payload.contentHash }),
  ...(payload.dimensions === undefined ? {} : { dimensions: payload.dimensions }),
});

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

// F02 — server-derived caller identity. The auth gate classifies each
// request by WHICH key authenticated (extension bridge key vs MCP key)
// and stashes the verdict here, keyed by the request object. Trust
// enforcement + audit provenance read this — never the voluntary
// `x-sidetrack-mcp-tool` header, which a caller could simply omit to
// slip past the gate. A WeakMap so entries are collected with the
// request and never leak across requests.
type CallerClass = 'extension' | 'mcp';

interface CallerIdentity {
  readonly callerClass: CallerClass;
  // Best-effort client name for `mcp:<client-name>` audit provenance,
  // sourced from the (still-honoured, LOGGING-only) tool header's
  // namespace or a client hint. Undefined ⇒ 'mcp' with no sub-name.
  readonly clientName?: string;
}

const callerIdentities = new WeakMap<IncomingMessage, CallerIdentity>();

const setCallerIdentity = (request: IncomingMessage, identity: CallerIdentity): void => {
  callerIdentities.set(request, identity);
};

// Default to `extension` when unclassified: legacy runtimes / tests that
// never wire an MCP key see the pre-F02 exempt behaviour, and a request
// that somehow reached a handler without passing the auth gate is treated
// as the least-privileged-surprise (extension) rather than crashing.
const callerIdentityFor = (request: IncomingMessage): CallerIdentity =>
  callerIdentities.get(request) ?? { callerClass: 'extension' };

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
const MCP_ALLOWED_MUTATING_ROUTES: readonly { readonly method: HttpMethod; readonly pattern: RegExp }[] =
  [
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
const requireWorkstreamTrust = async (
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

// Write an audit row for an HTTP write that does NOT flow through the
// vault writer's own audit() closure (annotation edits/deletes go straight
// to annotationStore, so they never recorded a provenance line). Mirrors
// the writer's audit format + on-disk layout (_BAC/audit/<YYYY-MM-DD>.jsonl,
// one JSON object per line) and merges the ambient request-scoped
// AuditContext (agent / tool / argsSummary / scope / trustModeActive) so
// the caller identity is on the line. Best-effort: an audit-write failure
// must never fail the mutation it records.
const appendHttpAuditLine = async (
  vaultRoot: string,
  event: { readonly requestId: string; readonly route: string; readonly bac_id?: string },
): Promise<void> => {
  const timestamp = new Date().toISOString();
  const provenance = currentAuditContextMut();
  const base = {
    requestId: event.requestId,
    route: event.route,
    outcome: 'success' as const,
    ...(event.bac_id === undefined ? {} : { bac_id: event.bac_id }),
    timestamp,
  };
  const enriched =
    provenance === undefined
      ? base
      : {
          ...base,
          agent: provenance.agent,
          tool: provenance.tool,
          ...(provenance.argsSummary === undefined ? {} : { argsSummary: provenance.argsSummary }),
          scope: provenance.scope,
          trustModeActive: provenance.trustModeActive,
        };
  // Validate against the shared schema so an invalid line can never reach
  // disk (the audit reader parses with the same schema).
  const parsed = auditEventSchema.safeParse(enriched);
  if (!parsed.success) return;
  const auditPath = join(vaultRoot, '_BAC', 'audit', `${timestamp.slice(0, 10)}.jsonl`);
  await mkdir(join(vaultRoot, '_BAC', 'audit'), { recursive: true }).catch(() => undefined);
  await appendFile(auditPath, `${JSON.stringify(parsed.data)}\n`, 'utf8').catch(() => undefined);
};

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

// `/v1/system/health` is polled by the extension (App.tsx every
// ~15-30s, HealthPanel ~30s) with NO in-flight dedupe across its
// (observed: 6) stacked sockets. Each call is ~0.85s and fully
// UNCACHED: directorySize() recurses the entire multi-GB _BAC tree,
// and the workGraph section's LIVE fallback (drain-time artifact
// missing — see system/workGraphHealthArtifact.ts) re-reads the typed
// event subsets (two FULL eventLog.readMerged passes when
// SIDETRACK_EVENT_STORE is off) + fingerprints every training label.
// Concurrent/rapid polls pile up into N overlapping full-tree walks
// ⇒ a pinned core (the second, non-connections CPU runaway). Mirror
// the /v1/system/hygiene-status fix (gcInventoryCached): a short TTL
// + in-flight dedupe so rapid/overlapping polls coalesce to ~1
// compute. Health is a status indicator; ≤TTL staleness is fine (the
// hygiene sibling uses a 5-MIN TTL — this is far more conservative).
// P3 — default raised 10s→60s. The extension polls /v1/system/health
// ~every 30s, so a 10s TTL guaranteed a cache MISS on every poll
// (~441ms recompute each). Health is a status indicator; ≤60s
// staleness is fine (the sibling /v1/system/hygiene-status uses a
// 5-min TTL). Env-tunable; resolved once (process-lifetime const).
const SYSTEM_HEALTH_TTL_MS = ((): number => {
  const raw = process.env['SIDETRACK_SYSTEM_HEALTH_TTL_MS'];
  const n = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
})();
interface SystemHealthCacheEntry {
  readonly value: HealthReport;
  readonly computedAtMs: number;
}
const systemHealthCache = new Map<string, SystemHealthCacheEntry>();
const systemHealthInFlight = new Map<string, Promise<HealthReport>>();
const cachedCollectHealth = async (
  vaultRoot: string,
  build: () => Promise<HealthReport>,
): Promise<HealthReport> => {
  const cached = systemHealthCache.get(vaultRoot);
  if (cached !== undefined && Date.now() - cached.computedAtMs < SYSTEM_HEALTH_TTL_MS) {
    return cached.value;
  }
  const existing = systemHealthInFlight.get(vaultRoot);
  if (existing !== undefined) return existing;
  const compute = (async (): Promise<HealthReport> => {
    try {
      const value = await build();
      systemHealthCache.set(vaultRoot, { value, computedAtMs: Date.now() });
      return value;
    } catch (err) {
      // A failed refresh must not poison: serve the last good value
      // if we have one (mirrors gcInventoryCached).
      const prev = systemHealthCache.get(vaultRoot);
      if (prev !== undefined) return prev.value;
      throw err;
    } finally {
      systemHealthInFlight.delete(vaultRoot);
    }
  })();
  systemHealthInFlight.set(vaultRoot, compute);
  return compute;
};

// GET /v1/connections rebuilds a ~14MB response per call: readCurrent
// (14MB) + readMerged (whole event log → feedback overlay) +
// applyPageContentCoverage + JSON-serialize ~14MB — UNCACHED,
// measured ~1.5-2.7s/call. The extension's connections view polls it
// across (observed) 6+ stacked sockets ⇒ a pinned core (the second,
// non-connections CPU runaway, "consumer #2"). current.json is
// stable under the W1c drain floor and the event log only advances
// on the extension's ~1/min flush, so a CHEAP fingerprint —
// current.json + shadow file stat (mtime+size) + replica.peekSeq()
// (cheap in-memory event-log version, the only thing the feedback
// overlay depends on) + the query string — hits constantly between
// flushes. A TTL ceiling bounds any fingerprint miss; in-flight
// dedupe collapses the concurrent polls into one compute.
const CONNECTIONS_RESPONSE_TTL_MS = ((): number => {
  const raw = process.env['SIDETRACK_CONNECTIONS_RESPONSE_TTL_MS'];
  const n = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 30_000;
})();
interface ConnectionsResponseCacheEntry {
  readonly result: readonly [number, unknown];
  readonly etag: string;
  readonly computedAtMs: number;
}
const connectionsResponseCache = new Map<string, ConnectionsResponseCacheEntry>();
const connectionsResponseInFlight = new Map<string, Promise<readonly [number, unknown]>>();
const connectionsResponseGraphKey = (key: string): string => key.split('|q=', 1)[0] ?? key;
const pruneConnectionsResponseCacheForGraph = (key: string): void => {
  const graphKey = connectionsResponseGraphKey(key);
  for (const cachedKey of connectionsResponseCache.keys()) {
    if (connectionsResponseGraphKey(cachedKey) !== graphKey) {
      connectionsResponseCache.delete(cachedKey);
    }
  }
};
const statSig = async (path: string): Promise<string> => {
  try {
    const s = await stat(path);
    return `${String(s.mtimeMs)}:${String(s.size)}`;
  } catch {
    return 'absent';
  }
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
  // staleness acceptable" tradeoff); nodeCount/edgeCount still rotate the
  // key on a real graph change, and user mutations call
  // invalidateResolveCaches() for immediate freshness.
  const m = await store.readSnapshotMetadata();
  if (m === null) return 'none';
  const updatedMs = Date.parse(m.updatedAt);
  const bucket =
    RESOLVE_SIG_BUCKET_MS > 0 && Number.isFinite(updatedMs)
      ? Math.floor(updatedMs / RESOLVE_SIG_BUCKET_MS)
      : Number.isFinite(updatedMs)
        ? updatedMs
        : (m.snapshotRevision ?? 'none');
  return `${String(bucket)}:${String(m.nodeCount)}:${String(m.edgeCount)}`;
};
const connectionsGraphSig = async (store: ConnectionsStore, jsonPath: string): Promise<string> =>
  store instanceof SqliteConnectionsStore ? await sqliteSig(store) : await resolveSig(jsonPath);
// NOTE: deliberately NOT keyed on replica.peekSeq()/event-log
// position. The feedback + page-content overlays do depend on the
// event log, but it advances on EVERY extension event flush (~1/min
// of edge events, many per flush), so a seq-keyed cache never hits
// under the real workload (validated: 0 hits, CPU unchanged). Key
// only on what makes the GRAPH change — current.json (W1c-floored,
// so stable between drains) + the shadow revision file + the query.
// The overlays' freshness is bounded by CONNECTIONS_RESPONSE_TTL_MS
// instead: graph structure is exact, contextual overlays are
// ≤TTL stale. Consistent with the W2b "connections is contextual,
// not user-immediate-feedback; staleness is acceptable" stance.
const connectionsResponseCacheKey = async (
  store: ConnectionsStore,
  vaultRoot: string,
  querySearch: string,
): Promise<string> => {
  const root = join(vaultRoot, '_BAC', 'connections');
  const [cur, shadow] = await Promise.all([
    connectionsGraphSig(store, join(root, 'current.json')),
    statSig(join(root, 'topics', 'current.shadow.json')),
  ]);
  return `cur=${cur}|shadow=${shadow}|q=${querySearch}`;
};
// Stable short ETag derived from the (already collision-resistant)
// cache key. Exposed for HTTP If-None-Match → 304 (staged separately).
const connectionsResponseEtag = (key: string): string =>
  `"c-${createHash('sha256').update(key).digest('hex').slice(0, 16)}"`;
const cachedConnectionsResponse = async (
  key: string,
  ttlMs: number,
  build: () => Promise<readonly [number, unknown]>,
): Promise<{ result: readonly [number, unknown]; etag: string }> => {
  const cached = connectionsResponseCache.get(key);
  if (cached !== undefined && Date.now() - cached.computedAtMs < ttlMs) {
    return { result: cached.result, etag: cached.etag };
  }
  const inFlight = connectionsResponseInFlight.get(key);
  if (inFlight !== undefined) {
    return { result: await inFlight, etag: connectionsResponseEtag(key) };
  }
  // Each cached /v1/connections response holds its nodes/edges arrays,
  // which in turn keep that revision's materialized graph alive. Once a
  // newer graph key is requested, drop older revision responses before
  // build() calls readCurrent() and allocates the replacement snapshot.
  pruneConnectionsResponseCacheForGraph(key);
  const compute = (async (): Promise<readonly [number, unknown]> => {
    try {
      const result = await build();
      // Only pin successful full-snapshot responses; errors/empties
      // are cheap and must not be cached.
      if (result[0] === 200) {
        connectionsResponseCache.set(key, {
          result,
          etag: connectionsResponseEtag(key),
          computedAtMs: Date.now(),
        });
        // Bound resident memory: each cached response pins that revision's
        // full filtered nodes/edges arrays (~14MB). First drop expired
        // entries, then HARD-cap the count by evicting the oldest (by
        // compute time). The cache is a pure memo keyed on revision+query,
        // so a re-computed variant returns byte-identical output — eviction
        // can only change hit rate, never bytes. Caps the worst-case
        // resident set at ~N×fullGraph instead of 16×.
        const MAX_CONNECTIONS_RESPONSE_CACHE = 4;
        const now = Date.now();
        for (const [k, v] of connectionsResponseCache) {
          if (now - v.computedAtMs >= ttlMs) connectionsResponseCache.delete(k);
        }
        if (connectionsResponseCache.size > MAX_CONNECTIONS_RESPONSE_CACHE) {
          const oldestFirst = [...connectionsResponseCache.entries()].sort(
            (a, b) => a[1].computedAtMs - b[1].computedAtMs,
          );
          for (const [k] of oldestFirst.slice(
            0,
            oldestFirst.length - MAX_CONNECTIONS_RESPONSE_CACHE,
          )) {
            connectionsResponseCache.delete(k);
          }
        }
      }
      return result;
    } finally {
      connectionsResponseInFlight.delete(key);
    }
  })();
  connectionsResponseInFlight.set(key, compute);
  return { result: await compute, etag: connectionsResponseEtag(key) };
};

// GET /v1/suggestions/thread/<id> is the dominant "consumer #2"
// (ground-truth request log: the sidepanel fires one fetch PER
// visible thread row on every render — observed ~1.3 req/s per
// thread, ~600ms each: readCurrent 14MB + readMerged whole log +
// resolveThreadAttribution graph PPR/sim/cluster, UNCACHED). Same
// fix: cache per (threadId, current.json stat, query). TTL bounds
// the event-log-derived attribution freshness (deliberately NOT
// keyed on event seq — that floods, see connections cache note);
// in-flight dedupe collapses the concurrent duplicate fetches the
// extension fires on re-render.
const THREAD_SUGGESTIONS_TTL_MS = ((): number => {
  const raw = process.env['SIDETRACK_THREAD_SUGGESTIONS_TTL_MS'];
  const n = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 30_000;
})();
interface ThreadSuggestionsCacheEntry {
  readonly result: readonly [number, unknown];
  readonly computedAtMs: number;
}
const threadSuggestionsCache = new Map<string, ThreadSuggestionsCacheEntry>();
const threadSuggestionsInFlight = new Map<string, Promise<readonly [number, unknown]>>();
const cachedThreadSuggestions = async (
  key: string,
  ttlMs: number,
  build: () => Promise<readonly [number, unknown]>,
): Promise<readonly [number, unknown]> => {
  const cached = threadSuggestionsCache.get(key);
  if (cached !== undefined && Date.now() - cached.computedAtMs < ttlMs) {
    return cached.result;
  }
  const inFlight = threadSuggestionsInFlight.get(key);
  if (inFlight !== undefined) return inFlight;
  const compute = (async (): Promise<readonly [number, unknown]> => {
    try {
      const result = await build();
      if (result[0] === 200) {
        threadSuggestionsCache.set(key, { result, computedAtMs: Date.now() });
        if (threadSuggestionsCache.size > 64) {
          const now = Date.now();
          for (const [k, v] of threadSuggestionsCache) {
            if (now - v.computedAtMs >= ttlMs) threadSuggestionsCache.delete(k);
          }
        }
      }
      return result;
    } finally {
      threadSuggestionsInFlight.delete(key);
    }
  })();
  threadSuggestionsInFlight.set(key, compute);
  return compute;
};

// Generic stat-fingerprint + TTL + in-flight-dedupe cache for the
// remaining uncached GET resolver/projection endpoints the extension
// polls (tabsessions/visits resolve — ~4x/min PER visible card ×
// many cards, each readCurrent 14MB + readMerged + resolve ~1s;
// workstreams/projections — readMerged + project, polled by
// refreshCachedWorkstreams). Same rationale + tradeoff as the
// connections/suggestions caches: graph-exact via current.json stat,
// event-log-derived parts ≤TTL stale (W2b "contextual" stance).
const ROUTE_CACHE_TTL_MS = ((): number => {
  const raw = process.env['SIDETRACK_ROUTE_CACHE_TTL_MS'];
  const n = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 300_000;
})();
interface RouteCacheEntry {
  readonly result: readonly [number, unknown];
  readonly computedAtMs: number;
}
const routeCache = new Map<string, RouteCacheEntry>();
const routeInFlight = new Map<string, Promise<readonly [number, unknown]>>();
const cachedRoute = async (
  key: string,
  ttlMs: number,
  build: () => Promise<readonly [number, unknown]>,
): Promise<readonly [number, unknown]> => {
  const cached = routeCache.get(key);
  if (cached !== undefined && Date.now() - cached.computedAtMs < ttlMs) {
    return cached.result;
  }
  const inFlight = routeInFlight.get(key);
  if (inFlight !== undefined) return inFlight;
  const compute = (async (): Promise<readonly [number, unknown]> => {
    try {
      const result = await build();
      if (result[0] === 200) {
        routeCache.set(key, { result, computedAtMs: Date.now() });
        if (routeCache.size > 256) {
          const now = Date.now();
          for (const [k, v] of routeCache) {
            if (now - v.computedAtMs >= ttlMs) routeCache.delete(k);
          }
        }
      }
      return result;
    } finally {
      routeInFlight.delete(key);
    }
  })();
  routeInFlight.set(key, compute);
  return compute;
};

const OVER_COLLAPSED_PAGE_CONTENT_HYGIENE_CACHE_TTL_MS = 60_000;
let overCollapsedPageContentHygieneCache: {
  readonly vaultRoot: string;
  readonly computedAtMs: number;
  readonly records: readonly OverCollapsedRecord[];
} | null = null;

const scanForOverCollapsedPageContentHygieneCached = async (
  vaultRoot: string,
): Promise<readonly OverCollapsedRecord[]> => {
  const now = Date.now();
  if (
    overCollapsedPageContentHygieneCache !== null &&
    overCollapsedPageContentHygieneCache.vaultRoot === vaultRoot &&
    now - overCollapsedPageContentHygieneCache.computedAtMs <
      OVER_COLLAPSED_PAGE_CONTENT_HYGIENE_CACHE_TTL_MS
  ) {
    return overCollapsedPageContentHygieneCache.records;
  }
  const records = await scanForOverCollapsedPageContent(vaultRoot);
  overCollapsedPageContentHygieneCache = { vaultRoot, computedAtMs: now, records };
  return records;
};

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
const acquireResolveSlot = (): Promise<void> =>
  new Promise<void>((resolve) => {
    if (resolvePermits > 0) {
      resolvePermits -= 1;
      resolve();
    } else {
      resolveWaiters.push(resolve);
    }
  });
const releaseResolveSlot = (): void => {
  const next = resolveWaiters.shift();
  if (next !== undefined) {
    next();
  } else {
    resolvePermits += 1;
  }
};
const cachedResolveRoute = (
  key: string,
  ttlMs: number,
  build: () => Promise<readonly [number, unknown]>,
): Promise<readonly [number, unknown]> =>
  cachedRoute(key, ttlMs, async (): Promise<readonly [number, unknown]> => {
    await acquireResolveSlot();
    try {
      return await build();
    } finally {
      releaseResolveSlot();
    }
  });

// The suggestion-resolve caches (visres:/tabres:) are keyed on the
// connections snapshot, deliberately NOT the event log (see the statSig
// note — seq advances every flush, so seq-keying never hits). But an
// explicit user attribution/ignore decision MUST take effect at once,
// and the resolver fuses graph signals so one decision can shift other
// suggestions too. Purge both resolve caches on every user decision.
// This is rare (a few/session), so it does NOT reintroduce the
// per-flush cache-busting the snapshot keying avoids.
const invalidateResolveCaches = (): void => {
  for (const key of [...routeCache.keys()]) {
    if (key.startsWith('visres:') || key.startsWith('tabres:')) routeCache.delete(key);
  }
  for (const key of [...routeInFlight.keys()]) {
    if (key.startsWith('visres:') || key.startsWith('tabres:')) routeInFlight.delete(key);
  }
};

const pageEvidenceBackgroundEmbeddingEnabled = (): boolean => {
  const raw = process.env['SIDETRACK_PAGE_EVIDENCE_BACKGROUND_EMBEDDING'];
  return raw === '1' || raw?.toLowerCase() === 'true';
};

const resolverSignalEventsForCanonicalUrls = (
  events: readonly AcceptedEvent[],
  canonicalUrls: readonly string[],
): readonly AcceptedEvent[] => {
  const targets = new Set(canonicalUrls);
  return events.filter((event) => {
    if (event.type === USER_FLOW_REJECTED && isUserFlowRejectedPayload(event.payload)) {
      return true;
    }
    if (event.type !== USER_ORGANIZED_ITEM || !isUserOrganizedItemPayload(event.payload)) {
      return false;
    }
    return event.payload.itemKind === 'canonical-url' && targets.has(event.payload.itemId);
  });
};

const resolverCanonicalUrlKey = (raw: string): string => raw.replace(/#.*$/u, '').replace(/\/+$/u, '');

const candidateSourceWeight = (sources: readonly string[]): number => {
  if (sources.includes('same_canonical_url')) return 0.9;
  if (sources.includes('opener_chain')) return 0.85;
  if (sources.includes('navigation_chain')) return 0.8;
  if (sources.includes('content_embedding_neighborhood')) return 0.75;
  if (sources.includes('content_term_overlap')) return 0.7;
  if (sources.includes('same_repo_or_domain')) return 0.65;
  if (sources.includes('same_search_query')) return 0.6;
  if (sources.includes('same_copied_snippet')) return 0.55;
  if (sources.includes('same_title_path_tokens')) return 0.45;
  if (sources.includes('embedding_neighborhood')) return 0.4;
  if (sources.includes('cross_replica_continuation')) return 0.35;
  return 0.1;
};

const timelineEventsForResolverCandidates = (
  events: readonly AcceptedEvent[],
): readonly AcceptedEvent[] =>
  events.filter((event) => event.type === BROWSER_TIMELINE_OBSERVED);

const resolverTimelineEventsForCanonicalUrls = (
  events: readonly AcceptedEvent[],
  canonicalUrls: ReadonlySet<string>,
): readonly AcceptedEvent[] => {
  const normalizedTargets = new Set([...canonicalUrls].map(resolverCanonicalUrlKey));
  return events.filter((event) => {
    if (event.type !== BROWSER_TIMELINE_OBSERVED || !isBrowserTimelineObservedPayload(event.payload)) {
      return false;
    }
    const visitKey = resolverCanonicalUrlKey(event.payload.canonicalUrl ?? event.payload.url);
    return normalizedTargets.has(visitKey);
  });
};

const resolverExpandedCandidateUrlsForCanonicalUrls = (
  events: readonly AcceptedEvent[],
  canonicalUrls: readonly string[],
  maxPerUrl = 80,
): ReadonlyMap<string, readonly string[]> => {
  if (canonicalUrls.length === 0) return new Map();
  const timelineEvents = timelineEventsForResolverCandidates(events);
  if (timelineEvents.length === 0) return new Map();
  const context = { merged: [...timelineEvents], existingEdges: [] };
  const out = new Map<string, readonly string[]>();
  for (const canonicalUrl of canonicalUrls) {
    const targetVisitKey = resolverCanonicalUrlKey(canonicalUrl);
    const ranked = generateCandidates(targetVisitKey, context)
      .map((candidate) => ({
        canonicalUrl: resolverCanonicalUrlKey(candidate.toVisitId),
        weight: candidateSourceWeight(candidate.sources),
      }))
      .filter(
        (candidate) =>
          candidate.canonicalUrl.length > 0 &&
          candidate.canonicalUrl !== targetVisitKey &&
          /^https?:\/\//iu.test(candidate.canonicalUrl),
      )
      .sort(
        (left, right) =>
          right.weight - left.weight || left.canonicalUrl.localeCompare(right.canonicalUrl),
      );
    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const candidate of ranked) {
      if (seen.has(candidate.canonicalUrl)) continue;
      seen.add(candidate.canonicalUrl);
      deduped.push(candidate.canonicalUrl);
      if (deduped.length >= maxPerUrl) break;
    }
    out.set(canonicalUrl, deduped);
  }
  return out;
};

const resolverSignalEventsForTabSession = (
  events: readonly AcceptedEvent[],
  tabSessionId: string,
): readonly AcceptedEvent[] =>
  events.filter((event) => {
    if (event.type === USER_FLOW_REJECTED && isUserFlowRejectedPayload(event.payload)) {
      return true;
    }
    if (event.type !== USER_ORGANIZED_ITEM || !isUserOrganizedItemPayload(event.payload)) {
      return false;
    }
    return event.payload.itemKind === 'tab-session' && event.payload.itemId === tabSessionId;
  });

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
      lastCaptureTitle?: string;
      lastCaptureThreadId?: string;
    }
  >();
  const recentWarnings: CaptureWarningHealth[] = [];
  const now = Date.now();
  const since24h = now - 24 * 60 * 60 * 1000;
  const since1h = now - 60 * 60 * 1000;
  let window1hCaptures = 0;
  let window1hWarnings = 0;
  let window1hFails = 0;
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
          readonly title?: unknown;
          readonly threadId?: unknown;
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
          if (!Number.isNaN(capturedMillis) && capturedMillis >= since1h) {
            window1hCaptures += 1;
            if (selectorCanary === 'warning') window1hWarnings += 1;
            if (selectorCanary === 'failed') window1hFails += 1;
          }
          if (current.lastCaptureAt === null || current.lastCaptureAt < event.capturedAt) {
            current.lastCaptureAt = event.capturedAt;
            current.lastStatus = selectorCanary;
            if (typeof event.title === 'string' && event.title.length > 0) {
              current.lastCaptureTitle = event.title;
            } else {
              delete current.lastCaptureTitle;
            }
            if (typeof event.threadId === 'string' && event.threadId.length > 0) {
              current.lastCaptureThreadId = event.threadId;
            } else {
              delete current.lastCaptureThreadId;
            }
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
    window1h: {
      captures: window1hCaptures,
      warnings: window1hWarnings,
      fails: window1hFails,
    },
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

const optionalAttributionPolicyMode = (
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

const optionalAttributionPolicyTelemetry = (
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

const optionalFiniteNumber = (value: unknown, fieldName: string): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new HttpRouteError(
      400,
      'VALIDATION_ERROR',
      'Validation failed.',
      `${fieldName} must be a finite number when provided.`,
    );
  }
  return value;
};

const PRIVACY_AGGREGATE_ID = 'privacy';

const isPrivacyEventType = (
  value: unknown,
): value is
  | typeof PRIVACY_GATE_FLIPPED
  | typeof PRIVACY_PERMISSION_GRANTED
  | typeof PRIVACY_PERMISSION_REVOKED =>
  value === PRIVACY_GATE_FLIPPED ||
  value === PRIVACY_PERMISSION_GRANTED ||
  value === PRIVACY_PERMISSION_REVOKED;

const isPrivacyPayloadForType = (
  type: string,
  payload: unknown,
): payload is Record<string, unknown> => {
  if (type === PRIVACY_GATE_FLIPPED) return isPrivacyGateFlippedPayload(payload);
  if (type === PRIVACY_PERMISSION_GRANTED) return isPrivacyPermissionGrantedPayload(payload);
  if (type === PRIVACY_PERMISSION_REVOKED) return isPrivacyPermissionRevokedPayload(payload);
  return false;
};

const privacyEventsFrom = (events: readonly import('../sync/causal.js').AcceptedEvent[]) =>
  events.filter((event) => isPrivacyEventType(event.type));

// `types`, when provided, restricts the store scan to those event types
// at the SQL level (events_type_idx via forEachChunkOfTypes) — O(matching
// rows) instead of O(all 370K events). The predicate still runs to refine
// (e.g. by canonicalUrl / tabSession). EVERY type the predicate can
// accept MUST be in `types` or matching events are missed. Without a hint
// this falls back to a full forEachChunk scan (legacy callers). This
// scan was ~4s per fresh /resolve on a real vault and, serialized across
// a burst of fresh navigations, starved /v1/status past its 45s budget.
const readEventsFromStoreOrLog = async (
  context: CompanionHttpConfig,
  eventLog: EventLog,
  predicate: (event: AcceptedEvent) => boolean,
  types?: readonly string[],
): Promise<readonly AcceptedEvent[]> => {
  if (context.vaultRoot === undefined) {
    return (await eventLog.readMerged()).filter(predicate);
  }
  const store = await getCaughtUpSharedEventStore(context.vaultRoot);
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

// Type hints for the readEventsFromStoreOrLog callers (must list every
// type the corresponding predicate can match).
const RESOLVER_SIGNAL_EVENT_TYPES = [USER_FLOW_REJECTED, USER_ORGANIZED_ITEM] as const;
const RESOLVER_EXPAND_EVENT_TYPES = [
  BROWSER_TIMELINE_OBSERVED,
  USER_FLOW_REJECTED,
  USER_ORGANIZED_ITEM,
] as const;
const PRIVACY_EVENT_TYPES = [
  PRIVACY_GATE_FLIPPED,
  PRIVACY_PERMISSION_GRANTED,
  PRIVACY_PERMISSION_REVOKED,
] as const;
const WORKSTREAM_PROJECTION_EVENT_TYPES = [WORKSTREAM_UPSERTED, WORKSTREAM_DELETED] as const;
// The bootstrap RECONSTRUCTS positives from historical explicit feedback only.
// It deliberately does NOT read recall.served/recall.action: the served+action
// snapshot-join path is the per-drain child's job (P1a), and feeding the
// thousands of historical recall.served impressions into the build here is both
// wasted work (their only actions are non-trainable click/open) and a ~44s
// single-tick freeze (synchronous feature extraction over every served set).
const RANKER_BOOTSTRAP_FEEDBACK_EVENT_TYPES = [
  USER_FLOW_CONFIRMED,
  USER_FLOW_REJECTED,
  USER_ORGANIZED_ITEM,
  USER_SNIPPET_PROMOTED,
] as const;
const DISPATCH_PROJECTION_EVENT_TYPES = [DISPATCH_RECORDED, DISPATCH_LINKED] as const;
const ANNOTATION_PROJECTION_EVENT_TYPES = [
  ANNOTATION_CREATED,
  ANNOTATION_NOTE_SET,
  ANNOTATION_DELETED,
] as const;
const FEEDBACK_EVENT_TYPE_LIST = [
  USER_ORGANIZED_ITEM,
  USER_ENGAGEMENT_RELABELED,
  USER_FLOW_CONFIRMED,
  USER_FLOW_REJECTED,
  USER_TOPIC_RENAMED,
  USER_SNIPPET_PROMOTED,
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
const tabSessionProjectionCache = new Map<string, { sig: string; proj: TabSessionProjection }>();

const projectUrlsFromStoreOrLog = async (
  context: CompanionHttpConfig,
  eventLog: EventLog,
): Promise<UrlProjection> => {
  const key = context.vaultRoot ?? '<none>';
  const sig = await eventLog.logSignature();
  const cached = urlProjectionCache.get(key);
  if (cached !== undefined && cached.sig === sig) return cached.proj;
  let proj: UrlProjection;
  if (context.vaultRoot === undefined) {
    proj = projectUrls(await eventLog.readMerged());
  } else {
    const store = await getCaughtUpSharedEventStore(context.vaultRoot);
    if (store === null) {
      proj = projectUrls(await eventLog.readMerged());
    } else {
      const accumulator = createEmptyUrlProjectionAccumulator();
      await store.forEachChunk((chunk) => {
        for (const event of chunk) foldEventIntoUrlProjectionAccumulator(accumulator, event);
      }, 2000);
      proj = urlProjectionFromAccumulator(accumulator);
    }
  }
  urlProjectionCache.set(key, { sig, proj });
  return proj;
};

const projectTabSessionsFromStoreOrLog = async (
  context: CompanionHttpConfig,
  eventLog: EventLog,
): Promise<TabSessionProjection> => {
  const key = context.vaultRoot ?? '<none>';
  const sig = await eventLog.logSignature();
  const cached = tabSessionProjectionCache.get(key);
  if (cached !== undefined && cached.sig === sig) return cached.proj;
  let proj: TabSessionProjection;
  if (context.vaultRoot === undefined) {
    proj = projectTabSessions(await eventLog.readMerged());
  } else {
    const store = await getCaughtUpSharedEventStore(context.vaultRoot);
    if (store === null) {
      proj = projectTabSessions(await eventLog.readMerged());
    } else {
      const accumulator = createEmptyTabSessionProjectionAccumulator();
      await store.forEachChunk((chunk) => {
        for (const event of chunk) foldEventIntoTabSessionProjectionAccumulator(accumulator, event);
      }, 2000);
      proj = tabSessionProjectionFromAccumulator(accumulator);
    }
  }
  tabSessionProjectionCache.set(key, { sig, proj });
  return proj;
};

const isFeedbackEventType = (
  value: unknown,
): value is
  | typeof USER_ORGANIZED_ITEM
  | typeof USER_ENGAGEMENT_RELABELED
  | typeof USER_FLOW_CONFIRMED
  | typeof USER_FLOW_REJECTED
  | typeof USER_TOPIC_RENAMED
  | typeof USER_SNIPPET_PROMOTED =>
  value === USER_ORGANIZED_ITEM ||
  value === USER_ENGAGEMENT_RELABELED ||
  value === USER_FLOW_CONFIRMED ||
  value === USER_FLOW_REJECTED ||
  value === USER_TOPIC_RENAMED ||
  value === USER_SNIPPET_PROMOTED;

const isFeedbackPayloadForType = (
  type: string,
  payload: unknown,
): payload is Record<string, unknown> => {
  if (type === USER_ORGANIZED_ITEM) return isUserOrganizedItemPayload(payload);
  if (type === USER_ENGAGEMENT_RELABELED) return isUserEngagementRelabeledPayload(payload);
  if (type === USER_FLOW_CONFIRMED) return isUserFlowConfirmedPayload(payload);
  if (type === USER_FLOW_REJECTED) return isUserFlowRejectedPayload(payload);
  if (type === USER_TOPIC_RENAMED) return isUserTopicRenamedPayload(payload);
  if (type === USER_SNIPPET_PROMOTED) return isUserSnippetPromotedPayload(payload);
  return false;
};

const aggregateIdForFeedbackEvent = (type: string, payload: Record<string, unknown>): string => {
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
  return 'feedback:unknown';
};

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

// Stage 5.2 R2 — snapshot-first projection lookup. HTTP routes prefer the
// committed snapshot's embedded projection so reads don't pay the cost of
// projectUrls(merged) / projectTabSessions(merged) on every request. Falls
// back to re-deriving from the event log only when the snapshot is null
// (cold start before first reconciliation) or doesn't yet carry the
// projection field (loading a pre-R1 snapshot from disk).
const loadUrlProjection = async (
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

const loadTabSessionProjection = async (
  context: CompanionHttpConfig,
  eventLog: EventLog,
): Promise<{ projection: TabSessionProjection; snapshotRevision: string | null }> => {
  if (context.connectionsStore instanceof SqliteConnectionsStore) {
    const metadata = await context.connectionsStore.readSnapshotMetadata();
    if (metadata?.tabSessionProjection !== undefined && metadata.urlProjection !== undefined) {
      return {
        projection: overlayUrlAttributionOntoTabSessions(
          deserializeTabSessionProjection(metadata.tabSessionProjection),
          deserializeUrlProjection(metadata.urlProjection),
        ),
        snapshotRevision: metadata.snapshotRevision ?? null,
      };
    }
  }
  const snapshot = await context.connectionsStore?.readCurrent();
  const snapshotRevision = snapshot?.snapshotRevision ?? null;
  const tab =
    snapshot?.tabSessionProjection !== undefined
      ? deserializeTabSessionProjection(snapshot.tabSessionProjection)
      : await projectTabSessionsFromStoreOrLog(context, eventLog);
  // Same snapshot's URL projection (no extra re-fold in steady state) —
  // a chat thread the user filed via the Current-tab card is a URL
  // attribution; overlay it so All-threads / inbox / the resolver stop
  // re-asking. Single seam → every tab-session consumer is consistent.
  const url =
    snapshot?.urlProjection !== undefined
      ? deserializeUrlProjection(snapshot.urlProjection)
      : await projectUrlsFromStoreOrLog(context, eventLog);
  return {
    projection: overlayUrlAttributionOntoTabSessions(tab, url),
    snapshotRevision,
  };
};

const routes: readonly RouteDefinition[] = [
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
  {
    method: 'GET',
    pattern: /^\/v1\/health$/,
    authRequired: false,
    handle: (_request, requestId) => Promise.resolve([200, { status: 'ok', requestId }]),
  },
  {
    // Minimal version/identity probe. Two consumers:
    //  - the attach-diagnostic (detect a stale companion: extension
    //    rebuilt but companion still on the prior build);
    //  - the extension's connection identity check — it pins
    //    {vaultRoot, codePath} on first attach and compares on every
    //    poll, so a port reused by a DIFFERENT companion (a common
    //    dogfood foot-gun: a test instance and the daily instance
    //    both want :17373) surfaces instead of silently serving the
    //    wrong vault.
    // Returns companion-controlled fields only; no auth needed
    // because the information leak is harmless (all local).
    method: 'GET',
    pattern: /^\/v1\/version$/,
    authRequired: false,
    handle: (_request, requestId, _match, context) =>
      Promise.resolve([
        200,
        {
          data: {
            companionVersion: COMPANION_VERSION,
            ...(context.vaultRoot === undefined ? {} : { vaultRoot: context.vaultRoot }),
            ...(context.startedAt === undefined
              ? {}
              : { startedAt: context.startedAt.toISOString() }),
            // codePath: the absolute path of the running entry script
            // (`dist/cli.js`). Directly answers "which checkout is
            // this companion built from" — the field the extension
            // compares to catch a build/checkout swap on a reused
            // port. process.argv[1] is the entry script; absent only
            // in exotic embeddings (then the field is just omitted).
            ...(typeof process.argv[1] === 'string' && process.argv[1].length > 0
              ? { codePath: process.argv[1] }
              : {}),
            // pid distinguishes restarts of the same companion from a
            // genuinely different process on the port.
            pid: process.pid,
            // instanceLabel: free-form operator tag via
            // SIDETRACK_INSTANCE_LABEL (e.g. "test" vs "daily"). Lets
            // the extension show, and the operator eyeball, which
            // instance is answering.
            ...(typeof process.env['SIDETRACK_INSTANCE_LABEL'] === 'string' &&
            process.env['SIDETRACK_INSTANCE_LABEL'].length > 0
              ? { instanceLabel: process.env['SIDETRACK_INSTANCE_LABEL'] }
              : {}),
            // gitSha is best-effort: it's set when the CLI is invoked
            // with --git-sha or with the SIDETRACK_COMPANION_GIT_SHA
            // env var. Absent in normal `bun dist/cli.js` runs.
            ...(typeof process.env['SIDETRACK_COMPANION_GIT_SHA'] === 'string' &&
            process.env['SIDETRACK_COMPANION_GIT_SHA'].length > 0
              ? { gitSha: process.env['SIDETRACK_COMPANION_GIT_SHA'] }
              : {}),
            requestId,
          },
        },
      ]),
  },
  {
    method: 'GET',
    pattern: /^\/v1\/status$/,
    authRequired: true,
    handle: async (_request, requestId, _match, context) => {
      // /v1/status is the **liveness + cached-readiness** probe the
      // side panel polls every 15s. It MUST:
      //   - Return immediately even if the materializer is in the
      //     middle of catchUp, the recall index is rebuilding, or
      //     the ONNX embedder hasn't been initialised yet.
      //   - Never trigger a rebuild, a model load, an embedder
      //     warmup, or an unbounded `waitForRebuild()` call.
      //   - Never transitively import recall/ingestor/embedder/
      //     transformers/ONNX. The only allowed dependencies are
      //     synchronous getters on the runtime context.
      // The response shape reports subsystem state as data; the
      // request itself does no work to make any subsystem ready.
      //
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
      // Live relay status for the side panel banner. Only present
      // when the companion was started with --sync-relay/-local
      // AND the runtime exposed a getRelayStatus closure. Routed
      // through /v1/status (not /v1/system/health) because the
      // extension polls /v1/status on every reachability check;
      // adding it there means the relay-down banner can flip the
      // moment the WS dies, with no extra HTTP round-trip.
      const relayLive = context.sync?.getRelayStatus?.() ?? null;
      const relayBlock =
        context.sync?.relay === undefined
          ? undefined
          : {
              ...context.sync.relay,
              ...(relayLive === null
                ? {}
                : {
                    connected: relayLive.connected,
                    consecutiveFailures: relayLive.consecutiveFailures,
                    pendingPublishes: relayLive.pendingPublishes,
                    ...(relayLive.lastConnectedAtMs === undefined
                      ? {}
                      : { lastConnectedAtMs: relayLive.lastConnectedAtMs }),
                    ...(relayLive.lastDisconnectedAtMs === undefined
                      ? {}
                      : { lastDisconnectedAtMs: relayLive.lastDisconnectedAtMs }),
                    // Peer-event throughput counters mirrored from
                    // /v1/system/health.sync — the side panel polls
                    // /v1/status frequently for reachability, so
                    // surfacing them here too means the throughput
                    // chips can update at the same cadence.
                    ...(relayLive.eventsIn === undefined ? {} : { eventsIn: relayLive.eventsIn }),
                    ...(relayLive.eventsOut === undefined
                      ? {}
                      : { eventsOut: relayLive.eventsOut }),
                    ...(relayLive.lastInboundAtMs === undefined
                      ? {}
                      : { lastInboundAtMs: relayLive.lastInboundAtMs }),
                    ...(relayLive.lastOutboundAtMs === undefined
                      ? {}
                      : { lastOutboundAtMs: relayLive.lastOutboundAtMs }),
                    ...(relayLive.byReplica === undefined
                      ? {}
                      : { byReplica: relayLive.byReplica }),
                  }),
            };
      // ---- cached subsystem state — no work allowed ----
      // Snapshot state: the connections snapshot store's last
      // committed revision. Read once, no rebuild trigger.
      //
      // CRITICAL — short timeout (500ms) on the SQLite read:
      //   bun:sqlite serializes queries on a single DB handle. If
      //   another caller is mid-`readCurrent()` (which can take 30+s
      //   on a 12k-edge snapshot — see materializer perf debt), the
      //   /status query queues behind it. The 45s extension timeout
      //   then fires and the side panel flips to "disconnected"
      //   even though the companion is reachable. The /status
      //   contract says "MUST return immediately even if the
      //   materializer is mid-catchUp" — honor that by reporting
      //   `state: 'busy'` instead of waiting on the metadata read.
      let snapshotState:
        | {
            readonly state: 'missing' | 'ready' | 'busy';
            readonly revision?: string;
            readonly updatedAt?: string;
          }
        | undefined;
      if (context.connectionsStore !== undefined) {
        try {
          const SNAPSHOT_PROBE_TIMEOUT_MS = 500;
          const readPromise =
            context.connectionsStore instanceof SqliteConnectionsStore
              ? context.connectionsStore.readSnapshotMetadata()
              : context.connectionsStore.readCurrent();
          const timeoutSentinel: unique symbol = Symbol('snapshot-probe-timeout');
          const current = (await Promise.race([
            readPromise,
            new Promise((resolve) =>
              setTimeout(() => resolve(timeoutSentinel), SNAPSHOT_PROBE_TIMEOUT_MS),
            ),
          ])) as Awaited<typeof readPromise> | typeof timeoutSentinel;
          if (current === timeoutSentinel) {
            // DB handle contended — caller (likely /v1/connections
            // doing a snapshot rebuild) has the lock. Don't block
            // /status; the side panel polls again in 15 s.
            snapshotState = { state: 'busy' };
          } else if (current === null) {
            snapshotState = { state: 'missing' };
          } else {
            snapshotState = {
              state: 'ready',
              ...(current.snapshotRevision === undefined
                ? {}
                : { revision: current.snapshotRevision }),
              updatedAt: current.updatedAt,
            };
          }
        } catch {
          snapshotState = { state: 'missing' };
        }
      }
      // Recall state — uses `isRebuilding()` (sync) only. Calling
      // `report()` here would read the index file (fast) but adds
      // I/O latency; `/v1/system/health` already exposes the rich
      // report for callers that want it. /status reports just the
      // coarse state so the panel can render "warming" vs "ready".
      const embedderStatus = context.getEmbedderStatus?.() ?? { state: 'disabled' as const };
      let recallState:
        | {
            readonly state: 'disabled' | 'rebuilding' | 'ready';
            readonly vectorState: 'disabled' | 'cold' | 'warming' | 'ready' | 'failed';
            readonly vectorError?: string;
            readonly semanticRecallPoolMigration: ReturnType<
              typeof getSemanticRecallPoolMigrationStatus
            >;
          }
        | undefined;
      if (context.recallLifecycle !== undefined) {
        recallState = {
          state: context.recallLifecycle.isRebuilding() ? 'rebuilding' : 'ready',
          vectorState: embedderStatus.state,
          ...(embedderStatus.lastError === undefined
            ? {}
            : { vectorError: embedderStatus.lastError }),
          semanticRecallPoolMigration: getSemanticRecallPoolMigrationStatus(),
        };
      } else {
        recallState = {
          state: 'disabled',
          vectorState: embedderStatus.state,
          semanticRecallPoolMigration: getSemanticRecallPoolMigrationStatus(),
        };
      }
      // Materializer state — cached health snapshot (sync).
      const materializerHealth = context.syncMaterializerHealth?.() ?? undefined;
      const materializerState =
        materializerHealth === undefined
          ? undefined
          : {
              state: Object.values(materializerHealth).some((h) => h.status === 'failed')
                ? 'failed'
                : Object.values(materializerHealth).some((h) => h.pending)
                  ? 'catching_up'
                  : 'idle',
              detail: materializerHealth,
            };
      const eventLoopState = context.getEventLoopSnapshot?.();
      return [
        200,
        {
          data: {
            companion: 'running',
            vault: await context.vaultWriter.status(),
            api: { live: true },
            ...(snapshotState === undefined ? {} : { snapshot: snapshotState }),
            ...(recallState === undefined ? {} : { recall: recallState }),
            ...(materializerState === undefined ? {} : { materializer: materializerState }),
            ...(eventLoopState === undefined ? {} : { eventLoop: eventLoopState }),
            ...(context.vaultChanges === undefined
              ? {}
              : { vaultChangeSubscribers: context.vaultChanges.subscriberCount() }),
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
            ...(relayBlock === undefined ? {} : { sync: { relay: relayBlock } }),
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
    pattern: /^\/v1\/privacy\/projection$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => {
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      return [
        200,
        {
          data: projectPrivacy(
            await readEventsFromStoreOrLog(
              context,
              context.eventLog,
              (event) => isPrivacyEventType(event.type),
              PRIVACY_EVENT_TYPES,
            ),
          ),
        },
      ];
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/privacy\/events$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      const eventLog = context.eventLog;
      const idempotencyKey = requireIdempotencyKey(request);
      return await runIdempotent(context, 'privacyEvent', idempotencyKey, async () => {
        const body = objectRecord(await readBody(request));
        const type = body?.['type'];
        const payload = body?.['payload'];
        if (!isPrivacyEventType(type) || !isPrivacyPayloadForType(type, payload)) {
          throw new HttpRouteError(
            400,
            'VALIDATION_ERROR',
            'Validation failed.',
            'Body must be a valid privacy event envelope.',
          );
        }
        const accepted = await eventLog.appendClient({
          clientEventId: idempotencyKey,
          aggregateId: PRIVACY_AGGREGATE_ID,
          type,
          payload,
          baseVector: await baseVectorForAggregate(eventLog, PRIVACY_AGGREGATE_ID),
        });
        return [
          201,
          {
            data: {
              accepted,
              projection: projectPrivacy(
                await readEventsFromStoreOrLog(
                  context,
                  eventLog,
                  (event) => isPrivacyEventType(event.type),
                  PRIVACY_EVENT_TYPES,
                ),
              ),
            },
          },
        ];
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/feedback\/events$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      const eventLog = context.eventLog;
      const idempotencyKey = requireIdempotencyKey(request);
      return await runIdempotent(context, 'feedbackEvent', idempotencyKey, async () => {
        const body = objectRecord(await readBody(request));
        const type = body?.['type'];
        const payload = body?.['payload'];
        if (!isFeedbackEventType(type) || !isFeedbackPayloadForType(type, payload)) {
          throw new HttpRouteError(
            400,
            'VALIDATION_ERROR',
            'Validation failed.',
            'Body must be a valid feedback event envelope.',
          );
        }
        const aggregateId = aggregateIdForFeedbackEvent(type, payload);
        const accepted = await eventLog.appendClient({
          clientEventId: idempotencyKey,
          aggregateId,
          type,
          payload,
          baseVector: await baseVectorForAggregate(eventLog, aggregateId),
        });
        return [201, { data: { accepted } }];
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/feedback\/projection$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => {
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      return [
        200,
        {
          data: projectFeedback(
            await readEventsFromStoreOrLog(
              context,
              context.eventLog,
              (event) => isFeedbackEventType(event.type),
              FEEDBACK_EVENT_TYPE_LIST,
            ),
          ),
        },
      ];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/tabsessions\/projection$/u,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => {
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      const { projection, snapshotRevision } = await loadTabSessionProjection(
        context,
        context.eventLog,
      );
      return [
        200,
        {
          // PR #141 added a single-flight+TTL cache for this route;
          // Stage 5.2 R2 supersedes it with snapshot-first reads via
          // loadTabSessionProjection (same goal, architecturally aligned
          // with the W2 accumulator wiring).
          data: serializeTabSessionProjection(projection),
          ...(snapshotRevision === null ? {} : { snapshotRevision }),
        },
      ];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/tabsessions\/inbox$/u,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      const url = new URL(request.url ?? '/v1/tabsessions/inbox', 'http://internal');
      const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
      const offsetRaw = Number.parseInt(url.searchParams.get('offset') ?? '0', 10);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
      const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;
      const { projection, snapshotRevision } = await loadTabSessionProjection(
        context,
        context.eventLog,
      );
      const items = tabSessionInbox(projection, { limit, offset });
      return [
        200,
        {
          data: {
            items,
            total: tabSessionInbox(projection, { limit: Number.MAX_SAFE_INTEGER, offset: 0 })
              .length,
            limit,
            offset,
          },
          ...(snapshotRevision === null ? {} : { snapshotRevision }),
        },
      ];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/tabsessions\/(?<tabSessionId>[^/]+)\/resolve$/u,
    authRequired: true,
    handle: async (request, _requestId, match, context) => {
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
      const url = new URL(request.url ?? '/v1/tabsessions/resolve', 'http://internal');
      if (url.searchParams.get('dryRun') !== 'true') {
        throw new HttpRouteError(
          400,
          'VALIDATION_ERROR',
          'Validation failed.',
          'Tab-session resolver is dry-run only in this phase.',
        );
      }
      const tabResKey = `tabres:${decodeURIComponent(match.tabSessionId ?? '')}|${await connectionsGraphSig(
        context.connectionsStore,
        join(requireVaultRoot(context), '_BAC', 'connections', 'current.json'),
      )}|${url.search}`;
      return cachedResolveRoute(
        tabResKey,
        ROUTE_CACHE_TTL_MS,
        async (): Promise<readonly [number, unknown]> => {
          const tabSessionId = decodeURIComponent(match.tabSessionId ?? '');
          const usesSqliteSubgraph = context.connectionsStore instanceof SqliteConnectionsStore;
          const snapshot =
            usesSqliteSubgraph
              ? await context.connectionsStore.readResolverSubgraphForTabSession(tabSessionId)
              : await context.connectionsStore!.readCurrent();
          if (snapshot === null) {
            throw new HttpRouteError(
              409,
              'CONNECTIONS_SNAPSHOT_MISSING',
              'Connections snapshot is not ready.',
            );
          }
          const resolverEvents = usesSqliteSubgraph
            ? await readEventsFromStoreOrLog(
                context,
                context.eventLog!,
                (event) => resolverSignalEventsForTabSession([event], tabSessionId).length > 0,
                RESOLVER_SIGNAL_EVENT_TYPES,
              )
            : await context.eventLog!.readMerged();
          // Stage 5.2 R2 — snapshot-first via loadTabSessionProjection.
          const { projection } = await loadTabSessionProjection(context, context.eventLog!);
          if (!projection.bySessionId.has(tabSessionId)) {
            throw new HttpRouteError(404, 'TAB_SESSION_NOT_FOUND', 'Tab session was not found.');
          }
          return [
            200,
            {
              data: resolveAttribution({
                tabSessionId,
                snapshot,
                projection,
                events: resolverEvents,
                ...(usesSqliteSubgraph ? { useEventCandidateSimilarity: false } : {}),
              }),
              ...(snapshot.snapshotRevision === undefined
                ? {}
                : { snapshotRevision: snapshot.snapshotRevision }),
            },
          ];
        },
      );
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/tabsessions\/(?<tabSessionId>[^/]+)\/resolve$/u,
    authRequired: true,
    handle: async (request, _requestId, match, context) => {
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
      const eventLog = context.eventLog;
      const connectionsStore = context.connectionsStore;
      const idempotencyKey = requireIdempotencyKey(request);
      return await runIdempotent(
        context,
        'tabSessionResolveAutoApply',
        idempotencyKey,
        async () => {
          const body = objectRecord(await readBody(request)) ?? {};
          if (body['dryRun'] !== false) {
            throw new HttpRouteError(
              400,
              'VALIDATION_ERROR',
              'Validation failed.',
              'Body must set dryRun:false for auto-apply.',
            );
          }
          const tabSessionId = decodeURIComponent(match.tabSessionId ?? '');
          const usesSqliteSubgraph = connectionsStore instanceof SqliteConnectionsStore;
          const snapshot =
            usesSqliteSubgraph
              ? await connectionsStore.readResolverSubgraphForTabSession(tabSessionId)
              : await connectionsStore.readCurrent();
          if (snapshot === null) {
            throw new HttpRouteError(
              409,
              'CONNECTIONS_SNAPSHOT_MISSING',
              'Connections snapshot is not ready.',
            );
          }
          // Stage 5.2 R4 — stale-snapshot guard. Auto-apply mutates
          // attribution state; the caller MUST act on a fresh-enough
          // snapshot. If a `dependencyKey` is supplied and it doesn't
          // match the current snapshotRevision, reject with 409. Stale
          // suggestions are fine; stale mutations are not.
          const dependencyKey = body['dependencyKey'];
          if (
            typeof dependencyKey === 'string' &&
            snapshot.snapshotRevision !== undefined &&
            dependencyKey !== snapshot.snapshotRevision
          ) {
            throw new HttpRouteError(
              409,
              'STALE_SNAPSHOT',
              'Caller-supplied dependencyKey is stale.',
              `Expected snapshotRevision=${snapshot.snapshotRevision}; client sent dependencyKey=${dependencyKey}. Re-fetch the resolve dry-run and retry.`,
            );
          }
          // Stage 5.2 R2 — snapshot-first via loadTabSessionProjection;
          // the event-log fallback covers a snapshot loaded from disk that
          // was produced before R1 (no embedded projection).
          const { projection } = await loadTabSessionProjection(context, eventLog);
          if (!projection.bySessionId.has(tabSessionId)) {
            throw new HttpRouteError(404, 'TAB_SESSION_NOT_FOUND', 'Tab session was not found.');
          }
          const resolverEvents = usesSqliteSubgraph
            ? await readEventsFromStoreOrLog(
                context,
                eventLog,
                (event) => resolverSignalEventsForTabSession([event], tabSessionId).length > 0,
                RESOLVER_SIGNAL_EVENT_TYPES,
              )
            : await eventLog.readMerged();
          const policyMode = optionalAttributionPolicyMode(body['policyMode'], 'policyMode');
          const policyTelemetry = optionalAttributionPolicyTelemetry(
            body['policyTelemetry'],
            'policyTelemetry',
          );
          const result = await autoApplyTabSessionAttribution({
            eventLog,
            snapshot,
            tabSessionId,
            events: resolverEvents,
            ...(context.vaultRoot === undefined ? {} : { vaultRoot: context.vaultRoot }),
            ...(usesSqliteSubgraph ? { useEventCandidateSimilarity: false } : {}),
            ...(policyMode === undefined ? {} : { policyMode }),
            ...(policyTelemetry === undefined ? {} : { policyTelemetry }),
          });
          // PR #141 invalidated the TTL cache here; Stage 5.2 R2 reads
          // from the snapshot store so no manual invalidation is needed
          // (the materializer's next drain publishes the fresh snapshot).
          return [
            result.status === 'applied' ? 201 : 200,
            {
              data: {
                status: result.status,
                resolution: result.resolution,
                ...(result.accepted === undefined ? {} : { accepted: result.accepted }),
              },
            },
          ];
        },
      );
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/tabsessions\/(?<tabSessionId>[^/]+)\/attribute$/u,
    authRequired: true,
    handle: async (request, _requestId, match, context) => {
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      const tabSessionId = decodeURIComponent(match.tabSessionId ?? '');
      if (tabSessionId.length === 0) {
        throw new HttpRouteError(400, 'VALIDATION_ERROR', 'Validation failed.');
      }
      const eventLog = context.eventLog;
      const idempotencyKey = requireIdempotencyKey(request);
      return await runIdempotent(context, 'tabSessionAttribute', idempotencyKey, async () => {
        const body = objectRecord(await readBody(request));
        const workstreamId = body?.['workstreamId'];
        if (
          !(workstreamId === null || (typeof workstreamId === 'string' && workstreamId.length > 0))
        ) {
          throw new HttpRouteError(
            400,
            'VALIDATION_ERROR',
            'Validation failed.',
            'Body must contain workstreamId as a non-empty string or null.',
          );
        }
        // Stage 5.2 R5 — pre-write reads prior attribution from snapshot
        // (cheap); post-write goes through the same loadTabSessionProjection
        // helper, which prefers the snapshot's embedded projection over a
        // full event-log re-projection. Read-your-writes is preserved
        // because the materializer's drain debounce (250ms) typically
        // publishes the new snapshot before the panel re-reads; when it
        // hasn't, the helper's event-log fallback covers the gap. Half 2's
        // W2 will upgrade this to a true row-local fold.
        const { projection: priorProjection } = await loadTabSessionProjection(context, eventLog);
        const fromWorkstreamId =
          priorProjection.bySessionId.get(tabSessionId)?.currentAttribution?.workstreamId;
        const payload = {
          payloadVersion: 1,
          itemKind: 'tab-session',
          itemId: tabSessionId,
          action: 'move',
          ...(fromWorkstreamId === undefined || fromWorkstreamId === null
            ? {}
            : { fromContainer: fromWorkstreamId }),
          toContainer: workstreamId,
        } as const;
        const aggregateId = aggregateIdForFeedbackEvent(USER_ORGANIZED_ITEM, payload);
        const accepted = await eventLog.appendClient({
          clientEventId: idempotencyKey,
          aggregateId,
          type: USER_ORGANIZED_ITEM,
          payload,
          baseVector: await baseVectorForAggregate(eventLog, aggregateId),
        });
        invalidateResolveCaches();
        // Stage 5.2 R5 — post-write response goes through the
        // snapshot-first helper so we don't pay a full event-log
        // re-projection when the materializer has already published
        // the next snapshot. Falls back to the event log only when the
        // snapshot is null or pre-R1. (PR #141's
        // invalidateCachedTabSessionProjection was a TTL cache buster
        // that R2/R5 makes redundant.)
        const { projection: postProjection } = await loadTabSessionProjection(context, eventLog);
        return [
          201,
          {
            data: {
              accepted,
              projection: serializeTabSessionProjection(postProjection),
            },
          },
        ];
      });
    },
  },
  // -- Per-canonical-URL attribution surface --------------------------
  // The user-facing Inbox/Connections triages PAGES (canonical URLs),
  // not tab sessions. These routes mirror /v1/tabsessions/* but key by
  // canonical URL so multiple visits of the same page collapse to one
  // attribution unit. Tab-session attribution stays available for
  // back-compat sync from older replicas.
  {
    method: 'GET',
    pattern: /^\/v1\/visits\/projection$/u,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => {
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      const { projection, snapshotRevision } = await loadUrlProjection(context, context.eventLog);
      return [
        200,
        {
          // PR #141 added a TTL cache here; superseded by Stage 5.2 R2.
          data: serializeUrlProjection(projection),
          ...(snapshotRevision === null ? {} : { snapshotRevision }),
        },
      ];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/visits\/inbox$/u,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      const url = new URL(request.url ?? '/v1/visits/inbox', 'http://internal');
      const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
      const offsetRaw = Number.parseInt(url.searchParams.get('offset') ?? '0', 10);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
      const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;
      const { projection, snapshotRevision } = await loadUrlProjection(context, context.eventLog);
      const items = urlInbox(projection, { limit, offset });
      return [
        200,
        {
          data: {
            items,
            total: urlInbox(projection, { limit: Number.MAX_SAFE_INTEGER, offset: 0 }).length,
            limit,
            offset,
          },
          ...(snapshotRevision === null ? {} : { snapshotRevision }),
        },
      ];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/visits\/(?<canonicalUrl>[^/]+)\/resolve$/u,
    authRequired: true,
    handle: async (request, _requestId, match, context) => {
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
      const url = new URL(request.url ?? '/v1/visits/resolve', 'http://internal');
      if (url.searchParams.get('dryRun') !== 'true') {
        throw new HttpRouteError(
          400,
          'VALIDATION_ERROR',
          'Validation failed.',
          'URL resolver is dry-run only in this phase.',
        );
      }
      const visResKey = `visres:${decodeURIComponent(match.canonicalUrl ?? '')}|${await connectionsGraphSig(
        context.connectionsStore,
        join(requireVaultRoot(context), '_BAC', 'connections', 'current.json'),
      )}|${url.search}`;
      return cachedResolveRoute(
        visResKey,
        ROUTE_CACHE_TTL_MS,
        async (): Promise<readonly [number, unknown]> => {
          const canonicalUrl = decodeURIComponent(match.canonicalUrl ?? '');
          const expandEventCandidates =
            url.searchParams.get('eventCandidates') === '1' ||
            url.searchParams.get('eventCandidates') === 'true';
          const sqliteStore =
            context.connectionsStore instanceof SqliteConnectionsStore
              ? context.connectionsStore
              : null;
          const usesSqliteSubgraph = sqliteStore !== null;
          const preloadedMerged =
            usesSqliteSubgraph && expandEventCandidates
              ? await readEventsFromStoreOrLog(
                  context,
                  context.eventLog!,
                  (event) =>
                    event.type === BROWSER_TIMELINE_OBSERVED ||
                    event.type === USER_FLOW_REJECTED ||
                    event.type === USER_ORGANIZED_ITEM,
                  RESOLVER_EXPAND_EVENT_TYPES,
                )
              : null;
          const expandedCandidateUrls =
            preloadedMerged === null
              ? []
              : (resolverExpandedCandidateUrlsForCanonicalUrls(preloadedMerged, [canonicalUrl]).get(
                  canonicalUrl,
                ) ?? []);
          const snapshot =
            usesSqliteSubgraph
              ? expandedCandidateUrls.length === 0
                ? await sqliteStore.readResolverSubgraphForUrl(canonicalUrl)
                : await sqliteStore.readResolverSubgraphForUrls([
                    canonicalUrl,
                    ...expandedCandidateUrls,
                  ])
              : await context.connectionsStore!.readCurrent();
          if (snapshot === null) {
            throw new HttpRouteError(
              409,
              'CONNECTIONS_SNAPSHOT_MISSING',
              'Connections snapshot is not ready.',
            );
          }
          if (canonicalUrl.length === 0) {
            throw new HttpRouteError(400, 'VALIDATION_ERROR', 'Validation failed.');
          }
          const snapshotRevision = snapshot.snapshotRevision;
          if (
            snapshotRevision !== undefined &&
            usesSqliteSubgraph &&
            !expandEventCandidates
          ) {
            const cached = await sqliteStore.getCachedResolverResult(
              canonicalUrl,
              snapshotRevision,
            );
            if (cached !== null) {
              return [
                200,
                {
                  data: cached as UrlResolutionResult,
                  snapshotRevision,
                },
              ];
            }
          }
          const merged =
            preloadedMerged ??
            (usesSqliteSubgraph
              ? await readEventsFromStoreOrLog(
                  context,
                  context.eventLog!,
                  (event) =>
                    event.type === USER_FLOW_REJECTED || event.type === USER_ORGANIZED_ITEM,
                  RESOLVER_SIGNAL_EVENT_TYPES,
                )
              : await context.eventLog!.readMerged());
          const resolverEvents =
            usesSqliteSubgraph && expandEventCandidates
              ? [
                  ...resolverSignalEventsForCanonicalUrls(merged, [canonicalUrl]),
                  ...resolverTimelineEventsForCanonicalUrls(
                    merged,
                    new Set([canonicalUrl, ...expandedCandidateUrls]),
                  ),
                ]
              : usesSqliteSubgraph
                ? resolverSignalEventsForCanonicalUrls(merged, [canonicalUrl])
                : merged;
          const result = resolveUrlAttribution({
            canonicalUrl,
            snapshot,
            events: resolverEvents,
            ...(usesSqliteSubgraph && !expandEventCandidates
              ? { useEventCandidateSimilarity: false }
              : {}),
          });
          if (
            snapshotRevision !== undefined &&
            usesSqliteSubgraph &&
            !expandEventCandidates
          ) {
            await sqliteStore.cacheResolverResult(
              canonicalUrl,
              snapshotRevision,
              result,
            );
          }
          return [
            200,
            {
              data: result,
              ...(snapshotRevision === undefined ? {} : { snapshotRevision }),
            },
          ];
        },
      );
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/visits\/batch-resolve$/u,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
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
      const sqliteStore =
        context.connectionsStore instanceof SqliteConnectionsStore ? context.connectionsStore : null;
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
        const results: Record<string, UrlResolutionResult> = {};
        const misses: string[] = [];
        for (const canonicalUrl of uniqueUrls) {
          if (eventCandidateTargetSet.has(canonicalUrl)) {
            misses.push(canonicalUrl);
            continue;
          }
          if (snapshotRevision !== undefined) {
            const cached = await sqliteStore.getCachedResolverResult(
              canonicalUrl,
              snapshotRevision,
            );
            if (cached !== null) {
              results[canonicalUrl] = cached as UrlResolutionResult;
              continue;
            }
          }
          misses.push(canonicalUrl);
        }
        const merged =
          misses.length === 0
            ? []
            : await readEventsFromStoreOrLog(
                context,
                context.eventLog,
                (event) =>
                  event.type === BROWSER_TIMELINE_OBSERVED ||
                  event.type === USER_FLOW_REJECTED ||
                  event.type === USER_ORGANIZED_ITEM,
                RESOLVER_EXPAND_EVENT_TYPES,
              );
        const expandedCandidateUrlsByTarget =
          eventCandidateTargetSet.size === 0
            ? new Map<string, readonly string[]>()
            : resolverExpandedCandidateUrlsForCanonicalUrls(
                merged,
                misses.filter((canonicalUrl) => eventCandidateTargetSet.has(canonicalUrl)),
              );
        const expandedCandidateUrls = [
          ...new Set(
            [...expandedCandidateUrlsByTarget.values()].flatMap((candidateUrls) => candidateUrls),
          ),
        ];
        const missedSnapshot =
          misses.length === 0
            ? null
            : await sqliteStore.readResolverSubgraphForUrls([
                ...misses,
                ...expandedCandidateUrls,
              ]);
        if (misses.length > 0 && missedSnapshot === null) {
          throw new HttpRouteError(
            409,
            'CONNECTIONS_SNAPSHOT_MISSING',
            'Connections snapshot is not ready.',
          );
        }
        const missedEvents = resolverSignalEventsForCanonicalUrls(merged, misses);
        for (const canonicalUrl of misses) {
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
          const resolverEvents = expandEventCandidates
            ? [
                ...resolverSignalEventsForCanonicalUrls(merged, [canonicalUrl]),
                ...resolverTimelineEventsForCanonicalUrls(
                  merged,
                  new Set([canonicalUrl, ...expandedForTarget]),
                ),
              ]
            : missedEvents;
          const result = resolveUrlAttribution({
            canonicalUrl,
            snapshot,
            events: resolverEvents,
            ...(expandEventCandidates ? {} : { useEventCandidateSimilarity: false }),
          });
          results[canonicalUrl] = result;
          if (snapshotRevision !== undefined && !expandEventCandidates) {
            await sqliteStore.cacheResolverResult(canonicalUrl, snapshotRevision, result);
          }
        }
        return [
          200,
          {
            data: { results },
            ...(snapshotRevision === undefined ? {} : { snapshotRevision }),
          },
        ];
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
      for (const canonicalUrl of uniqueUrls) {
        const result = resolveUrlAttribution({
          canonicalUrl,
          snapshot,
          events: merged,
        });
        results[canonicalUrl] = result;
      }
      return [
        200,
        {
          data: { results },
          ...(snapshotRevision === undefined ? {} : { snapshotRevision }),
        },
      ];
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/visits\/(?<canonicalUrl>[^/]+)\/resolve$/u,
    authRequired: true,
    handle: async (request, _requestId, match, context) => {
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
      const eventLog = context.eventLog;
      const connectionsStore = context.connectionsStore;
      const idempotencyKey = requireIdempotencyKey(request);
      return await runIdempotent(context, 'urlResolveAutoApply', idempotencyKey, async () => {
        const body = objectRecord(await readBody(request)) ?? {};
        if (body['dryRun'] !== false) {
          throw new HttpRouteError(
            400,
            'VALIDATION_ERROR',
            'Validation failed.',
            'Body must set dryRun:false for auto-apply.',
          );
        }
        const canonicalUrl = decodeURIComponent(match.canonicalUrl ?? '');
        const usesSqliteSubgraph = connectionsStore instanceof SqliteConnectionsStore;
        const snapshot =
          usesSqliteSubgraph
            ? await connectionsStore.readResolverSubgraphForUrl(canonicalUrl)
            : await connectionsStore.readCurrent();
        if (snapshot === null) {
          throw new HttpRouteError(
            409,
            'CONNECTIONS_SNAPSHOT_MISSING',
            'Connections snapshot is not ready.',
          );
        }
        if (canonicalUrl.length === 0) {
          throw new HttpRouteError(400, 'VALIDATION_ERROR', 'Validation failed.');
        }
        const snapshotProjection = snapshot.urlProjection;
        if (
          snapshotProjection !== undefined &&
          snapshotProjection.byCanonicalUrl[canonicalUrl] === undefined
        ) {
          throw new HttpRouteError(404, 'URL_NOT_FOUND', 'URL was not found.');
        }
        const policyMode = optionalAttributionPolicyMode(body['policyMode'], 'policyMode');
        const policyTelemetry = optionalAttributionPolicyTelemetry(
          body['policyTelemetry'],
          'policyTelemetry',
        );
        const resolverEvents = usesSqliteSubgraph
          ? await readEventsFromStoreOrLog(
              context,
              eventLog,
              (event) => resolverSignalEventsForCanonicalUrls([event], [canonicalUrl]).length > 0,
              RESOLVER_SIGNAL_EVENT_TYPES,
            )
          : await eventLog.readMerged();
        const result = await autoApplyUrlAttribution({
          eventLog,
          snapshot,
          canonicalUrl,
          events: resolverEvents,
          ...(context.vaultRoot === undefined ? {} : { vaultRoot: context.vaultRoot }),
          ...(snapshotProjection === undefined ? {} : { urlProjection: snapshotProjection }),
          ...(usesSqliteSubgraph ? { useEventCandidateSimilarity: false } : {}),
          ...(policyMode === undefined ? {} : { policyMode }),
          ...(policyTelemetry === undefined ? {} : { policyTelemetry }),
        });
        // PR #141 invalidated the TTL cache here; Stage 5.2 R2 reads
        // from the snapshot store so no manual invalidation is needed.
        return [
          result.status === 'applied' ? 201 : 200,
          {
            data: {
              status: result.status,
              resolution: result.resolution,
              ...(result.accepted === undefined ? {} : { accepted: result.accepted }),
            },
          },
        ];
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/visits\/(?<canonicalUrl>[^/]+)\/attribute$/u,
    authRequired: true,
    handle: async (request, _requestId, match, context) => {
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      // canonicalUrl is URL-encoded in the path component (slashes and
      // colons survive encoding). Decode and validate non-empty.
      const canonicalUrl = decodeURIComponent(match.canonicalUrl ?? '');
      if (canonicalUrl.length === 0) {
        throw new HttpRouteError(400, 'VALIDATION_ERROR', 'Validation failed.');
      }
      const eventLog = context.eventLog;
      const idempotencyKey = requireIdempotencyKey(request);
      return await runIdempotent(context, 'urlAttribute', idempotencyKey, async () => {
        const body = objectRecord(await readBody(request));
        const workstreamId = body?.['workstreamId'];
        if (
          !(workstreamId === null || (typeof workstreamId === 'string' && workstreamId.length > 0))
        ) {
          throw new HttpRouteError(
            400,
            'VALIDATION_ERROR',
            'Validation failed.',
            'Body must contain workstreamId as a non-empty string or null.',
          );
        }
        // Stage 5.2 R5 — see matching note on the tab-session POST route
        // above. post-write goes through loadUrlProjection (snapshot-first
        // with event-log fallback); Half 2 W2 will upgrade to a row-local
        // fold for true read-your-writes without a full re-projection.
        const { projection: priorProjection } = await loadUrlProjection(context, eventLog);
        const fromWorkstreamId =
          priorProjection.byCanonicalUrl.get(canonicalUrl)?.currentAttribution?.workstreamId;
        const payload = {
          payloadVersion: 1,
          itemKind: 'canonical-url',
          itemId: canonicalUrl,
          action: 'move',
          ...(fromWorkstreamId === undefined || fromWorkstreamId === null
            ? {}
            : { fromContainer: fromWorkstreamId }),
          toContainer: workstreamId,
        } as const;
        const aggregateId = aggregateIdForFeedbackEvent(USER_ORGANIZED_ITEM, payload);
        const accepted = await eventLog.appendClient({
          clientEventId: idempotencyKey,
          aggregateId,
          type: USER_ORGANIZED_ITEM,
          payload,
          baseVector: await baseVectorForAggregate(eventLog, aggregateId),
        });
        invalidateResolveCaches();
        // Stage 5.2 R5 — see matching block in the tab-session POST
        // route. (PR #141's invalidateCachedUrlProjection was a TTL
        // cache buster that R2/R5 makes redundant.)
        const { projection: postProjection } = await loadUrlProjection(context, eventLog);
        return [
          201,
          {
            data: {
              accepted,
              projection: serializeUrlProjection(postProjection),
            },
          },
        ];
      });
    },
  },
  {
    // Stage 5 polish — explicit "don't bother me about this URL"
    // signal. Distinct from POST /attribute with workstreamId:null
    // (which says "meaningful but no workstream"). Writes a
    // urls.ignored event; the URL projection's currentIgnored field
    // hides it from Inbox + auto-apply.
    method: 'POST',
    pattern: /^\/v1\/visits\/(?<canonicalUrl>[^/]+)\/ignore$/u,
    authRequired: true,
    handle: async (request, _requestId, match, context) => {
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      const canonicalUrl = decodeURIComponent(match.canonicalUrl ?? '');
      if (canonicalUrl.length === 0) {
        throw new HttpRouteError(400, 'VALIDATION_ERROR', 'Validation failed.');
      }
      const eventLog = context.eventLog;
      const idempotencyKey = requireIdempotencyKey(request);
      return await runIdempotent(context, 'urlIgnore', idempotencyKey, async () => {
        const body = objectRecord(await readBody(request)) ?? {};
        const rawReason = body['reason'];
        const reason =
          rawReason === 'noise' || rawReason === 'duplicate' || rawReason === 'private'
            ? rawReason
            : 'noise';
        const payload = {
          payloadVersion: 1 as const,
          canonicalUrl,
          reason,
        };
        const aggregateId = `url-ignored:${canonicalUrl}`;
        const accepted = await eventLog.appendClient({
          clientEventId: idempotencyKey,
          aggregateId,
          type: URL_IGNORED,
          payload,
          baseVector: await baseVectorForAggregate(eventLog, aggregateId),
        });
        invalidateResolveCaches();
        const { projection: postProjection } = await loadUrlProjection(context, eventLog);
        return [
          201,
          {
            data: {
              accepted,
              projection: serializeUrlProjection(postProjection),
            },
          },
        ];
      });
    },
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
          data: await cachedCollectHealth(vaultRoot, () =>
            collectHealth({
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
                // Recall serves from recall-v2 (sqlite-vec). The legacy
                // index.bin is deprecated; reading + parsing it here (24MB)
                // was both wrong and SLOW — it timed out this probe under
                // load, surfacing as a permanent false "degraded". Use a
                // cheap v2 sqlite stat + (when the store is already open)
                // its doc count, so the probe is fast and reflects the
                // actually-served backend.
                const { peekRecallV2Store } = await import('../recall-v2/pipeline.js');
                const v2SqlitePath = join(vaultRoot, '_BAC', 'recall', 'v2', 'index.sqlite');
                const [info, modelStatus, v2Store, v2Stat] = await Promise.all([
                  stat(indexPath).catch(() => undefined),
                  getModelCacheStatus().catch(() => undefined),
                  peekRecallV2Store(vaultRoot).catch(() => undefined),
                  stat(v2SqlitePath).catch(() => undefined),
                ]);
                const v2DocCount = v2Store !== undefined ? v2Store.documentCount() : null;
                const v2Present =
                  (v2DocCount !== null && v2DocCount > 0) ||
                  (v2Stat !== undefined && v2Stat.size > 0);
                // The legacy recall-lifecycle report runs countTurnsInEventLog
                // — a FULL scan of the entire event store that blew the 5s
                // health budget on a real-size vault (the ~5.0s /v1/system/health
                // wall). It's vestigial once v2 (sqlite-vec) is the served
                // backend (status is already reported 'ready' from v2 below),
                // so only pay the scan on a legacy non-v2 vault that still
                // depends on those drift fields.
                const lifecycleReport = v2Present
                  ? undefined
                  : await (context.recallLifecycle?.report() ?? Promise.resolve(undefined));
                const indexExists = v2Present;
                return {
                  indexExists,
                  entryCount: v2DocCount,
                  modelId: modelStatus?.modelId ?? null,
                  sizeBytes: v2Stat?.size ?? info?.size ?? null,
                  semanticRecallPoolMigration: getSemanticRecallPoolMigrationStatus(),
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
                        rebuildPhase: lifecycleReport.rebuildPhase,
                        embedderDevice: lifecycleReport.embedderDevice,
                        embedderAccelerator: lifecycleReport.embedderAccelerator,
                        drift: lifecycleReport.drift,
                      }),
                  // recall-v2 is the served backend; when it's present,
                  // recall is ready regardless of the deprecated legacy
                  // lifecycle's status (which would otherwise force a false
                  // "degraded" on a v2-only vault).
                  ...(v2Present ? { status: 'ready' as const } : {}),
                  ...(context.recallActivity === undefined
                    ? {}
                    : { activity: context.recallActivity.report() }),
                  ...(modelStatus === undefined
                    ? {}
                    : {
                        model: {
                          id: modelStatus.modelId,
                          revision: modelStatus.revision,
                          cacheDir: modelStatus.cacheDir,
                          present: modelStatus.present,
                          verified: modelStatus.verified,
                          offline: modelStatus.offline,
                        },
                      }),
                };
              },
              serviceStatus: async () => {
                // `installed` still comes from the installer (plist/unit
                // existence), which is what "installed" honestly means.
                // `running`, however, must reflect ACTUAL process
                // liveness — the installer inferred it from plist
                // existence, so a crashed-but-installed service read as
                // "running" forever. Probe real liveness (launchctl /
                // systemctl); only when the probe is `unknown` (tool
                // absent / timed out) do we fall back to the installer's
                // heuristic rather than claim a false negative.
                const status = await (context.serviceInstaller ?? pickInstaller()).status();
                const liveness = await (
                  context.serviceLiveness ?? (() => probeServiceLiveness(process.platform))
                )();
                return {
                  installed: status.installed,
                  running: resolveServiceRunning(status.running, liveness),
                };
              },
              eventLaneHealth: getEventLaneHealth,
              storeReconciliation: async () => {
                // Cheap store-vs-JSONL reconciliation the store ALREADY
                // knows: its physical row count vs the sum of its
                // per-replica watermarks (the count it believes it
                // accepted). A non-zero delta ⇒ committed events the
                // store thinks it holds are missing, or seqs are sparse —
                // either way a durability red flag. Never a full JSONL
                // scan: getSharedEventStore returns the already-open store
                // (or null when the event store is off) and count() /
                // watermark() are single indexed queries.
                const store = await getSharedEventStore(vaultRoot);
                if (store === null) return null;
                const storeRowCount = store.count();
                const watermark = store.watermark();
                const expectedFromWatermark = Object.values(watermark).reduce(
                  (sum, seq) => sum + seq,
                  0,
                );
                return {
                  storeRowCount,
                  expectedFromWatermark,
                  delta: expectedFromWatermark - storeRowCount,
                };
              },
              ...(context.rankerHealth === undefined
                ? {}
                : { rankerHealth: context.rankerHealth }),
              ...(context.mcpChildHealth === undefined
                ? {}
                : { mcpChildHealth: context.mcpChildHealth }),
              workGraphSummary: async () => {
                // Drain-time artifact first: the connections drain
                // materializes workgraph-health.json after every
                // successful pass (runtime/companion.ts onDrainSuccess),
                // keeping the cold-boot path off the heavy live collect
                // that used to blow the 5s budget and pin the section
                // on 'unavailable'. The serve gate is symmetric with
                // the writer's (eventStoreEnabled) AND age-bounded:
                // the writer only refreshes while the event store is
                // on, so a restart without SIDETRACK_EVENT_STORE=1
                // would otherwise serve a frozen snapshot forever —
                // drains succeed, the hook no-ops, sync.materializers
                // stays green, and nothing surfaces the staleness.
                // Missing/corrupt/schema-mismatched/stale ⇒ live
                // compute below, unchanged.
                if (eventStoreEnabled()) {
                  const artifact = await readWorkGraphHealthArtifact(vaultRoot);
                  if (artifact !== null && isWorkGraphHealthArtifactFresh(artifact)) {
                    return artifact.report;
                  }
                }
                // Phase 4 — peek the canonical SQLite recall store so
                // health reports live document/chunk vector counts.
                // Non-blocking: returns undefined when the store
                // hasn't been opened yet (no /v2/recall fired since
                // companion start), in which case counts default to 0.
                const { peekRecallV2Store } = await import('../recall-v2/pipeline.js');
                const canonicalRecallStore = await peekRecallV2Store(vaultRoot);
                return collectWorkGraphHealth({
                  vaultRoot,
                  ...(context.eventLog === undefined ? {} : { eventLog: context.eventLog }),
                  ...(context.connectionsDiagnostics === undefined
                    ? {}
                    : { connectionsDiagnostics: context.connectionsDiagnostics }),
                  ...(canonicalRecallStore === undefined
                    ? {}
                    : { canonicalRecallStore }),
                });
              },
              ...syncSummaryDeps(context.replica, context.sync, context.syncMaterializerHealth),
            }),
          ),
        },
      ];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/system\/hygiene-status$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      // GC inventory walks thousands of derived files — too slow for a
      // synchronous request on a real vault. Served from a TTL'd
      // background-refreshed cache (follow-up #15): O(1) here, the walk
      // happens off the request. Honest tri-state: unavailable until the
      // first compute lands, stale while refreshing an expired entry, ok
      // when fresh. pageContent counts are cheap → keep the inline
      // budget guard so a slow disk still degrades honestly (plan X1).
      const budget = async <T>(
        op: () => Promise<T>,
        ms: number,
      ): Promise<{ value: T | null; availability: 'ok' | 'unavailable' }> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            op().then((value) => ({ value, availability: 'ok' as const })),
            new Promise<{ value: null; availability: 'unavailable' }>((resolve) => {
              timer = setTimeout(() => {
                resolve({ value: null, availability: 'unavailable' });
              }, ms);
            }),
          ]);
        } catch {
          return { value: null, availability: 'unavailable' };
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      };
      const [gc, pageContent, overCollapsedRecords] = await Promise.all([
        gcInventoryCached(vaultRoot),
        budget(() => pageContentCoverageCounts(vaultRoot), 4_000),
        budget(() => scanForOverCollapsedPageContentHygieneCached(vaultRoot), 4_000),
      ]);
      return [
        200,
        {
          data: {
            ...(context.hygieneStatus ?? {}),
            asOf: new Date().toISOString(),
            availability: {
              gc: gc.availability,
              pageContent: pageContent.availability,
              overCollapsedRecords: overCollapsedRecords.availability,
            },
            gcAsOf: gc.asOf,
            gc: gc.value,
            pageContent: pageContent.value,
            overCollapsedRecords:
              overCollapsedRecords.value === null
                ? null
                : {
                    count: overCollapsedRecords.value.length,
                    samples: overCollapsedRecords.value.slice(0, 5),
                  },
          },
        },
      ];
    },
  },
  {
    // Plan TODO-H4: Focus surface. Serves the pre-digested
    // diagnostics/latest.json (O(1) file read — the materializer
    // already writes it every drain) plus an optional ?history=N
    // window from the dumb ring buffer. Never scans diagnostics/history.
    method: 'GET',
    pattern: /^\/v1\/system\/focus-health$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      const url = new URL(request.url ?? '/v1/system/focus-health', 'http://internal');
      const historyRaw = url.searchParams.get('history');
      const historyN =
        historyRaw === null ? 0 : Math.max(0, Math.min(96, Number.parseInt(historyRaw, 10) || 0));
      const latestPath = join(vaultRoot, '_BAC/connections/diagnostics/latest.json');
      let digest: unknown = null;
      let availability: 'ok' | 'unavailable' = 'unavailable';
      let asOf: string | null = null;
      try {
        const parsed = JSON.parse(await readFile(latestPath, 'utf8')) as {
          readonly producedAt?: unknown;
        };
        digest = parsed;
        availability = 'ok';
        asOf = typeof parsed.producedAt === 'string' ? parsed.producedAt : null;
      } catch {
        // Missing/corrupt digest → honest "unavailable", not a faked
        // healthy empty (plan X1).
        availability = 'unavailable';
      }
      const history = historyN > 0 ? await readHealthHistory(vaultRoot, historyN) : [];
      return [
        200,
        {
          data: {
            availability,
            asOf,
            digest,
            history,
          },
        },
      ];
    },
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
  // Stage 4 — collector framework status + replay routes.
  {
    method: 'GET',
    pattern: /^\/v1\/collectors$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => {
      if (context.collectorFramework === undefined) {
        return [503, { error: 'collector framework not enabled' }];
      }
      const loaded = context.collectorFramework.loadedCollectors();
      const collectors = await Promise.all(
        loaded.map(async (entry) => {
          // Defensive extraction — the framework's LoadedCollector
          // shape is widened to `unknown` at the HTTP context boundary
          // (see CompanionHttpConfig.collectorFramework comment).
          const e = entry as {
            manifest: {
              id: string;
              name: string;
              version: string;
              manifest_schema: number;
              emits: readonly {
                event_type: string;
                payload_version: number;
                stability?: 'alpha' | 'beta' | 'stable' | 'deprecated';
              }[];
              capabilities: {
                'reads-paths'?: readonly string[];
                'reads-env'?: readonly string[];
                'reads-network'?: boolean;
                'default-enabled'?: boolean;
              };
            };
            status: 'loaded' | 'load-failed';
            rejectedReason?: string;
          };
          const id = e.manifest.id;
          const fw = context.collectorFramework!;
          const quarantineCount = await fw.quarantineCountFor(id);
          const resolveGate = fw.resolveGate;
          const lastPromotedAtFor = fw.lastPromotedAtFor;
          // capability_gates: per-(collector_id, capability) gate
          // state. Only includes capabilities the collector actually
          // declared — declaring no `reads-paths` paths means no
          // 'reads-paths' key appears here. When the framework
          // doesn't expose a resolver, we surface 'pending' so the
          // UI can show a neutral state rather than a misleading
          // 'granted'.
          const capabilityGates: Record<string, 'granted' | 'revoked' | 'pending'> = {};
          if (
            e.manifest.capabilities['reads-paths'] !== undefined &&
            e.manifest.capabilities['reads-paths'].length > 0
          ) {
            capabilityGates['reads-paths'] = resolveGate
              ? resolveGate(id, 'reads-paths')
              : 'pending';
          }
          if (
            e.manifest.capabilities['reads-env'] !== undefined &&
            e.manifest.capabilities['reads-env'].length > 0
          ) {
            capabilityGates['reads-env'] = resolveGate ? resolveGate(id, 'reads-env') : 'pending';
          }
          if (e.manifest.capabilities['reads-network'] === true) {
            capabilityGates['reads-network'] = resolveGate
              ? resolveGate(id, 'reads-network')
              : 'pending';
          }
          return {
            collector_id: id,
            name: e.manifest.name,
            version: e.manifest.version,
            manifest_schema: e.manifest.manifest_schema,
            status: e.status,
            ...(e.rejectedReason === undefined ? {} : { rejected_reason: e.rejectedReason }),
            emits: e.manifest.emits,
            capabilities: {
              reads_paths: e.manifest.capabilities['reads-paths'] ?? [],
              reads_env: e.manifest.capabilities['reads-env'] ?? [],
              reads_network: e.manifest.capabilities['reads-network'] ?? false,
              default_enabled: e.manifest.capabilities['default-enabled'] ?? true,
            },
            capability_gates: capabilityGates,
            quarantine_count: quarantineCount,
            last_promoted_at: lastPromotedAtFor ? lastPromotedAtFor(id) : null,
          };
        }),
      );
      return [200, { collectors }];
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/collectors\/(?<collectorId>[a-z0-9.-]+)\/replay$/,
    authRequired: true,
    handle: async (_request, _requestId, match, context) => {
      if (context.collectorFramework === undefined) {
        return [503, { error: 'collector framework not enabled' }];
      }
      const collectorId = match.collectorId;
      if (collectorId === undefined || collectorId.length === 0) {
        return [400, { error: 'invalid collector id' }];
      }
      const result = await context.collectorFramework.replayCollector(collectorId);
      return [
        200,
        {
          collector_id: collectorId,
          scanned: result.scanned,
          promoted: result.promoted,
          still_quarantined: result.stillQuarantined,
        },
      ];
    },
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
          // Provider-aware warning threshold. The chat surface for each
          // provider caps context well below the raw API window; see
          // safety/tokenBudget.ts for the (approximate) per-provider map.
          const tokenThreshold = tokenThresholdForProvider(input.target.provider);
          const tokenBudgetExceeded = tokenEstimate > tokenThreshold;
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
              .appendServerObserved({
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
                  // Phase 4 cross-replica fix: include the
                  // structural attribution so peer companions can
                  // emit dispatch_from_thread /
                  // dispatch_in_workstream /
                  // dispatch_requested_coding_session from the
                  // event log alone — the dispatch JSONL is per-
                  // replica and doesn't sync.
                  ...(dispatchEvent.sourceThreadId === undefined
                    ? {}
                    : { sourceThreadId: dispatchEvent.sourceThreadId }),
                  ...(dispatchEvent.mcpRequest === undefined
                    ? {}
                    : {
                        mcpRequest: {
                          codingSessionId: dispatchEvent.mcpRequest.codingSessionId,
                        },
                      }),
                  ...(dispatchEvent.title === undefined ? {} : { title: dispatchEvent.title }),
                },
              })
              .catch(() => undefined);
          }
          return [
            201,
            {
              data: {
                ...result,
                // F01: return the SAFE text the companion stored so the
                // extension can render/copy exactly that instead of the
                // caller's pre-redaction original. `body` is redacted;
                // `redaction.rules` are the applied rule ids.
                body: dispatchEvent.body,
                redactionSummary: dispatchEvent.redactionSummary,
                redaction: {
                  applied: redaction.matched > 0,
                  rules: [...redaction.categories],
                },
                tokenEstimate,
                tokenWarning: {
                  provider: input.target.provider,
                  threshold: tokenThreshold,
                  exceeded: tokenBudgetExceeded,
                },
              },
              ...(tokenBudgetExceeded ? { warnings: ['token-budget-exceeded'] } : {}),
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
          .appendServerObserved({
            clientEventId: requestId,
            aggregateId: match.bacId,
            type: DISPATCH_LINKED,
            payload: { dispatchId: match.bacId, threadId: body.threadId },
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
      const dispatchEvents = await readEventsFromStoreOrLog(
        context,
        context.eventLog,
        (event) => event.type === DISPATCH_RECORDED || event.type === DISPATCH_LINKED,
        DISPATCH_PROJECTION_EVENT_TYPES,
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
          // Browser-driven: the editor's `baseVector` is what they
          // observed. Empty `{}` is legal — means the editor saw
          // no prior events. Companion does NOT replace it.
          const event = await eventLog.appendClientObserved({
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
      // Invariant C: omit baseVector. The eventLog auto-resolves
      // deps from the aggregate's prior events, which equals the
      // current review-draft projection's vector — so the discard
      // event still causally dominates every prior review-draft
      // event for this thread.
      await eventLog.appendServerObserved({
        clientEventId: requestId,
        aggregateId: threadId,
        type: 'review-draft.discarded',
        payload: { reason: 'deleted-via-http' },
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
              .appendServerObserved({
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
            .appendServerObserved({
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
      const vaultRoot = requireVaultRoot(context);
      const input = annotationUpdateSchema.parse(await readBody(request));
      const updated = await updateAnnotation(vaultRoot, match.annotationId, input);
      // Annotation edits go straight to annotationStore, bypassing the vault
      // writer's audit() closure — record a provenance line here so an mcp
      // (or extension) caller's edit is attributable in the audit log.
      await appendHttpAuditLine(vaultRoot, {
        requestId,
        route: 'updateAnnotation',
        bac_id: match.annotationId,
      });
      if (context.eventLog !== undefined && typeof input.note === 'string') {
        await context.eventLog
          .appendServerObserved({
            clientEventId: requestId,
            aggregateId: match.annotationId,
            type: ANNOTATION_NOTE_SET,
            payload: { bac_id: match.annotationId, note: input.note },
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
      const vaultRoot = requireVaultRoot(context);
      const result = await softDeleteAnnotation(vaultRoot, match.annotationId);
      // Annotation deletes bypass the vault writer's audit() closure —
      // record a provenance line here so a delete is attributable.
      await appendHttpAuditLine(vaultRoot, {
        requestId,
        route: 'deleteAnnotation',
        bac_id: match.annotationId,
      });
      // Emit ANNOTATION_DELETED whenever an event log is configured. The
      // clientEventId falls back to a stable 'local' replica placeholder
      // when no replica is bound — previously the whole event was SKIPPED
      // if replica was undefined, so a delete could vanish from the log
      // (and from peers) on any companion without a replica context.
      // requestId already makes the key unique per call.
      if (context.eventLog !== undefined) {
        const replicaId = context.replica?.replicaId ?? 'local';
        await context.eventLog
          .appendServerObserved({
            clientEventId: `annotation-delete:${replicaId}:${match.annotationId}:${requestId}`,
            aggregateId: match.annotationId,
            type: ANNOTATION_DELETED,
            payload: { bac_id: match.annotationId },
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
      const annotationEvents = await readEventsFromStoreOrLog(
        context,
        context.eventLog,
        (event) =>
          event.type === ANNOTATION_CREATED ||
          event.type === ANNOTATION_NOTE_SET ||
          event.type === ANNOTATION_DELETED,
        ANNOTATION_PROJECTION_EVENT_TYPES,
      );
      return [200, { data: projectAnnotations(annotationEvents) }];
    },
  },
  {
    // Per-annotation projection. F13 — extension's SSE subscriber
    // hits this when `_BAC/annotations/<bac_id>.json` changes.
    method: 'GET',
    pattern: /^\/v1\/annotations\/(?<bacId>[A-Za-z0-9_-]+)\/projection$/,
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
      const merged = await context.eventLog.readByAggregate(match.bacId);
      const projection = projectAnnotations(merged);
      const entry = projection.entries.find((row) => row.bac_id === match.bacId);
      return [
        200,
        {
          data: {
            ...(entry === undefined ? {} : { entry }),
            vector: projection.vector,
            updatedAtMs: projection.updatedAtMs,
          },
        },
      ];
    },
  },
  {
    // Per-dispatch projection. F15 — extension's SSE subscriber
    // hits this when `_BAC/dispatches/<bac_id>.json` changes.
    method: 'GET',
    pattern: /^\/v1\/dispatches\/(?<bacId>[A-Za-z0-9_-]+)\/projection$/,
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
      const merged = await context.eventLog.readByAggregate(match.bacId);
      const projection = projectDispatches(merged);
      const entry = projection.entries.find((row) => row.bac_id === match.bacId);
      const link = projection.links.find((row) => row.dispatchId === match.bacId);
      return [
        200,
        {
          data: {
            ...(entry === undefined ? {} : { entry }),
            ...(link === undefined ? {} : { link }),
            vector: projection.vector,
            updatedAtMs: projection.updatedAtMs,
          },
        },
      ];
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/recall\/index$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      // FX2 — single batched write. Was: embed all → loop N times,
      // each iteration `await recallLifecycle.appendEntry(entry)`.
      // `appendEntry` → `upsertEntries(path, [entry])` → reads the
      // full ~MB index, parses 7000+ items, adds one, writes back.
      // 100 items = 100 full-file rewrites under the enqueueWrite
      // mutex → 35 s POST /v1/recall/index → /v2/recall etc. cascade
      // to 26 s+. Now: one upsertEntries call with the full array
      // does one read+write regardless of batch size.
      const vaultRoot = requireVaultRoot(context);
      const input = recallIndexSchema.parse(await readBody(request));
      const { embed, MODEL_ID } = await loadEmbedderModule();
      const vectors = await embed(input.items.map((item) => item.text));
      const entries: { id: string; threadId: string; capturedAt: string; embedding: Float32Array }[] = [];
      const indexedThreadIds: string[] = [];
      for (let index = 0; index < input.items.length; index += 1) {
        const item = input.items[index];
        const embedding = vectors[index];
        if (item === undefined || embedding === undefined) continue;
        entries.push({
          id: item.id,
          threadId: item.threadId,
          capturedAt: item.capturedAt,
          embedding,
        });
        indexedThreadIds.push(item.threadId);
      }
      if (entries.length > 0) {
        if (context.recallLifecycle !== undefined) {
          await context.recallLifecycle.appendEntries(entries);
        } else {
          // Legacy / test path with no lifecycle wrapper. Use the
          // batched upsert too — same scale win.
          await upsertEntriesRaw(recallIndexPath(vaultRoot), entries, MODEL_ID);
        }
      }
      context.recallActivity?.recordIncrementalIndex({
        count: entries.length,
        threadIds: indexedThreadIds,
      });
      return [202, { data: { indexed: entries.length } }];
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
      const indexFilePath = recallIndexPath(vaultRoot);
      const index = await readIndex(indexFilePath);
      if (index === null) {
        return [200, { data: [] }];
      }
      // Short-circuit when the index is empty. The lifecycle's first
      // background rebuild creates an empty index file on a fresh
      // vault, so `index !== null` doesn't imply there's anything to
      // search. Without this branch we'd burn an embedder load (and
      // surface a misleading 503 RECALL_MODEL_MISSING in offline +
      // empty-cache mode) for a query that has nothing to rank.
      if (index.items.length === 0) {
        return [200, { data: [] }];
      }
      // Vector availability gate. The embedder runs in a child
      // process; cold/warming/failed states return lexical-only
      // results immediately. Callers that want to wait for the
      // vector path can pass ?waitMs=N (capped at 5000) and we'll
      // poll for ready up to that budget. Default is non-blocking
      // — /v1/recall/query must not stall the side panel on a
      // cold embedder.
      const embedderStatus = context.getEmbedderStatus?.() ?? { state: 'disabled' as const };
      const rawWait = Number.parseInt(url.searchParams.get('waitMs') ?? '0', 10);
      const waitBudgetMs = Number.isFinite(rawWait) && rawWait > 0 ? Math.min(rawWait, 5_000) : 0;
      const isVectorUsable = (s: string): boolean => s === 'ready' || s === 'disabled';
      let vectorStateAtQuery = embedderStatus.state;
      if (
        !isVectorUsable(vectorStateAtQuery) &&
        waitBudgetMs > 0 &&
        vectorStateAtQuery !== 'failed'
      ) {
        const deadline = Date.now() + waitBudgetMs;
        while (Date.now() < deadline) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 50);
          });
          const next = context.getEmbedderStatus?.() ?? { state: 'disabled' as const };
          vectorStateAtQuery = next.state;
          if (isVectorUsable(vectorStateAtQuery)) break;
        }
      }
      // Embedding the query needs the local model. In offline mode
      // with an empty cache (or any other "we can't load the model"
      // failure path), the embedder throws RecallModelMissingError —
      // surface that as a typed 503 so the side panel can show a
      // distinct "model missing" affordance instead of a generic
      // "recall failed". Capture continues to work in that state
      // because POST /v1/events doesn't depend on the embedder.
      let queryEmbedding: Float32Array | undefined;
      let vectorMode: 'used' | 'skipped-warming' | 'skipped-failed' = 'used';
      if (!isVectorUsable(vectorStateAtQuery)) {
        vectorMode = vectorStateAtQuery === 'failed' ? 'skipped-failed' : 'skipped-warming';
      } else {
        const { embed, MODEL_ID, RecallModelMissingError } = await loadEmbedderModule();
        try {
          [queryEmbedding] = await embed([query.q]);
        } catch (error) {
          if (error instanceof RecallModelMissingError) {
            return [
              503,
              createProblem({
                title: 'Recall embedding model is not available',
                status: 503,
                code: 'RECALL_MODEL_MISSING',
                correlationId: createRequestId(),
                detail: error.offline
                  ? `Companion is in offline-models mode and the cache at ${error.cacheDir} does not contain ${MODEL_ID}. Run \`sidetrack-companion models ensure\` (with network access) or disable --offline-models / SIDETRACK_OFFLINE_MODELS.`
                  : `Could not load ${MODEL_ID} from ${error.cacheDir}. Run \`sidetrack-companion models ensure\` to (re)download the model.`,
              }),
            ];
          }
          throw error;
        }
      }
      const threadIds =
        query.workstreamId === undefined
          ? undefined
          : await readWorkstreamThreadIds(vaultRoot, query.workstreamId);
      // Resolve the lexical index from cache. If the on-disk file
      // mtime + entry count haven't changed, reuse the prior
      // MiniSearch instance — building it from scratch on every
      // query is wasteful for large indexes. Falls back to vector-
      // only ranking when the index has zero entries that carry
      // chunk metadata (V2 holdovers post-rebuild).
      const indexStat = await stat(indexFilePath).catch(() => undefined);
      const indexMtime = indexStat?.mtimeMs ?? 0;
      const cached = lexicalIndexCache.get(indexFilePath);
      const lexical: HybridLexicalIndex =
        cached?.mtimeMs === indexMtime && cached.entryCount === index.items.length
          ? cached.index
          : buildLexicalIndex(index.items);
      if (cached?.mtimeMs !== indexMtime || cached.entryCount !== index.items.length) {
        lexicalIndexCache.set(indexFilePath, {
          mtimeMs: indexMtime,
          entryCount: index.items.length,
          index: lexical,
        });
      }
      // Hybrid lexical + vector retrieval via RRF. Falls back
      // gracefully when the index has no chunk-metadata entries
      // (V2 holdovers): the lexical search side returns no hits,
      // RRF degenerates to vector ranking, which is what the
      // pre-V3 behavior already produced.
      const hybridRanked = rankHybrid(
        query.q,
        queryEmbedding ?? new Float32Array(384),
        index.items,
        new Date(),
        {
          limit: query.limit,
          lexical,
          ...(threadIds === undefined
            ? {}
            : { workstreamMembership: (threadId: string) => threadIds.has(threadId) }),
        },
      );
      // If hybrid returned nothing AND the index has entries, the
      // user still expects vector-only behavior (e.g., a query that
      // matches nothing lexically but is semantically close). Plain
      // `rank` is the back-compat path for that case.
      const ranked =
        hybridRanked.length > 0
          ? hybridRanked
          : rank(queryEmbedding ?? new Float32Array(384), index.items, new Date(), {
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
      return [
        200,
        {
          data: enriched,
          meta: {
            vectorMode,
            vectorState: vectorStateAtQuery,
            ...(waitBudgetMs > 0 ? { waitedMs: waitBudgetMs } : {}),
          },
        },
      ];
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/page-content\/extracted$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      const idempotencyKey = requireIdempotencyKey(request);
      const payload = compactPageContentExtractedPayload(
        pageContentExtractedSchema.parse(await readBody(request)),
      );
      return await runIdempotent(context, 'pageContentExtracted', idempotencyKey, async () => {
        const coverage = await writePageContentExtracted(vaultRoot, payload);
        const evidence = await writeExtractedPageEvidence(vaultRoot, {
          ...payload,
          storageMode: 'indexed_chunks',
        });
        if (context.eventLog !== undefined) {
          await context.eventLog.appendServerObserved({
            clientEventId: idempotencyKey,
            aggregateId: `page-content:${coverage.canonicalUrl}`,
            type: PAGE_CONTENT_EXTRACTED,
            payload: { ...payload },
          });
          await context.eventLog.appendServerObserved({
            clientEventId: `${idempotencyKey}:page-evidence`,
            aggregateId: `page-evidence:${evidence.canonicalUrl}`,
            type: PAGE_EVIDENCE_EXTRACTED,
            payload: {
              ...pageEvidenceExtractedEventPayload(evidence, {
                ...payload,
                storageMode: 'indexed_chunks',
              }),
            },
          });
        }
        return [202, { data: { coverage } }];
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/page-evidence\/summary(?:\?.*)?$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const canonicalUrl = url.searchParams.get('canonicalUrl');
      if (canonicalUrl === null || canonicalUrl.length === 0) {
        throw new HttpRouteError(
          400,
          'MISSING_PARAMETER',
          'canonicalUrl query parameter is required.',
          'GET /v1/page-evidence/summary requires a canonicalUrl query parameter.',
        );
      }
      try {
        const result = await readPageEvidence(vaultRoot, canonicalUrl);
        return [
          200,
          {
            data: {
              canonicalUrl: result.record?.canonicalUrl ?? canonicalUrl,
              pageEvidence:
                result.record === null ? null : pageEvidenceSummaryPayload(result.record),
              stale: result.stale,
              ...(result.staleReason === undefined ? {} : { staleReason: result.staleReason }),
            },
          },
        ];
      } catch (error) {
        throw new HttpRouteError(
          400,
          'VALIDATION_ERROR',
          'Validation failed.',
          error instanceof Error ? error.message : 'Invalid canonicalUrl.',
        );
      }
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/page-evidence\/extracted$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      const idempotencyKey = requireIdempotencyKey(request);
      const payload = compactPageEvidenceExtractedPayload(
        pageEvidenceExtractedSchema.parse(await readBody(request)),
      );
      return await runIdempotent(context, 'pageEvidenceExtracted', idempotencyKey, async () => {
        const pageContentPayload = compactPageContentExtractedPayload(payload);
        const coverage =
          payload.storageMode === 'indexed_chunks'
            ? await writePageContentExtracted(vaultRoot, pageContentPayload)
            : null;
        // Skip both the O(records) manifest rebuild and doc embedding
        // on the request path. The per-URL features record is written
        // immediately so /v1/page-evidence/summary can resolve on the
        // next badge poll. Doc embedding is intentionally not run on
        // the default API process; it is still main-loop CPU until the
        // dedicated worker lane lands.
        const evidence = await writeExtractedPageEvidenceFast(vaultRoot, payload, {
          rebuildManifestAfterWrite: false,
        });
        if (
          pageEvidenceBackgroundEmbeddingEnabled() &&
          evidence.evidenceTier !== 'metadata_only' &&
          evidence.content?.embeddingState === 'missing'
        ) {
          setTimeout(() => {
            void completeExtractedPageEvidenceEmbedding(vaultRoot, payload, {
              rebuildManifestAfterWrite: false,
            }).catch((error: unknown) => {
              console.warn(
                '[page-evidence] background doc embedding failed:',
                error instanceof Error ? error.message : error,
              );
            });
          }, 0);
        }
        if (context.eventLog !== undefined) {
          if (coverage !== null) {
            await context.eventLog.appendServerObserved({
              clientEventId: `${idempotencyKey}:page-content`,
              aggregateId: `page-content:${coverage.canonicalUrl}`,
              type: PAGE_CONTENT_EXTRACTED,
              payload: { ...pageContentPayload },
            });
          }
          await context.eventLog.appendServerObserved({
            clientEventId: `${idempotencyKey}:page-evidence`,
            aggregateId: `page-evidence:${evidence.canonicalUrl}`,
            type: PAGE_EVIDENCE_EXTRACTED,
            payload: { ...pageEvidenceExtractedEventPayload(evidence, payload) },
          });
        }
        return [202, { data: { evidence, ...(coverage === null ? {} : { coverage }) } }];
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/page-content\/tombstone$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      const idempotencyKey = requireIdempotencyKey(request);
      const payload = compactPageContentTombstonedPayload(
        pageContentTombstonedSchema.parse(await readBody(request)),
      );
      return await runIdempotent(context, 'pageContentTombstone', idempotencyKey, async () => {
        const coverage = await writePageContentTombstoned(vaultRoot, payload);
        if (context.eventLog !== undefined) {
          await context.eventLog.appendServerObserved({
            clientEventId: idempotencyKey,
            aggregateId: `page-content:${coverage.canonicalUrl}`,
            type: PAGE_CONTENT_TOMBSTONED,
            payload: { ...payload },
          });
        }
        return [202, { data: { coverage } }];
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/page-content\/recanonicalize$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      const body = await readBody(request);
      const record = objectRecord(body);
      const canonicalUrl =
        typeof body === 'string'
          ? body
          : typeof record?.['canonicalUrl'] === 'string'
            ? record['canonicalUrl']
            : undefined;
      if (canonicalUrl === undefined || canonicalUrl.trim().length === 0) {
        throw new HttpRouteError(
          400,
          'MISSING_PARAMETER',
          'canonicalUrl is required.',
          'POST /v1/page-content/recanonicalize requires a canonicalUrl string body.',
        );
      }
      const coverage = await writePageContentTombstoned(vaultRoot, {
        payloadVersion: 1,
        canonicalUrl,
        tombstonedAt: new Date().toISOString(),
        reason: 'user-delete',
        dimensions: { source: 'recanonicalize' },
      });
      return [200, { data: { tombstoned: true, canonicalUrl: coverage.canonicalUrl } }];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/page-content\/coverage(?:\?.*)?$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const query = pageContentCoverageQuerySchema.parse({
        canonicalUrl: url.searchParams.get('canonicalUrl') ?? '',
      });
      const coverage = await readPageContentCoverage(vaultRoot, query.canonicalUrl);
      return [200, { data: coverage }];
    },
  },
  {
    // Recall v2 — single unified retrieval endpoint. POST so the
    // extension can pass a typed request body (sources / suppression
    // policy / strategy) without URL-encoding gymnastics. Initially
    // delegates to v1.5 functions via recall-v2/pipeline.ts; later
    // phases swap the SQLite backend + query analysis + cross-encoder
    // rerank without touching the contract.
    method: 'POST',
    pattern: /^\/v2\/recall$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      const body = (await readBody(request)) as unknown;
      const parsed = recallV2RequestSchema.safeParse(body);
      if (!parsed.success) {
        // Surface the first Zod issue path so callers can see WHICH
        // field is wrong without dumping the full ZodError. Keeps the
        // error shape consistent with the rest of the v1 API.
        const first = parsed.error.issues[0];
        const path = first?.path.join('.') ?? 'body';
        const message = first?.message ?? 'invalid request body';
        throw new HttpRouteError(
          400,
          first === undefined ? 'INVALID_REQUEST' : 'INVALID_FIELD',
          `${path}: ${message}`,
          'POST /v2/recall body failed schema validation.',
        );
      }
      const req = parsed.data as import('../recall-v2/types.js').RecallRequest;
      // P1 — pass embedder lifecycle state so the pipeline can
      // degrade gracefully when the model is still warming up. Same
      // status the /v1/status endpoint exposes.
      const embedderState = context.getEmbedderStatus?.()?.state;
      // Phase 0 — wire impression logging. When the event log is
      // configured, every /v2/recall response writes a
      // `recall.served` event the trainer (Phase 3) can read. Append
      // is fire-and-forget inside the pipeline.
      const eventLog = context.eventLog;
      const appendImpression = eventLog === undefined
        ? undefined
        : async (payload: RecallServedPayload): Promise<void> => {
            await eventLog.appendServerObserved({
              clientEventId: `recall.served:${payload.servedContextId}:${String(payload.sequenceNumber)}`,
              aggregateId: payload.servedContextId,
              type: RECALL_SERVED,
              payload: payload as unknown as Record<string, unknown>,
            });
          };
      // Phase 5 — cross-encoder rerank ON by default in the dogfood
      // serving path. The pipeline library's default is 0 (off) for
      // test determinism; production /v2 endpoint applies
      // DOGFOOD_RERANK_TOP_K unless the caller overrides explicitly.
      // 20 candidates × ~5ms/pair on MiniLM-L-6-v2 ≈ ~100ms added per
      // request. Tune via the eval harness; calibration follow-up.
      const DOGFOOD_RERANK_TOP_K = 20;
      const reqWithDefaultRerank: import('../recall-v2/types.js').RecallRequest = {
        ...req,
        strategy: {
          ...(req.strategy ?? {}),
          rerankTopK: req.strategy?.rerankTopK ?? DOGFOOD_RERANK_TOP_K,
        },
      };
      // P3 — learned-rerank context loader. Reads the CURRENT connections
      // snapshot + the feedback-only event window (the SAME merged the
      // impression trainer used: RANKER_BOOTSTRAP_FEEDBACK_EVENT_TYPES,
      // indexed) so serve features match train features exactly. Invoked
      // only on the background TTL refresh AND only after the serve gate
      // passes (active impression-trained ship-gate-passed model) — never
      // inline on the request path. Omitted (→ feature off) without a
      // connections store / event log.
      const connectionsStore = context.connectionsStore;
      const learnedRerankContext =
        connectionsStore === undefined || eventLog === undefined
          ? undefined
          : async (): Promise<
              import('../recall-v2/learnedRerank.js').LearnedRerankContext | null
            > => {
              const snapshot = await connectionsStore.readCurrent();
              if (snapshot === null) return null;
              const feedbackTypes = RANKER_BOOTSTRAP_FEEDBACK_EVENT_TYPES as readonly string[];
              const merged = await readEventsFromStoreOrLog(
                context,
                eventLog,
                (event) => feedbackTypes.includes(event.type),
                RANKER_BOOTSTRAP_FEEDBACK_EVENT_TYPES,
              );
              return { snapshot, merged };
            };
      const response = await runRecallV2(
        {
          vaultRoot,
          ...(embedderState === undefined ? {} : { embedderState }),
          ...(appendImpression === undefined ? {} : { appendImpression }),
          ...(learnedRerankContext === undefined ? {} : { learnedRerankContext }),
        },
        reqWithDefaultRerank,
      );
      // Wrap in { data } to match the rest of the v1 API convention so
      // the bridge clients (recallV2 in pageContentClient.ts) can
      // unwrap consistently with the other endpoints.
      return [200, { data: response }];
    },
  },
  {
    // Phase 0 — POST /v1/recall/action. The extension echoes a user
    // action (click / open-new-tab / explicit feedback) on a served
    // candidate back to the companion. The companion appends a
    // `recall.action` event tied to the parent `recall.served` by
    // servedContextId. The group-level ranker trainer (Phase 3)
    // joins the two to build training groups.
    //
    // Body shape: RecallActionPayload (see recall/events.ts).
    // Idempotency: the X-Idempotency-Key header is the clientEventId,
    // so duplicate POSTs collapse to one event.
    method: 'POST',
    pattern: /^\/v1\/recall\/action$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const eventLog = context.eventLog;
      if (eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'event log not configured for this companion',
        );
      }
      const idempotencyKey = requireIdempotencyKey(request);
      return await runIdempotent(context, 'recallAction', idempotencyKey, async () => {
        const body = await readBody(request);
        if (!isRecallActionPayload(body)) {
          throw new HttpRouteError(
            400,
            'INVALID_REQUEST',
            'body did not match RecallActionPayload',
            'POST /v1/recall/action body failed payload validation.',
          );
        }
        const accepted = await eventLog.appendClientObserved({
          clientEventId: idempotencyKey,
          aggregateId: body.servedContextId,
          type: RECALL_ACTION,
          payload: body as unknown as Record<string, unknown>,
          // {} = "browser observed nothing"; the parent recall.served
          // already lives on the same aggregate, and the deps the
          // system stamps from frontier will pick it up automatically.
          baseVector: {},
        });
        return [
          201,
          {
            data: {
              accepted: true,
              clientEventId: accepted.clientEventId,
              servedContextId: body.servedContextId,
              actionKind: body.actionKind,
            },
          },
        ];
      });
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
        // Lazy: recall/rebuild.ts is on the /v1/status forbidden-import
          // list (statusContract.test.ts) — load it when the rebuild route
          // actually fires.
          {
            data: await (
              await import('../recall/rebuild.js')
            ).rebuildFromEventLog(vaultRoot, join(vaultRoot, '_BAC', 'events')),
          },
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
      if (match.threadId === undefined) {
        throw new Error('Missing threadId path parameter.');
      }
      // Capture the guard-narrowed values: TS narrowing from the
      // throws above does not carry into the cached builder closure.
      const threadId = match.threadId;
      const eventLog = context.eventLog;
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const query = suggestionQuerySchema.parse({
        limit: url.searchParams.get('limit') ?? undefined,
        threshold: url.searchParams.get('threshold') ?? undefined,
      });
      const suggestionsCacheKey = `thread:${threadId}|${await connectionsGraphSig(
        context.connectionsStore,
        join(vaultRoot, '_BAC', 'connections', 'current.json'),
      )}|l=${String(query.limit)}|th=${String(query.threshold ?? '')}`;
      return cachedThreadSuggestions(
        suggestionsCacheKey,
        THREAD_SUGGESTIONS_TTL_MS,
        async (): Promise<readonly [number, unknown]> => {
          const target = await readThreadSuggestionTarget(vaultRoot, threadId);
          const snapshot =
            context.connectionsStore instanceof SqliteConnectionsStore
              ? await context.connectionsStore.readResolverSubgraphForThread(target)
              : await context.connectionsStore!.readCurrent();
          if (snapshot === null) {
            throw new HttpRouteError(
              409,
              'CONNECTIONS_SNAPSHOT_MISSING',
              'Connections snapshot is not ready.',
            );
          }
          // resolveThreadAttribution only consumes USER_FLOW_REJECTED /
          // USER_ORGANIZED_ITEM from `events` (same as the URL/tab-session
          // resolver), so read just those via the events_type_idx instead of
          // the whole log — this was the dominant cost of the per-thread
          // suggestion fan-out (readMerged whole log, 7-22s under load).
          const merged = await readEventsFromStoreOrLog(
            context,
            eventLog,
            (event) => event.type === USER_FLOW_REJECTED || event.type === USER_ORGANIZED_ITEM,
            RESOLVER_SIGNAL_EVENT_TYPES,
          );
          const resolution = resolveThreadAttribution({
            threadId: target.threadId,
            ...(target.providerThreadId === undefined
              ? {}
              : { providerThreadId: target.providerThreadId }),
            ...(target.threadUrl === undefined ? {} : { threadUrl: target.threadUrl }),
            snapshot,
            events: merged,
          });
          // Compatibility route: callers still receive a ranked
          // Suggestion[] array, but the score now comes from the same
          // graph resolver used by URL/current-tab suggestions.
          const envThreshold = Number.parseFloat(process.env['SIDETRACK_SUGGEST_THRESHOLD'] ?? '');
          const defaultThreshold = Number.isFinite(envThreshold) ? envThreshold : 0.25;
          const threshold = query.threshold ?? defaultThreshold;
          const suggestions = resolution.fusedCandidates
            .map((candidate) => {
              const score = 1 / (1 + Math.exp(-candidate.rawFusionLogit));
              return {
                workstreamId: candidate.workstreamId,
                score,
                breakdown: {
                  ppr: candidate.pprScore,
                  similarity: candidate.simTopScore,
                  cluster: candidate.clusterPosterior,
                  corroboration: candidate.corroborationCount,
                  margin: resolution.decision.margin,
                },
                resolver: {
                  modelRevision: resolution.reasons.modelRevision,
                  graphRevision: resolution.reasons.graphRevision,
                  dominantSource: candidate.dominantSource,
                  action: resolution.decision.action,
                },
              };
            })
            .filter((suggestion) => suggestion.score >= threshold)
            .slice(0, query.limit);
          context.recallActivity?.recordSuggestion({
            threadId,
            resultCount: suggestions.length,
          });
          return [200, { data: suggestions }];
        },
      );
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
        //
        // Carry the richer per-turn fields (markdown / formattedText /
        // modelName) plus the thread-level metadata (title) through
        // to the log payload so the chunker has the best possible
        // source. Without this, the chunker would fall back to plain
        // text — losing heading structure, lists, and code fences.
        const eventLogAppended =
          context.eventLog === undefined
            ? false
            : await context.eventLog
                .appendServerObserved({
                  clientEventId: idempotencyKey,
                  aggregateId: result.bac_id,
                  type: CAPTURE_RECORDED,
                  payload: {
                    bac_id: result.bac_id,
                    ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
                    threadUrl: input.threadUrl,
                    provider: input.provider,
                    ...(input.title === undefined ? {} : { title: input.title }),
                    capturedAt: input.capturedAt,
                    turns: input.turns.map((turn) => ({
                      ordinal: turn.ordinal,
                      role: turn.role,
                      text: turn.text,
                      capturedAt: turn.capturedAt,
                      ...(turn.markdown === undefined ? {} : { markdown: turn.markdown }),
                      ...(turn.formattedText === undefined
                        ? {}
                        : { formattedText: turn.formattedText }),
                      ...(turn.modelName === undefined ? {} : { modelName: turn.modelName }),
                    })),
                  },
                })
                .then(() => true)
                .catch(() => false);
        void eventLogAppended;
        // Recall ingest is owned by the contract runner →
        // recallMaterializer path. `appendServerObserved` already
        // routes the accepted event through
        // `onLocalAccepted` → `syncContractRunner.onAcceptedEvent({
        // origin: 'local' })`, which fires the recall materializer's
        // onAccepted → coalesced ingest drain. Failures are recorded
        // via the materializer's `recallActivity.recordIngestFailed`.
        // Reviewer-flagged: do NOT also schedule
        // `lifecycle.ingestIncremental` here — that was the pre-
        // contract fast path and now duplicates work, weakening the
        // single-dispatch contract. The boot-time `catchUpAll` and
        // manual `recall reingest` cover the case where the embedder
        // was offline at capture time.
        return [201, mutationResponse(result, requestId)];
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/threads$/,
    authRequired: true,
    handle: async (request, requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      const input = await parseThreadUpsertBody(vaultRoot, await readBody(request));
      // Enforce trust for MCP-key callers regardless of the (voluntary,
      // now logging-only) tool header. A thread upsert that sets a
      // primaryWorkstreamId is a move; gate it on the DESTINATION
      // workstream.
      await requireWorkstreamTrust(
        context,
        request,
        input.primaryWorkstreamId,
        'sidetrack.threads.move',
      );
      // ALSO gate on the SOURCE workstream — the thread's CURRENT
      // primaryWorkstreamId — mirroring archive/unarchive which gate on
      // readThreadWorkstreamId. Without this, an mcp caller could steal a
      // thread OUT of an untrusted workstream (destination-only checks let
      // "move untrusted A → trusted B" and detach-to-null slip through with
      // zero source trust). A brand-new thread (no bac_id, nothing on disk)
      // has no source scope, so this is a no-op create. Detach (destination
      // null/absent) is still gated on the source here.
      if (input.bac_id !== undefined) {
        const sourceWorkstreamId = await readThreadWorkstreamId(vaultRoot, input.bac_id);
        if (sourceWorkstreamId !== undefined && sourceWorkstreamId !== input.primaryWorkstreamId) {
          await requireWorkstreamTrust(
            context,
            request,
            sourceWorkstreamId,
            'sidetrack.threads.move',
          );
        }
      }
      const result = await context.vaultWriter.upsertThread(input, requestId);
      // Mirror the upsert as a `thread.upserted` AcceptedEvent so
      // peers see thread state via sync. The legacy thread.json
      // write above is the immediate read source for callers that
      // don't yet consume the projection.
      if (context.eventLog !== undefined) {
        await context.eventLog
          .appendServerObserved({
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
    // §13 step 13 — user-facing Markdown export of a single thread.
    // Same shape + atomic-write path as the workstream export. Normal
    // bridge-key route.
    method: 'POST',
    pattern: /^\/v1\/threads\/(?<bacId>[A-Za-z0-9_-]+)\/export$/,
    authRequired: true,
    handle: async (_request, _requestId, match, context) => {
      if (match.bacId === undefined) {
        throw new Error('Missing bacId path parameter.');
      }
      requireVaultRoot(context);
      const result = await context.vaultWriter.exportThread(match.bacId);
      return [200, { data: { files: [...result.files] } }];
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
      await requireWorkstreamTrust(
        context,
        _request,
        await readThreadWorkstreamId(vaultRoot, match.bacId),
        'sidetrack.threads.archive',
      );
      const result = await context.vaultWriter.archiveThread(match.bacId, requestId);
      // Mirror as a thread.archived event so peers see the status
      // change via sync. clientEventId is deterministic per
      // (replica, thread) so a duplicate archive call collapses on
      // the eventLog's idempotency check.
      if (context.eventLog !== undefined && context.replica !== undefined) {
        await context.eventLog
          .appendServerObserved({
            clientEventId: `thread-archive:${context.replica.replicaId}:${match.bacId}`,
            aggregateId: match.bacId,
            type: THREAD_ARCHIVED,
            payload: { bac_id: match.bacId },
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
      await requireWorkstreamTrust(
        context,
        _request,
        await readThreadWorkstreamId(requireVaultRoot(context), match.bacId),
        'sidetrack.threads.unarchive',
      );
      const result = await context.vaultWriter.unarchiveThread(match.bacId, requestId);
      if (context.eventLog !== undefined && context.replica !== undefined) {
        await context.eventLog
          .appendServerObserved({
            clientEventId: `thread-unarchive:${context.replica.replicaId}:${match.bacId}:${requestId}`,
            aggregateId: match.bacId,
            type: THREAD_UNARCHIVED,
            payload: { bac_id: match.bacId },
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
      // F32 — creating a CHILD workstream is trust-gated on the parent
      // for MCP-key callers; a top-level create (no parentId) has no
      // scope to check and passes. Extension surface is exempt.
      await requireWorkstreamTrust(
        context,
        request,
        input.parentId,
        'sidetrack.workstreams.create',
      );
      const result = await context.vaultWriter.createWorkstream(input, requestId);
      if (context.eventLog !== undefined) {
        await context.eventLog
          .appendServerObserved({
            clientEventId: requestId,
            aggregateId: result.bac_id,
            type: WORKSTREAM_UPSERTED,
            payload: {
              bac_id: result.bac_id,
              title: input.title,
              ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
              // Match the writer's default (createWorkstream stamps
              // `privacy: input.privacy ?? 'private'`) so the event log
              // never disagrees with the persisted record.
              privacy: input.privacy ?? 'private',
              ...(input.screenShareSensitive === undefined
                ? {}
                : { screenShareSensitive: input.screenShareSensitive }),
              ...(input.tags === undefined ? {} : { tags: input.tags }),
              ...(input.children === undefined ? {} : { children: input.children }),
              ...(input.checklist === undefined ? {} : { checklist: input.checklist }),
              ...(input.description === undefined ? {} : { description: input.description }),
            },
          })
          .catch(() => undefined);
      }
      return [201, mutationResponse(result, requestId)];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/workstreams\/projections$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => {
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      // Bulk endpoint used by extension's refreshCachedWorkstreams: enumerate
      // every aggregate id touched by a WORKSTREAM_UPSERTED or
      // WORKSTREAM_DELETED event and project each one. This is the bridge
      // from the companion's relay-replicated event log to the extension's
      // chrome.storage cache, so workstreams created on Browser A reach
      // Browser B's side panel via the standard sync path.
      return cachedRoute(
        'wsproj',
        ROUTE_CACHE_TTL_MS,
        async (): Promise<readonly [number, unknown]> => {
          const events = await readEventsFromStoreOrLog(
            context,
            context.eventLog!,
            (event) => event.type === WORKSTREAM_UPSERTED || event.type === WORKSTREAM_DELETED,
            WORKSTREAM_PROJECTION_EVENT_TYPES,
          );
          // Bucket per-bacId once so each projectWorkstream call sees
          // only its own events. Without bucketing this is
          // O(aggregates × events) and stalls the route on large
          // vaults — same fix as buildConnectionsSnapshot.
          const eventsByBacId = new Map<string, typeof events[number][]>();
          for (const event of events) {
            const existing = eventsByBacId.get(event.aggregateId);
            if (existing === undefined) eventsByBacId.set(event.aggregateId, [event]);
            else existing.push(event);
          }
          const projections = [...eventsByBacId.keys()]
            .sort()
            .map((bacId) => projectWorkstream(bacId, eventsByBacId.get(bacId) ?? []));
          return [200, { data: projections }];
        },
      );
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
    // §13 step 13 — user-facing Markdown export of a workstream (and,
    // when includeThreads is set, its threads). Writes tree-path report
    // files OUTSIDE _BAC/ via the writer's atomic primitive, returning
    // vault-root-relative paths. Normal bridge-key route.
    method: 'POST',
    pattern: /^\/v1\/workstreams\/(?<bacId>[A-Za-z0-9_-]+)\/export$/,
    authRequired: true,
    handle: async (request, _requestId, match, context) => {
      if (match.bacId === undefined) {
        throw new Error('Missing bacId path parameter.');
      }
      requireVaultRoot(context);
      // readBody returns {} for an empty POST, so includeThreads defaults off.
      const input = workstreamExportSchema.parse(await readBody(request));
      const result = await context.vaultWriter.exportWorkstream(match.bacId, {
        ...(input.includeThreads === undefined ? {} : { includeThreads: input.includeThreads }),
      });
      return [200, { data: { files: [...result.files] } }];
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
            // to NO allowed write tools — matches isAllowed's
            // deny-by-default semantic (PRD §6.1.14, re-recorded
            // 2026-07-11): MCP write trust is opt-in per workstream.
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
      await requireWorkstreamTrust(context, _request, match.bacId, 'sidetrack.workstreams.bump');
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
            await context.eventLog.appendServerObserved({
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
        // F12 — emit workstream.deleted so peers learn of the
        // deletion. Without this, the local file is removed but the
        // event log is silent; the peer's mirror keeps the row
        // forever and any thread the user moved to this workstream
        // (which DID emit a thread.upserted with the new ws-id)
        // points at a dangling reference on the peer.
        if (context.eventLog !== undefined) {
          await context.eventLog
            .appendServerObserved({
              clientEventId: requestId,
              aggregateId: result.bac_id,
              type: WORKSTREAM_DELETED,
              payload: { bac_id: result.bac_id },
            })
            .catch(() => undefined);
        }
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
        // Only a workstream-scoped queue item is trust-gated; a thread /
        // global item has no workstream to check. MCP-key callers are
        // gated on that workstream; the extension surface is exempt.
        if (input.scope === 'workstream') {
          await requireWorkstreamTrust(context, request, input.targetId, 'sidetrack.queue.create');
        }
        const result = await context.vaultWriter.createQueueItem(input, requestId);
        if (context.eventLog !== undefined) {
          await context.eventLog
            .appendServerObserved({
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
  // Sync Contract v1 — timeline (Class F + Class B) routes.
  //
  // POST /v1/timeline/events — imports plugin-originated edge events
  // (browser.timeline.observed). The plugin allocates the edge dot;
  // the companion does NOT restamp. importEdgeEvent runs the
  // accepted event through the contract runner so the timeline
  // materializer rebuilds the affected day projection.
  //
  // GET /v1/timeline — returns the daily-bucketed projection. Range
  // filtered by `since` / `until` (UTC ISO timestamps); plain
  // substring filter on `q` (matches title or url). Always returns
  // a ScopedResult-shaped envelope with `scope: 'companion-extended'`.
  {
    method: 'POST',
    pattern: /^\/v1\/timeline\/events$/u,
    authRequired: true,
    handle: async (request, requestId, _match, context) => {
      if (context.importEdgeEvent === undefined) {
        throw new HttpRouteError(503, 'TIMELINE_NOT_WIRED', 'Timeline import is not configured.');
      }
      const body = (await readBody(request)) as { events?: unknown };
      if (body === null || typeof body !== 'object' || !Array.isArray(body.events)) {
        throw new HttpRouteError(
          400,
          'INVALID_REQUEST',
          'Body must be { events: AcceptedEvent[] }.',
        );
      }
      const imported: { replicaId: string; seq: number }[] = [];
      const skipped: (
        | { replicaId: string; seq: number; reason: string }
        | { status: 'duplicate-in-batch'; clientEventId: string; droppedAt: number }
      )[] = [];
      const recordImported = (event: import('../sync/causal.js').AcceptedEvent): void => {
        imported.push({ replicaId: event.dot.replicaId, seq: event.dot.seq });
      };
      const recordSkipped = (
        event: import('../sync/causal.js').AcceptedEvent,
        reason: string,
      ): void => {
        skipped.push({ replicaId: event.dot.replicaId, seq: event.dot.seq, reason });
      };
      // Validate + sanitize every candidate first, collecting the
      // accepted ones, so the import can run as ONE batched dedupe
      // pass instead of a per-event whole-log scan (the per-event
      // path made multi-event POSTs run 0.4-3.4 s).
      const valid: import('../sync/causal.js').AcceptedEvent[] = [];
      const seenClientEventIds = new Set<string>();
      for (const [index, candidate] of body.events.entries()) {
        if (
          candidate === null ||
          typeof candidate !== 'object' ||
          typeof (candidate as { type?: unknown }).type !== 'string' ||
          typeof (candidate as { dot?: unknown }).dot !== 'object' ||
          (candidate as { dot?: { replicaId?: unknown } }).dot === null
        ) {
          continue;
        }
        const event = candidate as import('../sync/causal.js').AcceptedEvent;
        // Reviewer-flagged: this endpoint is timeline-only. Reject
        // any event whose type is not browser.timeline.observed OR
        // whose payload fails the runtime predicate. Engagement /
        // selection / visual-fingerprint events go through the
        // companion's `/v1/edge/events` route (defined below).
        if (event.type !== BROWSER_TIMELINE_OBSERVED) {
          recordSkipped(event, 'invalid-event-type');
          continue;
        }
        if (!isBrowserTimelineObservedPayload(event.payload)) {
          recordSkipped(event, 'invalid-payload');
          continue;
        }
        // Reviewer-flagged defense-in-depth: sanitize URLs BEFORE
        // the event is appended. The plugin observer already
        // sanitizes outgoing URLs, but this route accepts events
        // from any caller with the bridge key (older plugin builds,
        // archive-import path, …). Once the event lands in the
        // immutable log we can't strip auth tokens out — this is
        // the last opportunity. We construct a new event with the
        // sanitized payload (preserving the edge dot + clientEventId
        // so importPeerEvent dedupe still works).
        const sanitizedPayload = sanitizeTimelinePayload(event.payload);
        const sanitized =
          sanitizedPayload === event.payload ? event : { ...event, payload: sanitizedPayload };
        if (seenClientEventIds.has(sanitized.clientEventId)) {
          skipped.push({
            status: 'duplicate-in-batch',
            clientEventId: sanitized.clientEventId,
            droppedAt: index,
          });
          continue;
        }
        seenClientEventIds.add(sanitized.clientEventId);
        valid.push(sanitized);
      }
      // Batched ingest — ONE readMerged dedupe for the whole POST.
      // importTimelineEvents dispatches each accepted event to the
      // contract runner (timeline/projection materializers are
      // event-driven), exactly like the per-event path. Falls back
      // to per-event importEdgeEvent when the batched importer is
      // not wired (tests / programmatic startCompanion callers).
      if (context.importTimelineEvents !== undefined && valid.length > 0) {
        const byClientEventId = new Map(valid.map((event) => [event.clientEventId, event]));
        try {
          const results = await context.importTimelineEvents(valid);
          for (const result of results) {
            const event = byClientEventId.get(result.clientEventId);
            if (event === undefined) continue;
            if (result.imported) recordImported(event);
            else recordSkipped(event, 'already-imported');
          }
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          for (const event of valid) recordSkipped(event, reason);
        }
      } else {
        for (const event of valid) {
          try {
            const result = await context.importEdgeEvent(event);
            if (result.imported) recordImported(event);
            else recordSkipped(event, 'already-imported');
          } catch (err) {
            recordSkipped(event, err instanceof Error ? err.message : String(err));
          }
        }
      }
      void requestId;
      return [200, { data: { imported, skipped } }];
    },
  },
  // POST /v1/edge/events — generic ingest route for plugin-originated
  // edge events that are NOT timeline observations: engagement
  // (interval + session aggregated), selection (copied + pasted),
  // visual fingerprint. The plugin's edge-event buffer drains here on
  // its 1-minute alarm; pre-fix this route returned 404 and engagement
  // events accumulated in the plugin's IndexedDB forever, starving
  // similarity edges, URL inference, and the ranker. Same import +
  // dedupe pipeline as /v1/timeline/events, narrowed to the set of
  // event types this route accepts.
  {
    method: 'POST',
    pattern: /^\/v1\/edge\/events$/u,
    authRequired: true,
    handle: async (request, requestId, _match, context) => {
      if (context.importEdgeEvent === undefined) {
        throw new HttpRouteError(
          503,
          'EDGE_EVENTS_NOT_WIRED',
          'Edge event import is not configured.',
        );
      }
      const body = (await readBody(request)) as { events?: unknown };
      if (body === null || typeof body !== 'object' || !Array.isArray(body.events)) {
        throw new HttpRouteError(
          400,
          'INVALID_REQUEST',
          'Body must be { events: AcceptedEvent[] }.',
        );
      }
      // Single source of truth for what `/v1/edge/events` accepts.
      // Previously a parallel `ACCEPTED_EDGE_EVENT_TYPES` Set plus a
      // `validatePayload` switch could drift (each new event type
      // needed two synchronized edits — that's how navigation.committed
      // shipped without a validator entry). One Map; adding a type
      // means one entry, period.
      const EDGE_EVENT_VALIDATORS = new Map<string, (payload: unknown) => boolean>([
        [ENGAGEMENT_INTERVAL_OBSERVED, isEngagementIntervalObservedPayload],
        [ENGAGEMENT_SESSION_AGGREGATED, isEngagementSessionAggregatedPayload],
        [SELECTION_COPIED, isSelectionCopiedPayload],
        [SELECTION_PASTED, isSelectionPastedPayload],
        [VISUAL_FINGERPRINT_OBSERVED, isVisualFingerprintObservedPayload],
        [NAVIGATION_COMMITTED, isNavigationCommittedPayload],
      ]);
      const isAcceptedEdgeEventType = (type: string): boolean => EDGE_EVENT_VALIDATORS.has(type);
      const validatePayload = (type: string, payload: unknown): boolean =>
        EDGE_EVENT_VALIDATORS.get(type)?.(payload) ?? false;
      const imported: { replicaId: string; seq: number }[] = [];
      const skipped: { replicaId: string; seq: number; reason: string }[] = [];
      const valid: import('../sync/causal.js').AcceptedEvent[] = [];
      for (const candidate of body.events) {
        if (
          candidate === null ||
          typeof candidate !== 'object' ||
          typeof (candidate as { type?: unknown }).type !== 'string' ||
          typeof (candidate as { dot?: unknown }).dot !== 'object' ||
          (candidate as { dot?: { replicaId?: unknown } }).dot === null
        ) {
          continue;
        }
        const event = candidate as import('../sync/causal.js').AcceptedEvent;
        if (!isAcceptedEdgeEventType(event.type)) {
          skipped.push({
            replicaId: event.dot.replicaId,
            seq: event.dot.seq,
            reason: 'invalid-event-type',
          });
          continue;
        }
        if (!validatePayload(event.type, event.payload)) {
          skipped.push({
            replicaId: event.dot.replicaId,
            seq: event.dot.seq,
            reason: 'invalid-payload',
          });
          continue;
        }
        valid.push(event);
      }
      void requestId;
      // P2 — batch the whole flush: ONE readMerged + dedupe + shard
      // write, vs ~3 whole-log scans PER event (the 39s-on-backlog
      // quadratic). Fallback to the per-event path when the batch
      // dep isn't wired (tests / programmatic startCompanion users).
      const recordResult = (
        event: import('../sync/causal.js').AcceptedEvent,
        wasImported: boolean,
      ): void => {
        if (wasImported) {
          imported.push({ replicaId: event.dot.replicaId, seq: event.dot.seq });
        } else {
          skipped.push({
            replicaId: event.dot.replicaId,
            seq: event.dot.seq,
            reason: 'already-imported',
          });
        }
      };
      const recordError = (
        event: import('../sync/causal.js').AcceptedEvent,
        err: unknown,
      ): void => {
        skipped.push({
          replicaId: event.dot.replicaId,
          seq: event.dot.seq,
          reason: err instanceof Error ? err.message : String(err),
        });
      };
      if (context.importEdgeEvents !== undefined) {
        try {
          const res = await context.importEdgeEvents(valid);
          const importedById = new Map(res.map((r) => [r.clientEventId, r.imported]));
          for (const event of valid) {
            recordResult(event, importedById.get(event.clientEventId) === true);
          }
        } catch (err) {
          for (const event of valid) recordError(event, err);
        }
      } else {
        for (const event of valid) {
          try {
            const result = await context.importEdgeEvent!(event);
            recordResult(event, result.imported);
          } catch (err) {
            recordError(event, err);
          }
        }
      }
      return [200, { data: { imported, skipped } }];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/timeline(?:\?.*)?$/u,
    authRequired: true,
    handle: async (request, requestId, _match, context) => {
      if (context.timelineStore === undefined) {
        throw new HttpRouteError(
          503,
          'TIMELINE_NOT_WIRED',
          'Timeline projection is not configured.',
        );
      }
      const url = new URL(request.url ?? '/v1/timeline', 'http://internal');
      const sinceRaw = url.searchParams.get('since') ?? undefined;
      const untilRaw = url.searchParams.get('until') ?? undefined;
      // Normalize date-only inputs (YYYY-MM-DD) to ISO timestamps:
      // since=date → start-of-day; until=date → end-of-day. Without
      // this, an entry's full ISO timestamp would lex-compare
      // greater than the bare date prefix and get excluded
      // incorrectly. With explicit ISO inputs we leave the value
      // alone — "exact" filtering at the timestamp level.
      const isDateOnly = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s);
      const since =
        sinceRaw === undefined
          ? undefined
          : isDateOnly(sinceRaw)
            ? `${sinceRaw}T00:00:00.000Z`
            : sinceRaw;
      const until =
        untilRaw === undefined
          ? undefined
          : isDateOnly(untilRaw)
            ? `${untilRaw}T23:59:59.999Z`
            : untilRaw;
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
      const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '100', 10);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : 100;

      const days = await context.timelineStore.listDays();
      // Day-bucket coarse filter — picks files we need to open.
      const inRange = days.filter((d) => {
        if (since !== undefined && d < since.slice(0, 10)) return false;
        if (until !== undefined && d > until.slice(0, 10)) return false;
        return true;
      });
      const items: {
        readonly date: string;
        readonly id: string;
        readonly firstSeenAt: string;
        readonly lastSeenAt: string;
        readonly url: string;
        readonly canonicalUrl?: string;
        readonly title?: string;
        readonly provider?: string;
        readonly visitCount: number;
      }[] = [];
      // Reviewer F6: also apply EXACT timestamp filtering. The
      // day-bucket filter above is only a coarse pass that picks
      // which files to open. An entry on the boundary day might
      // straddle the requested range — we include it if its
      // [firstSeenAt, lastSeenAt] window overlaps [since, until].
      // Without this, since=2026-05-07T12:00:00Z would still
      // return entries from 09:00 the same day.
      const overlapsRange = (entry: { firstSeenAt: string; lastSeenAt: string }): boolean => {
        if (since !== undefined && entry.lastSeenAt < since) return false;
        if (until !== undefined && entry.firstSeenAt > until) return false;
        return true;
      };
      // Walk newest-day first so we hit the limit on recent
      // entries.
      for (const date of [...inRange].reverse()) {
        const day = await context.timelineStore.readDay(date);
        if (day === null) continue;
        for (const entry of day.entries) {
          if (!overlapsRange(entry)) continue;
          if (q.length > 0) {
            const hay = `${entry.title ?? ''} ${entry.url}`.toLowerCase();
            if (!hay.includes(q)) continue;
          }
          items.push({ date, ...entry });
          if (items.length >= limit) break;
        }
        if (items.length >= limit) break;
      }
      void requestId;
      return [
        200,
        {
          data: {
            scope: 'companion-extended',
            items,
            entryCount: items.length,
          },
        },
      ];
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/connections\/ranker\/retrain$/u,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
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
      const vaultRoot = requireVaultRoot(context);
      const body = objectRecord(await readBody(request)) ?? {};
      const force = body['force'] === true;
      const threshold =
        optionalFiniteNumber(body['threshold'], 'threshold') ?? (force ? 1 : undefined);
      const randomNegativeCandidatesPerPositive = optionalFiniteNumber(
        body['randomNegativeCandidatesPerPositive'],
        'randomNegativeCandidatesPerPositive',
      );
      const trainNumRound = optionalFiniteNumber(body['numRound'], 'numRound');
      // Stage 5 polish — route through the worker helper so BOTH the
      // cold-path file reads (readMerged + readCurrent) AND the
      // LightGBM training math run off the main event loop. /v1/status
      // + every other warm-path poll stay responsive while retrain is
      // in flight. The handler now returns to the request body only
      // after the worker round-trip, but it never executes any
      // CPU-heavy or I/O-heavy work on its own thread.
      // SIDETRACK_RANKER_RETRAIN_INLINE=1 opts back into the legacy
      // inline path for fixtures + tests that don't carry a built
      // worker bundle.
      const trainOptions = trainNumRound === undefined ? undefined : { numRound: trainNumRound };
      let result: Awaited<ReturnType<typeof maybeRetrainClosestVisitRanker>>;
      if (process.env['SIDETRACK_RANKER_RETRAIN_INLINE'] === '1') {
        // Inline path also gets called for tests, which inject
        // `context.eventLog` + `context.connectionsStore` directly.
        const snapshot = await context.connectionsStore.readCurrent();
        if (snapshot === null) {
          throw new HttpRouteError(
            409,
            'CONNECTIONS_SNAPSHOT_MISSING',
            'Connections snapshot is not ready.',
          );
        }
        result = await maybeRetrainClosestVisitRanker({
          vaultRoot,
          merged: await context.eventLog.readMerged(),
          snapshot,
          ...(threshold === undefined ? {} : { threshold }),
          ...(force ? { force: true } : {}),
          ...(randomNegativeCandidatesPerPositive === undefined
            ? {}
            : { randomNegativeCandidatesPerPositive }),
          ...(trainOptions === undefined ? {} : { trainOptions }),
        });
      } else {
        result = await runMaybeRetrainInWorker({
          vaultRoot,
          ...(threshold === undefined ? {} : { threshold }),
          ...(force ? { force: true } : {}),
          ...(randomNegativeCandidatesPerPositive === undefined
            ? {}
            : { randomNegativeCandidatesPerPositive }),
          ...(trainOptions === undefined ? {} : { trainOptions }),
        });
      }
      if (result.status === 'trained') {
        await context.refreshConnections?.();
      }
      return [200, { data: result }];
    },
  },
  {
    // P1b — main-process impression-bootstrap. Reconstructs LightGBM training
    // groups from historical explicit feedback by re-running /v2 recall here
    // (warm pipeline, I/O-bound → interleaves with /v1/status), trains
    // OFF-THREAD via the train-groups worker, ship-gates, and promotes the
    // active closest-visit revision on PASS. Manual + idempotent (the trainer
    // dedupes already-referenced feedback). Gated by
    // SIDETRACK_RANKER_RECONSTRUCT_FEEDBACK; reconstruction capped by
    // SIDETRACK_RANKER_RECONSTRUCT_CAP (default 200, oldest-first).
    method: 'POST',
    pattern: /^\/v1\/ranker\/impression-bootstrap$/u,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => {
      if (process.env['SIDETRACK_RANKER_RECONSTRUCT_FEEDBACK'] === '0') {
        throw new HttpRouteError(403, 'BOOTSTRAP_DISABLED', 'Impression bootstrap is disabled.');
      }
      if (context.eventLog === undefined || context.connectionsStore === undefined) {
        throw new HttpRouteError(
          503,
          'CONNECTIONS_NOT_WIRED',
          'Event log / connections is not configured.',
        );
      }
      const vaultRoot = requireVaultRoot(context);
      const snapshot = await context.connectionsStore.readCurrent();
      if (snapshot === null) {
        throw new HttpRouteError(
          409,
          'CONNECTIONS_SNAPSHOT_MISSING',
          'Connections snapshot is not ready.',
        );
      }
      const embedderState = context.getEmbedderStatus?.()?.state;
      const history = await readEventsFromStoreOrLog(
        context,
        context.eventLog,
        (event) =>
          event.type === USER_FLOW_CONFIRMED ||
          event.type === USER_FLOW_REJECTED ||
          event.type === USER_ORGANIZED_ITEM ||
          event.type === USER_SNIPPET_PROMOTED,
        RANKER_BOOTSTRAP_FEEDBACK_EVENT_TYPES,
      );
      const capRaw = Number(process.env['SIDETRACK_RANKER_RECONSTRUCT_CAP']);
      const reconstructCap = Number.isFinite(capRaw) && capRaw > 0 ? capRaw : 200;
      let reconstructed = 0;
      const result = await runRecallImpressionBootstrap({
        vaultRoot,
        history,
        snapshot,
        reconstructFeedback: async (req) => {
          if (reconstructed >= reconstructCap) {
            return null;
          }
          reconstructed += 1;
          // Yield a macrotask before each (CPU-heavy) reconstruction so
          // /v1/status and other warm-path requests interleave. Back-to-back
          // runRecall calls otherwise saturate the event loop — measured a
          // ~42s /status freeze without this. With the yield the bootstrap
          // takes the same wall-clock but /status stays responsive.
          await new Promise((resolve) => setImmediate(resolve));
          return runRecallV2(
            { vaultRoot, ...(embedderState === undefined ? {} : { embedderState }) },
            req.recallRequest,
          );
        },
      });
      if (result.status === 'trained') {
        await context.refreshConnections?.();
      }
      return [200, { data: { ...result, reconstructed, historyEventCount: history.length } }];
    },
  },
  // Sync Contract v1 — Connections (Class B evidence graph) routes.
  //
  // GET /v1/connections                            full snapshot or
  //                                                workstream-scoped
  //                                                subgraph
  // GET /v1/connections/nodes/<id>/neighbors?hops= subgraph around an anchor
  // GET /v1/connections/edges/<id>                 edge + producing event
  // GET /v1/connections/path?fromNodeId=...        BFS path between two nodes
  //
  // All bridge-key authenticated. ScopedResult-shaped envelope so
  // the side panel + MCP can render partial-data states honestly.
  {
    method: 'GET',
    pattern: /^\/v1\/connections(?:\?.*)?$/u,
    authRequired: true,
    handle: async (request, requestId, _match, context) => {
      void requestId;
      if (context.connectionsStore === undefined) {
        throw new HttpRouteError(503, 'CONNECTIONS_NOT_WIRED', 'Connections is not configured.');
      }
      const url = new URL(request.url ?? '/v1/connections', 'http://internal');
      const workstreamId = url.searchParams.get('workstreamId') ?? undefined;
      const nodeKind = url.searchParams.get('nodeKind') ?? undefined;
      const edgeKind = url.searchParams.get('edgeKind') ?? undefined;
      const provider = url.searchParams.get('provider') ?? undefined;
      const originReplicaId = url.searchParams.get('originReplicaId') ?? undefined;
      const topicVariantRaw = url.searchParams.get('topicVariant') ?? undefined;
      if (topicVariantRaw !== undefined && topicVariantRaw !== 'shadow') {
        throw new HttpRouteError(
          400,
          'INVALID_REQUEST',
          'topicVariant must be omitted or "shadow".',
        );
      }
      const topicVariant = topicVariantRaw === 'shadow' ? topicVariantRaw : undefined;

      const cacheVaultRoot = requireVaultRoot(context);
      const cacheKey = await connectionsResponseCacheKey(
        context.connectionsStore,
        cacheVaultRoot,
        url.search,
      );
      const { result: connectionsResult } = await cachedConnectionsResponse(
        cacheKey,
        CONNECTIONS_RESPONSE_TTL_MS,
        async (): Promise<readonly [number, unknown]> => {
          let snap = await context.connectionsStore!.readCurrent();
          if (snap === null) {
            // Materializer hasn't run yet — return an empty scoped
            // envelope so callers don't have to special-case 404.
            return [
              200,
              {
                data: {
                  scope: 'companion-extended',
                  snapshot: {
                    scope: { ...(topicVariant === undefined ? {} : { topicVariant }) },
                    nodes: [],
                    edges: [],
                    updatedAt: '1970-01-01T00:00:00.000Z',
                    nodeCount: 0,
                    edgeCount: 0,
                  },
                },
              },
            ];
          }
          if (topicVariant === 'shadow') {
            const shadowRevision = await createTopicRevisionStore(
              requireVaultRoot(context),
            ).readShadowRevision();
            if (shadowRevision === null) {
              return [
                200,
                {
                  data: {
                    scope: 'companion-extended',
                    snapshot: {
                      scope: { topicVariant },
                      nodes: [],
                      edges: [],
                      updatedAt: snap.updatedAt,
                      nodeCount: 0,
                      edgeCount: 0,
                      ...(snap.snapshotRevision === undefined
                        ? {}
                        : { snapshotRevision: `${snap.snapshotRevision}:shadow-missing` }),
                    },
                  },
                },
              ];
            }
            snap = overlayTopicRevisionOnSnapshot(snap, shadowRevision);
          }
          if (context.eventLog !== undefined) {
            snap = applyFeedbackOverlayToSnapshot(
              snap,
              projectFeedback(
                await readEventsFromStoreOrLog(
                  context,
                  context.eventLog,
                  (event) => isFeedbackEventType(event.type),
                  FEEDBACK_EVENT_TYPE_LIST,
                ),
              ),
            );
          }
          snap = await applyPageContentCoverageToSnapshot(requireVaultRoot(context), snap);
          // Coarse filters — honoured by simple matchers. workstreamId
          // narrows to nodes either matching the ws id directly or
          // having metadata.workstreamId pointing to it; edges between
          // selected nodes survive.
          let nodes = snap.nodes;
          let edges = snap.edges;
          if (workstreamId !== undefined) {
            const wsNodeId = `workstream:${workstreamId}`;
            const keepNodeIds = new Set<string>([wsNodeId]);
            for (const n of nodes) {
              if (n.metadata.workstreamId === workstreamId) keepNodeIds.add(n.id);
            }
            // Pull in edge endpoints reachable from the kept set in one
            // hop so the projection is comprehensible.
            for (const e of edges) {
              if (keepNodeIds.has(e.fromNodeId)) keepNodeIds.add(e.toNodeId);
              if (keepNodeIds.has(e.toNodeId)) keepNodeIds.add(e.fromNodeId);
            }
            nodes = nodes.filter((n) => keepNodeIds.has(n.id));
            edges = edges.filter(
              (e) => keepNodeIds.has(e.fromNodeId) && keepNodeIds.has(e.toNodeId),
            );
          }
          if (nodeKind !== undefined) {
            nodes = nodes.filter((n) => n.kind === nodeKind);
            const kept = new Set(nodes.map((n) => n.id));
            edges = edges.filter((e) => kept.has(e.fromNodeId) && kept.has(e.toNodeId));
          }
          if (edgeKind !== undefined) {
            edges = edges.filter((e) => e.kind === edgeKind);
          }
          if (provider !== undefined) {
            nodes = nodes.filter((n) => n.metadata.provider === provider);
            const kept = new Set(nodes.map((n) => n.id));
            edges = edges.filter((e) => kept.has(e.fromNodeId) && kept.has(e.toNodeId));
          }
          if (originReplicaId !== undefined) {
            nodes = nodes.filter((n) => n.originReplicaIds.includes(originReplicaId));
            const kept = new Set(nodes.map((n) => n.id));
            edges = edges.filter((e) => kept.has(e.fromNodeId) && kept.has(e.toNodeId));
          }
          return [
            200,
            {
              data: {
                scope: 'companion-extended',
                snapshot: {
                  scope: {
                    ...(workstreamId === undefined ? {} : { workstreamId }),
                    ...(topicVariant === undefined ? {} : { topicVariant }),
                  },
                  nodes,
                  edges,
                  updatedAt: snap.updatedAt,
                  nodeCount: nodes.length,
                  edgeCount: edges.length,
                  ...(snap.snapshotRevision === undefined
                    ? {}
                    : { snapshotRevision: snap.snapshotRevision }),
                },
              },
            },
          ];
        },
      );
      return connectionsResult;
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/connections\/nodes\/(?<connectionsNodeId>[^/?]+)\/neighbors(?:\?.*)?$/u,
    authRequired: true,
    handle: async (request, _requestId, match, context) => {
      if (context.connectionsStore === undefined) {
        throw new HttpRouteError(503, 'CONNECTIONS_NOT_WIRED', 'Connections is not configured.');
      }
      // Path params are URI-encoded (we accept the whole node id
      // as the URL segment); decode and validate length.
      const nodeId = decodeURIComponent(match.connectionsNodeId ?? '');
      const url = new URL(request.url ?? '/v1/connections', 'http://internal');
      const hopsRaw = Number.parseInt(url.searchParams.get('hops') ?? '1', 10);
      const hops = Number.isFinite(hopsRaw) && hopsRaw >= 0 ? Math.min(hopsRaw, 4) : 1;
      if (context.connectionsStore instanceof SqliteConnectionsStore) {
        let sub = await context.connectionsStore.readSubgraphForNode(nodeId, hops);
        if (sub !== null && sub.nodes.length > 0) {
          if (context.eventLog !== undefined) {
            sub = applyFeedbackOverlayToSnapshot(
              sub,
              projectFeedback(
                await readEventsFromStoreOrLog(
                  context,
                  context.eventLog,
                  (event) => isFeedbackEventType(event.type),
                  FEEDBACK_EVENT_TYPE_LIST,
                ),
              ),
            );
          }
          sub = await applyPageContentCoverageToSnapshot(requireVaultRoot(context), sub);
          return [200, { data: { scope: 'companion-extended', snapshot: sub } }];
        }
      }
      let snap = await context.connectionsStore.readCurrent();
      if (snap === null) {
        return [
          200,
          {
            data: {
              scope: 'companion-extended',
              snapshot: {
                scope: { nodeId, hops },
                nodes: [],
                edges: [],
                updatedAt: '1970-01-01T00:00:00.000Z',
                nodeCount: 0,
                edgeCount: 0,
              },
            },
          },
        ];
      }
      if (context.eventLog !== undefined) {
        snap = applyFeedbackOverlayToSnapshot(
          snap,
          projectFeedback(
            await readEventsFromStoreOrLog(
              context,
              context.eventLog,
              (event) => isFeedbackEventType(event.type),
              FEEDBACK_EVENT_TYPE_LIST,
            ),
          ),
        );
      }
      snap = await applyPageContentCoverageToSnapshot(requireVaultRoot(context), snap);
      const { subgraphForNode } = await import('../connections/snapshot.js');
      const resolvedNodeId = resolveConnectionsNodeId(snap, nodeId);
      const sub = subgraphForNode(snap, resolvedNodeId, hops);
      return [200, { data: { scope: 'companion-extended', snapshot: sub } }];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/connections\/edges\/(?<connectionsEdgeId>[^/?]+)(?:\?.*)?$/u,
    authRequired: true,
    handle: async (_request, _requestId, match, context) => {
      if (context.connectionsStore === undefined) {
        throw new HttpRouteError(503, 'CONNECTIONS_NOT_WIRED', 'Connections is not configured.');
      }
      const edgeId = decodeURIComponent(match.connectionsEdgeId ?? '');
      if (context.connectionsStore instanceof SqliteConnectionsStore) {
        const edge = await context.connectionsStore.readEdge(edgeId);
        if (edge === null) {
          throw new HttpRouteError(404, 'EDGE_NOT_FOUND', 'Edge not found.');
        }
        return [200, { data: { edge } }];
      }
      const snap = await context.connectionsStore.readCurrent();
      if (snap === null) {
        throw new HttpRouteError(404, 'EDGE_NOT_FOUND', 'No connections snapshot yet.');
      }
      const edge = snap.edges.find((e) => e.id === edgeId);
      if (edge === undefined) {
        throw new HttpRouteError(404, 'EDGE_NOT_FOUND', 'Edge not found.');
      }
      return [200, { data: { edge } }];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/connections\/path(?:\?.*)?$/u,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      if (context.connectionsStore === undefined) {
        throw new HttpRouteError(503, 'CONNECTIONS_NOT_WIRED', 'Connections is not configured.');
      }
      const url = new URL(request.url ?? '/v1/connections/path', 'http://internal');
      const fromNodeId = url.searchParams.get('fromNodeId') ?? '';
      const toNodeId = url.searchParams.get('toNodeId') ?? '';
      const maxHopsRaw = Number.parseInt(url.searchParams.get('maxHops') ?? '4', 10);
      const maxHops = Number.isFinite(maxHopsRaw) && maxHopsRaw > 0 ? Math.min(maxHopsRaw, 8) : 4;
      if (fromNodeId.length === 0 || toNodeId.length === 0) {
        throw new HttpRouteError(400, 'INVALID_REQUEST', 'fromNodeId and toNodeId are required.');
      }
      const snap = await context.connectionsStore.readCurrent();
      if (snap === null) {
        return [200, { data: { found: false } }];
      }
      const { findPath } = await import('../connections/snapshot.js');
      const result = findPath(snap, fromNodeId, toNodeId, maxHops);
      return [200, { data: result }];
    },
  },
  // Stage 5 polish — debug snapshot endpoint. The side panel collects
  // current visual state (focused tab, urlInbox, urlSuggestions, panel
  // settings) and POSTs the JSON blob here. We always overwrite
  // `${vaultRoot}/_BAC/debug-dumps/latest.json` so the user (and any
  // assistant they hand the path to) can read a single stable location
  // without tracking timestamps; the timestamped copy under the same
  // directory is kept for short-history scrubbing.
  {
    method: 'POST',
    pattern: /^\/v1\/debug\/dump$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      const body = await readBody(request);
      const dumpsDir = join(vaultRoot, '_BAC', 'debug-dumps');
      await mkdir(dumpsDir, { recursive: true });
      // Use an ISO timestamp + millisecond suffix so rapid-fire dumps
      // don't collide. Colons are valid on macOS / Linux but APFS
      // displays them oddly in Finder — strip to a safe pattern.
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const stamped = join(dumpsDir, `${ts}.json`);
      const latest = join(dumpsDir, 'latest.json');
      // Wrap the panel-supplied payload alongside a server-side header
      // (timestamp + companion uptime + vaultRoot) so the dump is
      // self-contained for offline review.
      const wrapped = {
        header: {
          dumpedAt: new Date().toISOString(),
          vaultRoot,
          companion: 'sidetrack-companion',
        },
        panel: body,
      };
      const json = JSON.stringify(wrapped, null, 2);
      await writeFile(stamped, json, 'utf8');
      await writeFile(latest, json, 'utf8');
      return [
        201,
        {
          data: { path: latest, stampedPath: stamped, sizeBytes: Buffer.byteLength(json, 'utf8') },
        },
      ];
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
      (isMcpKey ||
        (await isBridgeKeyAccepted(context.vaultRoot, context.bridgeKey, actualKey)));
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
    // Debug-only request log (SIDETRACK_HTTP_LOG=1): ground-truth of
    // what the extension actually polls + per-request latency. Written
    // to a file because the screen-session pty isn't capturable.
    // Fire-and-forget; zero overhead when the env is unset.
    const httpLog = process.env['SIDETRACK_HTTP_LOG'] === '1';
    const httpLogStartedMs = httpLog ? Date.now() : 0;
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
    const logHttp = (statusForLog: number): void => {
      if (!httpLog) return;
      // pathname ONLY — url.search is deliberately omitted (PII).
      void appendHttpDebugLine(
        `${new Date().toISOString()} ${method ?? 'UNKNOWN'} ${url.pathname} ${String(statusForLog)} ${String(Date.now() - httpLogStartedMs)}ms\n`,
      ).catch(() => undefined);
    };
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
