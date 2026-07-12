import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildCompactionPlan } from './compactionPlanner.js';

// Minimal AcceptedEvent-shaped lines. The planner only needle-tests the
// raw `"type":"..."` substring, so these don't need to be complete.
const eventLine = (type: string, seq: number): string =>
  `${JSON.stringify({
    clientEventId: `e-${type}-${String(seq)}`,
    dot: { replicaId: 'peer-A', seq },
    deps: {},
    aggregateId: `agg-${String(seq)}`,
    type,
    payload: {},
    acceptedAtMs: seq,
  })}\n`;

describe('buildCompactionPlan (report-only)', () => {
  let vaultRoot: string;
  let logDir: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-compaction-'));
    logDir = join(vaultRoot, '_BAC', 'log', 'peer-A');
    await mkdir(logDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('reports reclaimable engagement.interval bytes on a sealed past shard', async () => {
    const sealedPath = join(logDir, '2020-01-01.jsonl');
    const intervalA = eventLine('engagement.interval.observed', 1);
    const intervalB = eventLine('engagement.interval.observed', 2);
    const navLine = eventLine('navigation.committed', 3);
    await writeFile(sealedPath, intervalA + navLine + intervalB, 'utf8');

    const plan = await buildCompactionPlan(vaultRoot, { now: new Date('2026-07-12T00:00:00Z') });

    expect(plan.reportOnly).toBe(true);
    expect(plan.shards.length).toBe(1);
    const shard = plan.shards[0];
    expect(shard?.replicaId).toBe('peer-A');
    expect(shard?.date).toBe('2020-01-01');
    expect(shard?.intervalLines).toBe(2);
    expect(shard?.totalLines).toBe(3);
    // Reclaimable = the two interval lines' bytes (incl. their newline).
    const expectedReclaimable =
      Buffer.byteLength(intervalA.trimEnd(), 'utf8') +
      1 +
      Buffer.byteLength(intervalB.trimEnd(), 'utf8') +
      1;
    expect(shard?.reclaimableBytes).toBe(expectedReclaimable);
    expect(plan.reclaimableBytes).toBe(expectedReclaimable);
  });

  it("excludes today's shard (never rewrite the live shard)", async () => {
    const today = '2026-07-12';
    await writeFile(
      join(logDir, `${today}.jsonl`),
      eventLine('engagement.interval.observed', 1),
      'utf8',
    );
    await writeFile(
      join(logDir, '2020-01-01.jsonl'),
      eventLine('engagement.interval.observed', 2),
      'utf8',
    );

    const plan = await buildCompactionPlan(vaultRoot, { now: new Date(`${today}T12:00:00Z`) });

    // Only the sealed 2020 shard is reported; today's is live.
    expect(plan.shards.map((s) => s.date)).toEqual(['2020-01-01']);
  });

  it('deletes nothing — every shard file is byte-for-byte untouched', async () => {
    const sealedPath = join(logDir, '2020-01-01.jsonl');
    const body = eventLine('engagement.interval.observed', 1) + eventLine('navigation.committed', 2);
    await writeFile(sealedPath, body, 'utf8');
    const beforeSize = (await stat(sealedPath)).size;

    await buildCompactionPlan(vaultRoot, { now: new Date('2026-07-12T00:00:00Z') });

    // File still present, same size, same content.
    const afterEntries = await readdir(logDir);
    expect(afterEntries).toContain('2020-01-01.jsonl');
    expect((await stat(sealedPath)).size).toBe(beforeSize);
    expect(await readFile(sealedPath, 'utf8')).toBe(body);
  });

  it('returns an empty plan when the log dir does not exist', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'sidetrack-compaction-empty-'));
    try {
      const plan = await buildCompactionPlan(empty);
      expect(plan.shards).toEqual([]);
      expect(plan.reclaimableBytes).toBe(0);
      expect(plan.reportOnly).toBe(true);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
