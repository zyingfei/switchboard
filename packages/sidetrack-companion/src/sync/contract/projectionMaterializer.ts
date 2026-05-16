import type { AcceptedEvent } from '../causal.js';
import type { EventLog } from '../eventLog.js';
import type { ProjectionChangeFeed } from '../projectionChanges.js';
import { runImportProjectors, runImportProjectorsFromEvents } from '../projectors.js';
import type { Materializer, MaterializerHealth } from './materializer.js';
import { eventTypesForMaterializer } from './registry.js';

// Class A materializer.
//
// Wraps the existing `runImportProjectors` dispatch. Receives every
// accepted event (local OR peer) from the contract runner, dispatches
// to the projector registry that handles the per-aggregate
// projection write.
//
// Local + peer symmetry (gate L1-G10): the projection materializer
// runs for BOTH origins. The local route's vault/writer.ts also
// writes the legacy flat-shape file; the projection materializer
// writes the projection envelope at the projection subpath. Stage
// L1.S3 separates the paths so they don't collide.
//
// Coalescing: this materializer runs synchronously per event today.
// Each event's projection is small + cheap; the dirty-bit pattern
// isn't required here. Future scaling can introduce per-aggregate
// queuing without changing the interface.
//
// catchUp: runs runImportProjectors over the merged log's latest event
// per aggregate. Idempotent (projector overwrites the file with the
// same content if nothing changed). Used at startup AND after relay
// reconnect.

export interface CreateProjectionMaterializerDeps {
  readonly vaultRoot: string;
  readonly eventLog: EventLog;
  readonly projectionChanges?: ProjectionChangeFeed;
}

export const createProjectionMaterializer = (
  deps: CreateProjectionMaterializerDeps,
): Materializer => {
  const handles = eventTypesForMaterializer('projection');

  let pending = false;
  let lastSuccessAt: string | null = null;
  let lastError: string | null = null;

  const runOne = async (event: AcceptedEvent, eventLog: EventLog): Promise<void> => {
    pending = true;
    try {
      await runImportProjectors(
        {
          vaultRoot: deps.vaultRoot,
          eventLog,
          ...(deps.projectionChanges === undefined
            ? {}
            : { projectionChanges: deps.projectionChanges }),
        },
        event,
      );
      lastSuccessAt = new Date().toISOString();
      lastError = null;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      // Failure is per-event; the event is durable in the log; next
      // catchUp recovers.
    } finally {
      pending = false;
    }
  };

  // EventLog is bound at construction time (single log per process).
  // No "boundEventLog === null" race — onAccepted always has the
  // log available.
  const onAccepted: Materializer['onAccepted'] = (event) => {
    void runOne(event, deps.eventLog);
  };

  const catchUp: Materializer['catchUp'] = async (eventLog) => {
    pending = true;
    try {
      const merged = await eventLog.readMerged();
      const byAggregate = new Map<string, AcceptedEvent[]>();
      const latest = new Map<string, AcceptedEvent>();
      for (const event of merged) {
        const aggregateEvents = byAggregate.get(event.aggregateId) ?? [];
        aggregateEvents.push(event);
        byAggregate.set(event.aggregateId, aggregateEvents);
        if (handles.has(event.type)) {
          const prior = latest.get(event.aggregateId);
          if (prior === undefined || event.acceptedAtMs >= prior.acceptedAtMs) {
            latest.set(event.aggregateId, event);
          }
        }
      }
      let projected = 0;
      for (const event of latest.values()) {
        try {
          await runImportProjectorsFromEvents(
            {
              vaultRoot: deps.vaultRoot,
              eventLog,
              ...(deps.projectionChanges === undefined
                ? {}
                : { projectionChanges: deps.projectionChanges }),
            },
            event,
            byAggregate.get(event.aggregateId) ?? [],
          );
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
        projected += 1;
        if (projected % 100 === 0) {
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
        }
      }
      lastSuccessAt = new Date().toISOString();
    } finally {
      pending = false;
    }
  };

  const awaitIdle: Materializer['awaitIdle'] = async () => {
    while (pending) {
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  const health: Materializer['health'] = (): MaterializerHealth => ({
    status: lastError !== null ? 'failed' : 'healthy',
    lastSuccessAt,
    lastError,
    pending,
  });

  return {
    name: 'projection',
    handles,
    onAccepted,
    catchUp,
    awaitIdle,
    health,
  };
};
