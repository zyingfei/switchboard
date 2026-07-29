import { createReadStream, existsSync } from 'node:fs';
import { readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import {
  ENGAGEMENT_INTERVAL_OBSERVED,
  ENGAGEMENT_SESSION_AGGREGATED,
} from '../engagement/events.js';
import { eventStoreEnabled } from '../sync/eventStore.js';

// REPORT-ONLY log-compaction planner.
//
// The canonical JSONL event log is ~88-92% engagement.interval by line
// count and grows monotonically with browsing; no full-history consumer
// needs individual intervals once a session is aggregated. Compacting
// (dropping those lines from sealed past-day shards) would bound the
// forever-growth of readMerged + the default training scan — but the
// DESTRUCTIVE rewrite is NOT freeze-safe: the append-path indexes reject
// in-process shard rewrites, and dropping events changes which events
// fold into projections/graph. So this module ships the SAFE half: it
// REPORTS the reclaimable bytes per sealed past-day shard, mirroring
// gcInventory. It deletes NOTHING. The destructive pass is deferred to
// the §15 window (recorded as a followup).
//
// "Sealed" = a date-stamped shard strictly older than today (UTC), i.e.
// no replica is still appending to it. Today's shard (and any future-
// dated shard from a peer with a fast clock) is intentionally excluded —
// it is live and must never be rewritten.
//
// Cost: one streamed pass per sealed shard, testing the raw line for the
// engagement.interval needle BEFORE any JSON.parse (same pattern as
// eventLog.streamEvents), so the 92% bulk is measured by byte length
// without being parsed. Bounded, streaming, cooperative-yield — safe to
// run off a request or on a TTL like gcInventory. This is an inventory
// read, never invoked on the drain thread or a hot poll.

const LOG_ROOT_SEGMENTS = ['_BAC', 'log'] as const;
const SHARD_NAME_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/u;
// Raw needle: the type field is always serialised as `"type":"value"`,
// so this can only false-MATCH inside a payload (costs nothing here — we
// only measure bytes) and never false-NEGATIVE.
const INTERVAL_NEEDLE = `"type":"${ENGAGEMENT_INTERVAL_OBSERVED}"`;
// Yield to the loop every N lines so a large shard scan interleaves with
// other work (mirrors eventLog's EVENT_LOG_PARSE_YIELD_EVERY).
const YIELD_EVERY_LINES = 500;

export interface ShardCompactionReport {
  /** Shard file path. */
  readonly path: string;
  /** Owning replica id (the shard's parent dir name). */
  readonly replicaId: string;
  /** The shard's date stamp (YYYY-MM-DD). */
  readonly date: string;
  /** Total bytes on disk for this shard. */
  readonly totalBytes: number;
  /**
   * Bytes attributable to engagement.interval lines — the reclaimable
   * amount IF a future compaction pass dropped them. Reported only.
   */
  readonly reclaimableBytes: number;
  /** engagement.interval line count in this shard. */
  readonly intervalLines: number;
  /** Total line count in this shard. */
  readonly totalLines: number;
}

export interface CompactionPlan {
  readonly producedAt: string;
  /** Per-sealed-shard reports, sorted by path. */
  readonly shards: readonly ShardCompactionReport[];
  /** Sum of reclaimableBytes across all sealed shards. */
  readonly reclaimableBytes: number;
  /** Sum of totalBytes across all sealed shards. */
  readonly scannedBytes: number;
  /**
   * REPORT-ONLY marker. Always true — this planner never deletes. Kept
   * explicit so a caller can never mistake the plan for an actionable
   * GC plan (which has an applyGcPlan; this deliberately does not).
   */
  readonly reportOnly: true;
}

export interface BuildCompactionPlanOptions {
  /** Injectable clock for the today/sealed cutoff (tests). */
  readonly now?: Date;
}

const eventLogRoot = (vaultRoot: string): string => join(vaultRoot, ...LOG_ROOT_SEGMENTS);

const todayStamp = (now: Date): string => now.toISOString().slice(0, 10);

const listReplicaDirs = async (root: string): Promise<readonly string[]> => {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
};

const listShards = async (
  dir: string,
): Promise<readonly { readonly path: string; readonly date: string }[]> => {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  const out: { path: string; date: string }[] = [];
  for (const name of names) {
    const match = SHARD_NAME_RE.exec(name);
    if (match === null) continue;
    out.push({ path: join(dir, name), date: match[1] as string });
  }
  return out;
};

const scanShard = async (
  path: string,
  replicaId: string,
  date: string,
): Promise<ShardCompactionReport> => {
  const info = await stat(path);
  let reclaimableBytes = 0;
  let intervalLines = 0;
  let totalLines = 0;
  let processed = 0;
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.length === 0) continue;
    totalLines += 1;
    if (line.includes(INTERVAL_NEEDLE)) {
      intervalLines += 1;
      // +1 for the newline that the readline split consumed; a dropped
      // line reclaims its bytes AND its separator.
      reclaimableBytes += Buffer.byteLength(line, 'utf8') + 1;
    }
    processed += 1;
    if (processed % YIELD_EVERY_LINES === 0) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
  }
  return {
    path,
    replicaId,
    date,
    totalBytes: info.size,
    reclaimableBytes,
    intervalLines,
    totalLines,
  };
};

