import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Per-replica identity + per-replica monotonic seq.
//
// Each companion process owns one (replicaId, seq) pair scoped to a vault.
// The replicaId is a v4 UUID generated on first start and persisted at
// `_BAC/.config/replica-id`; resetting requires deleting the file. The seq
// counter persists at `_BAC/.config/replica-seq` and is allocated by the
// companion on event acceptance — browsers never mint seq values directly,
// so an outbox replay from a stale browser cannot collide with a newer event.
//
// `seq` is the second half of the (replicaId, seq) "dot" used for causal
// ordering — see `sync/causal.ts`. It is NOT a Lamport / HLC clock, and
// must not be compared as a scalar across replicas.

export const replicaIdPath = (vaultPath: string): string =>
  join(vaultPath, '_BAC', '.config', 'replica-id');

export const replicaSeqPath = (vaultPath: string): string =>
  join(vaultPath, '_BAC', '.config', 'replica-seq');

// Pre-causal-rename file path. Read on startup so a vault that was
// initialised under the older naming keeps its monotonic counter.
const legacyLamportPath = (vaultPath: string): string =>
  join(vaultPath, '_BAC', '.config', 'replica-lamport');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ensureConfigDir = async (vaultPath: string): Promise<void> => {
  await mkdir(join(vaultPath, '_BAC', '.config'), { recursive: true });
};

const writeAtomic = async (path: string, body: string): Promise<void> => {
  const tmp = `${path}.${String(process.pid)}.${String(Date.now())}.tmp`;
  await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
};

const readReplicaIdFile = async (path: string): Promise<string | null> => {
  try {
    const trimmed = (await readFile(path, 'utf8')).trim();
    return UUID_V4.test(trimmed) ? trimmed : null;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

const readSeqFile = async (path: string): Promise<number> => {
  try {
    const raw = (await readFile(path, 'utf8')).trim();
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return 0;
    }
    throw error;
  }
};

export interface ReplicaContext {
  readonly replicaId: string;
  // True if this call generated the id (first run); false if reused from disk.
  readonly created: boolean;
  // Allocate the next monotonic seq value, persisted to disk before
  // returning so a crash cannot hand out the same value twice.
  readonly nextSeq: () => Promise<number>;
  // Observe the high-water mark without consuming a value — for diagnostics.
  readonly peekSeq: () => number;
  // Bump our counter past a peer event's seq if needed. No-op if the
  // incoming value is lower. Used when this companion absorbs a peer
  // shard whose seq numbering ran ahead of ours.
  readonly observeSeq: (incoming: number) => Promise<void>;
}

export const loadOrCreateReplica = async (vaultPath: string): Promise<ReplicaContext> => {
  await ensureConfigDir(vaultPath);

  const idPath = replicaIdPath(vaultPath);
  const seqPath = replicaSeqPath(vaultPath);
  const legacyPath = legacyLamportPath(vaultPath);

  const existingId = await readReplicaIdFile(idPath);
  let replicaId: string;
  let created: boolean;
  if (existingId === null) {
    replicaId = randomUUID();
    await writeAtomic(idPath, `${replicaId}\n`);
    created = true;
  } else {
    replicaId = existingId;
    created = false;
  }

  // Migration path: pick the higher of the two files. If only the
  // legacy file exists, copy its value forward and delete the old one
  // so subsequent startups read only the canonical name.
  const [seqFromCanonical, seqFromLegacy] = await Promise.all([
    readSeqFile(seqPath),
    readSeqFile(legacyPath),
  ]);
  let highWaterMark = Math.max(seqFromCanonical, seqFromLegacy);
  if (seqFromLegacy > 0 && seqFromCanonical < seqFromLegacy) {
    await writeAtomic(seqPath, `${String(highWaterMark)}\n`);
  }
  if (seqFromLegacy > 0) {
    await unlink(legacyPath).catch(() => undefined);
  }

  let chain: Promise<unknown> = Promise.resolve();

  const persist = async (value: number): Promise<void> => {
    await writeAtomic(seqPath, `${String(value)}\n`);
  };

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task, task);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const nextSeq = (): Promise<number> =>
    enqueue(async () => {
      const next = highWaterMark + 1;
      await persist(next);
      highWaterMark = next;
      return next;
    });

  const peekSeq = (): number => highWaterMark;

  const observeSeq = (incoming: number): Promise<void> =>
    enqueue(async () => {
      if (!Number.isFinite(incoming) || incoming <= highWaterMark) {
        return;
      }
      await persist(incoming);
      highWaterMark = incoming;
    });

  return {
    replicaId,
    created,
    nextSeq,
    peekSeq,
    observeSeq,
  };
};
