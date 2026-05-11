import {
  ANNOTATION_CREATED,
  ANNOTATION_DELETED,
  ANNOTATION_NOTE_SET,
} from '../../annotations/events.js';
import { buildEngagementClassRevision } from '../../connections/engagementClassifier.js';
import { readVaultStores } from '../../connections/loader.js';
import {
  buildConnectionsSnapshot,
  type ClosestVisitRanker,
  type ConnectionsInput,
} from '../../connections/snapshot.js';
import type { ConnectionsStore } from '../../connections/snapshot.js';
import {
  buildTopicRevision,
  type BuildTopicRevisionInput,
  type TopicVisit,
} from '../../connections/topicClusterer.js';
import { buildHdbscanTopicRevision } from '../../connections/hdbscanClusterer.js';
import {
  buildVisitSimilarity,
  type VisitSimilarityEmbedder,
} from '../../connections/visitSimilarity.js';
import { DISPATCH_LINKED, DISPATCH_RECORDED } from '../../dispatches/events.js';
import { ENGAGEMENT_SESSION_AGGREGATED } from '../../engagement/events.js';
import {
  USER_ENGAGEMENT_RELABELED,
  USER_FLOW_CONFIRMED,
  USER_FLOW_REJECTED,
  USER_ORGANIZED_ITEM,
  USER_SNIPPET_PROMOTED,
  USER_TOPIC_RENAMED,
} from '../../feedback/events.js';
import { NAVIGATION_COMMITTED } from '../../navigation/events.js';
import {
  buildEngagementClassifierInputs,
  createEngagementClassRevisionStore,
  type EngagementClassRevisionStore,
} from '../../producers/engagement-class-revision.js';
import {
  readActiveClosestVisitRankerRevisionManifest,
  readClosestVisitRankerRevision,
} from '../../producers/closest-visit-revision.js';
import {
  TOPIC_HDBSCAN_REVISION_KEY,
  TOPIC_UNION_FIND_REVISION_KEY,
  createTopicRevisionStore,
  type TopicAlgorithmVersion,
  type TopicRevision,
  type TopicRevisionStore,
} from '../../producers/topic-revision.js';
import { loadRankerModel, predictRanker, type LightGBMModel } from '../../ranker/predict.js';
import { maybeRetrainClosestVisitRanker, type RankerRetrainer } from '../../ranker/retrain.js';
import { writeVisitSimilarityRevision } from '../../producers/visit-resembles-revision.js';
import { QUEUE_CREATED, QUEUE_STATUS_SET } from '../../queue/events.js';
import { CAPTURE_RECORDED, RECALL_TOMBSTONE_TARGET } from '../../recall/events.js';
import { CAPTURE_EXTRACTION_PRODUCED } from '../../recall/extraction/events.js';
import { embed as defaultEmbed } from '../../recall/embedder.js';
import { SELECTION_COPIED, SELECTION_PASTED } from '../../snippets/events.js';
import {
  THREAD_ARCHIVED,
  THREAD_DELETED,
  THREAD_UNARCHIVED,
  THREAD_UPSERTED,
} from '../../threads/events.js';
import {
  BROWSER_TIMELINE_OBSERVED,
  type BrowserTimelineObservedPayload,
  isBrowserTimelineObservedPayload,
} from '../../timeline/events.js';
import {
  buildDayProjection,
  collectTimelinePayloads,
  entryIdFor,
  groupByDay,
  type TimelineDayProjection,
  type TimelineStore,
} from '../../timeline/projection.js';
import { WORKSTREAM_DELETED, WORKSTREAM_UPSERTED } from '../../workstreams/events.js';
import { VISUAL_FINGERPRINT_OBSERVED } from '../../visual/events.js';
import type { AcceptedEvent } from '../causal.js';
import type { EventLog } from '../eventLog.js';
import type { Materializer, MaterializerHealth } from './materializer.js';
import { projectTabSessions } from '../../tabsession/projection.js';
import { projectUrls } from '../../urls/projection.js';
import { TAB_SESSION_ATTRIBUTION_INFERRED } from '../../tabsession/events.js';

