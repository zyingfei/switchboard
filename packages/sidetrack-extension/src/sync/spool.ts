// Sync Contract v1 / Class F — bounded local spool + state machine.
//
// State machine per item:
//
//   active ─overflow──▶ pending-send ─companion-ack──▶ evicted-after-ack
//                            │
//                            └─overflow w/o ack──▶ spooled
//                                                    │
//                                                    └─spool overflow / long-offline──▶ exported
//                                                                                          │
//                                                                                          └─companion-import──▶ companion-imported
//
//   terminal: failed-explicit (visible rejection)
//             dropped-passive-by-policy (health-visible)
//
// This module owns the durable spool state in chrome.storage. Items
// are addressable by their edgeDot so drain-to-companion can dedupe
// idempotently.

import type { EdgeReplica } from './edgeReplicaId';

export type ItemState =
  | 'active'
  | 'pending-send'
  | 'spooled'
  | 'exported'
  | 'companion-imported'
  | 'evicted-after-ack'
  | 'failed-explicit'
  | 'dropped-passive-by-policy';

export interface SpoolEntry<TPayload = unknown> {
  // The edge dot uniquely identifies the originating event. Stable
  // across re-imports + cross-companion archive imports.
  readonly edgeDot: { readonly replicaId: string; readonly seq: number };
  // Logical event identity within the originating browser. Same
  // shape as companion's clientEventId — used for dedupe before
  // the companion has stamped a dot.
  readonly clientEventId: string;
  // Surface name (matches PluginMaterializer.name).
  readonly surface: string;
  // Wire-format payload to ship to companion. Surface-specific.
  readonly payload: TPayload;
  // Current state in the machine.
  readonly state: ItemState;
  // Wall-clock for ordering + GC. Spool drains FIFO by createdAt
  // when fairness matters; archive export bundles by age.
  readonly createdAt: string;
  // The last action that produced this state (audit trail).
  readonly lastTransitionAt: string;
  // Optional reason for terminal states (failed-explicit reason
  // text, dropped-passive policy id).
  readonly reason?: string;
}

const STORAGE_KEY_PREFIX = 'sidetrack.sync.spool.';

const storageKey = (surface: string): string => `${STORAGE_KEY_PREFIX}${surface}`;

interface ChromeStorageLike {
  readonly get: (key: string) => Promise<Record<string, unknown>>;
  readonly set: (entries: Record<string, unknown>) => Promise<void>;
}

const getChromeStorage = (): ChromeStorageLike => {
  // chrome.storage.local in production; tests inject a stub via
  // globalThis.chrome before importing this module.
  const c = (globalThis as unknown as { chrome?: { storage?: { local?: ChromeStorageLike } } })
    .chrome;
  const local = c?.storage?.local;
  if (local === undefined) {
    throw new Error('chrome.storage.local is unavailable');
  }
  return local;
};

const isEntry = (value: unknown): value is SpoolEntry => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v['clientEventId'] !== 'string') return false;
  if (typeof v['surface'] !== 'string') return false;
  if (typeof v['state'] !== 'string') return false;
  return true;
};

export const readSpool = async (surface: string): Promise<readonly SpoolEntry[]> => {
  const got = await getChromeStorage().get(storageKey(surface));
  const raw = got[storageKey(surface)];
  if (!Array.isArray(raw)) return [];
  return raw.filter(isEntry);
};

export const writeSpool = async (
  surface: string,
  entries: readonly SpoolEntry[],
): Promise<void> => {
  await getChromeStorage().set({ [storageKey(surface)]: [...entries] });
};

const dotEquals = (a: SpoolEntry['edgeDot'], b: SpoolEntry['edgeDot']): boolean =>
  a.replicaId === b.replicaId && a.seq === b.seq;

// Append an entry to the spool. Idempotent on edgeDot — re-spooling
// the same dot is a no-op.
export const spoolAppend = async (
  surface: string,
  entry: SpoolEntry,
): Promise<{ added: boolean }> => {
  const existing = await readSpool(surface);
  if (existing.some((e) => dotEquals(e.edgeDot, entry.edgeDot))) {
    return { added: false };
  }
  await writeSpool(surface, [...existing, entry]);
  return { added: true };
};

export const spoolTransition = async (
  surface: string,
  edgeDot: SpoolEntry['edgeDot'],
  nextState: ItemState,
  reason?: string,
): Promise<void> => {
  const existing = await readSpool(surface);
  const updated = existing.map((entry) => {
    if (!dotEquals(entry.edgeDot, edgeDot)) return entry;
    return {
      ...entry,
      state: nextState,
      lastTransitionAt: new Date().toISOString(),
      ...(reason === undefined ? {} : { reason }),
    };
  });
  await writeSpool(surface, updated);
};

export const spoolRemove = async (
  surface: string,
  edgeDot: SpoolEntry['edgeDot'],
): Promise<void> => {
  const existing = await readSpool(surface);
  const next = existing.filter((entry) => !dotEquals(entry.edgeDot, edgeDot));
  await writeSpool(surface, next);
};

export const spoolMetrics = async (
  surface: string,
): Promise<{
  readonly total: number;
  readonly byState: Record<ItemState, number>;
}> => {
  const existing = await readSpool(surface);
  const byState: Record<ItemState, number> = {
    active: 0,
    'pending-send': 0,
    spooled: 0,
    exported: 0,
    'companion-imported': 0,
    'evicted-after-ack': 0,
    'failed-explicit': 0,
    'dropped-passive-by-policy': 0,
  };
  for (const entry of existing) {
    byState[entry.state] += 1;
  }
  return { total: existing.length, byState };
};

// Mint an outgoing edge dot for a new event using the EdgeReplica
// allocator. Caller passes an allocator function so this module
// stays decoupled from the chrome.storage-bound edgeReplicaId
// state.
export const newEdgeDot = (replica: EdgeReplica, seq: number): SpoolEntry['edgeDot'] => ({
  replicaId: replica.edgeReplicaId,
  seq,
});
