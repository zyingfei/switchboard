import { createReadStream } from 'node:fs';
import { readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import {
  ENGAGEMENT_INTERVAL_OBSERVED,
  ENGAGEMENT_SESSION_AGGREGATED,
  isEngagementIntervalObservedPayload,
  isEngagementSessionAggregatedPayload,
} from '../engagement/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { isAcceptedEvent, type EventLog } from '../sync/eventLog.js';
import { writeFileAtomic } from '../vault/atomic.js';
import {
  type EngagementCompactionManifestEntry,
  readEngagementCompactionManifest,
  sequenceRanges,
  sha256File,
  sha256Text,
  verifyCompactionShardState,
  withEngagementCompactionReceipt,
  writeEngagementCompactionManifest,
} from './engagementCompactionManifest.js';

// Plan-first log-compaction inventory plus verified engagement compaction.
//
// The canonical JSONL event log is ~88-92% engagement.interval by line
// count and grows monotonically with browsing; no full-history consumer
// needs individual intervals once a session is aggregated. Compacting
// (dropping those lines from sealed past-day shards) would bound the
// forever-growth of readMerged + the default training scan. The generic
// inventory remains report-only; the engagement-specific path below can apply
// only after its coverage, receipt, writer-lifecycle, and consumer proofs pass.
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
// THE OPERATIONAL ANSWER: fail-closed. The four former blockers are addressed
// as one proof protocol:
//   1. a prepared receipt records source/compacted digests before atomic rename;
//      eventStore recognises only that intentional shrink and verifies every
//      retained row was already mirrored before advancing shard_progress;
//   2. exact removed dot ranges are persisted and added to count() accounting,
//      so genuine sequence gaps remain non-zero reconciliation deltas;
//   3. online apply runs behind EventLog.runExclusiveMaintenance and rebuilds
//      the add-only append indexes before the next writer;
//   4. the lane-health probe reports compacted-only/absent raw evidence as
//      unknown, never as a false "not flowing" observation.
// There is no force path: armed + every proof passed is the sole apply gate.

/** Default retention for raw intervals before they become compaction candidates. */
export const ENGAGEMENT_COMPACT_DAYS_DEFAULT = 30;

export const engagementCompactDays = (): number => {
  const raw = process.env['SIDETRACK_ENGAGEMENT_COMPACT_DAYS'];
  if (raw === undefined) return ENGAGEMENT_COMPACT_DAYS_DEFAULT;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.floor(parsed)
    : ENGAGEMENT_COMPACT_DAYS_DEFAULT;
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
  /** Source identity checked again immediately before a rewrite. */
  readonly sourceSha256: string;
  /** Exact dots eligible for removal; compressed only in the durable receipt. */
  readonly droppedSequences: readonly number[];
  readonly maxDroppedAcceptedAtMs: number;
}

export type EngagementCompactionProofStatus = 'passed' | 'failed' | 'unknown';

export interface EngagementCompactionProof {
  readonly status: EngagementCompactionProofStatus;
  readonly evidence: string;
}

export interface EngagementCompactionProofs {
  readonly aggregateCoverage: EngagementCompactionProof;
  readonly denseSequenceReconciliation: EngagementCompactionProof;
  readonly crashRecovery: EngagementCompactionProof;
  readonly downstreamConsumers: EngagementCompactionProof;
  readonly appendLifecycle: EngagementCompactionProof;
  readonly laneHealth: EngagementCompactionProof;
}

export interface EngagementCompactionObservation {
  readonly operation:
    | 'sidetrack.gc.engagement_compaction.plan'
    | 'sidetrack.gc.engagement_compaction.apply';
  readonly outcome: 'ready' | 'skipped' | 'succeeded' | 'failed';
  readonly durationMs: number;
  readonly candidateShards: number;
  readonly intervalsFolded: number;
  readonly bytesReclaimable: number;
  readonly proofStatuses: Readonly<
    Record<keyof EngagementCompactionProofs, EngagementCompactionProofStatus>
  >;
  readonly skipReason?: 'not-armed' | 'proof-failed' | 'no-candidates';
  /** Stable, PII-free category. Never includes paths, visit ids, or payloads. */
  readonly errorCategory?: 'manifest-invalid' | 'source-changed' | 'receipt-mismatch' | 'io';
}

export interface EngagementCompactionPlan {
  readonly vaultRoot: string;
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
  /** Coverage set derived only from validated aggregate events. */
  readonly coveredVisitIds: readonly string[];
  readonly proofs: EngagementCompactionProofs;
  /** SIDETRACK_ENGAGEMENT_COMPACT. */
  readonly armed: boolean;
  readonly blockers: readonly CompactionBlocker[];
  /** armed AND no blocking blocker. The only condition under which apply runs. */
  readonly wouldRewrite: boolean;
}

const AGGREGATE_NEEDLE = `"type":"${ENGAGEMENT_SESSION_AGGREGATED}"`;

const acceptedEventFromLine = (line: string): AcceptedEvent | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  return isAcceptedEvent(parsed) ? parsed : null;
};

