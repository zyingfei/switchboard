import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProjectionChangeFeed } from './projectionChanges.js';

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
});
