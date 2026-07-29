import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { INGRESS_RETAIN_DAYS_DEFAULT, ingressRetainDays, planIngressRetention } from './ingressRetention.js';

// The interesting assertion here is a REFUSAL. The brief asked for age-based
// retention on `_BAC/events/` gated on a proof that a day was fully ingested.
// That proof does not exist anywhere on disk (no bookmark, no per-file offset;
// `recall/ingest-state.json` is a version vector over the CANONICAL log and
// says nothing about this spool; idempotency receipts expire in an hour). So
// the planner reports the opportunity and vouches for NOTHING — and these tests
// pin that, so a future change that starts deleting has to change a test that
// explains why deleting was unsafe.

describe('planIngressRetention (report-only)', () => {
  let vaultRoot: string;
  let spool: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-ingress-'));
    spool = join(vaultRoot, '_BAC', 'events');
    await mkdir(spool, { recursive: true });
    delete process.env['SIDETRACK_INGRESS_RETAIN_DAYS'];
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
    delete process.env['SIDETRACK_INGRESS_RETAIN_DAYS'];
  });

  const day = async (date: string, bytes: number): Promise<void> => {
    // One JSON line padded to the requested size, so line counts are meaningful.
    const line = JSON.stringify({ bac_id: `b-${date}`, pad: 'x'.repeat(Math.max(0, bytes - 40)) });
    await writeFile(join(spool, `${date}.jsonl`), `${line}\n`, 'utf8');
  };

  it('classifies days past the retention window but reclaims nothing without proof', async () => {
    await day('2026-05-01', 200);
    await day('2026-07-20', 300);
    await day('2026-07-28', 400);

    const plan = await planIngressRetention(vaultRoot, {
      now: new Date('2026-07-29T12:00:00Z'),
      retainDays: 14,
    });

    expect(plan.reportOnly).toBe(true);
    expect(plan.cutoffDate).toBe('2026-07-15');
    expect(plan.days.map((entry) => entry.date)).toEqual([
      '2026-05-01',
      '2026-07-20',
      '2026-07-28',
    ]);
    const may = plan.days.find((entry) => entry.date === '2026-05-01');
    expect(may?.pastRetention).toBe(true);
    // The load-bearing refusal: past retention, still not reclaimable.
    expect(may?.proof).toBe('absent');
    expect(may?.reclaimable).toBe(0);
    expect(may?.note).toContain('nothing on disk proves it was ingested');
    expect(plan.days.find((entry) => entry.date === '2026-07-20')?.pastRetention).toBe(false);
    // The opportunity is measured even though it is not actioned — an operator
    // can see exactly what a bookmark record would unlock.
    expect(plan.pastRetentionBytes).toBeGreaterThan(0);
    expect(plan.reclaimableBytes).toBe(0);
    expect(plan.blockedBy?.missingArtifact).toContain('.bookmark.json');
  });

  it('reports refuted (not absent) once a bookmark artifact exists', async () => {
    await day('2026-05-01', 200);
    // A collector-shaped bookmark exists but per-day verification against it is
    // deliberately not implemented, so the planner says "proof found, comparison
    // outstanding" rather than silently vouching for a deletion.
    await writeFile(
      join(spool, '.bookmark.json'),
      JSON.stringify({ filename: '2026-05-01.jsonl', byte_offset: 10 }),
      'utf8',
    );

    const plan = await planIngressRetention(vaultRoot, {
      now: new Date('2026-07-29T12:00:00Z'),
      retainDays: 14,
    });
    expect(plan.days[0]?.proof).toBe('refuted');
    expect(plan.days[0]?.reclaimable).toBe(0);
    expect(plan.blockedBy).toBeNull();
  });

  it('counts lines, ignores non-spool filenames, and honours the env knob', async () => {
    await day('2026-05-01', 200);
    await writeFile(join(spool, 'notes.txt'), 'ignore me', 'utf8');
    // The name filter matches the SHAPE `YYYY-MM-DD.jsonl`, not a calendar
    // date — same as plan.ts's SNAPSHOT_DATE_NAME_RE. A shape-valid but
    // calendar-impossible name is still a day here, and that is deliberate: it
    // sorts lexicographically like any other and is never deleted anyway, so
    // rejecting it would only hide bytes from the report.
    await writeFile(join(spool, '2026-13-99.jsonl'), 'bad date\n', 'utf8');

    const plan = await planIngressRetention(vaultRoot, {
      now: new Date('2026-07-29T12:00:00Z'),
    });
    expect(plan.days.map((entry) => entry.date)).toEqual(['2026-05-01', '2026-13-99']);
    expect(plan.days[0]?.lines).toBe(1);
    // `notes.txt` is not a spool day and contributes nothing.
    expect(plan.days.some((entry) => entry.path.endsWith('notes.txt'))).toBe(false);

    // Stat-only mode: absent line count is null, NOT 0 (absent ≠ zero).
    const statOnly = await planIngressRetention(vaultRoot, {
      now: new Date('2026-07-29T12:00:00Z'),
      countLines: false,
    });
    expect(statOnly.days[0]?.lines).toBeNull();

    expect(ingressRetainDays()).toBe(INGRESS_RETAIN_DAYS_DEFAULT);
    process.env['SIDETRACK_INGRESS_RETAIN_DAYS'] = '3';
    expect(ingressRetainDays()).toBe(3);
    // Garbage falls back to the default rather than disabling retention.
    process.env['SIDETRACK_INGRESS_RETAIN_DAYS'] = 'nonsense';
    expect(ingressRetainDays()).toBe(INGRESS_RETAIN_DAYS_DEFAULT);
  });

  it('is empty and non-throwing on a vault with no spool', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'sidetrack-ingress-bare-'));
    try {
      const plan = await planIngressRetention(bare, { now: new Date('2026-07-29T12:00:00Z') });
      expect(plan.days).toEqual([]);
      expect(plan.totalBytes).toBe(0);
      expect(plan.reclaimableBytes).toBe(0);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});
