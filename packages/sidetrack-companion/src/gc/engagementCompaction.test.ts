import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { engagementInputsFromEvents } from '../engagement/engagementFactsStore.js';
import {
  ENGAGEMENT_INTERVAL_OBSERVED,
  ENGAGEMENT_SESSION_AGGREGATED,
  type EngagementDimensions,
} from '../engagement/events.js';
import { NAVIGATION_COMMITTED } from '../navigation/events.js';
import { VISIT_SIMILARITY_DEFAULT_ENGAGEMENT_GATE_MS } from '../connections/visitSimilarity.js';
import type { AcceptedEvent } from '../sync/causal.js';
import {
  applyEngagementCompaction,
  engagementCompactionBlockers,
  planEngagementCompaction,
} from './compactionPlanner.js';

// ===========================================================================
// THE GOLDEN INVARIANT
// ===========================================================================
//
// Compacting `engagement.interval.observed` out of sealed shards is only
// defensible if EVERY quantity the serving path derives is bit-for-bit the same
// afterwards. This file is that proof, and it is deliberately built from the
// PRODUCTION readers — `engagementInputsFromEvents` (the exact function the
// engagement facts store projects with) and the real
// VISIT_SIMILARITY_DEFAULT_ENGAGEMENT_GATE_MS — rather than a reimplementation.
// A test that re-derives the invariant with its own arithmetic proves nothing
// about the code that ships.
//
// Three derived quantities, all compared as JSON bytes:
//   1. the per-session engagement aggregate,
//   2. focusedWindowMs per visit,
//   3. the similarity ELIGIBILITY set (focusedWindowMs >= the gate).
//
// WHY IT HOLDS, structurally: `engagement.session.aggregated` is not derived
// from intervals inside the companion at all. The extension folds per-tab
// intervals and posts BOTH types independently to /v1/edge/events, so the
// aggregate is an ingested PRIMARY event. Dropping intervals removes an input
// nothing downstream reads. The fixture makes that falsifiable by giving the
// aggregates totals that DISAGREE with the sum of their intervals — if any
// derivation secretly folded intervals, the two sides would differ and these
// assertions would fail loudly instead of passing vacuously.

const dimensions = (overrides: Partial<EngagementDimensions> = {}): EngagementDimensions => ({
  activeMs: 0,
  visibleMs: 0,
  focusedWindowMs: 0,
  idleMs: 0,
  foregroundBursts: 0,
  returnCount: 0,
  scrollEvents: 0,
  maxScrollRatio: 0,
  copyCount: 0,
  pasteCount: 0,
  ...overrides,
});

let seq = 0;
const event = (
  type: string,
  payload: Record<string, unknown>,
  acceptedAtMs: number,
): AcceptedEvent => {
  seq += 1;
  return {
    clientEventId: `e-${type}-${String(seq)}`,
    dot: { replicaId: 'edge-A', seq },
    deps: {},
    aggregateId: `${type}:${String(payload['visitId'] ?? seq)}`,
    type,
    payload,
    acceptedAtMs,
  } as AcceptedEvent;
};

const interval = (visitId: string, focusedWindowMs: number, atMs: number): AcceptedEvent =>
  event(
    ENGAGEMENT_INTERVAL_OBSERVED,
    {
      payloadVersion: 1,
      visitId,
      intervalStart: new Date(atMs).toISOString(),
      intervalEnd: new Date(atMs + 1000).toISOString(),
      dimensions: { engagement: dimensions({ focusedWindowMs, activeMs: focusedWindowMs }) },
    },
    atMs,
  );

const aggregate = (
  visitId: string,
  sessionId: string,
  focusedWindowMs: number,
  atMs: number,
): AcceptedEvent =>
  event(
    ENGAGEMENT_SESSION_AGGREGATED,
    {
      payloadVersion: 1,
      visitId,
      sessionId,
      dimensions: { engagement: dimensions({ focusedWindowMs, activeMs: focusedWindowMs }) },
    },
    atMs,
  );

const navigation = (visitId: string, canonicalUrl: string, atMs: number): AcceptedEvent =>
  event(NAVIGATION_COMMITTED, { payloadVersion: 1, visitId, canonicalUrl, url: canonicalUrl }, atMs);

/** The three derived quantities, exactly as serving computes them. */
const deriveServingQuantities = (
  events: readonly AcceptedEvent[],
): {
  readonly aggregatesPerVisit: string;
  readonly focusedWindowMsPerVisit: string;
  readonly eligibilitySet: string;
} => {
  const inputs = engagementInputsFromEvents(events, []);
  const sorted = [...inputs].sort((left, right) => left.visitId.localeCompare(right.visitId));
  const focused = sorted.map((input) => [input.visitId, input.engagement.focusedWindowMs] as const);
  return {
    aggregatesPerVisit: JSON.stringify(sorted),
    focusedWindowMsPerVisit: JSON.stringify(focused),
    eligibilitySet: JSON.stringify(
      focused
        .filter(([, ms]) => ms >= VISIT_SIMILARITY_DEFAULT_ENGAGEMENT_GATE_MS)
        .map(([visitId]) => visitId),
    ),
  };
};

