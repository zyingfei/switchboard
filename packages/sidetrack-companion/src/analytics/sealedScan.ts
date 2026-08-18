// Columnar event tier, stage 3: the sealed/hot watermark-split scan router.
// docs/design/2026-08-01-columnar-event-tier.md ; design note:
// docs/plans/2026-08-15-foundation-program.md, "Columnar scan routing"
// (2026-08-18).
//
// Routes a type-scoped forEachChunkOfTypes-shaped scan through DuckDB-over-
// Parquet for days already sealed (per the seal manifest, cross-checked
// live against store day-stats via the SAME entryMatches contract
// eventScan.ts's production integrity A/B uses) + the store's own day-
// bounded indexed read for the hot/unsealed tail. Additive and inert unless
// BOTH the seal tier is on (SIDETRACK_EVENT_SEAL=1) AND routing is
// explicitly opted in (SIDETRACK_COLUMNAR_SCANS=1 — default OFF, see
// columnarScansEnabled's own comment for the measured reason); when either
// condition fails this degrades to a byte-identical passthrough of
// store.forEachChunkOfTypes.
//
// SAFETY SCOPE — READ THIS BEFORE ADDING A CALL SITE:
// Sealed Parquet segments (eventSeal.ts's `seal_rows` table: replica_id,
// seq, type, accepted_at_ms, aggregate_id, client_event_id, payload — 7
// columns) never captured `deps` (VersionVector), `target` (TargetRef), or
// `hlc` (Hybrid Logical Clock), three fields AcceptedEvent otherwise
// carries. Events reconstructed from a SEALED day therefore always come
// back with `deps: {}` and no `target`/`hlc` — inherent to the Parquet
// schema, not fixable here. Events read from the HOT/unsealed tail are
// FULL FIDELITY (real deps/target/hlc, via EventStore.readEventsForDay) —
// this module does not gratuitously degrade the portion it doesn't have to.
// Both are safe ONLY for callers proven to never read event.deps /
// event.target / event.hlc, since a sealed day silently drops them
// regardless. Two confirmed, grep-verified
// consumers that DO — connectionsMaterializer.ts's foreground-navigation
// event synthesis (copies deps/hlc forward into a newly minted event) and
// threadRegisterStore.ts (persists + round-trips deps for projectThread to
// fold) — must NEVER be fed through this module. Both are reachable only
// from connectionsMaterializer.ts's own inlined reads; this module is not
// wired into that file at all. Before adding a new call site, grep the
// consumer's entire downstream fold for `.deps`, `.target`, `.hlc`.

import { stat } from 'node:fs/promises';

import { isAcceptedEvent } from '../sync/eventLog.js';
import type { AcceptedEvent } from '../sync/causal.js';
import type { EventStore } from '../sync/eventStore.js';
import { entryMatches } from './eventScan.js';
import {
  eventSealEnabled,
  readSealManifest,
  sealSegmentPath,
  type SealManifestEntry,
  type SealManifestRead,
} from './eventSeal.js';