/**
 * Build a REPORT-ONLY compaction plan: the reclaimable engagement.interval
 * bytes per sealed (strictly-past-day) shard. Deletes nothing, mutates
 * nothing on disk. Today's shard and any future-dated shard are excluded.
 */
export const buildCompactionPlan = async (
  vaultRoot: string,
  options: BuildCompactionPlanOptions = {},
): Promise<CompactionPlan> => {
  const now = options.now ?? new Date();
  const cutoff = todayStamp(now);
  const root = eventLogRoot(vaultRoot);

  const shards: ShardCompactionReport[] = [];
  for (const replicaId of await listReplicaDirs(root)) {
    for (const shard of await listShards(join(root, replicaId))) {
      // Lexicographic compare is correct for YYYY-MM-DD; only strictly
      // older shards are sealed. `>=` cutoff (today or a future-dated
      // peer shard) is live — skip it.
      if (shard.date >= cutoff) continue;
      shards.push(await scanShard(shard.path, replicaId, shard.date));
    }
  }

  shards.sort((left, right) => left.path.localeCompare(right.path));
  return {
    producedAt: now.toISOString(),
    shards,
    reclaimableBytes: shards.reduce((sum, s) => sum + s.reclaimableBytes, 0),
    scannedBytes: shards.reduce((sum, s) => sum + s.totalBytes, 0),
    reportOnly: true,
  };
};

