import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { ENGAGEMENT_INTERVAL_OBSERVED } from '../engagement/events.js';

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
