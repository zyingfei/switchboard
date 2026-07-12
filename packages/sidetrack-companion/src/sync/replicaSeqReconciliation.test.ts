import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createEventLog, maxShardTailSeqForReplica } from './eventLog.js';
import { loadOrCreateReplica, replicaSeqPath, type ReplicaContext } from './replicaId.js';

// Locate this replica's sole shard file. The tests below all append
// within a single day (one shard per day), so exactly one shard exists;
// the helper asserts that so a call site always has a defined path.
const shardDir = (vaultRoot: string, replicaId: string): string =>
  join(vaultRoot, '_BAC', 'log', replicaId);

const soleShardFor = async (vaultRoot: string, replicaId: string): Promise<string> => {
  const dir = shardDir(vaultRoot, replicaId);
  const entries = await readdir(dir);
  const shards = entries
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => join(dir, name))
    .sort();
  expect(shards.length).toBe(1);
  return shards[0] as string;
};

// F11 — reconcile the replica seq counter against shard tails at boot so
// a lost/regressed/garbled replica-seq file cannot reissue a
// (replicaId, seq) dot that already exists on disk (a duplicate causal
// primary key). Each test commits real events (so genuine shards exist
// under this replica's own dir), then corrupts the seq file and reloads,
// asserting the counter recovers ABOVE the committed shard tail.

const appendN = async (log: ReturnType<typeof createEventLog>, count: number): Promise<number> => {
  let lastSeq = 0;
  for (let i = 0; i < count; i += 1) {
    const event = await log.appendClient({
      clientEventId: `evt-${String(i)}`,
      aggregateId: 'thread-1',
      type: 'review-draft.span.added',
      payload: { spanId: `s-${String(i)}` },
      baseVector: {},
    });
    lastSeq = event.dot.seq;
  }
  return lastSeq;
};