// ===========================================================================
// ENGAGEMENT-INTERVAL COMPACTION (2026-07-29)
// ===========================================================================
//
// THE MEASUREMENT. `engagement.interval.observed` is 58.4% of a 580 MB event
// log on the dogfood vault (~339 MB, sampled over the three largest shards),
// the single biggest compressible mass in the whole 2.9 GB vault. The user's
// ask was literally "engagement data points … taking too much space".
//
// THE SEMANTIC ANSWER: SAFE. A full census of every reader (19 files touch the
// type; 9 non-test) found NOTHING that serves off raw intervals:
//   - the visit-similarity engagement gate (>=5s focusedWindowMs) reads
//     `engagement.session.aggregated` + `browser.timeline.observed`, never
//     intervals (visitSimilarity.ts:1216/1432/1464, timelineDays.ts:22-33,
//     connectionsMaterializer.ts:1944-1972);
//   - the ranker's trainable shard EXCLUDES them by type
//     (trainableEventsShard.ts:45-52) and features.ts reads only the aggregate;
//   - the connections graph treats them as CONTENT_LANE_ONLY_HANDLES with an
//     EMPTY invalidation set — they contribute zero graph rows;
//   - every `rebuildFromJsonl` (engagement facts, timeline facts, event store)
//     projects the aggregate, not the interval.
// The reason this holds is structural, not incidental: the aggregate is NOT
// derived from intervals inside the companion at all. The EXTENSION folds
// per-tab intervals (engagementSessionStore.ts:150-176) and posts BOTH types
// independently to /v1/edge/events, so `engagement.session.aggregated` is an
// INGESTED PRIMARY EVENT. There is no fold to preserve. (The brief assumed a
// companion-side fold that would need re-running before a drop; the only such
// fold is backfillSessionAggregates.ts, an already-completed one-shot repair
// for visits that have NO aggregate — which is exactly the coverage check
// below, and the reason it is a per-visit check rather than a re-fold.)
//
// THE OPERATIONAL ANSWER: BLOCKED, and this is why the rewrite ships DISARMED
// with the blockers in the PAYLOAD rather than only in a comment. Dropping
// lines from sealed shards trips four accounting mechanisms that do not care
// that the drop was semantically safe:
//
//   1. event-store shard re-parse storm (BLOCKING). eventStore.ts guards shard
//      re-reads on (path, size, mtime) with a stored read_offset. A compacted
//      shard mismatches, and because its stored offset now EXCEEDS the file
//      size the guard resets the offset to 0 and re-parses the whole shard —
//      where every surviving line is at-or-below the watermark and increments
//      `storeSkippedOutOfOrder` (eventStore.ts:407-411). That counter is in
//      anyLaneCounterNonZero, so /v1/system/health goes `failed`
//      (health.ts:473). Persisted `shard_progress` rows mean this fires on the
//      NEXT enable even if the store is off right now.
//   2. dense-seq reconciliation (BLOCKING). dataLoss.reconciliation computes
//      `sum(watermark) - store.count()` and calls any non-zero delta a
//      durability red flag (server.ts:6351-6358). Compaction makes the edge
//      replica's seqs sparse BY CONSTRUCTION, so the delta goes permanently
//      non-zero, and companion.ts:1168-1176 folds that into the §15 clean-day
//      ledger — which is write-once-dirty over a 60-day window, so it would
//      break the ">=7 consecutive clean days" gate for at least a week and a
//      restart would not clear it.
//   3. append indexes have no signature guard by default (BLOCKING). eventLog's
//      AppendIndexes are add-only and only signature-checked when
//      `externalWritersPossible` is true (default false). eventLog.ts:923-926
//      states outright that "rewriting/compacting shard files while the process
//      runs is not supported"; the failure mode is a thrown "Event log
//      inconsistent: clientEventId is indexed but unreadable from the shards".
//   4. engagementLaneHealth goes blind (DEGRADES OBSERVABILITY, not blocking).
//      Its interval-vs-aggregate divergence probe reads
//      maxAcceptedAtMsForType(interval); with old intervals gone it can report
//      `intervalsFlowing: false` and silently stop detecting the very
//      regression it was built for (the 2026-06-27 aggregate outage).
//
// So: the planner computes the real number, the rewrite is implemented and
// atomic, and `wouldRewrite` is false until an operator both arms the flag AND
// the blocking preconditions clear. A correct "cannot do this safely because X"
// beats a lossy compaction — and X is now machine-readable.

/** Default retention for raw intervals before they become compaction candidates. */
export const ENGAGEMENT_COMPACT_DAYS_DEFAULT = 30;

export const engagementCompactDays = (): number => {
  const raw = process.env['SIDETRACK_ENGAGEMENT_COMPACT_DAYS'];
  if (raw === undefined) return ENGAGEMENT_COMPACT_DAYS_DEFAULT;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : ENGAGEMENT_COMPACT_DAYS_DEFAULT;
};

/**
 * Is the DESTRUCTIVE rewrite armed? Defaults OFF — it deletes log lines, and
 * the repo rule is that anything which deletes data must be opted into. Arming
 * it is still not sufficient: `wouldRewrite` also requires every BLOCKING
 * blocker to have cleared.
 */
export const engagementCompactArmed = (): boolean => {
  const raw = process.env['SIDETRACK_ENGAGEMENT_COMPACT'];
  return raw === '1' || raw === 'true';
};

export type CompactionBlockerSeverity = 'blocking' | 'degrades-observability';

export interface CompactionBlocker {
  readonly id: string;
  readonly severity: CompactionBlockerSeverity;
  /** What breaks, in plain words. */
  readonly detail: string;
  /** Where to read the code that breaks — `file:line`. */
  readonly evidence: string;
  /** What would have to change for this to clear. */
  readonly clearedBy: string;
}

export interface EngagementShardPlan {
  readonly path: string;
  readonly replicaId: string;
  readonly date: string;
  readonly totalBytes: number;
  readonly totalLines: number;
  readonly intervalLines: number;
  /** Interval lines whose visit HAS a durable aggregate — droppable. */
  readonly coveredIntervalLines: number;
  readonly coveredBytes: number;
  /**
   * Interval lines whose visit has NO durable aggregate anywhere in the log.
   * For those visits the raw intervals are the ONLY engagement record, so
   * dropping them WOULD lose data. Never counted as reclaimable, never
   * rewritten — `sidetrack engagement backfill-aggregates` is what makes them
   * droppable, by synthesizing the missing aggregate first.
   */
  readonly uncoveredIntervalLines: number;
  readonly uncoveredBytes: number;
}