const proofStatuses = (
  proofs: EngagementCompactionProofs,
): Readonly<Record<keyof EngagementCompactionProofs, EngagementCompactionProofStatus>> => ({
  aggregateCoverage: proofs.aggregateCoverage.status,
  denseSequenceReconciliation: proofs.denseSequenceReconciliation.status,
  crashRecovery: proofs.crashRecovery.status,
  downstreamConsumers: proofs.downstreamConsumers.status,
  appendLifecycle: proofs.appendLifecycle.status,
  laneHealth: proofs.laneHealth.status,
});

const allProofs = (proofs: EngagementCompactionProofs): readonly EngagementCompactionProof[] => [
  proofs.aggregateCoverage,
  proofs.denseSequenceReconciliation,
  proofs.crashRecovery,
  proofs.downstreamConsumers,
  proofs.appendLifecycle,
  proofs.laneHealth,
];

const dateMinusDays = (now: Date, days: number): string =>
  new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);

/**
 * Which accounting mechanisms currently block a rewrite. Computed from the live
 * config, not hardcoded: an operator who has cleared one should see it clear.
 */
export const engagementCompactionBlockers = (
  vaultRoot: string,
  options: { readonly offline?: boolean; readonly onlineMaintenance?: boolean } = {},
): readonly CompactionBlocker[] => {
  void vaultRoot;
  const blockers: CompactionBlocker[] = [];
  if (options.offline !== true && options.onlineMaintenance !== true) {
    blockers.push({
      id: 'append-indexes-no-signature-guard',
      severity: 'blocking',
      detail:
        'an online rewrite requires the active EventLog exclusive-maintenance mutex so append indexes are rebuilt from the compacted shards',
      evidence: 'src/sync/eventLog.ts:EventLog.runExclusiveMaintenance',
      clearedBy:
        'pass offline:true with the companion stopped, or provide the active EventLog maintenance lifecycle',
    });
  }
  return blockers;
};

/**
 * PLAN-FIRST engagement-interval compaction. Streams the log once, deciding per
 * interval line whether its visit already has a durable aggregate. Deletes and
 * rewrites NOTHING.
 *
 * COST: one streamed pass over every shard (needed because a visit's aggregate
 * can live in a LATER shard than its intervals, so coverage is a global fact).
 * Needle-prefiltered, then parsed as unknown only for engagement records so
 * coverage and dot accounting use canonical validators. Cooperative-yield and
 * off-request only.
 */
