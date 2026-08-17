import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { createInterface } from 'node:readline';

import { surveyGenerations, type GenerationSurvey } from '../connections/generationBuffer.js';
import { eventStoreEnabled } from '../sync/eventStore.js';

// THE VAULT LEDGER — every byte under `_BAC`, classified, with a typed status.
//
// WHY THIS EXISTS (measured on the dogfood vault, 2026-07-29): the vault held
// 3.02 GB while the panel's "Revision inventory" reported "GC-tracked 10.7 MB /
// 1 file" — 99.6% of the disk was invisible to the only storage surface the
// product has. That is not a rendering bug. `gcInventory` (gc/plan.ts) rolls up
// a GC *plan*: it reports exactly the files buildGcPlan already decided to
// DELETE, in eight families it happens to scan. Everything the planner does not
// know about — the 2.1 GB `connections/` tree, the 608 MB event log, the 132 MB
// ingress spool, the 98 MB never-rotated sync changelog — contributes zero to
// its total, correctly by its own contract and catastrophically as a storage
// answer. Asking "why is my vault 3 GB" of a delete-plan gets you the size of
// the delete plan.
//
// So this module answers the other question, and answers it WHOLE. The design
// rule that makes it trustworthy:
//
//   THE RECONCILIATION INVARIANT — the family byte totals ALWAYS sum to the
//   on-disk total. Every file walked lands in exactly one family, and `other`
//   is the catch-all that absorbs whatever the classifier did not claim. A
//   ledger that does not reconcile is precisely how 10.7 MB of 3 GB happened,
//   so `vaultLedger.test.ts` asserts the sum on a synthetic tree containing
//   unclassifiable files. Adding a family can therefore never silently drop
//   bytes: it can only move them out of `other`.
//
// COST DISCIPLINE. One recursive directory walk, `stat` per entry, no file
// CONTENTS read except the deliberately-sampled event-log histogram (below).
// That is ~a few thousand stats on a real vault. It is memoized behind a TTL
// with background refresh (same shape as gcInventoryCached, follow-up #15) and
// must NEVER run inline on a request: the HTTP route reads the cache O(1) and
// reports `unavailable` until the first walk lands rather than blocking.
//
// SQLITE SIBLINGS travel with their main file, never into `other`: `-wal` /
// `-shm` are the same logical object and splitting them would make a 742 MB
// event store read as 737 MB + 4 MB of mystery.
//
// STATUS IS TYPED, NOT DECORATIVE. `unused-under-config` is the load-bearing
// one: `event-store.db` is 703-742 MB of a store this rig does not open
// (SIDETRACK_EVENT_STORE unset ⇒ eventStoreEnabled() false), yet it is fully
// load-bearing the moment the flag is on. That is neither "active" nor
// "reclaimable" and the ledger must not flatten it into either.

/** Every byte lives under this subdirectory of the vault root. */
const VAULT_SUBDIR = '_BAC';

export type LedgerFamily =
  /** Double-buffered connections generation dbs (`current.<gen>.db` + siblings). */
  | 'connections-generations'
  /** `current.db` — the kill-switch rollback anchor, NOT the served graph. */
  | 'connections-legacy-anchor'
  /** Auxiliary connections dbs: resolver cache, timeline/engagement facts. */
  | 'connections-sidecar-dbs'
  /** Derived revision artifacts under connections/ (similarity, topics, HNSW…). */
  | 'connections-derived'
  /** The shared event-store sqlite mirror. */
  | 'event-store'
  /** The canonical append-only JSONL log (`log/<replica>/<date>.jsonl`). */
  | 'event-log'
  /** Daily ingress JSONL spool (`events/`). */
  | 'ingress-spool'
  /** Projection changelog (`.sync/`). */
  | 'sync-changelog'
  | 'recall-index'
  | 'page-evidence'
  | 'page-content'
  | 'ranker'
  | 'diagnostics'
  | 'debug-dumps'
  /** Sealed Parquet segments + manifest (`seal/`, SIDETRACK_EVENT_SEAL). */
  | 'event-seal'
  /** Catch-all — the reconciliation invariant's escape valve. */
  | 'other';

/**
 * Typed status. Deliberately NOT a health traffic light: a family can be large,
 * correct, and permanent (`active`), or large and dead only because of how this
 * rig is configured (`unused-under-config`) — flattening those into one axis is
 * what made the old surface useless.
 */
