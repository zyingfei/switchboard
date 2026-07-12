// Process-lifetime data-loss / anomaly counters for the event lane.
//
// Zero data loss was previously unfalsifiable: nothing counted the
// places where the read/write path DETECTS a torn line, an out-of-order
// shard event, a dot collision, a duplicate capture, or a shard it
// could not read. These counters make that observable. The health
// surface reads them through `getEventLaneHealth` WITHOUT importing
// eventLog / eventStore internals, so the getter is the only coupling
// point (a phase-2 agent consumes it there).
//
// Counters are module-scoped integers, incremented at the exact
// detection site. They must stay cheap — no allocation, no I/O — so the
// hot append / drain paths pay nothing beyond an integer bump. They
// carry no read/write semantics: incrementing one never changes what is
// persisted or served.

export interface EventLaneHealth {
  // A JSONL line failed to parse into a valid AcceptedEvent and was
  // skipped (torn tail from a crash without fsync, or a garbled line).
  readonly skippedMalformedLines: number;
  // The event store permanently skipped an event at or below its
  // per-replica watermark (already-committed / out-of-order redelivery).
  readonly storeSkippedOutOfOrder: number;
  // A (replicaId, seq) "dot" already existed with DIFFERENT content —
  // the causal primary key collided.
  readonly dotCollisions: number;
  // A write that would have minted a duplicate identity was refused: a
  // duplicate (replicaId, seq) dot or a reused clientEventId.
  readonly duplicateCaptures: number;
  // A shard file that EXISTS could not be read on a runtime pass
  // (EACCES/EIO/EMFILE); it was skipped for that pass without advancing
  // any durable progress.
  readonly unreadableShards: number;
}

// Mutable module-scoped state. Not exported directly — mutated only
// through the increment helpers so every call site is greppable.
const counters: {
  skippedMalformedLines: number;
  storeSkippedOutOfOrder: number;
  dotCollisions: number;
  duplicateCaptures: number;
  unreadableShards: number;
} = {
  skippedMalformedLines: 0,
  storeSkippedOutOfOrder: 0,
  dotCollisions: 0,
  duplicateCaptures: 0,
  unreadableShards: 0,
};

export const incrementSkippedMalformedLines = (by = 1): void => {
  counters.skippedMalformedLines += by;
};

export const incrementStoreSkippedOutOfOrder = (by = 1): void => {
  counters.storeSkippedOutOfOrder += by;
};

export const incrementDotCollisions = (by = 1): void => {
  counters.dotCollisions += by;
};

export const incrementDuplicateCaptures = (by = 1): void => {
  counters.duplicateCaptures += by;
};

export const incrementUnreadableShards = (by = 1): void => {
  counters.unreadableShards += by;
};

// Stable zero-arg getter for the health surface. Returns a plain snapshot
// object (copied, not the live mutable record) so a reader can't mutate
// the counters.
export const getEventLaneHealth = (): EventLaneHealth => ({
  skippedMalformedLines: counters.skippedMalformedLines,
  storeSkippedOutOfOrder: counters.storeSkippedOutOfOrder,
  dotCollisions: counters.dotCollisions,
  duplicateCaptures: counters.duplicateCaptures,
  unreadableShards: counters.unreadableShards,
});

// Test-only reset. Counters are process-lifetime, so unit tests that
// assert on a delta must start from a known baseline.
export const resetEventLaneHealthForTests = (): void => {
  counters.skippedMalformedLines = 0;
  counters.storeSkippedOutOfOrder = 0;
  counters.dotCollisions = 0;
  counters.duplicateCaptures = 0;
  counters.unreadableShards = 0;
};
