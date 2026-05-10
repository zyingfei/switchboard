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
const KNOWN_REPLICAS_PATH_SEGMENTS = ['_BAC', '.config', 'known-replicas.json'];
const knownPath = (vaultPath) => join(vaultPath, ...KNOWN_REPLICAS_PATH_SEGMENTS);
const writeAtomic = async (path, body) => {
    const tmp = `${path}.${String(process.pid)}.${String(Date.now())}.tmp`;
    await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, path);
};
const readKnownFile = async (path) => {
    try {
        const raw = await readFile(path, 'utf8');
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
            return {};
        const out = {};
        for (const [replicaId, value] of Object.entries(parsed)) {
            if (typeof value !== 'object' || value === null)
                continue;
            const v = value;
            if (typeof v['publicKey'] !== 'string' || typeof v['approvedAt'] !== 'string')
                continue;
            const record = {
                publicKey: v['publicKey'],
                approvedAt: v['approvedAt'],
                ...(typeof v['label'] === 'string' ? { label: v['label'] } : {}),
                ...(typeof v['lastSeenAt'] === 'string' ? { lastSeenAt: v['lastSeenAt'] } : {}),
                ...(typeof v['revokedAt'] === 'string' ? { revokedAt: v['revokedAt'] } : {}),
            };
            out[replicaId] = record;
        }
        return out;
    }
    catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
            return {};
        throw error;
    }
};
export const createKnownReplicasStore = (vaultPath) => {
    let cache = null;
    let chain = Promise.resolve();
    const enqueue = (task) => {
        const next = chain.then(task, task);
        chain = next.then(() => undefined, () => undefined);
        return next;
    };
    const ensureLoaded = async () => {
        if (cache !== null)
            return cache;
        cache = await readKnownFile(knownPath(vaultPath));
        return cache;
    };
    const persist = async (next) => {
        cache = next;
        await mkdir(join(vaultPath, '_BAC', '.config'), { recursive: true });
        await writeAtomic(knownPath(vaultPath), `${JSON.stringify(next, null, 2)}\n`);
    };
    const snapshot = async () => {
        const known = await ensureLoaded();
        return { ...known };
    };
    const admit = (replicaId, publicKeyBase64Url, now = () => new Date()) => enqueue(async () => {
        const known = await ensureLoaded();
        const existing = known[replicaId];
        if (existing === undefined) {
            // Trust-on-first-use: record the public key and accept.
            const nowIso = now().toISOString();
            const record = {
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
        const refreshed = {
            ...existing,
            lastSeenAt: now().toISOString(),
        };
        await persist({ ...known, [replicaId]: refreshed });
        return { kind: 'accept', record: refreshed, fresh: false };
    });
    const revoke = (replicaId, now = () => new Date()) => enqueue(async () => {
        const known = await ensureLoaded();
        const existing = known[replicaId];
        if (existing === undefined)
            return;
        const next = {
            ...known,
            [replicaId]: { ...existing, revokedAt: now().toISOString() },
        };
        await persist(next);
    });
    const setLabel = (replicaId, label) => enqueue(async () => {
        const known = await ensureLoaded();
        const existing = known[replicaId];
        if (existing === undefined)
            return;
        const next = {
            ...known,
            [replicaId]: { ...existing, label },
        };
        await persist(next);
    });
    return { snapshot, admit, revoke, setLabel };
};
//# sourceMappingURL=knownReplicas.js.map