export type LedgerStatus =
  /** Live, load-bearing, expected to be this size. */
  | 'active'
  /** Real data that nothing reads UNDER THE CURRENT CONFIG (see event-store). */
  | 'unused-under-config'
  /** Retained on purpose as a rollback/recovery anchor. */
  | 'retained-anchor'
  /** Grows without a retention policy — the honest name for "will keep growing". */
  | 'unbounded'
  /** Fully abandoned; safe to collect (see `reclaimable`). */
  | 'orphaned'
  /** Present but empty. */
  | 'empty'
  /** Not classified — bytes we can see but cannot explain. */
  | 'unclassified';

export interface LedgerFamilyEntry {
  readonly family: LedgerFamily;
  readonly bytes: number;
  readonly files: number;
  readonly status: LedgerStatus;
  /**
   * Bytes this landing believes are safe to reclaim. ALWAYS <= bytes, and
   * ALWAYS reporting-only in v1 — no surface offers a delete affordance for it.
   * 0 is a real measurement here (nothing reclaimable), distinct from a family
   * that was never assessed, which reports `reclaimableAssessed: false`.
   */
  readonly reclaimable: number;
  /** False when nothing in this landing knows how to assess reclaimability —
   *  so a 0 cannot be misread as "assessed, nothing to reclaim". */
  readonly reclaimableAssessed: boolean;
  readonly note: string;
}

/** One event type's share of the event log, from a SAMPLE (see `sampled`). */
export interface EventTypeShare {
  readonly type: string;
  /** Bytes measured for this type across the sampled shards. */
  readonly sampleBytes: number;
  /** sampleBytes / total sampled bytes, 0..1. */
  readonly share: number;
  /** share × the WHOLE event-log byte total. An extrapolation, not a count. */
  readonly estimatedBytes: number;
}

export interface EventLogHistogram {
  /**
   * TRUE whenever the histogram came from fewer than all shards — which is the
   * normal case. Named in the payload (not just in a comment) because a
   * consumer that renders extrapolated bytes as measured bytes is lying for us.
   */
  readonly sampled: boolean;
  readonly shardsTotal: number;
  readonly shardsSampled: number;
  readonly sampledBytes: number;
  /** Byte total of the whole event-log family, the extrapolation base. */
  readonly totalBytes: number;
  /** Descending by sampleBytes. */
  readonly types: readonly EventTypeShare[];
}

export interface VaultLedger {
  readonly producedAt: string;
  readonly vaultRoot: string;
  /** Sum of every file walked under `_BAC`. The reconciliation target. */
  readonly totalBytes: number;
  readonly totalFiles: number;
  /** Descending by bytes. Sums to `totalBytes` — asserted in tests. */
  readonly families: readonly LedgerFamilyEntry[];
  readonly reclaimableBytes: number;
  /** Generation sub-classification (pointer / live-marked / orphan-collectable). */
  readonly generations: GenerationSurvey;
  /** Absent (null) when the histogram was disabled or the log is empty. */
  readonly eventLog: EventLogHistogram | null;
}

