import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createEventLog, maxShardTailSeqForReplica } from './eventLog.js';
import { loadOrCreateReplica, replicaSeqPath, type ReplicaContext } from './replicaId.js';

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
});