describe('replica seq boot reconciliation against shard tails', () => {
  let vaultRoot: string;
  let replica: ReplicaContext;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-seq-reconcile-'));
    replica = await loadOrCreateReplica(vaultRoot);
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('recovers next-seq above the shard tail when the seq file is deleted', async () => {
    const log = createEventLog(vaultRoot, replica);
    const tail = await appendN(log, 5);
    expect(tail).toBe(5);

    await unlink(replicaSeqPath(vaultRoot));

    const reloaded = await loadOrCreateReplica(vaultRoot);
    expect(reloaded.peekSeq()).toBe(5);
    expect(await reloaded.nextSeq()).toBe(6);
    // The counter is re-persisted so a further reload stays honest even
    // if the shards later rotate away.
    expect((await readFile(replicaSeqPath(vaultRoot), 'utf8')).trim()).toBe('6');
  });

  it('recovers when the seq file regressed to a smaller number', async () => {
    const log = createEventLog(vaultRoot, replica);
    const tail = await appendN(log, 7);
    expect(tail).toBe(7);

    // Simulate a stale/rolled-back seq file (e.g. restored from an old
    // backup) that trails the durable shard tail.
    await writeFile(replicaSeqPath(vaultRoot), '3\n', 'utf8');

    const reloaded = await loadOrCreateReplica(vaultRoot);
    expect(reloaded.peekSeq()).toBe(7);
    expect(await reloaded.nextSeq()).toBe(8);
    expect((await readFile(replicaSeqPath(vaultRoot), 'utf8')).trim()).toBe('8');
  });

  it('recovers when the seq file content is garbled', async () => {
    const log = createEventLog(vaultRoot, replica);
    const tail = await appendN(log, 4);
    expect(tail).toBe(4);

    await writeFile(replicaSeqPath(vaultRoot), 'not-a-number\n', 'utf8');

    const reloaded = await loadOrCreateReplica(vaultRoot);
    // Without reconciliation the garbled file parses to 0 and nextSeq
    // would reissue dot seq=1, colliding with the committed shard.
    expect(reloaded.peekSeq()).toBe(4);
    expect(await reloaded.nextSeq()).toBe(5);
  });

  it('leaves fresh-replica behaviour unchanged when there are no shards', async () => {
    // No appends: the replica has no shard directory at all.
    expect(await maxShardTailSeqForReplica(vaultRoot, replica.replicaId)).toBe(0);

    const reloaded = await loadOrCreateReplica(vaultRoot);
    expect(reloaded.peekSeq()).toBe(0);
    expect(await reloaded.nextSeq()).toBe(1);
  });

  it('maxShardTailSeqForReplica ignores foreign replicas and reads only the target shard tails', async () => {
    const log = createEventLog(vaultRoot, replica);
    await appendN(log, 6);

    // A peer shard sitting in the log root must not raise (or lower) our
    // reconciliation — it is scoped to this replica's own directory.
    const peerId = '00000000-1111-4222-8333-444444444444';
    const peerDir = join(vaultRoot, '_BAC', 'log', peerId);
    await mkdir(peerDir, { recursive: true });
    const peerEvent = {
      clientEventId: 'peer-1',
      dot: { replicaId: peerId, seq: 999 },
      deps: {},
      aggregateId: 'thread-9',
      type: 'review-draft.span.added',
      payload: { spanId: 'p-1' },
      acceptedAtMs: 1_000_000,
    };
    await writeFile(join(peerDir, '2026-05-05.jsonl'), `${JSON.stringify(peerEvent)}\n`, 'utf8');

    expect(await maxShardTailSeqForReplica(vaultRoot, replica.replicaId)).toBe(6);
    expect(await maxShardTailSeqForReplica(vaultRoot, peerId)).toBe(999);
  });

  it('appendClient refuses to reuse a local dot the index already carries', async () => {
    // Lay down three genuine events (seq 1..3) with the real replica.
    const seeder = createEventLog(vaultRoot, replica);
    await appendN(seeder, 3);

    // Defense-in-depth guard: simulate a runtime-corrupted seq counter by
    // handing appendClient a context whose nextSeq() returns a seq the
    // shards ALREADY carry. Boot reconciliation prevents this in the real
    // load path; this asserts the last-line-of-defence still refuses the
    // duplicate dot rather than poisoning the causal log.
    const reusing: ReplicaContext = {
      replicaId: replica.replicaId,
      created: false,
      nextSeq: () => Promise.resolve(2), // seq 2 already exists on disk
      peekSeq: () => 3,
      observeSeq: () => Promise.resolve(),
    };
    const log = createEventLog(vaultRoot, reusing);

    await expect(
      log.appendClient({
        clientEventId: 'evt-dup-dot',
        aggregateId: 'thread-1',
        type: 'review-draft.span.added',
        payload: { spanId: 's-dup' },
        baseVector: {},
      }),
    ).rejects.toThrow(/Refusing to reuse local dot/u);
  });

  // MAJOR-1(a): a crash mid-append can tear ONLY the last line of the
  // newest shard (no fsync anywhere). Reconciliation must recover the
  // PRIOR valid line's seq by scanning backward — not under-recover to
  // null and let a subsequent append reissue an already-used seq.
  it('recovers from a torn last line in the only/newest shard (no under-recovery)', async () => {
    const log = createEventLog(vaultRoot, replica);
    const tail = await appendN(log, 4);
    expect(tail).toBe(4);

    // Simulate the correlated fault: the seq file reverts/empties AND
    // the shard's last line tears mid-write.
    const shard = await soleShardFor(vaultRoot, replica.replicaId);
    const body = await readFile(shard, 'utf8');
    const lines = body.split('\n').filter((line) => line.length > 0);
    expect(lines.length).toBe(4);
    // Append a torn (unparseable) trailing line — a half-flushed record.
    const torn = `${lines.join('\n')}\n${'{"clientEventId":"evt-4","dot":{"replicaId'}`;
    await writeFile(shard, torn, 'utf8');
    await unlink(replicaSeqPath(vaultRoot));

    // Without the backward scan, readShardTailSeq returns null → the seq
    // counter under-recovers to 0 → the next append reissues seq 4.
    expect(await maxShardTailSeqForReplica(vaultRoot, replica.replicaId)).toBe(4);

    const reloaded = await loadOrCreateReplica(vaultRoot);
    expect(reloaded.peekSeq()).toBe(4);

    // A subsequent append must NOT collide with the committed seq 4.
    const resumed = createEventLog(vaultRoot, reloaded);
    const next = await resumed.appendClient({
      clientEventId: 'evt-after-tear',
      aggregateId: 'thread-1',
      type: 'review-draft.span.added',
      payload: { spanId: 's-after' },
      baseVector: {},
    });
    expect(next.dot.seq).toBe(5);
  });

  it('appendClientObservedBatch refuses to reuse a local dot the index already carries', async () => {
    // Lay down three genuine events (seq 1..3) with the real replica.
    const seeder = createEventLog(vaultRoot, replica);
    await appendN(seeder, 3);

    // A runtime-corrupted counter that regresses to an already-committed
    // seq. The batch path mints seqs with no dedupe guard pre-fix, so it
    // would SILENTLY write a duplicate (replicaId, seq) dot — permanent
    // sync poisoning. The guard must reject it loudly instead.
    const reusing: ReplicaContext = {
      replicaId: replica.replicaId,
      created: false,
      nextSeq: () => Promise.resolve(2), // seq 2 already exists on disk
      peekSeq: () => 3,
      observeSeq: () => Promise.resolve(),
    };
    const log = createEventLog(vaultRoot, reusing);

    await expect(
      log.appendClientObservedBatch([
        {
          clientEventId: 'evt-batch-dup',
          aggregateId: 'thread-1',
          type: 'review-draft.span.added',
          payload: { spanId: 's-batch-dup' },
          baseVector: {},
        },
      ]),
    ).rejects.toThrow(/Refusing to reuse local dot/u);
  });

  it('appendClientObservedBatch refuses a duplicate seq minted twice within one batch', async () => {
    const seeder = createEventLog(vaultRoot, replica);
    await appendN(seeder, 1);

    // A regressed counter that hands out the SAME seq on consecutive
    // nextSeq() calls. The first mint (seq 5) is fresh; the second reuses
    // it. The batch-local dot set must catch the intra-batch collision.
    let calls = 0;
    const stuck: ReplicaContext = {
      replicaId: replica.replicaId,
      created: false,
      nextSeq: () => {
        calls += 1;
        return Promise.resolve(5);
      },
      peekSeq: () => 5,
      observeSeq: () => Promise.resolve(),
    };
    const log = createEventLog(vaultRoot, stuck);

    await expect(
      log.appendClientObservedBatch([
        {
          clientEventId: 'evt-intra-1',
          aggregateId: 'thread-1',
          type: 'review-draft.span.added',
          payload: { spanId: 's-i1' },
          baseVector: {},
        },
        {
          clientEventId: 'evt-intra-2',
          aggregateId: 'thread-1',
          type: 'review-draft.span.added',
          payload: { spanId: 's-i2' },
          baseVector: {},
        },
      ]),
    ).rejects.toThrow(/Refusing to reuse local dot/u);
    expect(calls).toBe(2);
  });

  // MAJOR-2: a transient per-shard read error (EACCES/EIO/EMFILE on a
  // network-mounted or iCloud-dataless vault, fd exhaustion) must NOT
  // crash boot when the seq counter is intact — the seq file is the
  // durable counter and readable shards only raise it.
  it('boot proceeds with a warning when a shard is unreadable but the seq file is intact', async () => {
    if (process.getuid?.() === 0) return; // root ignores chmod perms
    const log = createEventLog(vaultRoot, replica);
    await appendN(log, 5);
    const seqBefore = (await readFile(replicaSeqPath(vaultRoot), 'utf8')).trim();
    expect(seqBefore).toBe('5');

    const shard = await soleShardFor(vaultRoot, replica.replicaId);
    await chmod(shard, 0o000);
    try {
      // maxShardTailSeqForReplica (strict) surfaces the unreadable shard.
      await expect(
        maxShardTailSeqForReplica(vaultRoot, replica.replicaId),
      ).rejects.toThrow(/unreadable/u);

      // But boot must NOT crash: the seq file is intact, so it proceeds.
      const reloaded = await loadOrCreateReplica(vaultRoot);
      expect(reloaded.peekSeq()).toBe(5);
      expect(await reloaded.nextSeq()).toBe(6);
    } finally {
      await chmod(shard, 0o644);
    }
  });

  it('boot REFUSES with a clear message when a shard is unreadable AND the seq file is missing', async () => {
    if (process.getuid?.() === 0) return; // root ignores chmod perms
    const log = createEventLog(vaultRoot, replica);
    await appendN(log, 5);

    const shard = await soleShardFor(vaultRoot, replica.replicaId);
    await chmod(shard, 0o000);
    await unlink(replicaSeqPath(vaultRoot));
    try {
      // The counter is untrusted AND the durable tail is unverifiable —
      // advancing now could reissue a duplicate dot. Refuse with an
      // actionable message rather than a raw ENOENT/EACCES crash.
      await expect(loadOrCreateReplica(vaultRoot)).rejects.toThrow(/Refusing to start/u);
    } finally {
      await chmod(shard, 0o644);
    }
  });

  it('boot REFUSES when a shard is unreadable AND the seq file is garbled', async () => {
    if (process.getuid?.() === 0) return; // root ignores chmod perms
    const log = createEventLog(vaultRoot, replica);
    await appendN(log, 5);

    const shard = await soleShardFor(vaultRoot, replica.replicaId);
    await chmod(shard, 0o000);
    await writeFile(replicaSeqPath(vaultRoot), 'not-a-number\n', 'utf8');
    try {
      await expect(loadOrCreateReplica(vaultRoot)).rejects.toThrow(/Refusing to start/u);
    } finally {
      await chmod(shard, 0o644);
    }
  });
});