// Default OFF (`=== '1'`), matching eventSealEnabled's own "additive-only
// until proven" idiom exactly — NOT the naive `!== '0'` kill-switch shape a
// first pass at this task used. Reason, measured (2026-08-18, real ~2.8GB
// test vault, 231 real sealed segments, `scripts/read-amplification-
// harness.ts`): on THIS vault's current segment shape — many SMALL daily
// Parquet files (avg 89KB) — an uncached classification pass plus one
// batched `read_parquet([...231 paths])` query for a RARE, already-mmap-
// indexed type (workGraphHealth's feedback-type fold) cost MORE kernel
// read bytes (measured up to ~310MB before the classification cache below;
// ~20-40MB even warm) than the equivalent tuned-SQLite `forEachChunkOfTypes`
// call (measured 4-11MB) — the opposite of the intended direction. DuckDB-
// over-Parquet's proven win (F2 design note: 17x vs a JS loop) is for
// AGGREGATE queries over row-group statistics, or for BROAD/near-full-
// history scans where SQLite would otherwise touch most of the table —
// NOT for a narrow, rare-type row-fetch that PR #400's mmap tuning already
// serves cheaply via events_type_idx. `=0` (still honored, see below) and
// unset both revert to the pure-store path; `=1` is required to opt in.
// The code is correct and tested (see sealedScan.test.ts's equivalence
// suite) — this default reflects "not yet a proven win on real data",
// the SAME reason SIDETRACK_EVENT_STORE itself still defaults off despite
// being production-ready code (see eventStore.ts's own long comment on
// that precedent). Re-evaluate once the sealer consolidates small daily
// segments into fewer/larger files (a write-path follow-up, out of this
// read-routing task's scope) or once a genuinely BROAD/unbounded consumer
// is found safe to route (see the design note's consumer table — none
// qualified in this task's audit).
export const columnarScansEnabled = (): boolean =>
  process.env['SIDETRACK_COLUMNAR_SCANS'] === '1';

export interface SealAwareScanStats {
  readonly consumer: string;
  readonly sealedDays: number;
  readonly hotDays: number;
  /** Bytes of sealed Parquet actually stat()'d for this call — real, not a
   *  guess. Does not include hot-tail store bytes (out of scope: this
   *  module never touches proc-level rusage). */
  readonly bytesEstimate: number;
}

const sqlString = (value: string): string => value.replaceAll("'", "''");

interface DuckSealedRow {
  readonly replica_id?: unknown;
  readonly seq?: unknown;
  readonly type?: unknown;
  readonly accepted_at_ms?: unknown;
  readonly aggregate_id?: unknown;
  readonly client_event_id?: unknown;
  readonly payload?: unknown;
}

// Row -> AcceptedEvent builder for the SEALED (Parquet) branch only — the
// hot branch reads full-fidelity AcceptedEvent objects straight from
// EventStore.readEventsForDay and needs no reconstruction. deps is always
// `{}` here (isAcceptedEvent requires an object, not undefined) since the
// Parquet schema never carried it; target/hlc are always omitted. See this
// file's header for why.
const buildEvent = (fields: {
  readonly replicaId: string;
  readonly seq: number;
  readonly type: string;
  readonly acceptedAtMs: number;
  readonly aggregateId: string;
  readonly clientEventId: string;
  readonly payload: string;
}): AcceptedEvent | null => {
  try {
    const event: AcceptedEvent = {
      clientEventId: fields.clientEventId,
      dot: { replicaId: fields.replicaId, seq: fields.seq },
      deps: {},
      aggregateId: fields.aggregateId,
      type: fields.type,
      payload: JSON.parse(fields.payload) as unknown,
      acceptedAtMs: fields.acceptedAtMs,
    };
    return isAcceptedEvent(event) && Number.isFinite(event.dot.seq) && Number.isFinite(event.acceptedAtMs)
      ? event
      : null;
  } catch {
    return null;
  }
};

const duckRowToEvent = (row: DuckSealedRow): AcceptedEvent | null =>
  buildEvent({
    replicaId: String(row.replica_id),
    seq: Number(row.seq),
    type: String(row.type),
    acceptedAtMs: Number(row.accepted_at_ms),
    aggregateId: String(row.aggregate_id),
    clientEventId: String(row.client_event_id),
    payload: String(row.payload),
  });