const readEvents = async (shardPaths: readonly string[]): Promise<readonly AcceptedEvent[]> => {
  const out: AcceptedEvent[] = [];
  for (const path of shardPaths) {
    const raw = await readFile(path, 'utf8').catch(() => '');
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      out.push(JSON.parse(line) as AcceptedEvent);
    }
  }
  return out;
};

describe('engagement-interval compaction', () => {
  let vaultRoot: string;
  let logDir: string;
  let sealedPath: string;
  let livePath: string;

  beforeEach(async () => {
    seq = 0;
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-engagement-compact-'));
    logDir = join(vaultRoot, '_BAC', 'log', 'edge-A');
    await mkdir(logDir, { recursive: true });
    sealedPath = join(logDir, '2020-01-01.jsonl');
    livePath = join(logDir, '2026-07-29.jsonl');
    delete process.env['SIDETRACK_ENGAGEMENT_COMPACT'];
    delete process.env['SIDETRACK_ENGAGEMENT_COMPACT_DAYS'];
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
    delete process.env['SIDETRACK_ENGAGEMENT_COMPACT'];
    delete process.env['SIDETRACK_ENGAGEMENT_COMPACT_DAYS'];
    delete process.env['SIDETRACK_EXTERNAL_WRITERS'];
  });

  const writeFixture = async (): Promise<void> => {
    // Visit v-covered: many raw intervals in the sealed shard AND a durable
    // aggregate. The aggregate's focusedWindowMs (9000) deliberately does NOT
    // equal the sum of its intervals (3 x 400 = 1200), so any derivation that
    // secretly folded intervals would produce a different number.
    const sealed = [
      interval('v-covered', 400, 1_577_836_800_000),
      interval('v-covered', 400, 1_577_836_801_000),
      navigation('v-covered', 'https://example.com/a', 1_577_836_802_000),
      interval('v-covered', 400, 1_577_836_803_000),
      // v-uncovered has NO aggregate anywhere: its intervals are the only
      // engagement record, so they must survive compaction untouched.
      interval('v-uncovered', 7_000, 1_577_836_804_000),
      navigation('v-uncovered', 'https://example.com/b', 1_577_836_805_000),
    ];
    // The aggregate lives in a LATER shard than the intervals it covers — which
    // is why coverage has to be a global fact and the planner streams every
    // shard, not just the candidates.
    const live = [
      aggregate('v-covered', 's-1', 9_000, 1_785_000_000_000),
      aggregate('v-below-gate', 's-2', 1_200, 1_785_000_001_000),
      navigation('v-below-gate', 'https://example.com/c', 1_785_000_002_000),
      interval('v-covered', 400, 1_785_000_003_000),
    ];
    await writeFile(
      sealedPath,
      `${sealed.map((e) => JSON.stringify(e)).join('\n')}\n`,
      'utf8',
    );
    await writeFile(livePath, `${live.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
  };

  it('THE GOLDEN INVARIANT: every served quantity is byte-identical after compaction', async () => {
    await writeFixture();
    const before = deriveServingQuantities(await readEvents([sealedPath, livePath]));
    // Sanity: the fixture must actually exercise the gate, or byte-equality is
    // trivially true. v-covered (9000ms) is eligible, v-below-gate (1200ms) is
    // not, and v-uncovered has no aggregate so it never appears at all.
    expect(before.eligibilitySet).toBe(JSON.stringify(['v-covered']));

    const plan = await planEngagementCompaction(vaultRoot, {
      now: new Date('2026-07-29T12:00:00Z'),
      retainDays: 30,
    });
    expect(plan.shards.map((shard) => shard.date)).toEqual(['2020-01-01']);
    // 3 covered interval lines droppable; the 1 uncovered line is not.
    expect(plan.intervalsFolded).toBe(3);
    expect(plan.bytesReclaimable).toBeGreaterThan(0);
    expect(plan.visitsCovered).toBe(1);
    expect(plan.visitsUncovered).toBe(1);

    const result = await applyEngagementCompaction(plan, new Set(['v-covered']), { force: true });
    expect(result.skipped).toBeNull();
    expect(result.droppedLines).toBe(3);
    expect(result.rewrittenShards).toBe(1);

    const after = deriveServingQuantities(await readEvents([sealedPath, livePath]));
    // The invariant, all three quantities, as bytes.
    expect(after.aggregatesPerVisit).toBe(before.aggregatesPerVisit);
    expect(after.focusedWindowMsPerVisit).toBe(before.focusedWindowMsPerVisit);
    expect(after.eligibilitySet).toBe(before.eligibilitySet);
  });

  it('never drops an interval whose visit has no durable aggregate', async () => {
    await writeFixture();
    const plan = await planEngagementCompaction(vaultRoot, {
      now: new Date('2026-07-29T12:00:00Z'),
      retainDays: 30,
    });
    await applyEngagementCompaction(plan, new Set(['v-covered']), { force: true });

    const survivors = await readEvents([sealedPath]);
    const remainingIntervals = survivors.filter(
      (candidate) => candidate.type === ENGAGEMENT_INTERVAL_OBSERVED,
    );
    // Exactly the uncovered visit's interval survives — for that visit the raw
    // interval is the ONLY engagement record, so dropping it WOULD lose data.
    expect(remainingIntervals.length).toBe(1);
    expect((remainingIntervals[0]?.payload as { visitId: string }).visitId).toBe('v-uncovered');
    // Non-interval events are untouched — compaction is not a filter on the log.
    expect(survivors.filter((c) => c.type === NAVIGATION_COMMITTED).length).toBe(2);
  });

  it('leaves the live shard and in-retention shards alone', async () => {
    await writeFixture();
    const liveBefore = await readFile(livePath, 'utf8');
    const plan = await planEngagementCompaction(vaultRoot, {
      now: new Date('2026-07-29T12:00:00Z'),
      retainDays: 30,
    });
    await applyEngagementCompaction(plan, new Set(['v-covered']), { force: true });
    // Today's shard is live (a writer may be appending) and is never a
    // candidate, so its interval line survives byte-for-byte.
    expect(await readFile(livePath, 'utf8')).toBe(liveBefore);

    // A huge retention window makes even the sealed 2020 shard in-retention.
    const wide = await planEngagementCompaction(vaultRoot, {
      now: new Date('2026-07-29T12:00:00Z'),
      retainDays: 100_000,
    });
    expect(wide.shards).toEqual([]);
    expect(wide.intervalsFolded).toBe(0);
  });

  it('is DISARMED by default and refuses to rewrite while blocked', async () => {
    await writeFixture();
    const plan = await planEngagementCompaction(vaultRoot, {
      now: new Date('2026-07-29T12:00:00Z'),
      retainDays: 30,
    });
    // Default: SIDETRACK_ENGAGEMENT_COMPACT unset ⇒ not armed, no rewrite.
    expect(plan.armed).toBe(false);
    expect(plan.wouldRewrite).toBe(false);
    const notArmed = await applyEngagementCompaction(plan, new Set(['v-covered']));
    expect(notArmed.skipped).toBe('not-armed');
    expect(notArmed.droppedLines).toBe(0);
    // The shard is untouched — a disarmed apply must be a pure no-op.
    const survivors = await readEvents([sealedPath]);
    expect(survivors.filter((c) => c.type === ENGAGEMENT_INTERVAL_OBSERVED).length).toBe(4);

    // Arming alone is NOT enough: the accounting blockers still stand, so the
    // apply refuses and names them. This is the shipped posture.
    process.env['SIDETRACK_ENGAGEMENT_COMPACT'] = '1';
    const armedPlan = await planEngagementCompaction(vaultRoot, {
      now: new Date('2026-07-29T12:00:00Z'),
      retainDays: 30,
    });
    expect(armedPlan.armed).toBe(true);
    expect(armedPlan.wouldRewrite).toBe(false);
    const blocked = await applyEngagementCompaction(armedPlan, new Set(['v-covered']));
    expect(blocked.skipped).toBe('blocked');
    expect(blocked.errors.length).toBeGreaterThan(0);
    expect(blocked.errors.join(' ')).toContain('watermark-density-reconciliation');
  });

  it('names the blockers with severity and evidence, and clears the offline one', async () => {
    const blockers = engagementCompactionBlockers(vaultRoot);
    const ids = blockers.map((blocker) => blocker.id);
    // The dense-seq reconciliation blocker is unconditional: any drop makes
    // sum(watermark) - count() non-zero, which the §15 ledger records as a
    // dirty day for at least a week.
    expect(ids).toContain('watermark-density-reconciliation');
    // The append-index blocker is conditional on running in-process.
    expect(ids).toContain('append-indexes-no-signature-guard');
    expect(engagementCompactionBlockers(vaultRoot, { offline: true }).map((b) => b.id)).not.toContain(
      'append-indexes-no-signature-guard',
    );
    // Observability degradation is reported but does NOT block.
    const probe = blockers.find((blocker) => blocker.id === 'engagement-lane-health-probe-blind');
    expect(probe?.severity).toBe('degrades-observability');
    // Every blocker carries the code that breaks and what would clear it —
    // machine-readable, not just a comment.
    for (const blocker of blockers) {
      expect(blocker.evidence.length).toBeGreaterThan(0);
      expect(blocker.clearedBy.length).toBeGreaterThan(0);
    }
  });

  it('rewrites atomically: a shard is fully old or fully new, never partial', async () => {
    await writeFixture();
    const plan = await planEngagementCompaction(vaultRoot, {
      now: new Date('2026-07-29T12:00:00Z'),
      retainDays: 30,
    });
    await applyEngagementCompaction(plan, new Set(['v-covered']), { force: true });
    const raw = await readFile(sealedPath, 'utf8');
    // Every line still parses (no torn tail) and the file ends with a newline,
    // so a subsequent append lands on a fresh line rather than mid-record.
    expect(raw.endsWith('\n')).toBe(true);
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
    // The temp file is gone — renamed, not left behind.
    await expect(readFile(`${sealedPath}.compact.tmp`, 'utf8')).rejects.toThrow();
  });
});