// Sync Contract v1 / Class B — Connections graph materializer.
//
// Consumer-only materializer: it doesn't OWN any registry surface
// row (same shape as `recall`). It subscribes to every event type
// that produces a node or edge in the connections graph, plus a
// vault-record sweep at snapshot time for fields the event payloads
// don't carry.
//
// Trigger model:
//   - onAccepted marks the snapshot dirty + sets pending. A single
//     in-flight drainer rebuilds the entire current snapshot from
//     the merged log + vault stores. Bursts coalesce naturally.
//   - catchUp is the same drain; bypasses the failure cooldown so
//     startup / reconnect always retry.
//   - drain failure → cooldown gates onAccepted-driven retries to
//     prevent tight loops; catchUp always bypasses.

const FAILURE_COOLDOWN_MS = 5_000;

// Hardcoded event types this materializer reacts to. Connections
// has no registry surface, so we can't derive handles from
// eventTypesForMaterializer('connections') — and we don't want to,
// since the materializer is a CONSUMER across many event-type
// owners. The list mirrors the union of event types that affect
// connection nodes or edges; any new event type that adds to the
// graph (e.g. a future capture-note event) gets added here.
const HANDLES: ReadonlySet<string> = new Set<string>([
  THREAD_UPSERTED,
  THREAD_ARCHIVED,
  THREAD_UNARCHIVED,
  THREAD_DELETED,
  WORKSTREAM_UPSERTED,
  WORKSTREAM_DELETED,
  DISPATCH_RECORDED,
  DISPATCH_LINKED,
  QUEUE_CREATED,
  QUEUE_STATUS_SET,
  ANNOTATION_CREATED,
  ANNOTATION_NOTE_SET,
  ANNOTATION_DELETED,
  CAPTURE_RECORDED,
  CAPTURE_EXTRACTION_PRODUCED,
  RECALL_TOMBSTONE_TARGET,
  NAVIGATION_COMMITTED,
  ENGAGEMENT_SESSION_AGGREGATED,
  USER_ENGAGEMENT_RELABELED,
  USER_FLOW_CONFIRMED,
  USER_FLOW_REJECTED,
  USER_ORGANIZED_ITEM,
  USER_SNIPPET_PROMOTED,
  USER_TOPIC_RENAMED,
  TAB_SESSION_ATTRIBUTION_INFERRED,
  SELECTION_COPIED,
  SELECTION_PASTED,
  // Timeline observations indirectly contribute (timeline visits
  // become nodes; same canonicalUrl produces edges to threads).
  // Including the event type here keeps freshness bound to the
  // arrival of the underlying observation, even though the
  // materializer reads the daily projection rather than the
  // event payload directly.
  BROWSER_TIMELINE_OBSERVED,
  VISUAL_FINGERPRINT_OBSERVED,
]);

export interface CreateConnectionsMaterializerDeps {
  readonly vaultRoot: string;
  readonly eventLog: EventLog;
  readonly timelineStore: TimelineStore;
  readonly store: ConnectionsStore;
  readonly embed?: VisitSimilarityEmbedder;
  readonly topicRevisionAlgorithm?: TopicAlgorithmVersion;
  readonly topicRevisionStore?: TopicRevisionStore;
  readonly engagementClassStore?: EngagementClassRevisionStore;
  readonly rankerRetrainer?: RankerRetrainer;
}

type TopicRevisionBuilder = (input: BuildTopicRevisionInput) => Promise<TopicRevision>;

interface LoadedClosestVisitRanker {
  readonly ranker: ClosestVisitRanker;
  readonly model: LightGBMModel;
}

const topicRevisionBuilderFor = (algorithm: TopicAlgorithmVersion): TopicRevisionBuilder => {
  switch (algorithm) {
    case TOPIC_UNION_FIND_REVISION_KEY:
      return buildTopicRevision;
    case TOPIC_HDBSCAN_REVISION_KEY:
      return buildHdbscanTopicRevision;
  }
};

