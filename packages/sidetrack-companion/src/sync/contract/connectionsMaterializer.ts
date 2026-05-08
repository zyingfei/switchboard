import {
  ANNOTATION_CREATED,
  ANNOTATION_DELETED,
  ANNOTATION_NOTE_SET,
} from '../../annotations/events.js';
import { readAllTimelineDays, readVaultStores } from '../../connections/loader.js';
import {
  buildConnectionsSnapshot,
  type ConnectionsInput,
} from '../../connections/snapshot.js';
import type { ConnectionsStore } from '../../connections/snapshot.js';
import { DISPATCH_LINKED, DISPATCH_RECORDED } from '../../dispatches/events.js';
import { QUEUE_CREATED, QUEUE_STATUS_SET } from '../../queue/events.js';
import { CAPTURE_RECORDED, RECALL_TOMBSTONE_TARGET } from '../../recall/events.js';
import { CAPTURE_EXTRACTION_PRODUCED } from '../../recall/extraction/events.js';
import {
  THREAD_ARCHIVED,
  THREAD_DELETED,
  THREAD_UNARCHIVED,
  THREAD_UPSERTED,
} from '../../threads/events.js';
import type { TimelineStore } from '../../timeline/projection.js';
import {
  WORKSTREAM_DELETED,
  WORKSTREAM_UPSERTED,
} from '../../workstreams/events.js';
import type { EventLog } from '../eventLog.js';
import type { Materializer, MaterializerHealth } from './materializer.js';

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
  // Timeline observations indirectly contribute (timeline visits
  // become nodes; same canonicalUrl produces edges to threads).
  // Including the event type here keeps freshness bound to the
  // arrival of the underlying observation, even though the
  // materializer reads the daily projection rather than the
  // event payload directly.
  'browser.timeline.observed',
]);

export interface CreateConnectionsMaterializerDeps {
  readonly vaultRoot: string;
  readonly eventLog: EventLog;
  readonly timelineStore: TimelineStore;
  readonly store: ConnectionsStore;
}

export const createConnectionsMaterializer = (
  deps: CreateConnectionsMaterializerDeps,
): Materializer => {
  let pending = false;
  let running = false;
  let dirty = false;
  let lastSuccessAt: string | null = null;
  let lastError: string | null = null;
  let lastFailureAtMs = 0;

  const buildAndWrite = async (): Promise<void> => {
    const merged = await deps.eventLog.readMerged();
    const vault = await readVaultStores(deps.vaultRoot);
    const timelineDays = await readAllTimelineDays(deps.timelineStore);
    const input: ConnectionsInput = {
      events: merged,
      ...vault,
      timelineDays,
    };
    const snapshot = buildConnectionsSnapshot(input);
    await deps.store.putCurrent(snapshot);
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

  const onAccepted: Materializer['onAccepted'] = (event, _ctx) => {
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