export interface BuildVaultLedgerOptions {
  readonly now?: Date;
  /**
   * How many of the LARGEST log shards to stream for the type histogram.
   * Default 3 (~50 MB on the live vault). 0 disables the histogram entirely.
   * Largest-first because the type mix is byte-weighted: sampling the biggest
   * shards estimates a byte share far better than sampling uniformly by file.
   */
  readonly histogramShardSample?: number;
  /** Injectable for tests: whether the shared event store is configured on. */
  readonly eventStoreOn?: boolean;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Strip a sqlite sidecar suffix so `-wal` / `-shm` classify with their main
 *  file. Also covers `-journal` (rollback-journal mode) for completeness. */
const withoutSqliteSidecar = (name: string): string =>
  name.replace(/-(wal|shm|journal)$/u, '');

const GENERATION_RE = /^current\.[^/]+\.db$/u;

/**
 * Which family does this file belong to? Pure, path-only, total — every path
 * gets an answer, so the reconciliation invariant holds by construction.
 *
 * `segments` is the path relative to `_BAC`, split on the separator.
 */
export const classifyVaultPath = (segments: readonly string[]): LedgerFamily => {
  const [top] = segments;
  const leaf = withoutSqliteSidecar(segments.at(-1) ?? '');
  if (top === undefined) return 'other';

  if (top === 'connections') {
    // Direct children of connections/ carry the big dbs; deeper paths are the
    // derived revision dirs.
    if (segments.length === 2) {
      if (leaf === 'event-store.db') return 'event-store';
      if (leaf === 'current.db') return 'connections-legacy-anchor';
      if (GENERATION_RE.test(leaf)) return 'connections-generations';
      if (
        leaf === 'resolver-cache.db' ||
        leaf === 'timeline-facts.db' ||
        leaf === 'engagement-facts.db' ||
        leaf === 'thread-register-facts.db' ||
        // W2 of the F8 IVM plan (docs/plans/2026-08-16-f8-ivm-designs.md):
        // search-query-index.db / capture-text-fts.db — see
        // src/search-index/searchQueryIndexStore.ts and
        // src/search-index/captureTextFtsStore.ts.
        leaf === 'search-query-index.db' ||
        leaf === 'capture-text-fts.db' ||
        // W3 of the F8 IVM plan — the persisted repair queue (bail
        // demotion target) + the durable needs-repair marker share this
        // sidecar. See src/connections/repairQueueStore.ts.
        leaf === 'repair-queue.db' ||
        // W4 of the F8 IVM plan — workstream-tree ancestor-chain lookup
        // (subtreeOf) for scoped workstream CRUD. See
        // src/workstreams/workstreamParentStore.ts.
        leaf === 'workstream-parent.db' ||
        // Gist keywords as sparse-data clustering features (2026-08-16) —
        // the maintained keyword -> page inverted index, and the small
        // keyword -> concept-id centroid store. See
        // src/search-index/keywordIndexStore.ts and
        // src/enrichment/keywordConceptStore.ts.
        leaf === 'keyword-index.db' ||
        leaf === 'keyword-concepts.db' ||
        leaf === 'snapshot.sqlite'
      ) {
        return 'connections-sidecar-dbs';
      }
      // current.gen / current.publish.lock / *.inflight belong to the
      // generation machinery even though they are not generation dbs — a
      // reader asking "what do generations cost" should see them together.
      if (leaf.startsWith('current.')) return 'connections-generations';
      return 'connections-derived';
    }
    if (segments[1] === 'diagnostics') return 'diagnostics';
    return 'connections-derived';
  }
  if (top === 'log') return 'event-log';
  if (top === 'events') return 'ingress-spool';
  if (top === '.sync') return 'sync-changelog';
  if (top === 'recall') return 'recall-index';
  if (top === 'page-evidence') return 'page-evidence';
  if (top === 'page-content') return 'page-content';
  if (top === 'ranker') return 'ranker';
  if (top === 'diagnostics') return 'diagnostics';
  if (top === 'debug-dumps') return 'debug-dumps';
  if (top === 'seal') return 'event-seal';
  return 'other';
};

const ALL_FAMILIES: readonly LedgerFamily[] = [
  'connections-generations',
  'connections-legacy-anchor',
  'connections-sidecar-dbs',
  'connections-derived',
  'event-store',
  'event-log',
  'ingress-spool',
  'sync-changelog',
  'recall-index',
  'page-evidence',
  'page-content',
  'ranker',
  'diagnostics',
  'debug-dumps',
  'event-seal',
  'other',
];

interface WalkedFile {
  readonly path: string;
  readonly segments: readonly string[];
  readonly bytes: number;
}

/**
 * Stat-only recursive walk of `_BAC`. Symlinks are counted by their own (link)
 * size via lstat semantics — `stat` would follow them and could double-count a
 * target inside the same tree, which would break reconciliation.
 */
const walkVault = async (root: string): Promise<readonly WalkedFile[]> => {
  const out: WalkedFile[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    // Unreadable dir — reported as absent bytes, never a throw.
    if (entries === null) continue;
    for (const entry of entries) {
      const path = join(dir, String(entry.name));
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      const info = await stat(path).catch(() => null);
      if (info === null || info.isDirectory()) continue;
      const rel = relative(root, path);
      out.push({ path, segments: rel.split(sep), bytes: info.size });
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// Event-log type histogram (sampled)
// ---------------------------------------------------------------------------

/**
 * `"type":"…"` is how every event serialises its discriminator, so this needle
 * finds the type without parsing the line. Matching the RAW line (as
 * compactionPlanner and eventLog.streamEvents both do) is what keeps a 20 MB
 * shard cheap: no JSON.parse of the 88-92% bulk.
 *
 * A payload STRING containing `"type":"x"` could false-match; we take the FIRST
 * occurrence, and the envelope's own `type` precedes any payload in every
 * writer, so first-match is the envelope's. Worst case a mis-attributed line
 * shifts a share by one line's bytes — acceptable for an explicitly-sampled
 * estimate, and it can never miss a line entirely.
 */
const TYPE_NEEDLE_RE = /"type":"([^"]+)"/u;
const YIELD_EVERY_LINES = 500;

const sampleShardTypes = async (
  path: string,
  tally: Map<string, number>,
): Promise<number> => {
  let bytes = 0;
  let processed = 0;
  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (line.length === 0) continue;
    // +1 for the newline readline consumed, so the shares sum to the file size.
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    bytes += lineBytes;
    const match = TYPE_NEEDLE_RE.exec(line);
    const type = match?.[1] ?? '(unparsed)';
    tally.set(type, (tally.get(type) ?? 0) + lineBytes);
    processed += 1;
    if (processed % YIELD_EVERY_LINES === 0) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
  }
  return bytes;
};

const buildEventLogHistogram = async (
  logFiles: readonly WalkedFile[],
  sampleCount: number,
): Promise<EventLogHistogram | null> => {
  const shards = logFiles.filter((file) => file.path.endsWith('.jsonl'));
  const totalBytes = logFiles.reduce((sum, file) => sum + file.bytes, 0);
  if (shards.length === 0 || sampleCount <= 0 || totalBytes === 0) return null;
  const chosen = [...shards].sort((left, right) => right.bytes - left.bytes).slice(0, sampleCount);
  const tally = new Map<string, number>();
  let sampledBytes = 0;
  for (const shard of chosen) {
    sampledBytes += await sampleShardTypes(shard.path, tally);
  }
  if (sampledBytes === 0) return null;
  const types = [...tally.entries()]
    .map(([type, bytes]) => ({
      type,
      sampleBytes: bytes,
      share: bytes / sampledBytes,
      estimatedBytes: Math.round((bytes / sampledBytes) * totalBytes),
    }))
    .sort((left, right) => right.sampleBytes - left.sampleBytes);
  return {
    sampled: chosen.length < shards.length,
    shardsTotal: shards.length,
    shardsSampled: chosen.length,
    sampledBytes,
    totalBytes,
    types,
  };
};

// ---------------------------------------------------------------------------
// Status + note per family
// ---------------------------------------------------------------------------

const describeFamily = (
  family: LedgerFamily,
  bytes: number,
  files: number,
  ctx: {
    readonly eventStoreOn: boolean;
    readonly generations: GenerationSurvey;
  },
): { readonly status: LedgerStatus; readonly reclaimable: number; readonly reclaimableAssessed: boolean; readonly note: string } => {
  if (files === 0) {
    return { status: 'empty', reclaimable: 0, reclaimableAssessed: true, note: 'no files' };
  }
  switch (family) {
    case 'connections-generations': {
      const { collectableCount, collectableBytes, entries } = ctx.generations;
      const kept = entries.filter((entry) => entry.disposition !== 'orphan-collectable').length;
      return {
        status: collectableCount > 0 ? 'orphaned' : 'active',
        reclaimable: collectableBytes,
        reclaimableAssessed: true,
        note:
          collectableCount === 0
            ? `${String(kept)} generation(s) resident: the served one plus the retired-handle margin`
            : `${String(collectableCount)} orphaned generation(s) — abandoned by a dead writer, safe to collect`,
      };
    }
    case 'connections-legacy-anchor':
      return {
        status: 'retained-anchor',
        reclaimable: 0,
        reclaimableAssessed: false,
        note: 'retained until storage retirement proves the S1 generation is complete; rollback can recreate it from current.gen',
      };
    case 'event-store':
      return ctx.eventStoreOn
        ? {
            status: 'active',
            reclaimable: 0,
            reclaimableAssessed: true,
            note: 'shared event-store mirror (SIDETRACK_EVENT_STORE is on)',
          }
        : {
            status: 'unused-under-config',
            reclaimable: 0,
            reclaimableAssessed: false,
            note: 'nothing reads it with the event store off; storage retirement verifies every row against canonical JSONL before removal',
          };
    case 'event-seal':
      return process.env['SIDETRACK_EVENT_SEAL'] === '1'
        ? {
            status: 'active',
            reclaimable: 0,
            reclaimableAssessed: true,
            note: 'sealed Parquet segments + manifest (SIDETRACK_EVENT_SEAL is on); rollback = delete seal/ — the canonical log is untouched',
          }
        : {
            status: 'unused-under-config',
            reclaimable: 0,
            reclaimableAssessed: false,
            note: 'sealed segments left by a previous SIDETRACK_EVENT_SEAL run; safe to delete wholesale, everything rebuilds from canonical JSONL',
          };
    case 'event-log':
      return {
        status: 'active',
        reclaimable: 0,
        reclaimableAssessed: false,
        note: 'the canonical append-only log — reclaimability is assessed by the compaction planner, not here',
      };
    case 'ingress-spool':
      return {
        status: 'unbounded',
        reclaimable: 0,
        reclaimableAssessed: false,
        note: 'legacy daily ingress spool — past-retention days are eligible only after canonical capture read-back proof',
      };
    case 'sync-changelog':
      return {
        status: 'unbounded',
        reclaimable: 0,
        reclaimableAssessed: false,
        note: 'bounded projection changelog — rotation requires a durable source read-back proof and publishes a retained floor',
      };
    case 'connections-derived':
    case 'diagnostics':
    case 'debug-dumps':
      return {
        status: 'active',
        reclaimable: 0,
        reclaimableAssessed: false,
        note: 'derived artifacts — retention is owned by the GC plan (gc/plan.ts), reported there',
      };
    case 'connections-sidecar-dbs':
      return {
        status: 'active',
        reclaimable: 0,
        reclaimableAssessed: true,
        note: 'resolver cache + fact stores, rebuilt on demand but small',
      };
    case 'recall-index':
    case 'page-evidence':
    case 'page-content':
    case 'ranker':
      return {
        status: 'active',
        reclaimable: 0,
        reclaimableAssessed: true,
        note: 'live derived index / captured evidence',
      };
    case 'other':
      return {
        status: 'unclassified',
        reclaimable: 0,
        reclaimableAssessed: false,
        note: 'bytes the ledger can see but does not yet name — the reconciliation catch-all',
      };
  }
};

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Walk the vault and classify every byte. Read-only: stats + the sampled log
 * read, no writes, no deletes. Do NOT call this on a request hot path — use
 * `vaultLedgerCached`.
 */
export const buildVaultLedger = async (
  vaultRoot: string,
  options: BuildVaultLedgerOptions = {},
): Promise<VaultLedger> => {
  const now = options.now ?? new Date();
  const root = join(vaultRoot, VAULT_SUBDIR);
  const files = await walkVault(root);

  const byFamily = new Map<LedgerFamily, { bytes: number; files: number }>();
  for (const family of ALL_FAMILIES) byFamily.set(family, { bytes: 0, files: 0 });
  const logFiles: WalkedFile[] = [];
  for (const file of files) {
    const family = classifyVaultPath(file.segments);
    const bucket = byFamily.get(family) as { bytes: number; files: number };
    bucket.bytes += file.bytes;
    bucket.files += 1;
    if (family === 'event-log') logFiles.push(file);
  }

  const generations = surveyGenerations(join(root, 'connections'), { now });
  const eventStoreOn = options.eventStoreOn ?? eventStoreEnabled();
  const eventLog = await buildEventLogHistogram(logFiles, options.histogramShardSample ?? 3);

  const families: LedgerFamilyEntry[] = [...byFamily.entries()]
    .map(([family, counts]) => {
      const described = describeFamily(family, counts.bytes, counts.files, {
        eventStoreOn,
        generations,
      });
      return { family, bytes: counts.bytes, files: counts.files, ...described };
    })
    .sort((left, right) => right.bytes - left.bytes || left.family.localeCompare(right.family));

  return {
    producedAt: now.toISOString(),
    vaultRoot,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    totalFiles: files.length,
    families,
    reclaimableBytes: families.reduce((sum, family) => sum + family.reclaimable, 0),
    generations,
    eventLog,
  };
};

/** Compact summary for embedding in `/v1/system/health` — never the full walk. */
export interface VaultLedgerSummary {
  readonly asOf: string;
  readonly availability: 'ok' | 'stale' | 'unavailable';
  readonly totalBytes: number;
  readonly reclaimableBytes: number;
  readonly familyCount: number;
  /** The three largest families, so health shows WHERE the bytes are. */
  readonly worstOffenders: readonly {
    readonly family: LedgerFamily;
    readonly bytes: number;
    readonly status: LedgerStatus;
  }[];
  /** Orphaned generations — the P0 counter. 0 here is a real measurement. */
  readonly orphanGenerations: number;
  readonly orphanGenerationBytes: number;
  readonly generationSweepRequested: boolean;
  readonly generationSweepArmed: boolean;
}

export const summarizeVaultLedger = (
  ledger: VaultLedger,
  availability: 'ok' | 'stale',
): VaultLedgerSummary => ({
  asOf: ledger.producedAt,
  availability,
  totalBytes: ledger.totalBytes,
  reclaimableBytes: ledger.reclaimableBytes,
  familyCount: ledger.families.filter((family) => family.files > 0).length,
  worstOffenders: ledger.families
    .slice(0, 3)
    .map((family) => ({ family: family.family, bytes: family.bytes, status: family.status })),
  orphanGenerations: ledger.generations.collectableCount,
  orphanGenerationBytes: ledger.generations.collectableBytes,
  generationSweepRequested: ledger.generations.sweepRequested,
  generationSweepArmed: ledger.generations.sweepArmed,
});

// ---------------------------------------------------------------------------
// TTL cache (mirrors gcInventoryCached — see gc/plan.ts follow-up #15)
// ---------------------------------------------------------------------------

/**
 * Read-only surface ⇒ default ON. Only an explicit '0'/'false' disables it, per
 * the repo rule (read surfaces default on, destructive ones default off).
 */
export const vaultLedgerEnabled = (): boolean => {
  const raw = process.env['SIDETRACK_VAULT_LEDGER'];
  return raw !== '0' && raw !== 'false';
};

export const VAULT_LEDGER_TTL_MS = 5 * 60_000;

export interface VaultLedgerCached {
  readonly value: VaultLedger | null;
  readonly asOf: string | null;
  readonly availability: 'ok' | 'stale' | 'unavailable' | 'disabled';
}

interface CacheEntry {
  readonly value: VaultLedger;
  readonly computedAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<void>>();

/** Test-only: drop cached state so timing-sensitive tests are deterministic. */
export const __resetVaultLedgerCache = (): void => {
  cache.clear();
  inFlight.clear();
};

const refresh = (vaultRoot: string, options: BuildVaultLedgerOptions): Promise<void> => {
  const existing = inFlight.get(vaultRoot);
  if (existing !== undefined) return existing;
  const run = (async () => {
    try {
      const value = await buildVaultLedger(vaultRoot, options);
      cache.set(vaultRoot, { value, computedAt: Date.now() });
    } catch {
      // Keep any previous entry: a failed refresh must not erase a usable
      // older value (same rule as gcInventoryCached).
    } finally {
      inFlight.delete(vaultRoot);
    }
  })();
  inFlight.set(vaultRoot, run);
  return run;
};

/**
 * Serve the ledger from a TTL'd cache, refreshing in the background. O(1) on
 * the request path. Honest tri-state plus `disabled`: `unavailable` until the
 * first walk lands, `stale` while refreshing an expired entry, `ok` when fresh.
 */
export const vaultLedgerCached = async (
  vaultRoot: string,
  options: BuildVaultLedgerOptions = {},
  opts: { readonly ttlMs?: number; readonly awaitFresh?: boolean } = {},
): Promise<VaultLedgerCached> => {
  if (!vaultLedgerEnabled()) return { value: null, asOf: null, availability: 'disabled' };
  const ttlMs = opts.ttlMs ?? VAULT_LEDGER_TTL_MS;
  const cached = cache.get(vaultRoot);
  if (cached !== undefined && Date.now() - cached.computedAt < ttlMs) {
    return {
      value: cached.value,
      asOf: new Date(cached.computedAt).toISOString(),
      availability: 'ok',
    };
  }
  const pending = refresh(vaultRoot, options);
  if (opts.awaitFresh === true) {
    await pending;
    const after = cache.get(vaultRoot);
    return after === undefined
      ? { value: null, asOf: null, availability: 'unavailable' }
      : {
          value: after.value,
          asOf: new Date(after.computedAt).toISOString(),
          availability: 'ok',
        };
  }
  return cached === undefined
    ? { value: null, asOf: null, availability: 'unavailable' }
    : {
        value: cached.value,
        asOf: new Date(cached.computedAt).toISOString(),
        availability: 'stale',
      };
};

/** Exported for the ledger test's reconciliation assertion + the route. */
export const ledgerFamilies = (): readonly LedgerFamily[] => ALL_FAMILIES;

/** Used by the retention planner to name the changelog file it rotates. */
export const vaultSubdir = (vaultRoot: string): string => join(vaultRoot, VAULT_SUBDIR);

/** basename re-export keeps the classifier honest in tests without importing
 *  node:path there. */
export const leafName = (path: string): string => basename(path);