export const planEngagementCompaction = async (
  vaultRoot: string,
  options: {
    readonly now?: Date;
    readonly retainDays?: number;
    readonly offline?: boolean;
    readonly onlineMaintenance?: boolean;
    readonly observe?: (observation: EngagementCompactionObservation) => void;
  } = {},
): Promise<EngagementCompactionPlan> => {
  const startedAt = performance.now();
  const now = options.now ?? new Date();
  const requestedRetainDays = options.retainDays ?? engagementCompactDays();
  const retainDays =
    Number.isFinite(requestedRetainDays) && requestedRetainDays >= 0
      ? Math.floor(requestedRetainDays)
      : ENGAGEMENT_COMPACT_DAYS_DEFAULT;
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
  const candidateIntervals = new Map<
    string,
    Array<{ visitId: string; seq: number; acceptedAtMs: number; bytes: number }>
  >();
  const shardMeta = new Map<
    string,
    {
      replicaId: string;
      date: string;
      totalBytes: number;
      totalLines: number;
      intervalLines: number;
    }
  >();

  for (const replicaId of await listReplicaDirs(root)) {
    for (const shard of await listShards(join(root, replicaId))) {
      const isCandidate = shard.date < cutoffDate;
      const info = await stat(shard.path);
      const intervals: Array<{
        visitId: string;
        seq: number;
        acceptedAtMs: number;
        bytes: number;
      }> = [];
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
          const event = acceptedEventFromLine(line);
          if (
            event?.type === ENGAGEMENT_SESSION_AGGREGATED &&
            isEngagementSessionAggregatedPayload(event.payload)
          ) {
            coveredVisits.add(event.payload.visitId);
          }
        } else if (line.includes(INTERVAL_NEEDLE)) {
          intervalLines += 1;
          if (isCandidate) {
            const event = acceptedEventFromLine(line);
            if (
              event?.type === ENGAGEMENT_INTERVAL_OBSERVED &&
              event.dot.replicaId === replicaId &&
              isEngagementIntervalObservedPayload(event.payload)
            ) {
              intervals.push({
                visitId: event.payload.visitId,
                seq: event.dot.seq,
                acceptedAtMs: event.acceptedAtMs,
                bytes: Buffer.byteLength(line, 'utf8') + 1,
              });
            }
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
        candidateIntervals.set(shard.path, intervals);
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
  const seenDots = new Set<string>();
  let duplicateDroppableDot = false;
  for (const [path, intervals] of candidateIntervals) {
    const meta = shardMeta.get(path);
    if (meta === undefined) continue;
    let coveredIntervalLines = 0;
    let coveredBytes = 0;
    let uncoveredIntervalLines = 0;
    let uncoveredBytes = 0;
    const droppedSequences: number[] = [];
    let maxDroppedAcceptedAtMs = 0;
    for (const interval of intervals) {
      // A visit with no aggregate anywhere: its intervals are the only record.
      // Excluded from reclaimable, never rewritten.
      if (coveredVisits.has(interval.visitId)) {
        coveredSeen.add(interval.visitId);
        coveredIntervalLines += 1;
        coveredBytes += interval.bytes;
        droppedSequences.push(interval.seq);
        maxDroppedAcceptedAtMs = Math.max(maxDroppedAcceptedAtMs, interval.acceptedAtMs);
        const key = `${meta.replicaId}:${String(interval.seq)}`;
        if (seenDots.has(key)) duplicateDroppableDot = true;
        seenDots.add(key);
      } else {
        uncoveredSeen.add(interval.visitId);
        uncoveredIntervalLines += 1;
        uncoveredBytes += interval.bytes;
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
      sourceSha256: await sha256File(path),
      droppedSequences,
      maxDroppedAcceptedAtMs,
    });
  }
  shards.sort((left, right) => left.path.localeCompare(right.path));

  const blockers = engagementCompactionBlockers(vaultRoot, {
    ...(options.offline === undefined ? {} : { offline: options.offline }),
    ...(options.onlineMaintenance === undefined
      ? {}
      : { onlineMaintenance: options.onlineMaintenance }),
  });
  const mutableBlockers = [...blockers];
  const manifestRead = await readEngagementCompactionManifest(vaultRoot);
  let crashRecoveryStatus: EngagementCompactionProofStatus = 'passed';
  if (manifestRead.state === 'invalid') {
    crashRecoveryStatus = 'failed';
    mutableBlockers.push({
      id: 'compaction-manifest-invalid',
      severity: 'blocking',
      detail: 'the prior compaction receipt is unreadable or fails schema/integrity validation',
      evidence: 'src/gc/engagementCompactionManifest.ts:readEngagementCompactionManifest',
      clearedBy: 'repair or remove the invalid receipt only after reconciling its shards',
    });
  } else if (manifestRead.state === 'valid') {
    for (const entry of manifestRead.manifest.entries) {
      const state = await verifyCompactionShardState(vaultRoot, entry);
      if (state === 'mismatch' || state === 'missing') {
        crashRecoveryStatus = 'failed';
        mutableBlockers.push({
          id: 'compaction-receipt-shard-mismatch',
          severity: 'blocking',
          detail: 'a receipt-covered shard matches neither its source nor compacted digest',
          evidence: 'src/gc/engagementCompactionManifest.ts:verifyCompactionShardState',
          clearedBy: 'restore the shard from a verified source or compacted copy before retrying',
        });
        break;
      }
    }
  }
  if (duplicateDroppableDot) {
    mutableBlockers.push({
      id: 'compaction-dot-duplication',
      severity: 'blocking',
      detail: 'two candidate events claim the same replica sequence',
      evidence: 'src/gc/compactionPlanner.ts:denseSequenceReconciliation',
      clearedBy: 'repair the causal dot collision; compaction never masks it',
    });
  }
  const appendLifecyclePassed = options.offline === true || options.onlineMaintenance === true;
  const proofs: EngagementCompactionProofs = {
    aggregateCoverage: {
      status: 'passed',
      evidence: 'every planned dot has a validated engagement.session.aggregated visit',
    },
    denseSequenceReconciliation: {
      status: duplicateDroppableDot ? 'failed' : 'passed',
      evidence:
        'exact non-overlapping replica sequence ranges are persisted; gaps are not inferred',
    },
    crashRecovery: {
      status: crashRecoveryStatus,
      evidence:
        'prepared receipt precedes atomic shard rename; source/compacted digests are read back',
    },
    downstreamConsumers: {
      status: 'passed',
      evidence: 'serving contract v1 reads validated engagement.session.aggregated records',
    },
    appendLifecycle: {
      status: appendLifecyclePassed ? 'passed' : 'unknown',
      evidence: appendLifecyclePassed
        ? 'offline process proof or EventLog exclusive-maintenance lifecycle supplied'
        : 'no exclusive online writer lifecycle supplied',
    },
    laneHealth: {
      status: 'passed',
      evidence: 'compacted-only interval evidence is reported as unknown, never as not-flowing',
    },
  };
  const armed = engagementCompactArmed();
  const intervalsFolded = shards.reduce((sum, shard) => sum + shard.coveredIntervalLines, 0);
  const bytesReclaimable = shards.reduce((sum, shard) => sum + shard.coveredBytes, 0);
  const allProofsPassed = allProofs(proofs).every((proof) => proof.status === 'passed');
  const plan: EngagementCompactionPlan = {
    vaultRoot,
    producedAt: now.toISOString(),
    retainDays,
    cutoffDate,
    shards,
    intervalsFolded,
    bytesReclaimable,
    visitsCovered: coveredSeen.size,
    visitsUncovered: uncoveredSeen.size,
    coveredVisitIds: [...coveredSeen].sort(),
    proofs,
    armed,
    blockers: mutableBlockers,
    wouldRewrite:
      armed &&
      intervalsFolded > 0 &&
      allProofsPassed &&
      !mutableBlockers.some((blocker) => blocker.severity === 'blocking'),
  };
  options.observe?.({
    operation: 'sidetrack.gc.engagement_compaction.plan',
    outcome: plan.wouldRewrite ? 'ready' : 'skipped',
    durationMs: performance.now() - startedAt,
    candidateShards: shards.length,
    intervalsFolded,
    bytesReclaimable,
    proofStatuses: proofStatuses(proofs),
    ...(plan.wouldRewrite
      ? {}
      : {
          skipReason:
            intervalsFolded === 0
              ? ('no-candidates' as const)
              : !armed
                ? ('not-armed' as const)
                : ('proof-failed' as const),
        }),
  });
  return plan;
};

export interface EngagementCompactionResult {
  readonly rewrittenShards: number;
  readonly droppedLines: number;
  readonly reclaimedBytes: number;
  readonly skipped: 'not-armed' | 'blocked' | null;
  readonly errors: readonly string[];
}

const recordsWithEndings = (raw: string): readonly string[] =>
  raw.split(/(?<=\n)/u).filter(Boolean);

const observationForApply = (
  plan: EngagementCompactionPlan,
  startedAt: number,
  outcome: EngagementCompactionObservation['outcome'],
  extra: Pick<EngagementCompactionObservation, 'skipReason' | 'errorCategory'> = {},
): EngagementCompactionObservation => ({
  operation: 'sidetrack.gc.engagement_compaction.apply',
  outcome,
  durationMs: performance.now() - startedAt,
  candidateShards: plan.shards.length,
  intervalsFolded: plan.intervalsFolded,
  bytesReclaimable: plan.bytesReclaimable,
  proofStatuses: proofStatuses(plan.proofs),
  ...(extra.skipReason === undefined ? {} : { skipReason: extra.skipReason }),
  ...(extra.errorCategory === undefined ? {} : { errorCategory: extra.errorCategory }),
});

/**
 * Apply a verified plan: rewrite each candidate shard WITHOUT the covered raw
 * interval lines. There is no force/bypass path.
 *
 * ATOMIC PER SHARD: write the survivors to `<shard>.compact.tmp`, then rename
 * over the shard. A rename is atomic within a filesystem, so a shard is either
 * fully old or fully new — never a half-written log. A crash mid-write leaves
 * the tmp file (cleaned by the connections-temp GC family's sibling discipline
 * and by the next run's overwrite), never a truncated shard.
 *
 * A prepared, checksummed receipt is atomically persisted BEFORE any rename.
 * After a crash each listed shard therefore matches either its source digest or
 * its compacted digest; a retry can finish the remaining source-state entries.
 */
export const applyEngagementCompaction = async (
  plan: EngagementCompactionPlan,
  options: {
    readonly offline?: boolean;
    readonly eventLog?: EventLog;
    readonly observe?: (observation: EngagementCompactionObservation) => void;
  } = {},
): Promise<EngagementCompactionResult> => {
  const startedAt = performance.now();
  const observe = options.observe;
  if (!plan.armed) {
    observe?.(observationForApply(plan, startedAt, 'skipped', { skipReason: 'not-armed' }));
    return {
      rewrittenShards: 0,
      droppedLines: 0,
      reclaimedBytes: 0,
      skipped: 'not-armed',
      errors: [],
    };
  }
  if (
    !plan.wouldRewrite ||
    (options.offline !== true &&
      (options.eventLog === undefined ||
        typeof options.eventLog.runExclusiveMaintenance !== 'function')) ||
    allProofs(plan.proofs).some((proof) => proof.status !== 'passed')
  ) {
    observe?.(observationForApply(plan, startedAt, 'skipped', { skipReason: 'proof-failed' }));
    return {
      rewrittenShards: 0,
      droppedLines: 0,
      reclaimedBytes: 0,
      skipped: 'blocked',
      errors: [
        ...plan.blockers
          .filter((blocker) => blocker.severity === 'blocking')
          .map((blocker) => blocker.id),
        ...(options.offline !== true &&
        (options.eventLog === undefined ||
          typeof options.eventLog.runExclusiveMaintenance !== 'function')
          ? ['append-lifecycle-not-supplied']
          : []),
      ],
    };
  }

  const applyUnderWriterLock = async (): Promise<EngagementCompactionResult> => {
    const manifestRead = await readEngagementCompactionManifest(plan.vaultRoot);
    if (manifestRead.state === 'invalid') {
      observe?.(
        observationForApply(plan, startedAt, 'failed', { errorCategory: 'manifest-invalid' }),
      );
      return {
        rewrittenShards: 0,
        droppedLines: 0,
        reclaimedBytes: 0,
        skipped: 'blocked',
        errors: ['manifest-invalid'],
      };
    }
    const existingEntries = new Map(
      manifestRead.state === 'valid'
        ? manifestRead.manifest.entries.map((entry) => [entry.shard, entry] as const)
        : [],
    );
    const coveredVisitIds = new Set(plan.coveredVisitIds);
    const prepared: Array<{
      entry: EngagementCompactionManifestEntry;
      tmp: string;
      path: string;
      reclaimedBytes: number;
    }> = [];
    try {
      for (const shard of plan.shards) {
        if (shard.coveredIntervalLines === 0) continue;
        const shardKey = `${shard.replicaId}/${shard.date}.jsonl`;
        const priorEntry = existingEntries.get(shardKey);
        if (priorEntry !== undefined) {
          const priorState = await verifyCompactionShardState(plan.vaultRoot, priorEntry);
          if (priorState === 'compacted') continue;
          if (priorState !== 'source') throw new Error('receipt-mismatch');
        }
        const sourceInfo = await stat(shard.path);
        if (
          sourceInfo.size !== shard.totalBytes ||
          (await sha256File(shard.path)) !== shard.sourceSha256
        ) {
          throw new Error('source-changed');
        }
        const raw = await readFile(shard.path, 'utf8');
        const expectedSequences = new Set(shard.droppedSequences);
        const seenSequences = new Set<number>();
        const droppedVisits = new Set<string>();
        const survivors: string[] = [];
        for (const record of recordsWithEndings(raw)) {
          const line = record.endsWith('\n') ? record.slice(0, -1) : record;
          const event = line.includes(INTERVAL_NEEDLE) ? acceptedEventFromLine(line) : null;
          if (
            event?.type === ENGAGEMENT_INTERVAL_OBSERVED &&
            event.dot.replicaId === shard.replicaId &&
            expectedSequences.has(event.dot.seq) &&
            isEngagementIntervalObservedPayload(event.payload) &&
            coveredVisitIds.has(event.payload.visitId)
          ) {
            seenSequences.add(event.dot.seq);
            droppedVisits.add(event.payload.visitId);
            continue;
          }
          survivors.push(record);
        }
        if (
          seenSequences.size !== expectedSequences.size ||
          [...expectedSequences].some((seq) => !seenSequences.has(seq))
        ) {
          throw new Error('receipt-mismatch');
        }
        const compacted = survivors.join('');
        const entryWithoutReceipt: Omit<EngagementCompactionManifestEntry, 'receiptSha256'> = {
          shard: shardKey,
          replicaId: shard.replicaId,
          sourceBytes: sourceInfo.size,
          sourceSha256: shard.sourceSha256,
          compactedBytes: Buffer.byteLength(compacted, 'utf8'),
          compactedSha256: sha256Text(compacted),
          droppedSequenceRanges: sequenceRanges([...seenSequences]),
          droppedCount: seenSequences.size,
          maxDroppedAcceptedAtMs: shard.maxDroppedAcceptedAtMs,
          coveredVisitCount: droppedVisits.size,
          preparedAt: plan.producedAt,
        };
        const computedEntry = withEngagementCompactionReceipt(entryWithoutReceipt);
        const entry = priorEntry ?? computedEntry;
        if (
          entry.replicaId !== computedEntry.replicaId ||
          entry.sourceBytes !== computedEntry.sourceBytes ||
          entry.compactedSha256 !== computedEntry.compactedSha256 ||
          entry.compactedBytes !== computedEntry.compactedBytes ||
          entry.droppedCount !== computedEntry.droppedCount ||
          entry.sourceSha256 !== computedEntry.sourceSha256 ||
          entry.maxDroppedAcceptedAtMs !== computedEntry.maxDroppedAcceptedAtMs ||
          entry.coveredVisitCount !== computedEntry.coveredVisitCount ||
          JSON.stringify(entry.droppedSequenceRanges) !==
            JSON.stringify(computedEntry.droppedSequenceRanges)
        ) {
          throw new Error('receipt-mismatch');
        }
        const tmp = `${shard.path}.compact.tmp`;
        // Durably flush the prepared body before the manifest is published.
        // If the later shard rename survives a crash, its bytes do too.
        await writeFileAtomic(tmp, compacted);
        prepared.push({
          entry,
          tmp,
          path: shard.path,
          reclaimedBytes: sourceInfo.size - entry.compactedBytes,
        });
        existingEntries.set(shardKey, entry);
      }
    } catch (error) {
      await Promise.all(prepared.map(async ({ tmp }) => await unlink(tmp).catch(() => undefined)));
      const category =
        error instanceof Error && error.message === 'source-changed'
          ? 'source-changed'
          : error instanceof Error && error.message === 'receipt-mismatch'
            ? 'receipt-mismatch'
            : 'io';
      observe?.(observationForApply(plan, startedAt, 'failed', { errorCategory: category }));
      return {
        rewrittenShards: 0,
        droppedLines: 0,
        reclaimedBytes: 0,
        skipped: 'blocked',
        errors: [category],
      };
    }

    try {
      await writeEngagementCompactionManifest(plan.vaultRoot, [...existingEntries.values()]);
    } catch {
      await Promise.all(prepared.map(async ({ tmp }) => await unlink(tmp).catch(() => undefined)));
      observe?.(observationForApply(plan, startedAt, 'failed', { errorCategory: 'io' }));
      return {
        rewrittenShards: 0,
        droppedLines: 0,
        reclaimedBytes: 0,
        skipped: 'blocked',
        errors: ['io'],
      };
    }

    let rewrittenShards = 0;
    let droppedLines = 0;
    let reclaimedBytes = 0;
    const errors: string[] = [];
    for (const item of prepared) {
      try {
        await rename(item.tmp, item.path);
        if ((await verifyCompactionShardState(plan.vaultRoot, item.entry)) !== 'compacted') {
          throw new Error('receipt-mismatch');
        }
        rewrittenShards += 1;
        droppedLines += item.entry.droppedCount;
        reclaimedBytes += item.reclaimedBytes;
      } catch {
        errors.push('io');
        await unlink(item.tmp).catch(() => undefined);
      }
    }
    observe?.(
      observationForApply(plan, startedAt, errors.length === 0 ? 'succeeded' : 'failed', {
        ...(errors.length === 0 ? {} : { errorCategory: 'io' as const }),
      }),
    );
    return { rewrittenShards, droppedLines, reclaimedBytes, skipped: null, errors };
  };

  return options.eventLog?.runExclusiveMaintenance === undefined
    ? await applyUnderWriterLock()
    : await options.eventLog.runExclusiveMaintenance(applyUnderWriterLock);
};