// Throttled audible mark — 30s per consumer, matching server.ts's
// logResolverCandidateWindowTruncated idiom (an HTTP route consumer can
// call this many times a second under a request burst; a health-poll
// consumer calls it rarely). Fires whenever the call actually reached
// routing logic (seal on, manifest non-empty for this scope) — not on the
// pure-passthrough fast path, which changes nothing and has nothing to
// report.
const MARK_THROTTLE_MS = 30_000;
const lastMarkAtByConsumer = new Map<string, number>();
const logColumnarScanMark = (stats: SealAwareScanStats): void => {
  const now = Date.now();
  const last = lastMarkAtByConsumer.get(stats.consumer) ?? 0;
  if (now - last < MARK_THROTTLE_MS) return;
  lastMarkAtByConsumer.set(stats.consumer, now);
  console.warn(
    `[scan.columnar] consumer=${stats.consumer} sealedDays=${String(stats.sealedDays)} ` +
      `hotDays=${String(stats.hotDays)} bytesEstimate=${String(stats.bytesEstimate)}`,
  );
};

/** Test-only reset, mirrors server.ts's resetResolverCandidateWindowTruncationLogForTest. */
export const resetColumnarScanMarkThrottleForTest = (): void => {
  lastMarkAtByConsumer.clear();
};

const passthroughStats = (consumer: string): SealAwareScanStats => ({
  consumer,
  sealedDays: 0,
  hotDays: 0,
  bytesEstimate: 0,
});

interface SealedVsHotClassification {
  readonly sealedTrusted: readonly SealManifestEntry[];
  readonly hot: readonly { readonly replicaId: string; readonly day: string }[];
}

interface ClassificationCacheEntry extends SealedVsHotClassification {
  readonly manifestLines: number;
  readonly watermarkSig: string;
}

// Per-vaultRoot memo — MEASURED (2026-08-18, real ~2.8GB test vault, 231
// sealed days): the classification loop below (store.sealDayStats PER
// replica, to cross-check each day against the manifest via entryMatches)
// costs ~269MB of kernel read on an UNCACHED call on this vault, dwarfing
// the DuckDB read it exists to route around (~20MB). store.watermark() —
// a single small `ingest_watermark` table read — is cheap and used here as
// the cheap "has anything changed" signal that gates redoing the expensive
// part: unchanged watermark + unchanged manifest line count (readSealManifest
// already read fresh, cheaply, every call — see its own header, ~0.1MB) means
// no replica ingested and no seal pass ran since the last classification, so
// the cached sealed/hot split is still exactly right. Invalidated the moment
// either changes. This directly answers the brief's "must not cost more than
// it saves" for the read-router itself, not just the DuckDB connection.
const classificationCache = new Map<string, ClassificationCacheEntry>();

/** Test-only: drop every cached classification (mirrors other test-reset
 *  exports in this file). */
export const resetSealedScanClassificationCacheForTest = (): void => {
  classificationCache.clear();
};

