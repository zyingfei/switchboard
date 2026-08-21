// F2 follow-up — event-store mirror DAY REPAIR.
//
// `retire-hot-tail --report` (analytics/hotTailRetirement.ts) fail-closes a
// shard as `store-drift` whenever the typed event-store mirror
// (`_BAC/connections/event-store.db`) has no rows (or a mismatched row
// count) for a (replica, day) the seal manifest already covers. Most
// store-drift is benign and self-heals on the next sealer pass (new
// arrivals since sealing). But a mirror with ZERO rows for a day whose
// canonical JSONL shard genuinely has events (readEventStoreDayStatsReadonly's
// `storeStat === undefined` case, detail string "event-store mirror
// unavailable or has no rows for this day") never self-heals: the live
// companion's ordinary catch-up path (`EventStore.catchUpFromJsonl`) tracks
// per-shard progress in a `shard_progress` table keyed on (path, size,
// mtime_ms, read_offset) and treats a file whose size+mtime already match
// the stored progress row as fully consumed — it will never re-read that
// day's shard again on its own, regardless of what rows are actually
// present in the `events` table. Observed on the test vault
// (docs/plans/2026-08-15-foundation-program.md, F2 2026-08-16 landing
// note): 6 such shards, one replica, six days in 2026-06/2026-07 —
// plausibly F1 engagement compaction rewrote those days' shards after the
// mirror's per-replica ingest watermark had already advanced past them, so
// no ordinary catch-up pass was ever going to revisit them. This module is
// the targeted, day-scoped repair path for exactly that condition.
//
// Ingestion path: `EventStore.ingestMany` (`INSERT OR IGNORE` keyed on the
// `(replica_id, seq)` primary key, `sync/eventStore.ts`'s `ingest`) —
// idempotent by construction and watermark/shard_progress-gate-FREE (unlike
// `catchUp`/`catchUpFromJsonl`), so it re-reads exactly the requested day's
// canonical JSONL regardless of the store's current watermark, and
// re-running this repair for an already-repaired day is a guaranteed no-op
// (`INSERT OR IGNORE` against an existing dot changes nothing).
//
// Discovery reuses `analytics/hotTailRetirement.ts`'s `listCanonicalEventShards`
// (walks BOTH `_BAC/log` and the F2-retired mirror `_BAC/retired/log`) so a
// day that was ALSO retired by `retire-hot-tail --apply` before its
// store-drift was noticed is still repairable — the shard's physical
// location (hot vs. retired) is irrelevant to the mirror repair; only its
// content matters. `EventStore.sealDayStats` (existing, RETAINED-row
// aggregate) is reused for both the default zero-rows discovery filter and
// the per-day rows-before/after report, rather than a new hand-rolled SQL
// query — matching the "don't reinvent wheels" foundation-program rule.

import { createReadStream } from 'node:fs';
import { basename, dirname } from 'node:path';
import { createInterface } from 'node:readline';

import { listCanonicalEventShards } from '../analytics/hotTailRetirement.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { isAcceptedEvent } from '../sync/eventLog.js';
import { createEventStore, type EventStore } from '../sync/eventStore.js';

export const EVENT_STORE_REPAIR_ARM_ENV = 'SIDETRACK_EVENT_STORE_REPAIR';

/**
 * Is the mirror-repair path armed? Defaults OFF, same posture as
 * `eventStoreVacuumArmed`/`hotTailRetireArmed` — re-ingesting rows into the
 * mirror must be opted into explicitly, in addition to the CLI's own recall
 * process-lock check.
 */