export const createConnectionsMaterializer = (
  deps: CreateConnectionsMaterializerDeps,
): Materializer => {
  const topicRevisionStore = deps.topicRevisionStore ?? createTopicRevisionStore(deps.vaultRoot);
  const topicRevisionAlgorithm = deps.topicRevisionAlgorithm ?? TOPIC_UNION_FIND_REVISION_KEY;
  const buildSelectedTopicRevision = topicRevisionBuilderFor(topicRevisionAlgorithm);
  const engagementClassStore =
    deps.engagementClassStore ?? createEngagementClassRevisionStore(deps.vaultRoot);
  const rankerRetrainer =
    deps.rankerRetrainer ??
    ((context) => maybeRetrainClosestVisitRanker({ vaultRoot: deps.vaultRoot, ...context }));
  let pending = false;
  let running = false;
  let dirty = false;
  let lastSuccessAt: string | null = null;
  let lastError: string | null = null;
  let lastFailureAtMs = 0;

  type TimelineEntryWithDimensions = TimelineDayProjection['entries'][number] & {
    readonly dimensions?: unknown;
  };
  type TimelineDayProjectionWithDimensions = Omit<TimelineDayProjection, 'entries'> & {
    readonly entries: readonly TimelineEntryWithDimensions[];
  };

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

  const focusedWindowMsFromPayload = (
    payload: BrowserTimelineObservedPayload,
  ): number | undefined => {
    if (!isRecord(payload.dimensions)) return undefined;
    const engagement = payload.dimensions['engagement'];
    if (!isRecord(engagement)) return undefined;
    const focused = engagement['focusedWindowMs'];
    if (typeof focused !== 'number' || !Number.isFinite(focused) || focused < 0) {
      return undefined;
    }
    return focused;
  };

  const focusedWindowMsFromEntry = (entry: TimelineEntryWithDimensions): number => {
    if (!isRecord(entry.dimensions)) return 0;
    const engagement = entry.dimensions['engagement'];
    if (!isRecord(engagement)) return 0;
    const focused = engagement['focusedWindowMs'];
    if (typeof focused !== 'number' || !Number.isFinite(focused) || focused < 0) {
      return 0;
    }
    return focused;
  };

  const stripFragmentAndTrailingSlash = (url: string): string =>
    url.replace(/#.*$/u, '').replace(/\/+$/u, '');

  const topicVisitFromEntry = (entry: TimelineEntryWithDimensions): TopicVisit => {
    const canonicalUrl = stripFragmentAndTrailingSlash(entry.canonicalUrl ?? entry.url);
    return {
      canonicalUrl,
      ...(entry.title === undefined ? {} : { title: entry.title }),
      focusedWindowMs: focusedWindowMsFromEntry(entry),
      firstObservedAt: entry.firstSeenAt,
      lastObservedAt: entry.lastSeenAt,
      ...(entry.workstreamId === undefined ? {} : { workstreamId: entry.workstreamId }),
    };
  };

  // Build the per-day timeline projection in-memory directly from the
  // merged event log instead of reading the timelineStore. The
  // timeline materializer also writes the same projection to disk
  // (for GET /v1/timeline) but its drain runs concurrently with this
  // materializer's drain — reading the disk-backed store would race
  // and produce stale or partial connections snapshots when the
  // timeline materializer hasn't finished yet (most visible
  // cross-replica, where peer events arrive in bursts).
  const buildTimelineDays = (
    merged: readonly AcceptedEvent[],
  ): readonly TimelineDayProjectionWithDimensions[] => {
    const payloads = collectTimelinePayloads(
      merged.filter(
        (e) => e.type === BROWSER_TIMELINE_OBSERVED && isBrowserTimelineObservedPayload(e.payload),
      ),
    );
    const grouped = groupByDay(payloads);
    const out: TimelineDayProjectionWithDimensions[] = [];
    for (const [date, dayPayloads] of grouped) {
      const focusedByEntryId = new Map<string, number>();
      for (const payload of dayPayloads) {
        const focusedWindowMs = focusedWindowMsFromPayload(payload);
        if (focusedWindowMs === undefined) continue;
        const entryId = entryIdFor(payload);
        focusedByEntryId.set(
          entryId,
          Math.max(focusedByEntryId.get(entryId) ?? 0, focusedWindowMs),
        );
      }
      const projection = buildDayProjection(date, dayPayloads);
      const entries: TimelineEntryWithDimensions[] = projection.entries.map((entry) => {
        const focusedWindowMs = focusedByEntryId.get(entry.id);
        if (focusedWindowMs === undefined) return entry;
        return {
          ...entry,
          dimensions: { engagement: { focusedWindowMs } },
        };
      });
      out.push({ ...projection, entries });
    }
    return out;
  };

  const dimensionsWithFocusedWindowMs = (
    entry: TimelineEntryWithDimensions,
    focusedWindowMs: number,
  ): Record<string, unknown> => {
    const dimensions = isRecord(entry.dimensions) ? entry.dimensions : {};
    const engagement = isRecord(dimensions['engagement']) ? dimensions['engagement'] : {};
    return {
      ...dimensions,
      engagement: {
        ...engagement,
        focusedWindowMs,
      },
    };
  };

  const enrichTimelineDaysWithEngagement = (
    days: readonly TimelineDayProjectionWithDimensions[],
    engagementInputs: ReturnType<typeof buildEngagementClassifierInputs>,
  ): readonly TimelineDayProjectionWithDimensions[] => {
    const focusedByCanonicalUrl = new Map<string, number>();
    for (const input of engagementInputs) {
      const canonicalUrl = stripFragmentAndTrailingSlash(input.canonicalUrl);
      focusedByCanonicalUrl.set(
        canonicalUrl,
        Math.max(focusedByCanonicalUrl.get(canonicalUrl) ?? 0, input.engagement.focusedWindowMs),
      );
    }

    return days.map((day) => ({
      ...day,
      entries: day.entries.map((entry): TimelineEntryWithDimensions => {
        const canonicalUrl = stripFragmentAndTrailingSlash(entry.canonicalUrl ?? entry.url);
        const focusedWindowMs = Math.max(
          focusedWindowMsFromEntry(entry),
          focusedByCanonicalUrl.get(canonicalUrl) ?? 0,
        );
        if (focusedWindowMs <= 0) return entry;
        return {
          ...entry,
          dimensions: dimensionsWithFocusedWindowMs(entry, focusedWindowMs),
        };
      }),
    }));
  };

  const maxAcceptedAtMs = (events: readonly AcceptedEvent[]): number =>
    events.reduce((max, event) => Math.max(max, event.acceptedAtMs), 0);

  const loadClosestVisitRanker = async (): Promise<LoadedClosestVisitRanker | null> => {
    const manifest = await readActiveClosestVisitRankerRevisionManifest(deps.vaultRoot);
    if (manifest === null) return null;
    const revision = await readClosestVisitRankerRevision(deps.vaultRoot, manifest.revisionId);
    if (revision === null) return null;
    try {
      const model = await loadRankerModel(revision);
      return {
        model,
        ranker: {
          revisionId: model.revisionId,
          predict: (features) => predictRanker(features, model),
        },
      };
    } catch {
      return null;
    }
  };

  const buildAndWrite = async (): Promise<void> => {
    const merged = await deps.eventLog.readMerged();
    const vault = await readVaultStores(deps.vaultRoot);
    const rawTimelineDays = buildTimelineDays(merged);
    const engagementInputs = buildEngagementClassifierInputs(merged, rawTimelineDays);
    const engagementClassRevision = buildEngagementClassRevision(engagementInputs, {
      producedAt: maxAcceptedAtMs(merged),
    });
    await engagementClassStore.putRevision(engagementClassRevision);
    const timelineDays = enrichTimelineDaysWithEngagement(rawTimelineDays, engagementInputs);
    const visitSimilarity = await buildVisitSimilarity(
      timelineDays.flatMap((day) => day.entries),
      deps.embed ?? defaultEmbed,
    );
    await writeVisitSimilarityRevision(deps.vaultRoot, visitSimilarity);
    const previousTopicRevision = await topicRevisionStore.readActiveRevision();
    const topicRevision = await buildSelectedTopicRevision({
      visits: timelineDays.flatMap((day) => day.entries.map(topicVisitFromEntry)),
      visitSimilarity,
      ...(previousTopicRevision === null ? {} : { previousRevision: previousTopicRevision }),
    });
    await topicRevisionStore.putActiveRevision(topicRevision);
    const input: ConnectionsInput = {
      events: merged,
      ...vault,
      timelineDays,
      tabSessionProjection: projectTabSessions(merged),
      urlProjection: projectUrls(merged),
      visitSimilarity,
      topicRevision,
      engagementClassRevision,
    };
    const baseSnapshot = buildConnectionsSnapshot(input);
    await rankerRetrainer({ merged, snapshot: baseSnapshot });
    const closestVisitRanker = await loadClosestVisitRanker();
    if (closestVisitRanker === null) {
      await deps.store.putCurrent(baseSnapshot);
      return;
    }

    try {
      const snapshot = buildConnectionsSnapshot({
        ...input,
        closestVisitRanker: closestVisitRanker.ranker,
      });
      await deps.store.putCurrent(snapshot);
    } finally {
      closestVisitRanker.model.dispose();
    }
  };

  const drain = async (): Promise<void> => {
    while (dirty) {
      dirty = false;
      try {
        await buildAndWrite();
        lastSuccessAt = new Date().toISOString();
        lastError = null;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        lastFailureAtMs = Date.now();
        // Re-flag dirty so the next trigger retries; exit drain to
        // avoid tight-retry on persistent failures.
        dirty = true;
        return;
      }
    }
  };

  const requestDrain = (): void => {
    dirty = true;
    pending = true;
    if (running) return;
    // Failure cooldown gate — same pattern as timelineMaterializer.
    // catchUp bypasses this gate; onAccepted respects it.
    const sinceFailureMs = Date.now() - lastFailureAtMs;
    if (lastError !== null && sinceFailureMs < FAILURE_COOLDOWN_MS) return;
    running = true;
    void (async () => {
      try {
        await drain();
      } finally {
        running = false;
        pending = dirty;
      }
    })();
  };

  const onAccepted: Materializer['onAccepted'] = (event) => {
    if (!HANDLES.has(event.type)) return;
    requestDrain();
  };

  const catchUp: Materializer['catchUp'] = async () => {
    pending = true;
    try {
      await buildAndWrite();
      lastSuccessAt = new Date().toISOString();
      lastError = null;
      dirty = false;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      // Don't spin during catchUp — leave dirty=true so the next
      // event trigger (after cooldown) retries.
      dirty = true;
    } finally {
      pending = dirty || running;
    }
  };

  const awaitIdle: Materializer['awaitIdle'] = async () => {
    // "Idle" = no in-flight drain AND no pending retry that the
    // failure-cooldown gate isn't currently blocking. After a failed
    // drain the materializer leaves dirty=true so the NEXT trigger
    // retries; if no further trigger arrives, dirty stays true
    // forever and a naive `while (running || dirty)` would spin
    // forever even though work is permanently parked. Treat a
    // sustained failure (lastError !== null AND no in-flight drain)
    // as idle — callers checking `health()` see `status: 'failed'`
    // and can act on it.
    while (running || (dirty && lastError === null)) {
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  const health: Materializer['health'] = (): MaterializerHealth => ({
    status: lastError !== null ? 'failed' : pending ? 'degraded' : 'healthy',
    lastSuccessAt,
    lastError,
    pending,
  });

  return {
    name: 'connections',
    handles: HANDLES,
    onAccepted,
    catchUp,
    awaitIdle,
    health,
  };
};
