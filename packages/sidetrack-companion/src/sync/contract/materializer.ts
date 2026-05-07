import type { AcceptedEvent, VersionVector } from '../causal.js';
import type { EventLog } from '../eventLog.js';

// Sync Contract v1 — Materializer interface.
//
// A Materializer owns a derived surface (Class A projection, Class B
// derived cache, Class E extraction revisions, …). The contract runner
// dispatches every accepted event (local OR peer) to every registered
// materializer; the materializer decides whether the event affects its
// surface and, if so, schedules an internal refresh.
//
// Required properties (asserted by tests):
//
//   1. Idempotent. `onAccepted(e)` followed by `catchUp(log)` produces
//      the same final state as `catchUp(log)` alone.
//
//   2. Coalesced. A burst of N events for the same materializer
//      schedules at most one in-flight worker (dirty-bit pattern).
//
//   3. Replayable. Materializer state is a pure function of the event
//      log + the materializer's own durable state. No state lives in
//      memory only; a process crash followed by `catchUp` reconstructs
//      everything.
//
//   4. Independently failing. A throw in `onAccepted` or `catchUp`
//      updates `health.status` and `lastError` but never bubbles into
//      other materializers.
//
//   5. Health-visible. `health()` is consumed by /v1/system/health.
//
//   6. Local-vs-peer symmetric. `onAccepted` produces the same
//      observable derived state regardless of `ctx.origin`. A
//      materializer MAY no-op for `origin: 'local'` if another path
//      already wrote the surface (e.g. local route writes a flat-shape
//      file via vault/writer.ts), but the choice must be explicit and
//      tested (gate L1-G10).
//
//   7. Startup + reconnect AWAIT drain. The runner's `catchUpAll` and
//      `onRelayReconnected` AWAIT each materializer's `catchUp`. A
//      fire-and-forget `catchUp` is forbidden — startup tests rely on
//      AWAITED resolution to assert "contract restored."
//
//   8. Callback-independent correctness. If a materializer notifies a
//      consumer materializer (e.g. extraction → recall), the consumer
//      MUST also independently scan durable state in `catchUp`. A
//      missed in-memory notification across a crash is recoverable
//      via replay, never via "we'll call you next time" semantics.

export interface MaterializerHealth {
  readonly status: 'healthy' | 'degraded' | 'failed';
  readonly lastSuccessAt: string | null;
  readonly lastError: string | null;
  // True while a worker is in-flight OR a coalesced re-run is queued.
  readonly pending: boolean;
  // Optional per-replica progress bound. Populated by materializers
  // that track a frontier (e.g., recall ingestor).
  readonly frontier?: VersionVector;
}

export interface AcceptedEventContext {
  readonly origin: 'local' | 'peer';
}

export interface Materializer {
  // Stable identifier; matches `materializer` field in the contract
  // registry. Used for /v1/system/health keys and registry coverage
  // assertions.
  readonly name: string;

  // Set of event types this materializer reacts to. Empty set means
  // "passive" — the materializer participates only via `catchUp`.
  readonly handles: ReadonlySet<string>;

  // Dispatched per accepted event. MUST coalesce internally; returns
  // synchronously. If the event is in `handles`, schedule a refresh;
  // otherwise no-op.
  readonly onAccepted: (event: AcceptedEvent, ctx: AcceptedEventContext) => void;

  // Replay-from-log. RESOLVES ONLY AFTER current drain is complete.
  // Materializers that depend on other materializers' durable state
  // (e.g. recall reads extraction store) MUST scan that state here —
  // never rely on a notification callback that may have been missed.
  readonly catchUp: (eventLog: EventLog) => Promise<void>;

  // Test/debug seam: wait for any in-flight + queued work to drain.
  // Resolves when `pending` would be false.
  readonly awaitIdle: () => Promise<void>;

  readonly health: () => MaterializerHealth;
}
