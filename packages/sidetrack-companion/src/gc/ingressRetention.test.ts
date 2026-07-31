import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcceptedEvent } from '../sync/causal.js';
import {
  INGRESS_RETAIN_DAYS_DEFAULT,
  ingressRetainDays,
  planIngressRetention,
} from './ingressRetention.js';

// S2 uses canonical JSONL read-back as the proof. No append result or expiring
// idempotency receipt is trusted: every spool record must have an identical,
// structurally-valid capture.recorded payload on disk.

describe('planIngressRetention (canonical read-back proof)', () => {
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

  const capture = (date: string) => ({
    bac_id: `b-${date}`,
    revision: `r-${date}`,
    requestId: `req-${date}`,
    receivedAt: `${date}T12:00:01.000Z`,
    threadUrl: `https://example.test/${date}`,
    provider: 'test',
    title: `Thread ${date}`,
    capturedAt: `${date}T12:00:00.000Z`,
    turns: [
      {
        ordinal: 1,
        role: 'user',
        text: `hello ${date}`,
        capturedAt: `${date}T12:00:00.000Z`,
      },
    ],
  });

  const day = async (date: string): Promise<ReturnType<typeof capture>> => {
    const row = capture(date);
    await writeFile(join(spool, `${date}.jsonl`), `${JSON.stringify(row)}\n`, 'utf8');
    return row;
  };

  const mirror = async (rows: readonly ReturnType<typeof capture>[]): Promise<void> => {
    const logDir = join(vaultRoot, '_BAC', 'log', 'replica-a');
    await mkdir(logDir, { recursive: true });
    const events: AcceptedEvent[] = rows.map((row, index) => ({
      clientEventId: `client-${String(index + 1)}`,
      dot: { replicaId: 'replica-a', seq: index + 1 },
      deps: index === 0 ? {} : { 'replica-a': index },
      aggregateId: row.bac_id,
      type: 'capture.recorded',
      payload: {
        bac_id: row.bac_id,
        threadUrl: row.threadUrl,
        provider: row.provider,
        title: row.title,
        capturedAt: row.capturedAt,
        turns: row.turns,
      },
      acceptedAtMs: Date.parse(row.capturedAt),
    }));
    await writeFile(
      join(logDir, '2026-01-01.jsonl'),
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
      'utf8',
    );
  };

  it('classifies days past the retention window but reclaims nothing without proof', async () => {
    await day('2026-05-01');
    await day('2026-07-20');
    await day('2026-07-28');

    const plan = await planIngressRetention(vaultRoot, {
      now: new Date('2026-07-29T12:00:00Z'),
      retainDays: 14,
    });

    expect(plan.reportOnly).toBe(false);
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
    expect(plan.blockedBy?.missingArtifact).toContain('_BAC/log');
  });

  it('verifies only a fully mirrored day and refutes a missing canonical record', async () => {
    const mirrored = await day('2026-05-01');
    await day('2026-05-02');
    await mirror([mirrored]);

    const plan = await planIngressRetention(vaultRoot, {
      now: new Date('2026-07-29T12:00:00Z'),
      retainDays: 14,
    });
    expect(plan.days[0]?.proof).toBe('verified');
    expect(plan.days[0]?.reclaimable).toBeGreaterThan(0);
    expect(plan.days[1]?.proof).toBe('refuted');
    expect(plan.days[1]?.reclaimable).toBe(0);
    expect(plan.blockedBy).toBeNull();
  });

  it('counts lines, ignores non-spool filenames, and honours the env knob', async () => {
    await day('2026-05-01');
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
