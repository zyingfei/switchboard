// Read-amplification tuning for the companion's HOT, long-lived
// bun:sqlite handles (docs/plans/2026-08-15-foundation-program.md,
// read-amplification section).
//
// WHY: bun:sqlite connections default to `cache_size = -2000` (2 MiB,
// SQLite's own built-in default — see sqlite.org/pragma.html#pragma_cache_size)
// and `mmap_size = 0` (mmap off). None of the store modules overrode
// either before this file existed (audited 2026-08-17: every
// `PRAGMA journal_mode = WAL` block in src/ grepped for `cache_size` /
// `mmap_size` — zero hits). Against a ~956 MB event-store.db and a
// ~436 MB connections generation db (real test-vault sizes, 2026-08-17),
// a 2 MiB page cache means almost every catch-up chunk, resolve, and
// topic pass scan misses the process's own cache and falls through to
// the OS page cache — which a sustained ~1 GB/min read rate then evicts
// out from under itself, forcing physical disk reads on data this same
// process already touched minutes earlier. Kernel counters (proc_pid_rusage)
// measured 46.2 GB read in ~45 min of boot catch-up + topic pass + embed
// backlog on the daily test companion — see the harness report referenced
// from the landing note.
//
// ONLY apply these pragmas to a handle this module's callers document as
// "hot" (opened once, held for the process lifetime, read repeatedly):
// event-store.db (sync/eventStore.ts), the connections generation db's
// long-lived parent-reader/single-buffer handles (connections/snapshot.ts
// — NOT the child-writer's per-drain shadow, which is short-lived and
// already gets a fresh OS-cache-warm mmap from the parent's prior writes),
// and the recall-v2 FTS/vector index (recall-v2/store/sqlite.ts). Short-
// lived or CLI-only handles (page-content/page-evidence rebuild tmp files,
// the resolver-cache.db, search-index side tables, anything opened by a
// one-shot script) stay on SQLite's defaults — the whole point of a cache
// is amortizing REPEATED reads; a handle that's read once and closed gets
// nothing from a bigger one.
//
// TWO independent levers, deliberately not fused into one "cache" number:
//   - cache_size: SQLite's own pcache, malloc'd on the process heap. Counts
//     against RSS permanently (not reclaimable under OS memory pressure the
//     way mapped pages are) — this is the one that must stay bounded, hence
//     the shared <256MB-total budget below.
//   - mmap_size: pages come from the OS's unified page/VM cache, NOT the
//     process heap. They show up in a process's RSS while resident but are
//     the first thing the kernel reclaims under pressure, and — critically
//     for the companions' "memory ratchet" complaint (heap that only grows)
//     — reclaiming them does not fragment or grow the heap the way pcache
//     churn can. Measured on the harness (see landing note): mmap gave a
//     larger read-amplification reduction per MB "spent" than an equivalent
//     cache_size increase, so it carries most of the tuning weight here;
//     cache_size is kept modest and strictly budget-capped.

export type HotSqliteStore = 'eventStore' | 'connectionsGeneration' | 'recallV2Index';

export const SQLITE_CACHE_BUDGET_ENV = 'SIDETRACK_SQLITE_CACHE_MB';
export const SQLITE_MMAP_BUDGET_ENV = 'SIDETRACK_SQLITE_MMAP_MB';

// Total cache_size (heap) budget shared across all three hot stores.
// Bounded well under the 256MB ratchet ceiling the foundation program set
// for this change (see docs/plans/2026-08-15-foundation-program.md).
export const DEFAULT_TOTAL_CACHE_MB = 192;
export const MAX_TOTAL_CACHE_MB = 256;
const MIN_STORE_CACHE_MB = 8;

// Weighted by on-disk size on the real test vault (2026-08-17 baseline):
// event-store.db ~956MB, connections generation db ~436MB, recall-v2
// index ~153MB (+ WAL). Biggest file gets the biggest slice of the
// shared budget — a fixed-size cache on the biggest store has the most
// scans to amortize.
const CACHE_SHARE: Record<HotSqliteStore, number> = {
  eventStore: 0.5,
  connectionsGeneration: 0.32,
  recallV2Index: 0.18,
};

