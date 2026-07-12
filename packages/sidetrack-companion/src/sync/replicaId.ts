import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { writeFileAtomic } from '../vault/atomic.js';
import { reconcileShardTailSeqForReplica } from './eventLog.js';

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

// `intact` is true only when the file existed AND parsed to a valid
// non-negative counter. A missing (ENOENT) or garbled/negative file
// yields `{ value: 0, intact: false }` — the caller must NOT treat that
// zero as a trusted high-water mark when a shard tail is also
// unverifiable (that pairing is exactly the correlated fault that could
// reissue a duplicate dot).
interface SeqFileState {
  readonly value: number;
  readonly intact: boolean;
}

const readSeqFile = async (path: string): Promise<SeqFileState> => {
  try {
    const raw = (await readFile(path, 'utf8')).trim();
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value >= 0
      ? { value, intact: true }
      : { value: 0, intact: false };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { value: 0, intact: false };
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
    await writeFileAtomic(idPath, `${replicaId}\n`);
    created = true;
  } else {
    replicaId = existingId;
    created = false;
  }

  // Migration path: pick the higher of the two files. If only the
  // legacy file exists, copy its value forward and delete the old one
  // so subsequent startups read only the canonical name.
  const [canonical, legacy] = await Promise.all([
    readSeqFile(seqPath),
    readSeqFile(legacyPath),
  ]);
  // Reconcile the seq counter against the durable shard tails before
  // trusting the seq file. A lost, regressed, or garbled `replica-seq`
  // file would otherwise let nextSeq() reissue a (replicaId, seq) dot
  // that already exists on disk — a duplicate causal-log primary key
  // that appendClient's clientEventId-only dedupe cannot catch. The
  // shard high-water mark is bounded work (this replica's own shard
  // tails only) and is the source of truth for what we have committed.
  const { maxSeq: seqFromShards, unreadableShards } =
    await reconcileShardTailSeqForReplica(vaultPath, replicaId);

  // A shard that EXISTS but could not be read (network-mounted or
  // iCloud-dataless vault, fd exhaustion, a transient permissions glitch
  // on ONE shard) may hide a higher committed seq than the readable
  // shards revealed. Deciding what to trust:
  //   • Seq file intact → proceed with the seq-file value (it is the
  //     durable counter; the readable-shard max only ever RAISES it).
  //     Emit a loud warning so the operator knows a shard was skipped.
  //   • Seq file missing/garbled AND a shard is unreadable → the
  //     counter is untrusted and the durable truth is unverifiable.
  //     Refuse startup rather than silently advancing past an
  //     unverifiable tail (which could reissue a duplicate dot). This
  //     matches the safety property: never advance past an unverifiable
  //     shard tail when the counter is untrusted.
  const counterIntact = canonical.intact || legacy.intact;
  if (unreadableShards.length > 0 && !counterIntact) {
    const list = unreadableShards.join(', ');
    throw new Error(
      `Refusing to start: the replica-seq counter for ${replicaId} is missing or ` +
        `unreadable AND ${String(unreadableShards.length)} event-log shard tail(s) ` +
        `could not be read (${list}). Advancing the seq counter now could reissue a ` +
        `duplicate (replicaId, seq) dot and poison sync. Restore access to the vault ` +
        `shards (check that the network/iCloud vault is fully materialised and ` +
        `readable) and restart, or repair/restore the replica-seq file to its last ` +
        `known-good value.`,
    );
  }
  if (unreadableShards.length > 0) {
    // eslint-disable-next-line no-console -- boot-time durability warning, must be visible in logs
    console.warn(
      `[replicaId] ${String(unreadableShards.length)} event-log shard tail(s) for ${replicaId} ` +
        `could not be read (${unreadableShards.join(', ')}); proceeding with the intact ` +
        `replica-seq counter. If a shard hid a higher committed seq than the counter, ` +
        `restore shard access and restart before appending.`,
    );
  }

  let highWaterMark = Math.max(canonical.value, legacy.value, seqFromShards);
  if (highWaterMark > canonical.value) {
    await writeFileAtomic(seqPath, `${String(highWaterMark)}\n`);
  }
  if (legacy.value > 0) {
    await unlink(legacyPath).catch(() => undefined);
  }

  let chain: Promise<unknown> = Promise.resolve();

  const persist = async (value: number): Promise<void> => {
    await writeFileAtomic(seqPath, `${String(value)}\n`);
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
