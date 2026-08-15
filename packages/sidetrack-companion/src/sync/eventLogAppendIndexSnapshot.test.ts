// Persisted append-index snapshot: a fresh eventLog instance must answer
// identity questions (dedupe, dot-free, aggregate frontier) from the
// snapshot + per-shard tail delta EXACTLY as a full warm would. A wrong
// absence here mints a duplicate dot and poisons sync, so the round-trip
// is tested end-to-end through real appends, not by poking the maps.
import { mkdtemp, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createEventLog } from './eventLog.js';
import { loadOrCreateReplica } from './replicaId.js';
import type { ReplicaContext } from './replicaId.js';

const snapshotPath = (vaultRoot: string): string =>
  join(vaultRoot, '_BAC', 'system', 'append-index-cache.json');

const waitForSnapshot = async (vaultRoot: string): Promise<void> => {
  for (let i = 0; i < 200; i += 1) {
    try {
      await stat(snapshotPath(vaultRoot));
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error('append-index snapshot was not written');
};

describe('append-index snapshot', () => {
  let vaultRoot: string;
  let replica: ReplicaContext;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-append-idx-snap-'));
    replica = await loadOrCreateReplica(vaultRoot);
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  const appendN = async (
    log: ReturnType<typeof createEventLog>,
    from: number,
    to: number,
  ): Promise<void> => {
    for (let i = from; i <= to; i += 1) {
      await log.appendClient({
        clientEventId: `evt-${String(i)}`,
        aggregateId: `agg-${String(i % 3)}`,
        type: 'review-draft.span.added',
        payload: { i },
        baseVector: {},
      });
    }
  };

  it('round-trip: fresh instance dedupes and continues seq from snapshot + tail', async () => {
    const first = createEventLog(vaultRoot, replica);
    await appendN(first, 1, 20);
    await waitForSnapshot(vaultRoot);
    // Events appended AFTER the snapshot exist only in the shard tail.
    await appendN(first, 21, 30);

    const second = createEventLog(vaultRoot, replica);
    // Dedupe: a retried clientEventId from the SNAPSHOT-covered prefix
    // must return the original dot, not mint a new one.
    const dup = await second.appendClient({
      clientEventId: 'evt-5',
      aggregateId: 'agg-2',
      type: 'review-draft.span.added',
      payload: { i: 5 },
      baseVector: {},
    });
    expect(dup.dot.seq).toBe(5);
    // Dedupe from the TAIL beyond the snapshot's byte coverage.
    const dupTail = await second.appendClient({
      clientEventId: 'evt-25',
      aggregateId: 'agg-1',
      type: 'review-draft.span.added',
      payload: { i: 25 },
      baseVector: {},
    });
    expect(dupTail.dot.seq).toBe(25);
    // A genuinely new append continues the dot sequence past the tail.
    const fresh = await second.appendClient({
      clientEventId: 'evt-31',
      aggregateId: 'agg-1',
      type: 'review-draft.span.added',
      payload: { i: 31 },
      baseVector: {},
    });
    expect(fresh.dot.seq).toBe(31);
    // The log itself carries exactly 31 events — no duplicates.
    const merged = await second.readMerged();
    expect(merged.length).toBe(31);
  });

  it('rejects a snapshot whose shard shrank (rewrite) instead of trusting its stale claims', async () => {
    const first = createEventLog(vaultRoot, replica);
    await appendN(first, 1, 10);
    await waitForSnapshot(vaultRoot);
    // Drop the first-append snapshot (near-empty coverage) so the second
    // instance's full warm publishes one covering all 10 events.
    await rm(snapshotPath(vaultRoot), { force: true });
    const second = createEventLog(vaultRoot, replica);
    await appendN(second, 11, 11);
    await waitForSnapshot(vaultRoot);
    const snapshotBody = await readFile(snapshotPath(vaultRoot), 'utf8');
    expect(snapshotBody.includes('evt-7')).toBe(true);

    // Simulate an out-of-band rewrite: truncate the shard below the
    // snapshot's recorded size. The loader must fall back to the full
    // warm (which sees the truncated log as-is).
    const logDir = join(vaultRoot, '_BAC', 'log', replica.replicaId);
    const { readdir } = await import('node:fs/promises');
    const shard = join(logDir, (await readdir(logDir)).filter((f) => f.endsWith('.jsonl'))[0]!);
    const text = await readFile(shard, 'utf8');
    const lines = text.split('\n').filter((line) => line.length > 0);
    const keep = `${lines.slice(0, 6).join('\n')}\n`;
    await truncate(shard, 0);
    await writeFile(shard, keep, 'utf8');

    const third = createEventLog(vaultRoot, replica);
    // evt-7's line was truncated away. A STALE-ACCEPTED snapshot would
    // dedupe this retry to the old dot (seq 7); the rejected-snapshot
    // full warm sees no evt-7 and must mint a FRESH dot instead (the
    // replica's persisted counter never reuses seqs, so it is > 11).
    const seven = await third.appendClient({
      clientEventId: 'evt-7',
      aggregateId: 'agg-0',
      type: 'review-draft.span.added',
      payload: { i: 7 },
      baseVector: {},
    });
    expect(seven.dot.seq).not.toBe(7);
    expect(seven.dot.seq).toBeGreaterThan(11);
    const merged = await third.readMerged();
    expect(merged.length).toBe(7);
  });
});
