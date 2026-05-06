import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Trust-on-first-use registry of peer replicas allowed to publish
// events under our rendezvous. Stored at
// `_BAC/.config/known-replicas.json`:
//
//   {
//     "<replicaId>": {
//       "publicKey": "<base64url Ed25519 pubkey>",
//       "label": "Yingfei's laptop",      // optional, set in UI
//       "approvedAt": "ISO ts",
//       "lastSeenAt": "ISO ts",
//       "revokedAt": "ISO ts" | undefined
//     },
//     ...
//   }
//
// Verification rule (see `relayTransport.ts`):
//   - replicaId not in store          -> auto-record (TOFU); accept
//   - present + same publicKey        -> accept
//   - present + DIFFERENT publicKey   -> reject hard (key rotation
//                                       must go through user-driven
//                                       approval, not silent swap)
//   - present + revokedAt set         -> reject hard
//
// TOFU is the right default for the self-hosted relay binary plus
// a household-size set of devices. A future hosted relay will swap
// the auto-record path for an explicit "approve replica X?" prompt
// in the side panel.

const KNOWN_REPLICAS_PATH_SEGMENTS = ['_BAC', '.config', 'known-replicas.json'] as const;

export interface KnownReplicaRecord {
  readonly publicKey: string; // base64url, 32 bytes raw Ed25519
  readonly label?: string;
  readonly approvedAt: string;
  readonly lastSeenAt?: string;
  readonly revokedAt?: string;
}

export type KnownReplicas = Readonly<Record<string, KnownReplicaRecord>>;

export type AdmitDecision =
  | { readonly kind: 'accept'; readonly record: KnownReplicaRecord; readonly fresh: boolean }
  | { readonly kind: 'reject-key-mismatch'; readonly storedPublicKey: string }
  | { readonly kind: 'reject-revoked'; readonly revokedAt: string };

export interface KnownReplicasStore {
  readonly snapshot: () => Promise<KnownReplicas>;
  // Decide whether to admit a peer replica. On the trust-on-first-
  // use path, the public key is recorded and the call resolves to
  // `accept(fresh: true)`. On replays of an already-known replica
  // with the same key, `accept(fresh: false)`. Mismatched keys or
  // revoked records reject; the caller drops the event.
  readonly admit: (
    replicaId: string,
    publicKeyBase64Url: string,
    now?: () => Date,
  ) => Promise<AdmitDecision>;
  readonly revoke: (replicaId: string, now?: () => Date) => Promise<void>;
  readonly setLabel: (replicaId: string, label: string) => Promise<void>;
}

const knownPath = (vaultPath: string): string => join(vaultPath, ...KNOWN_REPLICAS_PATH_SEGMENTS);

const writeAtomic = async (path: string, body: string): Promise<void> => {
  const tmp = `${path}.${String(process.pid)}.${String(Date.now())}.tmp`;
  await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
};

const readKnownFile = async (path: string): Promise<KnownReplicas> => {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, KnownReplicaRecord> = {};
    for (const [replicaId, value] of Object.entries(parsed)) {
      if (typeof value !== 'object' || value === null) continue;
      const v = value as Record<string, unknown>;
      if (typeof v['publicKey'] !== 'string' || typeof v['approvedAt'] !== 'string') continue;
      const record: KnownReplicaRecord = {
        publicKey: v['publicKey'],
        approvedAt: v['approvedAt'],
        ...(typeof v['label'] === 'string' ? { label: v['label'] } : {}),
        ...(typeof v['lastSeenAt'] === 'string' ? { lastSeenAt: v['lastSeenAt'] } : {}),
        ...(typeof v['revokedAt'] === 'string' ? { revokedAt: v['revokedAt'] } : {}),
      };
      out[replicaId] = record;
    }
    return out;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {};
    throw error;
  }
};

export const createKnownReplicasStore = (vaultPath: string): KnownReplicasStore => {
  let cache: KnownReplicas | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task, task);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const ensureLoaded = async (): Promise<KnownReplicas> => {
    if (cache !== null) return cache;
    cache = await readKnownFile(knownPath(vaultPath));
    return cache;
  };

  const persist = async (next: KnownReplicas): Promise<void> => {
    cache = next;
    await mkdir(join(vaultPath, '_BAC', '.config'), { recursive: true });
    await writeAtomic(knownPath(vaultPath), `${JSON.stringify(next, null, 2)}\n`);
  };

  const snapshot = async (): Promise<KnownReplicas> => {
    const known = await ensureLoaded();
    return { ...known };
  };

  const admit = (
    replicaId: string,
    publicKeyBase64Url: string,
    now: () => Date = () => new Date(),
  ): Promise<AdmitDecision> =>
    enqueue(async () => {
      const known = await ensureLoaded();
      const existing = known[replicaId];
      if (existing === undefined) {
        // Trust-on-first-use: record the public key and accept.
        const nowIso = now().toISOString();
        const record: KnownReplicaRecord = {
          publicKey: publicKeyBase64Url,
          approvedAt: nowIso,
          lastSeenAt: nowIso,
        };
        await persist({ ...known, [replicaId]: record });
        return { kind: 'accept', record, fresh: true };
      }
      if (existing.revokedAt !== undefined) {
        return { kind: 'reject-revoked', revokedAt: existing.revokedAt };
      }
      if (existing.publicKey !== publicKeyBase64Url) {
        return { kind: 'reject-key-mismatch', storedPublicKey: existing.publicKey };
      }
      // Same key: refresh lastSeenAt and accept.
      const refreshed: KnownReplicaRecord = {
        ...existing,
        lastSeenAt: now().toISOString(),
      };
      await persist({ ...known, [replicaId]: refreshed });
      return { kind: 'accept', record: refreshed, fresh: false };
    });

  const revoke = (replicaId: string, now: () => Date = () => new Date()): Promise<void> =>
    enqueue(async () => {
      const known = await ensureLoaded();
      const existing = known[replicaId];
      if (existing === undefined) return;
      const next: KnownReplicas = {
        ...known,
        [replicaId]: { ...existing, revokedAt: now().toISOString() },
      };
      await persist(next);
    });

  const setLabel = (replicaId: string, label: string): Promise<void> =>
    enqueue(async () => {
      const known = await ensureLoaded();
      const existing = known[replicaId];
      if (existing === undefined) return;
      const next: KnownReplicas = {
        ...known,
        [replicaId]: { ...existing, label },
      };
      await persist(next);
    });

  return { snapshot, admit, revoke, setLabel };
};