export const eventStoreRepairArmed = (): boolean => {
  const raw = process.env[EVENT_STORE_REPAIR_ARM_ENV];
  return raw === '1' || raw === 'true';
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/u;

export interface RepairCandidate {
  readonly replica: string;
  readonly day: string;
  /** Usually length 1. Length 2 only in the documented late-arrival edge
   *  case (analytics/hotTailRetirement.ts's 'retired-destination-exists'
   *  note): a day retired, then re-opened at the hot path by a late peer
   *  arrival — both files together are "the complete canonical event set"
   *  for that day, so both are read and merged. */
  readonly shardPaths: readonly string[];
}

export interface DayRepairOutcome {
  readonly replica: string;
  readonly day: string;
  readonly shardPaths: readonly string[];
  /** Distinct (by dot) valid AcceptedEvent rows parsed from the canonical
   *  shard(s) for this day. */
  readonly canonicalEvents: number;
  /** Lines that failed to parse as JSON or did not pass isAcceptedEvent —
   *  counted and skipped, never fatal to the rest of the day's repair. */
  readonly malformedLines: number;
  /** Mirror rows for (replica, day) — via EventStore.sealDayStats — before
   *  this run's ingest. */
  readonly rowsBefore: number;
  /** Mirror rows for (replica, day) after this run's ingest. Equal to
   *  rowsBefore on an already-repaired (idempotent no-op) re-run. */
  readonly rowsAfter: number;
}

export interface EventStoreMirrorRepairTotals {
  readonly daysConsidered: number;
  readonly daysRepaired: number;
  readonly daysAlreadyOk: number;
  readonly rowsInsertedTotal: number;
  readonly malformedLinesTotal: number;
}

export interface EventStoreMirrorRepairResult {
  readonly vaultRoot: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly candidatesConsidered: number;
  readonly outcomes: readonly DayRepairOutcome[];
  readonly totals: EventStoreMirrorRepairTotals;
  /** Per-day failures (shard read error, etc.) — fail-closed PER DAY: one
   *  day's failure never blocks the rest of the run. Empty on a clean run. */
  readonly errors: readonly string[];
}

/**
 * Every (replica, day) -> [shardPath, ...] key derivable from
 * listCanonicalEventShards, restricted to valid `YYYY-MM-DD.jsonl` shard
 * names and (optionally) the caller's --replica/--day filters.
 */
const groupCanonicalShardsByDay = async (
  vaultRoot: string,
  filters: { readonly replica?: string; readonly day?: string },
): Promise<ReadonlyMap<string, RepairCandidate>> => {
  const shardPaths = await listCanonicalEventShards(vaultRoot);
  const byKey = new Map<string, { replica: string; day: string; shardPaths: string[] }>();
  for (const shardPath of shardPaths) {
    const day = basename(shardPath, '.jsonl');
    if (!DAY_RE.test(day)) continue;
    const replica = basename(dirname(shardPath));
    if (filters.replica !== undefined && replica !== filters.replica) continue;
    if (filters.day !== undefined && day !== filters.day) continue;
    const key = `${replica} ${day}`;
    const existing = byKey.get(key);
    if (existing === undefined) byKey.set(key, { replica, day, shardPaths: [shardPath] });
    else existing.shardPaths.push(shardPath);
  }
  const frozen = new Map<string, RepairCandidate>();
  for (const [key, value] of byKey) {
    frozen.set(key, { replica: value.replica, day: value.day, shardPaths: [...value.shardPaths].sort() });
  }
  return frozen;
};

/** Cached per-replica day->rows lookup over EventStore.sealDayStats — one
 *  query per distinct replica touched, not one per (replica, day) pair. */
const createDayRowsLookup = (
  store: Pick<EventStore, 'sealDayStats'>,
): ((replica: string, day: string) => number) => {
  const cache = new Map<string, ReadonlyMap<string, number>>();
  return (replica: string, day: string): number => {
    let byDay = cache.get(replica);
    if (byDay === undefined) {
      const rows = new Map<string, number>();
      for (const stat of store.sealDayStats(replica)) rows.set(stat.day, stat.rows);
      byDay = rows;
      cache.set(replica, byDay);
    }
    return byDay.get(day) ?? 0;
  };
};

/**
 * Discover which (replica, day) shards this run should target.
 *
 * Default (no --replica/--day filters): every canonical (replica, day) key
 * where the mirror currently has ZERO rows (`EventStore.sealDayStats` has no
 * entry for that day) — the exact store-drift condition this module exists
 * to fix, never a day that is merely behind (that self-heals on the next
 * sealer pass and is out of scope here).
 *
 * With --replica and/or --day: targets exactly the matching key(s)
 * unconditionally (explicit operator intent overrides the zero-rows
 * heuristic) — repairing an already-fine day is a safe, idempotent no-op,
 * not an error, so there is no need to re-check eligibility once the
 * operator has named the day directly.
 */
export const discoverEventStoreMirrorRepairCandidates = async (
  vaultRoot: string,
  store: Pick<EventStore, 'sealDayStats'>,
  options: { readonly replica?: string; readonly day?: string } = {},
): Promise<readonly RepairCandidate[]> => {
  const grouped = await groupCanonicalShardsByDay(vaultRoot, options);
  const explicit = options.replica !== undefined || options.day !== undefined;
  const rowsFor = createDayRowsLookup(store);

  const candidates: RepairCandidate[] = [];
  for (const candidate of grouped.values()) {
    if (!explicit && rowsFor(candidate.replica, candidate.day) > 0) continue;
    candidates.push(candidate);
  }
  return candidates.sort((a, b) =>
    a.replica === b.replica ? a.day.localeCompare(b.day) : a.replica.localeCompare(b.replica),
  );
};

/** Stream-parse one canonical shard file into valid AcceptedEvent rows,
 *  matching sync/eventStore.ts's own `mirrorContainsEveryShardEvent` line-
 *  reading idiom (readline over createReadStream — cheap on a potentially
 *  large day file, never a whole-file materialization). Malformed lines
 *  (bad JSON, or valid JSON that fails isAcceptedEvent) are counted and
 *  skipped, never thrown — the canonical log is the source of truth, but a
 *  repair tool must not abort a whole day over one bad line when the
 *  remaining events are still worth re-ingesting. */
const readShardEvents = async (
  shardPath: string,
): Promise<{ readonly events: readonly AcceptedEvent[]; readonly malformedLines: number }> => {
  const events: AcceptedEvent[] = [];
  let malformedLines = 0;
  const lines = createInterface({
    input: createReadStream(shardPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of lines) {
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        malformedLines += 1;
        continue;
      }
      if (!isAcceptedEvent(parsed)) {
        malformedLines += 1;
        continue;
      }
      events.push(parsed);
    }
  } finally {
    lines.close();
  }
  return { events, malformedLines };
};

const dotKey = (event: AcceptedEvent): string => `${event.dot.replicaId}:${String(event.dot.seq)}`;

/**
 * Repair the typed event-store mirror for one or more (replica, day) shards
 * by re-ingesting their canonical JSONL events via `EventStore.ingestMany`
 * — the store's own idempotent upsert path, keyed on the `(replica_id,
 * seq)` primary key. Opens its own read-write `EventStore` handle (direct
 * `createEventStore`, not the shared/coalesced singleton — this is a
 * one-shot CLI operation, not a long-lived process) and closes it before
 * returning. Caller (cli.ts) owns the arm-env check and the recall
 * process-lock; this function assumes both are already satisfied, kept
 * separate so it stays independently unit-testable, matching
 * `applyHotTailRetirement`/`runEventStoreVacuum`'s own split.
 *
 * Fail-closed PER DAY: one day's shard-read error is recorded in `errors`
 * and skipped; every other targeted day in the same run still repairs.
 */
export const repairEventStoreMirrorDays = async (
  vaultRoot: string,
  options: { readonly replica?: string; readonly day?: string; readonly now?: () => Date } = {},
): Promise<EventStoreMirrorRepairResult> => {
  const now = options.now ?? ((): Date => new Date());
  const startedAt = now().toISOString();

  const store = await createEventStore(vaultRoot);
  try {
    const candidates = await discoverEventStoreMirrorRepairCandidates(vaultRoot, store, options);
    const rowsFor = createDayRowsLookup(store);

    const outcomes: DayRepairOutcome[] = [];
    const errors: string[] = [];

    for (const candidate of candidates) {
      try {
        const rowsBefore = rowsFor(candidate.replica, candidate.day);

        const merged = new Map<string, AcceptedEvent>();
        let malformedLines = 0;
        for (const shardPath of candidate.shardPaths) {
          const read = await readShardEvents(shardPath);
          malformedLines += read.malformedLines;
          for (const event of read.events) merged.set(dotKey(event), event);
        }
        const events = [...merged.values()];
        if (events.length > 0) store.ingestMany(events);

        // sealDayStats reflects the SAME open handle's just-committed
        // ingest — re-query fresh rather than trusting the cached lookup,
        // which was built from the pre-ingest snapshot.
        const rowsAfterStats = store.sealDayStats(candidate.replica);
        const rowsAfter = rowsAfterStats.find((stat) => stat.day === candidate.day)?.rows ?? 0;

        outcomes.push({
          replica: candidate.replica,
          day: candidate.day,
          shardPaths: candidate.shardPaths,
          canonicalEvents: events.length,
          malformedLines,
          rowsBefore,
          rowsAfter,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${candidate.replica}/${candidate.day}: ${message}`);
      }
    }

    const totals: EventStoreMirrorRepairTotals = {
      daysConsidered: outcomes.length,
      daysRepaired: outcomes.filter((outcome) => outcome.rowsAfter > outcome.rowsBefore).length,
      daysAlreadyOk: outcomes.filter((outcome) => outcome.rowsAfter === outcome.rowsBefore).length,
      rowsInsertedTotal: outcomes.reduce(
        (sum, outcome) => sum + Math.max(0, outcome.rowsAfter - outcome.rowsBefore),
        0,
      ),
      malformedLinesTotal: outcomes.reduce((sum, outcome) => sum + outcome.malformedLines, 0),
    };

    return {
      vaultRoot,
      startedAt,
      finishedAt: now().toISOString(),
      candidatesConsidered: candidates.length,
      outcomes,
      totals,
      errors,
    };
  } finally {
    store.close();
  }
};