export interface EngagementCompactionPlan {
  readonly producedAt: string;
  readonly retainDays: number;
  /** Intervals in shards strictly older than this UTC date are candidates. */
  readonly cutoffDate: string;
  readonly shards: readonly EngagementShardPlan[];
  /** Interval events that would be folded away (covered ones only). */
  readonly intervalsFolded: number;
  readonly bytesReclaimable: number;
  /** Distinct visits observed in candidate shards, split by aggregate coverage. */
  readonly visitsCovered: number;
  readonly visitsUncovered: number;
  /** SIDETRACK_ENGAGEMENT_COMPACT. */
  readonly armed: boolean;
  readonly blockers: readonly CompactionBlocker[];
  /** armed AND no blocking blocker. The only condition under which apply runs. */
  readonly wouldRewrite: boolean;
}

const AGGREGATE_NEEDLE = `"type":"${ENGAGEMENT_SESSION_AGGREGATED}"`;
/** `"visitId":"…"` — extracted by needle, not JSON.parse, so the 58% interval
 *  bulk is never parsed (same discipline as INTERVAL_NEEDLE above). */
const VISIT_ID_RE = /"visitId":"([^"]+)"/u;

const dateMinusDays = (now: Date, days: number): string =>
  new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);

/**
 * Which accounting mechanisms currently block a rewrite. Computed from the live
 * config, not hardcoded: an operator who has cleared one should see it clear.
 */
export const engagementCompactionBlockers = (
  vaultRoot: string,
  options: { readonly offline?: boolean } = {},
): readonly CompactionBlocker[] => {
  const blockers: CompactionBlocker[] = [];
  const storeDbPath = join(vaultRoot, '_BAC', 'connections', 'event-store.db');
  if (eventStoreEnabled() || existsSync(storeDbPath)) {
    blockers.push({
      id: 'event-store-shard-progress-reparse',
      severity: 'blocking',
      detail:
        'the event store re-parses any shard whose size/mtime changed, and a shrunk shard resets its read_offset to 0 — every surviving line then increments storeSkippedOutOfOrder, which drives /v1/system/health to failed',
      evidence: 'src/sync/eventStore.ts:359-373,407-411; src/system/health.ts:273-278,473',
      clearedBy:
        'teach shard_progress that a SHRUNK shard was compacted (not torn) — e.g. persist a compaction generation per shard and skip-not-reset on a recognised shrink',
    });
  }
  blockers.push({
    id: 'watermark-density-reconciliation',
    severity: 'blocking',
    detail:
      'dataLoss.reconciliation computes sum(watermark) - store.count() and treats any non-zero delta as a durability red flag; dropping events makes the edge replica seqs sparse, so the delta goes permanently non-zero and the §15 clean-day ledger records the day dirty (write-once over a 60-day window)',
    evidence: 'src/http/server.ts:6351-6358; src/runtime/companion.ts:1168-1176; src/system/section15Counters.ts:113-114',
    clearedBy:
      'account for intentionally-compacted events in the expected count (a persisted compactedCount per replica subtracted from sum(watermark))',
  });
  if (options.offline !== true && process.env['SIDETRACK_EXTERNAL_WRITERS'] !== '1') {
    blockers.push({
      id: 'append-indexes-no-signature-guard',
      severity: 'blocking',
      detail:
        "eventLog's in-memory append indexes are add-only and are only signature-checked when external writers are possible (default: not), so a rewrite under a running companion makes them claim dropped events still exist — the next append throws 'Event log inconsistent: … indexed but unreadable from the shards'",
      evidence: 'src/sync/eventLog.ts:923-926,985-1001,1059-1064',
      clearedBy:
        'run the rewrite with the companion stopped (pass offline:true) or with SIDETRACK_EXTERNAL_WRITERS=1 so the signature guard is active',
    });
  }
  blockers.push({
    id: 'engagement-lane-health-probe-blind',
    severity: 'degrades-observability',
    detail:
      'the interval-vs-aggregate divergence probe reads maxAcceptedAtMsForType(interval); with old intervals gone it can report intervalsFlowing:false and stop detecting the aggregate outage it was built for',
    evidence: 'src/system/engagementLaneHealth.ts:75,95',
    clearedBy:
      'have the probe treat "no intervals in the retained window" as unknown rather than not-flowing',
  });
  return blockers;
};

