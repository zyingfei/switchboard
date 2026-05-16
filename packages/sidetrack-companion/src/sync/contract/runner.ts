import type { AcceptedEvent } from '../causal.js';
import type { EventLog } from '../eventLog.js';
import type { AcceptedEventContext, Materializer, MaterializerHealth } from './materializer.js';

// Sync Contract v1 — runner.
//
// Single dispatch point for every accepted event, local OR peer.
// The relay subscriber and every local appendClient* success
// callback both call `onAcceptedEvent` with the appropriate origin.
// Materializers see the same event under both origins; their
// behavior must be local-vs-peer symmetric (gate L1-G10).
//
// The runner does not own materializer state. It owns:
//   - registration
//   - dispatch
//   - startup and reconnect catch-up coordination (AWAITED)
//   - aggregated health
//
// Catch-up correctness model:
//   - At startup, runner.catchUpAll(eventLog) is AWAITED. Every
//     materializer's catchUp resolves only after its drain is
//     complete. Tests rely on this to assert "contract restored"
//     without races.
//   - On relay reconnect, runner.onRelayReconnected(eventLog) is
//     AWAITED. Each materializer's catchUp scans durable state and
//     replays missed events. Notifications between materializers
//     accelerate; correctness comes from the replay.
//
// See plan kind-prancing-river.md for the full contract.

export interface SyncContractRunner {
  readonly register: (m: Materializer) => void;
  readonly onAcceptedEvent: (event: AcceptedEvent, ctx: AcceptedEventContext) => void;
  readonly catchUpAll: (eventLog: EventLog) => Promise<void>;
  readonly onRelayReconnected: (eventLog: EventLog) => Promise<void>;
  readonly awaitIdle: () => Promise<void>;
  readonly health: () => Record<string, MaterializerHealth>;
}

export const createSyncContractRunner = (): SyncContractRunner => {
  const materializers = new Map<string, Materializer>();

  const register = (m: Materializer): void => {
    if (materializers.has(m.name)) {
      throw new Error(`SyncContractRunner: materializer '${m.name}' already registered`);
    }
    materializers.set(m.name, m);
  };

  const onAcceptedEvent = (event: AcceptedEvent, ctx: AcceptedEventContext): void => {
    for (const m of materializers.values()) {
      // Materializers MUST coalesce internally. We swallow throws so
      // one bad materializer doesn't stall the others — its health
      // updates and the runner continues. catchUp will recover on
      // next startup if the in-memory dispatch was lost.
      try {
        if (m.handles.has(event.type)) {
          m.onAccepted(event, ctx);
        }
      } catch {
        // The materializer's own try/catch should have updated
        // health. If it didn't, the failure is silent — but the
        // event is still durable in the log; catchUp recovers.
      }
    }
  };

  // Run catchUp on every materializer. AWAITS each one. If a
  // materializer throws, log + continue with others; aggregated
  // health surfaces the failure.
  const catchUpAll = async (eventLog: EventLog): Promise<void> => {
    for (const m of materializers.values()) {
      try {
        await m.catchUp(eventLog);
      } catch {
        // Materializer's own catch should have updated health. If
        // not, future events + next startup will retry.
      }
    }
  };

  // Same shape as catchUpAll. Callers signal post-reconnect drain;
  // every materializer scans durable state and replays missed work.
  const onRelayReconnected = (eventLog: EventLog): Promise<void> => catchUpAll(eventLog);

  const awaitIdle = async (): Promise<void> => {
    // Resolve when every materializer reports pending=false. Used by
    // tests; production code should not rely on this for correctness.
    for (const m of materializers.values()) {
      try {
        await m.awaitIdle();
      } catch {
        // Same swallow rationale as above.
      }
    }
  };

  const health = (): Record<string, MaterializerHealth> => {
    const out: Record<string, MaterializerHealth> = {};
    for (const [name, m] of materializers) {
      try {
        out[name] = m.health();
      } catch (err) {
        out[name] = {
          status: 'failed',
          lastSuccessAt: null,
          lastError: err instanceof Error ? err.message : `health() threw: ${String(err)}`,
          pending: false,
        };
      }
    }
    return out;
  };

  return {
    register,
    onAcceptedEvent,
    catchUpAll,
    onRelayReconnected,
    awaitIdle,
    health,
  };
};