const classifySealedVsHot = (
  vaultRoot: string,
  store: EventStore,
  manifest: SealManifestRead,
): SealedVsHotClassification => {
  const watermarkSig = JSON.stringify(
    Object.entries(store.watermark()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const cached = classificationCache.get(vaultRoot);
  if (
    cached !== undefined &&
    cached.manifestLines === manifest.lines &&
    cached.watermarkSig === watermarkSig
  ) {
    return cached;
  }

  // Classify every (replica, day) the store currently has rows for, using
  // the SAME entryMatches contract eventScan.ts's production integrity
  // check uses: manifest entry present AND matches the LIVE store day-stats
  // exactly. Anything else (no entry, or a stale/drifted entry) is hot.
  const sealedTrusted: SealManifestEntry[] = [];
  const hot: { readonly replicaId: string; readonly day: string }[] = [];
  for (const replicaId of Object.keys(store.watermark())) {
    for (const dayStat of store.sealDayStats(replicaId)) {
      const entry = manifest.latest.get(`${replicaId} ${dayStat.day}`);
      if (entry !== undefined && entryMatches(entry, dayStat)) {
        sealedTrusted.push(entry);
      } else {
        hot.push({ replicaId, day: dayStat.day });
      }
    }
  }
  const result: ClassificationCacheEntry = {
    manifestLines: manifest.lines,
    watermarkSig,
    sealedTrusted,
    hot,
  };
  classificationCache.set(vaultRoot, result);
  return result;
};

/**
 * Drop-in, sealed-aware alternative to EventStore.forEachChunkOfTypes. Same
 * signature plus a trailing options bag; same delivery contract (chunks of
 * up to `chunkSize`, ordered by (replicaId, seq), yielding between chunks).
 * See this file's header for the deps/target/hlc scope this is safe for.
 */
export const forEachChunkOfTypesSealAware = async (
  vaultRoot: string,
  store: EventStore,
  types: readonly string[],
  cb: (chunk: readonly AcceptedEvent[]) => void | Promise<void>,
  chunkSize: number,
  options: { readonly consumer: string },
): Promise<SealAwareScanStats> => {
  if (types.length === 0) return passthroughStats(options.consumer);
  if (!eventSealEnabled() || !columnarScansEnabled()) {
    await store.forEachChunkOfTypes(types, cb, chunkSize);
    return passthroughStats(options.consumer);
  }
  const manifest = await readSealManifest(vaultRoot);
  if (manifest.latest.size === 0) {
    await store.forEachChunkOfTypes(types, cb, chunkSize);
    return passthroughStats(options.consumer);
  }

  const { sealedTrusted, hot } = classifySealedVsHot(vaultRoot, store, manifest);

  if (sealedTrusted.length === 0) {
    await store.forEachChunkOfTypes(types, cb, chunkSize);
    return passthroughStats(options.consumer);
  }

  const typeSet = new Set(types);
  const collected: AcceptedEvent[] = [];
  let bytesEstimate = 0;

  try {
    const { DuckDBInstance } = await import('@duckdb/node-api');
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    try {
      const paths = sealedTrusted.map((entry) =>
        sealSegmentPath(vaultRoot, entry.replica, entry.day),
      );
      const pathList = paths.map((path) => `'${sqlString(path)}'`).join(', ');
      const typeList = types.map((type) => `'${sqlString(type)}'`).join(', ');
      const reader = await connection.runAndReadAll(
        `SELECT replica_id, seq, type, accepted_at_ms, aggregate_id, client_event_id, payload
           FROM read_parquet([${pathList}])
          WHERE type IN (${typeList})
          ORDER BY replica_id, seq`,
      );
      const rows = reader.getRowObjects() as never as readonly DuckSealedRow[];
      for (const row of rows) {
        const event = duckRowToEvent(row);
        if (event !== null && typeSet.has(event.type)) collected.push(event);
      }
      bytesEstimate = (
        await Promise.all(
          paths.map((path) =>
            stat(path)
              .then((info) => info.size)
              .catch(() => 0),
          ),
        )
      ).reduce((sum, size) => sum + size, 0);
    } finally {
      connection.closeSync();
    }
  } catch {
    // Fail closed to the pure-store path — correctness over performance.
    // A corrupt/unreadable segment must never yield partial or wrong data
    // on a serving-path read.
    await store.forEachChunkOfTypes(types, cb, chunkSize);
    return passthroughStats(options.consumer);
  }

  for (const { replicaId, day } of hot) {
    for (const event of store.readEventsForDay(replicaId, day)) {
      if (typeSet.has(event.type)) collected.push(event);
    }
  }

  collected.sort((left, right) => {
    if (left.dot.replicaId !== right.dot.replicaId) {
      return left.dot.replicaId < right.dot.replicaId ? -1 : 1;
    }
    return left.dot.seq - right.dot.seq;
  });

  const size = Math.max(1, Math.floor(chunkSize));
  for (let i = 0; i < collected.length; i += size) {
    await cb(collected.slice(i, i + size));
    if (i + size < collected.length) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  const stats: SealAwareScanStats = {
    consumer: options.consumer,
    sealedDays: sealedTrusted.length,
    hotDays: hot.length,
    bytesEstimate,
  };
  logColumnarScanMark(stats);
  return stats;
};
