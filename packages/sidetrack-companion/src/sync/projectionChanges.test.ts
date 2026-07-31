import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createProjectionChangeFeed,
  rotatedLogPath,
  SYNC_CHANGELOG_MAX_BYTES_DEFAULT,
  syncChangelogMaxBytes,
} from './projectionChanges.js';

describe('projection change feed', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-changes-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('appendChange increments seq monotonically and survives reload', async () => {
    const feed = createProjectionChangeFeed(vaultRoot);
    const a = await feed.appendChange({
      aggregate: 'review-draft',
      aggregateId: 't-1',
      relPath: '_BAC/review-drafts/t-1.json',
      vector: { A: 1 },
      kind: 'upsert',
    });
    const b = await feed.appendChange({
      aggregate: 'review-draft',
      aggregateId: 't-2',
      relPath: '_BAC/review-drafts/t-2.json',
      vector: { A: 2 },
      kind: 'upsert',
    });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);

    const reloaded = createProjectionChangeFeed(vaultRoot);
    const c = await reloaded.appendChange({
      aggregate: 'review-draft',
      aggregateId: 't-3',
      relPath: '_BAC/review-drafts/t-3.json',
      vector: { A: 3 },
      kind: 'upsert',
    });
    expect(c.seq).toBe(3);
  });

  it('readSince returns only changes with seq > sinceSeq, sorted, with cursor', async () => {
    const feed = createProjectionChangeFeed(vaultRoot);
    for (let i = 0; i < 5; i += 1) {
      await feed.appendChange({
        aggregate: 'review-draft',
        aggregateId: `t-${String(i)}`,
        relPath: `_BAC/review-drafts/t-${String(i)}.json`,
        vector: { A: i },
        kind: 'upsert',
      });
    }
    const all = await feed.readSince(0);
    expect(all.cursor).toBe(5);
    expect(all.changed.map((c) => c.aggregateId)).toEqual(['t-0', 't-1', 't-2', 't-3', 't-4']);

    const tail = await feed.readSince(3);
    expect(tail.changed.map((c) => c.seq)).toEqual([4, 5]);
    expect(tail.cursor).toBe(5);
  });

  it('cursor resume parses only newly appended lines on a steady-state poll', async () => {
    const feed = createProjectionChangeFeed(vaultRoot);
    const append = (i: number) =>
      feed.appendChange({
        aggregate: 'review-draft',
        aggregateId: `t-${String(i)}`,
        relPath: `_BAC/review-drafts/t-${String(i)}.json`,
        vector: { A: i },
        kind: 'upsert',
      });

    // Seed 4 changes, poll from 0 (full scan of 4 lines).
    for (let i = 1; i <= 4; i += 1) await append(i);
    const first = await feed.readSince(0);
    expect(first.cursor).toBe(4);
    expect(first.changed.map((c) => c.seq)).toEqual([1, 2, 3, 4]);
    const afterFirst = feed.__parsedLineCount();
    expect(afterFirst).toBe(4);

    // Append 2 more, poll resuming from the cursor we were just handed.
    // Only the 2 appended lines should be parsed — NOT the whole history.
    await append(5);
    await append(6);
    const second = await feed.readSince(first.cursor);
    expect(second.cursor).toBe(6);
    expect(second.changed.map((c) => c.seq)).toEqual([5, 6]);
    expect(feed.__parsedLineCount() - afterFirst).toBe(2);

    // A no-op poll from the latest cursor parses nothing at all.
    const third = await feed.readSince(second.cursor);
    expect(third.changed).toEqual([]);
    expect(feed.__parsedLineCount() - afterFirst).toBe(2);
  });

  it('cursor resume still serves an OLDER cursor via a full re-scan', async () => {
    const feed = createProjectionChangeFeed(vaultRoot);
    for (let i = 1; i <= 3; i += 1) {
      await feed.appendChange({
        aggregate: 'review-draft',
        aggregateId: `t-${String(i)}`,
        relPath: `_BAC/review-drafts/t-${String(i)}.json`,
        vector: { A: i },
        kind: 'upsert',
      });
    }
    // Advance the checkpoint to seq 3.
    await feed.readSince(0);
    // A resume from an OLDER cursor (below maxScannedSeq) must fall back
    // to a full scan and still return the correct tail.
    const older = await feed.readSince(1);
    expect(older.changed.map((c) => c.seq)).toEqual([2, 3]);
  });

  it('readSince on a missing log returns the current cursor and empty list', async () => {
    const feed = createProjectionChangeFeed(vaultRoot);
    const result = await feed.readSince(0);
    expect(result.cursor).toBe(0);
    expect(result.changed).toEqual([]);
  });

  it('skips malformed JSONL rows without throwing', async () => {
    // Seed the log with a mix of malformed lines and one valid row.
    await mkdir(join(vaultRoot, '_BAC', '.sync'), { recursive: true });
    await writeFile(
      join(vaultRoot, '_BAC', '.sync', 'projection-changes.jsonl'),
      '{"valid":false}\nnot-json\n' +
        JSON.stringify({
          seq: 7,
          aggregate: 'review-draft',
          aggregateId: 't-x',
          relPath: 'foo',
          vector: {},
          kind: 'upsert',
          localWrittenAtMs: 0,
        }) +
        '\n',
      'utf8',
    );
    const feed = createProjectionChangeFeed(vaultRoot);
    const result = await feed.readSince(0);
    expect(result.changed.map((c) => c.seq)).toEqual([7]);
  });

  it('recovers the next seq from the log when the seq file is stale', async () => {
    await mkdir(join(vaultRoot, '_BAC', '.sync'), { recursive: true });
    await writeFile(join(vaultRoot, '_BAC', '.sync', 'projection-changes-seq'), '2\n', 'utf8');
    await writeFile(
      join(vaultRoot, '_BAC', '.sync', 'projection-changes.jsonl'),
      `${JSON.stringify({
        seq: 9,
        aggregate: 'review-draft',
        aggregateId: 't-existing',
        relPath: '_BAC/review-drafts/t-existing.json',
        vector: { A: 9 },
        kind: 'upsert',
        localWrittenAtMs: 0,
      })}\n`,
      'utf8',
    );

    const feed = createProjectionChangeFeed(vaultRoot);
    const next = await feed.appendChange({
      aggregate: 'review-draft',
      aggregateId: 't-next',
      relPath: '_BAC/review-drafts/t-next.json',
      vector: { A: 10 },
      kind: 'upsert',
    });
    const changes = await feed.readSince(8);

    expect(next.seq).toBe(10);
    expect(changes.changed.map((change) => change.seq)).toEqual([9, 10]);
  });

  // -------------------------------------------------------------------------
  // ROTATION (2026-07-29). The feed reached 98.6 MB on the dogfood vault with
  // no retention at all. It now rotates at a byte cap keeping ONE prior
  // generation the reader still reads. Three things must not break: the seq
  // high-water, the byte checkpoint, and gap honesty.
  // -------------------------------------------------------------------------

  const append = async (
    feed: ReturnType<typeof createProjectionChangeFeed>,
    id: string,
  ): Promise<number> =>
    (
      await feed.appendChange({
        aggregate: 'review-draft',
        aggregateId: id,
        // Pad the relPath so the byte cap is reached in a handful of appends
        // instead of thousands — the mechanism is size-driven, not count-driven.
        relPath: `_BAC/review-drafts/${id}-${'p'.repeat(400)}.json`,
        vector: { A: 1 },
        kind: 'upsert',
      })
    ).seq;

  /** Append until the Nth rotation has happened, returning the last seq written.
   *  Self-calibrating: the cap is byte-driven, so counting appends would hard-code
   *  the serialized line size and break the moment a field is added. */
  const appendUntilRotations = async (
    feed: ReturnType<typeof createProjectionChangeFeed>,
    rotations: number,
    startIndex = 0,
  ): Promise<{ readonly lastSeq: number; readonly appends: number }> => {
    let seen = 0;
    let previousFloor = 0;
    let appends = 0;
    let lastSeq = 0;
    let rotatedExisted = existsSync(rotatedLogPath(vaultRoot));
    while (seen < rotations && appends < 200) {
      lastSeq = await append(feed, `t-${String(startIndex + appends)}`);
      appends += 1;
      const nowRotated = existsSync(rotatedLogPath(vaultRoot));
      const floor = (await feed.readSince(lastSeq)).retainedFromSeq;
      // Rotation #1 is "the rotated file appeared"; every later one is "the
      // floor moved" (the previous rotated generation got clobbered).
      if ((!rotatedExisted && nowRotated) || floor > previousFloor) seen += 1;
      rotatedExisted = nowRotated;
      previousFloor = floor;
    }
    return { lastSeq, appends };
  };

  it('rotates at the byte cap keeping one prior generation, and the reader reads both', async () => {
    process.env['SIDETRACK_SYNC_CHANGELOG_MAX_BYTES'] = '1200';
    try {
      const feed = createProjectionChangeFeed(vaultRoot);
      const { lastSeq } = await appendUntilRotations(feed, 1);

      // The live file is bounded by the cap (rotation happens BEFORE the append,
      // so the cap is a real ceiling, not "cap plus one batch").
      const live = await stat(join(vaultRoot, '_BAC', '.sync', 'projection-changes.jsonl'));
      expect(live.size).toBeLessThan(1200);
      // Exactly one prior generation exists — a plain rename onto `.1` clobbers,
      // so a second generation file can never accumulate.
      expect(existsSync(rotatedLogPath(vaultRoot))).toBe(true);
      expect(existsSync(`${rotatedLogPath(vaultRoot)}.1`)).toBe(false);
      const diagnostics = feed.__rotationDiagnostics();
      expect(diagnostics).toMatchObject({ attempts: 1, completed: 1, refused: 0 });
      expect(diagnostics.lastProofHash).toMatch(/^[a-f0-9]{64}$/u);
      const persistedProof = JSON.parse(
        await readFile(
          join(vaultRoot, '_BAC', '.sync', 'projection-changes-rotation-proof.json'),
          'utf8',
        ),
      ) as { readonly status?: unknown; readonly sourceHash?: unknown };
      expect(persistedProof.status).toBe('complete');
      expect(persistedProof.sourceHash).toBe(diagnostics.lastProofHash);

      // A COLD reader (no in-memory checkpoint) from 0 sees EVERY change across
      // both generations, in seq order, with no hole at the rotation boundary.
      // This is the assertion that "the reader reads both" is load-bearing.
      const cold = createProjectionChangeFeed(vaultRoot);
      const seqs = (await cold.readSince(0)).changed.map((change) => change.seq);
      expect(seqs).toEqual(Array.from({ length: lastSeq }, (_, index) => index + 1));
    } finally {
      delete process.env['SIDETRACK_SYNC_CHANGELOG_MAX_BYTES'];
    }
  });

  it('rotation never rewinds the seq high-water, even with the seq file deleted', async () => {
    process.env['SIDETRACK_SYNC_CHANGELOG_MAX_BYTES'] = '1200';
    try {
      const feed = createProjectionChangeFeed(vaultRoot);
      for (let index = 0; index < 8; index += 1) await append(feed, `t-${String(index)}`);

      // Worst case: the persisted high-water is lost, so the counter has to be
      // recovered from the logs. If recovery ignored the rotated generation it
      // would rewind and RE-ISSUE seqs, silently stranding every client cursor.
      await rm(join(vaultRoot, '_BAC', '.sync', 'projection-changes-seq'), { force: true });
      const recovered = createProjectionChangeFeed(vaultRoot);
      const next = await append(recovered, 't-after');
      expect(next).toBe(9);
    } finally {
      delete process.env['SIDETRACK_SYNC_CHANGELOG_MAX_BYTES'];
    }
  });

  it('a rotation invalidates the byte checkpoint instead of seeking into the new file', async () => {
    process.env['SIDETRACK_SYNC_CHANGELOG_MAX_BYTES'] = '1200';
    try {
      const feed = createProjectionChangeFeed(vaultRoot);
      for (let index = 0; index < 3; index += 1) await append(feed, `t-${String(index)}`);
      // Prime the checkpoint: this read parses the tail and remembers the offset.
      const primed = await feed.readSince(0);
      expect(primed.cursor).toBe(3);

      // Keep appending through the rotation on the SAME feed instance, so the
      // stale in-memory offset is live. A shrink check alone cannot catch this:
      // the fresh live file grows back past the old offset.
      for (let index = 3; index < 9; index += 1) await append(feed, `t-${String(index)}`);
      const after = await feed.readSince(3);
      // Every seq after the cursor is returned exactly once, in order — a stale
      // mid-line seek would drop or mangle some of them.
      expect(after.changed.map((change) => change.seq)).toEqual([4, 5, 6, 7, 8, 9]);
    } finally {
      delete process.env['SIDETRACK_SYNC_CHANGELOG_MAX_BYTES'];
    }
  });

  it('retainedFromSeq stays 0 until a generation is actually discarded', async () => {
    process.env['SIDETRACK_SYNC_CHANGELOG_MAX_BYTES'] = '1200';
    try {
      const feed = createProjectionChangeFeed(vaultRoot);
      // Nothing rotated yet ⇒ the whole history is retained ⇒ floor is 0, which
      // is a real measurement ("nothing lost"), not a missing field.
      expect((await feed.readSince(0)).retainedFromSeq).toBe(0);

      // ONE rotation loses nothing: the rotated generation is still read, so the
      // floor must stay 0. Reporting a floor here would be a false alarm that
      // pushed every client into an unnecessary full resync.
      const first = await appendUntilRotations(feed, 1);
      expect((await feed.readSince(0)).retainedFromSeq).toBe(0);
      const firstGenerationMaxSeq = first.lastSeq;

      // The SECOND rotation CLOBBERS the first rotated generation, so its
      // high-water becomes the floor and a client below it learns it must
      // full-resync instead of trusting an incomplete answer.
      await appendUntilRotations(feed, 1, first.appends);
      const floored = await feed.readSince(0);
      expect(floored.retainedFromSeq).toBeGreaterThan(0);
      // The floor is exactly the discarded generation's high-water — not an
      // approximation, and never above what is still readable.
      expect(floored.retainedFromSeq).toBeLessThanOrEqual(firstGenerationMaxSeq);
      const readable = floored.changed.map((change) => change.seq);
      expect(Math.min(...readable)).toBeGreaterThan(floored.retainedFromSeq);
    } finally {
      delete process.env['SIDETRACK_SYNC_CHANGELOG_MAX_BYTES'];
    }
  });

  it('the cap knob honours a positive override and rejects garbage', () => {
    delete process.env['SIDETRACK_SYNC_CHANGELOG_MAX_BYTES'];
    expect(syncChangelogMaxBytes()).toBe(SYNC_CHANGELOG_MAX_BYTES_DEFAULT);
    process.env['SIDETRACK_SYNC_CHANGELOG_MAX_BYTES'] = '4096';
    expect(syncChangelogMaxBytes()).toBe(4096);
    // Garbage must not disable rotation by accident.
    process.env['SIDETRACK_SYNC_CHANGELOG_MAX_BYTES'] = 'lots';
    expect(syncChangelogMaxBytes()).toBe(SYNC_CHANGELOG_MAX_BYTES_DEFAULT);
    process.env['SIDETRACK_SYNC_CHANGELOG_MAX_BYTES'] = '-1';
    expect(syncChangelogMaxBytes()).toBe(SYNC_CHANGELOG_MAX_BYTES_DEFAULT);
    delete process.env['SIDETRACK_SYNC_CHANGELOG_MAX_BYTES'];
  });

  it('fails closed and keeps an over-cap live log when durable read-back is malformed', async () => {
    process.env['SIDETRACK_SYNC_CHANGELOG_MAX_BYTES'] = '100';
    try {
      const dir = join(vaultRoot, '_BAC', '.sync');
      const live = join(dir, 'projection-changes.jsonl');
      await mkdir(dir, { recursive: true });
      await writeFile(live, `${'not-json\n'.repeat(20)}`, 'utf8');
      const feed = createProjectionChangeFeed(vaultRoot);
      await append(feed, 'safe-tail');

      expect(existsSync(live)).toBe(true);
      expect(existsSync(rotatedLogPath(vaultRoot))).toBe(false);
      expect(feed.__rotationDiagnostics()).toMatchObject({
        attempts: 1,
        completed: 0,
        refused: 1,
        lastProofHash: null,
      });
    } finally {
      delete process.env['SIDETRACK_SYNC_CHANGELOG_MAX_BYTES'];
    }
  });
});