// mmap_size per store, in MB. NOT drawn from the cache_size budget above
// (see module comment — mmap pages are OS-cache-backed, not heap). Each
// default is sized to comfortably cover the whole file on the real test
// vault so a cold scan can be served entirely from mapped pages; SQLite
// clamps mmap_size to the actual file size on open, so an oversized
// default is harmless (never over-allocates), which is why these can be
// generous without their own shared-budget accounting. mmap_size is also
// ADVISORY at the SQLite level regardless of file size — measured
// (sqliteCachePragmas.test.ts) on this project's linked libsqlite3
// (Homebrew's, via setup-sqlite.ts's setCustomSQLite): PRAGMA mmap_size
// silently clamps to a hard SQLITE_MAX_MMAP_SIZE ceiling of exactly
// 1073741824 bytes (1 GiB) no matter how large a value is requested. The
// 1536MB eventStore default below is therefore, on THIS build, actually
// ~1024MB in practice — still full coverage of the ~956MB event-store.db,
// so no functional loss, but a different SQLite build (a different
// SQLITE_MAX_MMAP_SIZE compile flag) could honor more or less of it.
// PRAGMA mmap_size read-back after applying always reports what SQLite
// actually granted, not the request, so this is self-correcting per-build
// rather than silently wrong.
const MMAP_MB: Record<HotSqliteStore, number> = {
  eventStore: 1536,
  connectionsGeneration: 768,
  recallV2Index: 256,
};

const parsePositiveInt = (raw: string | undefined): number | null => {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
};

/** Total cache_size budget (MB) shared across the three hot stores.
 *  Env override clamps to [0, MAX_TOTAL_CACHE_MB] — 0 is a valid,
 *  intentional "disable the added cache_size entirely" (e.g. a
 *  memory-constrained machine); an out-of-range or unparsable value
 *  falls back to the default rather than erroring, matching this repo's
 *  "bad env var degrades, does not crash boot" convention (see
 *  page-evidence/backgroundEmbeddingLane.ts's resolveEmbedBatchCapFromEnv). */
export const resolveTotalCacheBudgetMb = (env: NodeJS.ProcessEnv = process.env): number => {
  const parsed = parsePositiveInt(env[SQLITE_CACHE_BUDGET_ENV]);
  if (parsed === null) return DEFAULT_TOTAL_CACHE_MB;
  return Math.min(MAX_TOTAL_CACHE_MB, parsed);
};

/** This store's slice of the shared cache_size budget. Floors at
 *  MIN_STORE_CACHE_MB so a small total budget still gives every hot
 *  store *something* rather than rounding one down to 0 while the
 *  others get a share. */
export const resolveStoreCacheMb = (
  store: HotSqliteStore,
  env: NodeJS.ProcessEnv = process.env,
): number => {
  const total = resolveTotalCacheBudgetMb(env);
  if (total === 0) return 0;
  return Math.max(MIN_STORE_CACHE_MB, Math.round(total * CACHE_SHARE[store]));
};

/** This store's mmap_size (MB). A single env var scales ALL three
 *  stores' mmap defaults by the same factor (mmapMb / store's own
 *  default) when set to one store's worth of MB — simpler to reason
 *  about for an operator than three separate env vars, and this repo's
 *  precedent (SIDETRACK_SQLITE_CACHE_MB above) is one shared knob, not
 *  N per-store knobs. 0 disables mmap entirely (falls back to normal
 *  file IO) — the harness uses this to isolate cache_size's effect from
 *  mmap_size's. */
export const resolveStoreMmapMb = (
  store: HotSqliteStore,
  env: NodeJS.ProcessEnv = process.env,
): number => {
  const raw = env[SQLITE_MMAP_BUDGET_ENV];
  if (raw === undefined) return MMAP_MB[store];
  const parsed = parsePositiveInt(raw);
  if (parsed === null) return MMAP_MB[store];
  if (parsed === 0) return 0;
  // Scale every store proportionally to how the caller scaled the
  // biggest one (eventStore), so `SIDETRACK_SQLITE_MMAP_MB=0` disables
  // and any positive value scales all three together.
  const scale = parsed / MMAP_MB.eventStore;
  return Math.max(0, Math.round(MMAP_MB[store] * scale));
};

/** The exact PRAGMA statements this module wants applied to `store`'s
 *  handle, given the current env. Callers `db.exec()` this themselves
 *  right after opening + schema-init (see sync/eventStore.ts,
 *  connections/snapshot.ts, recall-v2/store/sqlite.ts) — this module
 *  stays pure (no I/O) so it's trivially unit-testable and so read-back
 *  verification stays with each store's own bun:sqlite/driver query API
 *  (see each store's *.test.ts for "PRAGMA cache_size" read-back
 *  assertions). cache_size uses SQLite's KiB form (negative value —
 *  see sqlite.org/pragma.html#pragma_cache_size) so the setting is exact
 *  regardless of the connection's page_size. */
export const hotCachePragmaSql = (
  store: HotSqliteStore,
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const cacheKb = resolveStoreCacheMb(store, env) * 1024;
  const mmapBytes = resolveStoreMmapMb(store, env) * 1024 * 1024;
  return `PRAGMA cache_size = -${String(cacheKb)};\nPRAGMA mmap_size = ${String(mmapBytes)};`;
};
