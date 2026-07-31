import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  __resetVaultLedgerCache,
  buildVaultLedger,
  classifyVaultPath,
  summarizeVaultLedger,
  vaultLedgerCached,
  vaultLedgerEnabled,
  type LedgerFamily,
} from './vaultLedger.js';

// THE RECONCILIATION INVARIANT IS THE POINT OF THIS FILE.
//
// On the live vault the old surface reported "GC-tracked 10.7 MB / 1 file"
// against 3.02 GB on disk — 99.6% invisible — because it summed a DELETE PLAN
// and called it an inventory. The only structural defence against that class of
// bug is an assertion that the family bytes equal the on-disk bytes, on a tree
// that deliberately contains files no classifier rule names. If someone adds a
// family and forgets a branch, these tests fail rather than quietly shrinking
// the total.

const write = async (root: string, rel: string, bytes: number): Promise<number> => {
  const path = join(root, rel);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, 'x'.repeat(bytes));
  return bytes;
};

describe('vaultLedger', () => {
  let vault: string | null = null;

  afterEach(async () => {
    __resetVaultLedgerCache();
    if (vault !== null) {
      await rm(vault, { recursive: true, force: true });
      vault = null;
    }
    delete process.env['SIDETRACK_VAULT_LEDGER'];
  });

  it('classifies every byte and the family totals reconcile to the on-disk total', async () => {
    vault = await mkdtemp(join(tmpdir(), 'ledger-reconcile-'));
    let expected = 0;
    // One file per required family, plus sqlite siblings, plus two files no rule
    // names (the `other` catch-all's whole reason to exist).
    expected += await write(vault, '_BAC/connections/current.1234-abc.db', 400);
    expected += await write(vault, '_BAC/connections/current.1234-abc.db-wal', 40);
    expected += await write(vault, '_BAC/connections/current.1234-abc.db-shm', 20);
    expected += await write(vault, '_BAC/connections/current.gen', 12);
    expected += await write(vault, '_BAC/connections/current.db', 300);
    expected += await write(vault, '_BAC/connections/event-store.db', 700);
    expected += await write(vault, '_BAC/connections/event-store.db-wal', 70);
    expected += await write(vault, '_BAC/connections/resolver-cache.db', 90);
    expected += await write(vault, '_BAC/connections/visit-similarity/current.json', 55);
    expected += await write(vault, '_BAC/connections/diagnostics/latest.json', 33);
    expected += await write(vault, '_BAC/log/replica-a/2026-05-01.jsonl', 500);
    expected += await write(vault, '_BAC/events/2026-05-01.jsonl', 130);
    expected += await write(vault, '_BAC/.sync/projection-changes.jsonl', 98);
    expected += await write(vault, '_BAC/recall/index.bin', 115);
    expected += await write(vault, '_BAC/page-evidence/a.json', 42);
    expected += await write(vault, '_BAC/page-content/a.json', 17);
    expected += await write(vault, '_BAC/ranker/model.txt', 9);
    expected += await write(vault, '_BAC/debug-dumps/latest.json', 3);
    // Unnamed by any rule — must land in `other`, never be dropped.
    expected += await write(vault, '_BAC/reminders/r1.json', 11);
    expected += await write(vault, '_BAC/.projector-version', 7);

    const ledger = await buildVaultLedger(vault, { histogramShardSample: 0 });

    expect(ledger.totalBytes).toBe(expected);
    const familySum = ledger.families.reduce((sum, family) => sum + family.bytes, 0);
    expect(familySum).toBe(ledger.totalBytes);
    const fileSum = ledger.families.reduce((sum, family) => sum + family.files, 0);
    expect(fileSum).toBe(ledger.totalFiles);
    // The catch-all really caught them (18 bytes across two unnamed files) —
    // this is what proves the invariant is not held by an accidental rule.
    const other = ledger.families.find((family) => family.family === 'other');
    expect(other?.bytes).toBe(18);
    expect(other?.files).toBe(2);
    expect(other?.status).toBe('unclassified');
  });

  it('keeps sqlite -wal/-shm siblings with their main file, never in other', async () => {
    vault = await mkdtemp(join(tmpdir(), 'ledger-siblings-'));
    await write(vault, '_BAC/connections/event-store.db', 100);
    await write(vault, '_BAC/connections/event-store.db-wal', 10);
    await write(vault, '_BAC/connections/event-store.db-shm', 5);

    const ledger = await buildVaultLedger(vault, { histogramShardSample: 0 });
    const store = ledger.families.find((family) => family.family === 'event-store');
    // 115, not 100 — a store that reads as "100 + 15 of mystery" is the bug.
    expect(store?.bytes).toBe(115);
    expect(store?.files).toBe(3);
    expect(ledger.families.find((family) => family.family === 'other')?.bytes).toBe(0);
  });

  it('reports the event store as unused-under-config when the store is off', async () => {
    vault = await mkdtemp(join(tmpdir(), 'ledger-store-off-'));
    await write(vault, '_BAC/connections/event-store.db', 100);

    const off = await buildVaultLedger(vault, { histogramShardSample: 0, eventStoreOn: false });
    const offEntry = off.families.find((family) => family.family === 'event-store');
    expect(offEntry?.status).toBe('unused-under-config');
    // NOT reclaimable, and explicitly NOT assessed: it is load-bearing again the
    // moment the flag flips, so a 0 here must not read as "assessed, keep".
    expect(offEntry?.reclaimable).toBe(0);
    expect(offEntry?.reclaimableAssessed).toBe(false);

    const on = await buildVaultLedger(vault, { histogramShardSample: 0, eventStoreOn: true });
    expect(on.families.find((family) => family.family === 'event-store')?.status).toBe('active');
  });

  it('surfaces orphaned generations as reclaimable and names the served one', async () => {
    vault = await mkdtemp(join(tmpdir(), 'ledger-generations-'));
    const connections = join(vault, '_BAC', 'connections');
    await write(vault, '_BAC/connections/current.100-served.db', 400);
    await write(vault, '_BAC/connections/current.99-prior.db', 400);
    await writeFile(join(connections, 'current.gen'), '100-served');

    const ledger = await buildVaultLedger(vault, { histogramShardSample: 0 });
    expect(ledger.generations.pointerGenId).toBe('100-served');
    // Two resident, both inside the keep window (pointer + retired-handle
    // margin) ⇒ nothing reclaimable, status active. This is the steady state
    // the live vault is in between drains.
    expect(ledger.generations.collectableCount).toBe(0);
    const gens = ledger.families.find((family) => family.family === 'connections-generations');
    expect(gens?.status).toBe('active');
    expect(gens?.reclaimable).toBe(0);
    // current.gen counts with the generations, not as `other`.
    expect(gens?.files).toBe(3);
  });

  it('samples the event log by type and says so in the payload', async () => {
    vault = await mkdtemp(join(tmpdir(), 'ledger-histogram-'));
    const interval = `${JSON.stringify({ type: 'engagement.interval.observed', p: 'x'.repeat(60) })}\n`;
    const capture = `${JSON.stringify({ type: 'capture.recorded', p: 'y' })}\n`;
    // Two shards; the bigger one dominates the byte share, which is why the
    // sampler picks LARGEST-first rather than uniformly by file.
    await writeFile(join(vault, '_BAC/log/replica-a/2026-05-01.jsonl'), '', { flag: 'w' }).catch(
      () => undefined,
    );
    await mkdir(join(vault, '_BAC/log/replica-a'), { recursive: true });
    await writeFile(
      join(vault, '_BAC/log/replica-a/2026-05-01.jsonl'),
      interval.repeat(20) + capture.repeat(2),
    );
    await writeFile(join(vault, '_BAC/log/replica-a/2026-05-02.jsonl'), capture.repeat(3));

    const ledger = await buildVaultLedger(vault, { histogramShardSample: 1 });
    expect(ledger.eventLog).not.toBeNull();
    // Sampled ⇒ the flag is TRUE in the data, not merely documented, so a
    // renderer cannot present an extrapolation as a measurement by accident.
    expect(ledger.eventLog?.sampled).toBe(true);
    expect(ledger.eventLog?.shardsTotal).toBe(2);
    expect(ledger.eventLog?.shardsSampled).toBe(1);
    const top = ledger.eventLog?.types[0];
    expect(top?.type).toBe('engagement.interval.observed');
    expect(top?.share).toBeGreaterThan(0.5);
    // The extrapolation base is the WHOLE family, not just the sample.
    expect(ledger.eventLog?.totalBytes).toBeGreaterThan(ledger.eventLog?.sampledBytes ?? 0);
  });

  it('classifyVaultPath is total — every path gets exactly one family', () => {
    const cases: readonly [readonly string[], LedgerFamily][] = [
      [['connections', 'current.5-x.db'], 'connections-generations'],
      [['connections', 'current.5-x.db-wal'], 'connections-generations'],
      [['connections', 'current.db'], 'connections-legacy-anchor'],
      [['connections', 'current.db-shm'], 'connections-legacy-anchor'],
      [['connections', 'event-store.db'], 'event-store'],
      [['connections', 'timeline-facts.db'], 'connections-sidecar-dbs'],
      [['connections', 'visit-similarity-hnsw.v1.bin'], 'connections-derived'],
      [['connections', 'topics', 'rev.json'], 'connections-derived'],
      [['connections', 'diagnostics', 'latest.json'], 'diagnostics'],
      [['log', 'r', '2026-01-01.jsonl'], 'event-log'],
      [['events', '2026-01-01.jsonl'], 'ingress-spool'],
      [['.sync', 'projection-changes.jsonl'], 'sync-changelog'],
      [['recall', 'x'], 'recall-index'],
      [['debug-dumps', 'x.json'], 'debug-dumps'],
      [['threads', 'x.json'], 'other'],
      [[], 'other'],
    ];
    for (const [segments, family] of cases) {
      expect(classifyVaultPath(segments), segments.join('/')).toBe(family);
    }
  });

  it('summarizeVaultLedger names the worst offenders and the orphan counter', async () => {
    vault = await mkdtemp(join(tmpdir(), 'ledger-summary-'));
    await write(vault, '_BAC/connections/event-store.db', 1000);
    await write(vault, '_BAC/log/r/2026-01-01.jsonl', 500);
    await write(vault, '_BAC/events/2026-01-01.jsonl', 200);
    await write(vault, '_BAC/recall/x', 10);

    const ledger = await buildVaultLedger(vault, { histogramShardSample: 0 });
    const summary = summarizeVaultLedger(ledger, 'ok');
    expect(summary.totalBytes).toBe(1710);
    expect(summary.worstOffenders.map((entry) => entry.family)).toEqual([
      'event-store',
      'event-log',
      'ingress-spool',
    ]);
    // 0 orphans is a REAL measurement here (the survey ran and found none), not
    // an absent field — that distinction is the whole P0 counter.
    expect(summary.orphanGenerations).toBe(0);
    expect(summary.generationSweepArmed).toBe(false);
    // Families with zero files are not counted as present.
    expect(summary.familyCount).toBe(4);
  });

  it('the TTL cache is honest: unavailable before the first walk, disabled when off', async () => {
    vault = await mkdtemp(join(tmpdir(), 'ledger-cache-'));
    await write(vault, '_BAC/recall/x', 10);

    // Read-only surface ⇒ default ON.
    expect(vaultLedgerEnabled()).toBe(true);
    const cold = await vaultLedgerCached(vault, { histogramShardSample: 0 });
    // The walk was kicked off in the background; the request never blocked on it.
    expect(cold.availability).toBe('unavailable');
    expect(cold.value).toBeNull();

    const warm = await vaultLedgerCached(vault, { histogramShardSample: 0 }, { awaitFresh: true });
    expect(warm.availability).toBe('ok');
    expect(warm.value?.totalBytes).toBe(10);

    // `disabled` is a distinct state from `unavailable`: an operator who turned
    // it off must not read that as a broken walk.
    process.env['SIDETRACK_VAULT_LEDGER'] = '0';
    expect(vaultLedgerEnabled()).toBe(false);
    const off = await vaultLedgerCached(vault, { histogramShardSample: 0 });
    expect(off.availability).toBe('disabled');
    expect(off.value).toBeNull();
  });
});
