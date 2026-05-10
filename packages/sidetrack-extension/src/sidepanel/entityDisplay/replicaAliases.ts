// Replica alias map — turns raw `replicaId` strings (which appear in the
// timeline rail, cross-replica edges, and orbital tooltips) into stable
// human names: "This browser" for the local replica; "Browser 2",
// "Browser 3", … for remote replicas in first-seen order.
//
// Persisted to chrome.storage.local so the numbering survives panel reloads.
// First paint uses the in-memory state ({}); the helper returns "Browser"
// (no slice of the raw id) until storage hydrates. The second opinion is
// explicit: never expose any part of a raw replica id as visible text.

import { useEffect, useMemo, useState } from 'react';

export const REPLICA_ALIAS_STORAGE_KEY = 'sidetrack.replicaAliases';

interface PersistedState {
  readonly localReplicaId?: string;
  readonly aliases: Record<string, number>; // replicaId → N
}

interface StorageBackend {
  readonly get: (key: string) => Promise<Record<string, unknown>>;
  readonly set: (entries: Record<string, unknown>) => Promise<void>;
}

const getStorage = (): StorageBackend | null => {
  const c = (
    globalThis as unknown as { chrome?: { storage?: { local?: StorageBackend } } }
  ).chrome;
  return c?.storage?.local ?? null;
};

const loadPersisted = async (): Promise<PersistedState> => {
  const storage = getStorage();
  if (storage === null) return { aliases: {} };
  try {
    const got = await storage.get(REPLICA_ALIAS_STORAGE_KEY);
    const raw = got[REPLICA_ALIAS_STORAGE_KEY];
    if (raw !== null && typeof raw === 'object') {
      const candidate = raw as Partial<PersistedState>;
      const aliases: Record<string, number> = {};
      if (candidate.aliases !== undefined && typeof candidate.aliases === 'object') {
        for (const [key, value] of Object.entries(candidate.aliases)) {
          if (typeof value === 'number' && Number.isFinite(value)) aliases[key] = value;
        }
      }
      return {
        ...(typeof candidate.localReplicaId === 'string'
          ? { localReplicaId: candidate.localReplicaId }
          : {}),
        aliases,
      };
    }
  } catch {
    // ignore — storage may not be available in tests
  }
  return { aliases: {} };
};

const persistState = async (state: PersistedState): Promise<void> => {
  const storage = getStorage();
  if (storage === null) return;
  try {
    await storage.set({ [REPLICA_ALIAS_STORAGE_KEY]: state });
  } catch {
    // ignore
  }
};

export interface UseReplicaAliasInput {
  readonly localReplicaId?: string;
  readonly observedReplicaIds: readonly string[];
}

export type ReplicaAliasResolver = (replicaId: string) => string;

// Hook: returns a stable resolver function. Numbering starts at 2
// (Browser 2, Browser 3, …) so the implicit "1" is reserved for the
// local replica which always reads "This browser". Numbering is
// persisted across reloads.
export const useReplicaAliasMap = (input: UseReplicaAliasInput): ReplicaAliasResolver => {
  const [state, setState] = useState<PersistedState>({ aliases: {} });

  // Hydrate from chrome.storage on mount.
  useEffect(() => {
    let cancelled = false;
    void loadPersisted().then((loaded) => {
      if (!cancelled) setState(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Merge in newly observed replica ids + the latest localReplicaId.
  useEffect(() => {
    setState((prev) => {
      const aliases = { ...prev.aliases };
      const used = new Set<number>(Object.values(aliases));
      const allocate = (): number => {
        let n = 2;
        while (used.has(n)) n += 1;
        used.add(n);
        return n;
      };
      let changed = prev.localReplicaId !== input.localReplicaId;
      for (const id of input.observedReplicaIds) {
        if (id.length === 0) continue;
        if (id === input.localReplicaId) continue;
        if (aliases[id] === undefined) {
          aliases[id] = allocate();
          changed = true;
        }
      }
      if (!changed) return prev;
      const next: PersistedState = {
        ...(input.localReplicaId === undefined ? {} : { localReplicaId: input.localReplicaId }),
        aliases,
      };
      void persistState(next);
      return next;
    });
  }, [input.localReplicaId, input.observedReplicaIds]);

  return useMemo(() => {
    const localId = input.localReplicaId ?? state.localReplicaId;
    return (replicaId: string): string => {
      if (replicaId.length === 0) return 'Browser';
      if (localId !== undefined && replicaId === localId) return 'This browser';
      const n = state.aliases[replicaId];
      if (n !== undefined) return `Browser ${n}`;
      return 'Browser';
    };
  }, [state, input.localReplicaId]);
};
