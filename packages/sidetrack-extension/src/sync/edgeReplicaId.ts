// Sync Contract v1 / Class F — edge replica identity (single-identity model).
//
// The plugin is a real edge replica with a stable `edgeReplicaId`.
// Every plugin-originated event has `dot.replicaId = edgeReplicaId`.
// Companions import edge events as peer-origin via importPeerEvent
// and do NOT restamp them — the edge dot IS the canonical event
// identity. Archive pack import is naturally idempotent because
// the same edge dots dedupe across re-imports and across companions.
//
// Bootstrap: generated once on first plugin run, persisted in
// chrome.storage.local. Backfill safe — if missing, generate +
// store on demand. Never resynced; this is identity, not state.
//
// Format: `edge_<base32(16-byte random)>`. Same shape as the
// companion's replicaId, with an `edge_` prefix for traceability
// in logs + audit.

const STORAGE_KEY = 'sidetrack.sync.edgeReplicaId';

const generateEdgeReplicaId = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // base32-ish encoding: hex is fine and shorter to read.
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `edge_${hex.slice(0, 24)}`;
};

interface EdgeReplicaState {
  readonly edgeReplicaId: string;
  // Monotonic per-edge-replica seq. Assigned to each emitted event.
  readonly nextSeq: number;
}

const isStateShape = (value: unknown): value is EdgeReplicaState => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v['edgeReplicaId'] === 'string' && typeof v['nextSeq'] === 'number';
};

const readState = async (): Promise<EdgeReplicaState | null> => {
  try {
    const got = await chrome.storage.local.get(STORAGE_KEY);
    const value = got[STORAGE_KEY];
    return isStateShape(value) ? value : null;
  } catch {
    return null;
  }
};

const writeState = async (state: EdgeReplicaState): Promise<void> => {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
};

export interface EdgeReplica {
  readonly edgeReplicaId: string;
  readonly nextSeq: number;
}

// Loads the current edge replica state, generating one on first
// call. Returns the same identity across calls within the same
// browser profile. The identity is durable: subsequent extension
// versions read the same chrome.storage key.
export const loadOrCreateEdgeReplica = async (): Promise<EdgeReplica> => {
  const existing = await readState();
  if (existing !== null) return existing;
  const fresh: EdgeReplicaState = {
    edgeReplicaId: generateEdgeReplicaId(),
    nextSeq: 1,
  };
  await writeState(fresh);
  return fresh;
};

// Allocate the next seq for an outgoing event. Persisted before the
// caller emits the event so a kill mid-flight can never re-use the
// same dot. Idempotent on re-call within the same caller batch:
// callers should `allocate(N)` for batch emits.
export const allocateNextSeq = async (
  count = 1,
): Promise<{
  readonly edgeReplicaId: string;
  readonly fromSeq: number;
  readonly toSeq: number;
}> => {
  const existing = (await readState()) ?? {
    edgeReplicaId: generateEdgeReplicaId(),
    nextSeq: 1,
  };
  const fromSeq = existing.nextSeq;
  const toSeq = existing.nextSeq + count - 1;
  await writeState({
    edgeReplicaId: existing.edgeReplicaId,
    nextSeq: existing.nextSeq + count,
  });
  return {
    edgeReplicaId: existing.edgeReplicaId,
    fromSeq,
    toSeq,
  };
};