/**
 * PLAN-FIRST engagement-interval compaction. Streams the log once, deciding per
 * interval line whether its visit already has a durable aggregate. Deletes and
 * rewrites NOTHING.
 *
 * COST: one streamed pass over every shard (needed because a visit's aggregate
 * can live in a LATER shard than its intervals, so coverage is a global fact).
 * Needle-matched, never JSON.parsed on the bulk, cooperative-yield — the same
 * discipline as buildCompactionPlan. Off-request only.
 */
export const planEngagementCompaction = async (
  vaultRoot: string,
  options: {
    readonly now?: Date;
    readonly retainDays?: number;
    readonly offline?: boolean;
  } = {},
): Promise<EngagementCompactionPlan> => {
  const now = options.now ?? new Date();
  const retainDays = options.retainDays ?? engagementCompactDays();
  const today = todayStamp(now);
  const retainCutoff = dateMinusDays(now, retainDays);
  // A candidate shard is SEALED (strictly before today — nobody is appending)
  // AND older than the retention window. Both conditions, not either: a sealed
  // shard from yesterday is still inside the retention the operator asked for.
  const cutoffDate = retainCutoff < today ? retainCutoff : today;
  const root = eventLogRoot(vaultRoot);

  // Pass 1 collects both facts in one read: the global covered-visit set (from
  // aggregate lines, ~0.6% of bytes) and, for candidate shards only, the
  // per-visit interval line/byte inventory.
  const coveredVisits = new Set<string>();
  const candidateVisitBytes = new Map<string, Map<string, { lines: number; bytes: number }>>();
  const shardMeta = new Map<
    string,
    { replicaId: string; date: string; totalBytes: number; totalLines: number; intervalLines: number }
  >();

  for (const replicaId of await listReplicaDirs(root)) {
    for (const shard of await listShards(join(root, replicaId))) {
      const isCandidate = shard.date < cutoffDate;
      const info = await stat(shard.path);
      const perVisit = new Map<string, { lines: number; bytes: number }>();
      let totalLines = 0;
      let intervalLines = 0;
      let processed = 0;
      const lines = createInterface({
        input: createReadStream(shard.path, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      });
      for await (const line of lines) {
        if (line.length === 0) continue;
        totalLines += 1;
        if (line.includes(AGGREGATE_NEEDLE)) {
          const visitId = VISIT_ID_RE.exec(line)?.[1];
          if (visitId !== undefined) coveredVisits.add(visitId);
        } else if (line.includes(INTERVAL_NEEDLE)) {
          intervalLines += 1;
          if (isCandidate) {
            const visitId = VISIT_ID_RE.exec(line)?.[1] ?? '(no-visit-id)';
            const bucket = perVisit.get(visitId) ?? { lines: 0, bytes: 0 };
            bucket.lines += 1;
            bucket.bytes += Buffer.byteLength(line, 'utf8') + 1;
            perVisit.set(visitId, bucket);
          }
        }
        processed += 1;
        if (processed % YIELD_EVERY_LINES === 0) {
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
        }
      }
      if (isCandidate) {
        candidateVisitBytes.set(shard.path, perVisit);
        shardMeta.set(shard.path, {
          replicaId,
          date: shard.date,
          totalBytes: info.size,
          totalLines,
          intervalLines,
        });
      }
    }
  }

  const coveredSeen = new Set<string>();
  const uncoveredSeen = new Set<string>();
  const shards: EngagementShardPlan[] = [];
  for (const [path, perVisit] of candidateVisitBytes) {
    const meta = shardMeta.get(path);
    if (meta === undefined) continue;
    let coveredIntervalLines = 0;
    let coveredBytes = 0;
    let uncoveredIntervalLines = 0;
    let uncoveredBytes = 0;
    for (const [visitId, counts] of perVisit) {
      // A visit with no aggregate anywhere: its intervals are the only record.
      // Excluded from reclaimable, never rewritten.
      if (coveredVisits.has(visitId)) {
        coveredSeen.add(visitId);
        coveredIntervalLines += counts.lines;
        coveredBytes += counts.bytes;
      } else {
        uncoveredSeen.add(visitId);
        uncoveredIntervalLines += counts.lines;
        uncoveredBytes += counts.bytes;
      }
    }
    shards.push({
      path,
      replicaId: meta.replicaId,
      date: meta.date,
      totalBytes: meta.totalBytes,
      totalLines: meta.totalLines,
      intervalLines: meta.intervalLines,
      coveredIntervalLines,
      coveredBytes,
      uncoveredIntervalLines,
      uncoveredBytes,
    });
  }
  shards.sort((left, right) => left.path.localeCompare(right.path));

  const blockers = engagementCompactionBlockers(vaultRoot, {
    ...(options.offline === undefined ? {} : { offline: options.offline }),
  });
  const armed = engagementCompactArmed();
  return {
    producedAt: now.toISOString(),
    retainDays,
    cutoffDate,
    shards,
    intervalsFolded: shards.reduce((sum, shard) => sum + shard.coveredIntervalLines, 0),
    bytesReclaimable: shards.reduce((sum, shard) => sum + shard.coveredBytes, 0),
    visitsCovered: coveredSeen.size,
    visitsUncovered: uncoveredSeen.size,
    armed,
    blockers,
    wouldRewrite: armed && !blockers.some((blocker) => blocker.severity === 'blocking'),
  };
};

export interface EngagementCompactionResult {
  readonly rewrittenShards: number;
  readonly droppedLines: number;
  readonly reclaimedBytes: number;
  readonly skipped: 'not-armed' | 'blocked' | null;
  readonly errors: readonly string[];
}

/**
 * Apply a plan: rewrite each candidate shard WITHOUT the droppable interval
 * lines. Refuses unless `plan.wouldRewrite` (armed and unblocked); `force` is
 * for tests, which is also how the golden invariant below can be proved without
 * arming anything in production.
 *
 * ATOMIC PER SHARD: write the survivors to `<shard>.compact.tmp`, then rename
 * over the shard. A rename is atomic within a filesystem, so a shard is either
 * fully old or fully new — never a half-written log. A crash mid-write leaves
 * the tmp file (cleaned by the connections-temp GC family's sibling discipline
 * and by the next run's overwrite), never a truncated shard.
 *
 * The drop predicate re-derives coverage from the PLAN, not from a second scan,
 * so what gets deleted is exactly what was reported.
 */
export const applyEngagementCompaction = async (
  plan: EngagementCompactionPlan,
  coveredVisitIds: ReadonlySet<string>,
  options: { readonly force?: boolean } = {},
): Promise<EngagementCompactionResult> => {
  if (options.force !== true) {
    if (!plan.armed) {
      return {
        rewrittenShards: 0,
        droppedLines: 0,
        reclaimedBytes: 0,
        skipped: 'not-armed',
        errors: [],
      };
    }
    if (!plan.wouldRewrite) {
      return {
        rewrittenShards: 0,
        droppedLines: 0,
        reclaimedBytes: 0,
        skipped: 'blocked',
        errors: plan.blockers
          .filter((blocker) => blocker.severity === 'blocking')
          .map((blocker) => `${blocker.id}: ${blocker.detail}`),
      };
    }
  }
  let rewrittenShards = 0;
  let droppedLines = 0;
  let reclaimedBytes = 0;
  const errors: string[] = [];
  for (const shard of plan.shards) {
    if (shard.coveredIntervalLines === 0) continue;
    const tmp = `${shard.path}.compact.tmp`;
    try {
      const survivors: string[] = [];
      let dropped = 0;
      let droppedBytes = 0;
      const lines = createInterface({
        input: createReadStream(shard.path, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      });
      for await (const line of lines) {
        if (line.length === 0) continue;
        if (line.includes(INTERVAL_NEEDLE)) {
          const visitId = VISIT_ID_RE.exec(line)?.[1] ?? '(no-visit-id)';
          if (coveredVisitIds.has(visitId)) {
            dropped += 1;
            droppedBytes += Buffer.byteLength(line, 'utf8') + 1;
            continue;
          }
        }
        survivors.push(line);
      }
      await writeFile(tmp, survivors.length === 0 ? '' : `${survivors.join('\n')}\n`, 'utf8');
      await rename(tmp, shard.path);
      rewrittenShards += 1;
      droppedLines += dropped;
      reclaimedBytes += droppedBytes;
    } catch (error) {
      errors.push(`${shard.path}: ${error instanceof Error ? error.message : String(error)}`);
      await unlink(tmp).catch(() => undefined);
    }
  }
  return { rewrittenShards, droppedLines, reclaimedBytes, skipped: null, errors };
};
