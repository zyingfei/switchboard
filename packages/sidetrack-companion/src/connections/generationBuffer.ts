// M4 double-buffer — generation-pointer publish for the connections
// current.db.
//
// WHY THIS EXISTS (all live-measured on an APFS clone of the real vault):
// readers (parent HTTP paths, resolve family, canary) and the drain writer
// (the fork-per-drain child) share ONE current.db today. The write path holds
// a `BEGIN IMMEDIATE` on the served file for the whole snapshot render; the
// second opener gets `SQLITE_BUSY` ("database is locked") and the parent's
// event loop stalls 250ms-12.8s ([api.stall]) while a resolve waits on the
// lock. Separating readers onto an immutable, checkpointed generation file
// eliminates the contention class outright: 50 readonly subgraph-style reads
// against a checkpointed generation WHILE a writer held a long BEGIN IMMEDIATE
// on a SEPARATE shadow file measured 3.1ms total / 2.2ms worst (vs an
// immediate SQLITE_BUSY for two writers on the same file).
//
// TWO DECISIVE MEASUREMENTS shape the protocol (probed with bun:sqlite 1.3.14):
//   1. rename()-ing a file OVER a path that an open readonly handle names
//      throws "disk I/O error" (SQLITE_IOERR_VNODE / APFS vnode swap) on the
//      handle's NEXT query. So publish is a generation-POINTER flip — the
//      served path never mutates in place — NEVER a rename-over-current.db.
//   2. `PRAGMA wal_checkpoint(TRUNCATE)` folds the WAL into the main file so a
//      readonly open needs no -wal/-shm sidecar and stats a ~0-byte WAL. Every
//      published generation is checkpoint-TRUNCATE'd BEFORE the pointer names
//      it, so a readonly reader is fully self-sufficient (D5 is structurally
//      required, not just hygiene).
//   3. unlinking a generation file while a readonly handle still holds it open
//      ALSO throws "disk I/O error" on the next query (bun:sqlite is
//      vnode-sensitive; not POSIX unlinked-inode-stays-alive). So GC only ever
//      unlinks a generation the parent has already REOPENED past — the child
//      GCs on its NEXT publish, keeping (pointer target + one prior) resident,
//      by which time the parent has long moved its handle forward.

import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/** The pointer file names the active generation's db filename (basename). */
export const POINTER_FILENAME = 'current.gen';
/** Cross-process publish mutex. Held (O_EXCL create) across the whole
 *  read-pointer → checkpoint → flip → GC critical section so the parent's
 *  overlay/scoped-delta publishes and the fork-per-drain child's full publish
 *  can never interleave their pointer flips (blockers: pointer clobber / GC of
 *  a live gen). Any publisher — parent or child, in ANY process — contends on
 *  this one file, giving cross-process serialization that a JS mutex can't. */
const PUBLISH_LOCK_FILENAME = 'current.publish.lock';
const GEN_PREFIX = 'current.';
const GEN_SUFFIX = '.db';
const LEGACY_DB_FILENAME = 'current.db';

export interface SqliteLikeDb {
  readonly exec: (sql: string) => unknown;
  readonly query: (sql: string) => { readonly get: (...p: readonly unknown[]) => unknown };
  readonly close?: () => void;
}

/** Result of resolving/creating the pointer for a role. */
export interface ResolvedGeneration {
  /** Absolute path to the generation db file this role should open. */
  readonly path: string;
  /** The generation id (pointer contents). */
  readonly genId: string;
}

const isGenerationFilename = (name: string): boolean =>
  name.startsWith(GEN_PREFIX) &&
  name.endsWith(GEN_SUFFIX) &&
  name !== LEGACY_DB_FILENAME &&
  // exclude sidecars (current.<gen>.db-wal / -shm) — those don't end in .db
  !name.includes('.db-');

const pointerPath = (connectionsDir: string): string => join(connectionsDir, POINTER_FILENAME);

const genFilename = (genId: string): string => `${GEN_PREFIX}${genId}${GEN_SUFFIX}`;

const genFilePath = (connectionsDir: string, genId: string): string =>
  join(connectionsDir, genFilename(genId));

/** Extract the gen id from a generation filename, or null. */
const genIdFromFilename = (name: string): string | null => {
  if (!isGenerationFilename(name)) return null;
  return name.slice(GEN_PREFIX.length, name.length - GEN_SUFFIX.length);
};

/** Read the active generation id from POINTER, or null if absent/empty. */
export const readPointer = (connectionsDir: string): string | null => {
  try {
    const raw = readFileSync(pointerPath(connectionsDir), 'utf8').trim();
    if (raw.length === 0) return null;
    // Stored as a bare gen id (not the filename) — tolerate either form.
    return raw.endsWith(GEN_SUFFIX) ? genIdFromFilename(raw) : raw;
  } catch {
    return null;
  }
};

/** Atomically flip POINTER to the given generation id (tmp write + rename of
 *  the pointer file only — nothing holds the pointer open, so rename is safe).
 *
 *  DURABILITY SCOPE: this is safe against kill-9 / SIGKILL (D6(c)) — SIGKILL
 *  loses only process state; the page cache survives, so a subsequently-booted
 *  process reads all committed writes and the atomic rename means the pointer
 *  names either the old or the new gen, never a torn value. It is NOT hardened
 *  against power loss / kernel panic: there is no fsync of the tmp file, the
 *  directory, or ordering between the gen db's data pages and this pointer
 *  rename, so a hard crash could leave a durable pointer to a not-yet-persisted
 *  gen. Hard-crash (power-loss) durability is explicitly OUT OF SCOPE for M4
 *  (the deliverable scopes crash-safety to kill-9); if it is ever wanted,
 *  fsync the gen db + its dir before the flip and fsync the dir after. */
export const writePointer = (connectionsDir: string, genId: string): void => {
  mkdirSync(connectionsDir, { recursive: true });
  const tmp = `${pointerPath(connectionsDir)}.${String(process.pid)}.${String(Date.now())}.tmp`;
  writeFileSync(tmp, genId, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, pointerPath(connectionsDir));
};

const safeUnlink = (path: string): void => {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* best-effort */
  }
};

const publishLockPath = (connectionsDir: string): string =>
  join(connectionsDir, PUBLISH_LOCK_FILENAME);

/** How long a stale lockfile (holder crashed mid-publish) is honoured before a
 *  contender steals it. A publish critical section is a checkpoint + a couple
 *  of renames + a readdir — sub-second at real scale — so a lock older than
 *  this is presumed abandoned by a killed holder. */
const PUBLISH_LOCK_STALE_MS = 15_000;
/** Poll interval while waiting to acquire the publish lock. */
const PUBLISH_LOCK_POLL_MS = 5;
/** Absolute ceiling on how long we spin for the lock before proceeding anyway
 *  (deadlock-avoidance: a publish must never hang the drain/overlay forever). */
const PUBLISH_LOCK_MAX_WAIT_MS = 30_000;

const sleepBusy = (ms: number): void => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* short synchronous spin — the critical section is sub-second */
  }
};

/**
 * Acquire the cross-process publish lock, run `fn` (the entire seed-read →
 * flip → GC critical section) with it held, and release it. Uses an O_EXCL
 * lockfile so contention is honoured across process boundaries (the parent
 * overlay/scoped-delta publishers and the fork-per-drain child all serialize
 * here). A lockfile older than PUBLISH_LOCK_STALE_MS is presumed orphaned by a
 * killed holder and stolen. `fn` is synchronous by design — the whole
 * critical section must complete without yielding the lock to another awaited
 * publisher (the flip + GC are pure fs ops).
 */
export const withPublishLock = <T>(connectionsDir: string, fn: () => T): T => {
  mkdirSync(connectionsDir, { recursive: true });
  const lockPath = publishLockPath(connectionsDir);
  const deadline = Date.now() + PUBLISH_LOCK_MAX_WAIT_MS;
  let held = false;
  while (!held) {
    try {
      // O_EXCL: fails if the lockfile already exists (another publisher holds
      // it). The pid+timestamp payload is diagnostic only.
      const fd = openSync(lockPath, 'wx', 0o600);
      try {
        writeFileSync(fd, `${String(process.pid)} ${String(Date.now())}`);
      } catch {
        /* payload is best-effort */
      }
      closeSync(fd);
      held = true;
    } catch {
      // Someone holds it. Steal it if it is stale (holder crashed), else wait.
      let stale = false;
      try {
        stale = Date.now() - statSync(lockPath).mtimeMs > PUBLISH_LOCK_STALE_MS;
      } catch {
        // Lock vanished between our failed create and the stat — retry create.
        continue;
      }
      if (stale) {
        safeUnlink(lockPath);
        continue;
      }
      if (Date.now() > deadline) break; // deadlock-avoidance: proceed unlocked
      sleepBusy(PUBLISH_LOCK_POLL_MS);
    }
  }
  try {
    return fn();
  } finally {
    if (held) safeUnlink(lockPath);
  }
};

/**
 * Compare-and-swap publish under the cross-process lock. Re-reads the pointer
 * at flip time and only advances it to `newGenId` if the pointer still names
 * `seedGenId` (the gen the shadow was cloned from). Returns:
 *   - `'published'` — the CAS won; the pointer now names `newGenId` and GC ran.
 *   - `'superseded'` — another publisher advanced the pointer underneath this
 *     shadow; the pointer is LEFT ALONE and the caller must discard its shadow
 *     (do NOT GC — the winner's gen must survive).
 *
 * The GC keep-set is computed from the pointer value observed AT flip time
 * (never a seed-time snapshot) unioned with `keepAlive` — every generation a
 * live handle in THIS process still holds (open reader gen, retired handles,
 * in-flight write shadows). gcOldGenerations additionally refuses to unlink
 * whatever the pointer currently names, as a defensive invariant.
 */
export const casPublish = (
  connectionsDir: string,
  input: {
    readonly seedGenId: string | null;
    readonly newGenId: string;
    readonly keepAlive?: readonly string[];
  },
): { readonly outcome: 'published' | 'superseded'; readonly unlinked: readonly string[] } =>
  withPublishLock(connectionsDir, () => {
    const currentPointer = readPointer(connectionsDir);
    // CAS: only flip if the pointer is still what this shadow was seeded from.
    // A null seed means "no gen was published when we started" — accept only if
    // the pointer is still null (nobody published underneath us).
    if (currentPointer !== input.seedGenId) {
      return { outcome: 'superseded' as const, unlinked: [] as readonly string[] };
    }
    writePointer(connectionsDir, input.newGenId);
    const keep = new Set<string>([input.newGenId, ...(input.keepAlive ?? [])]);
    if (input.seedGenId !== null) keep.add(input.seedGenId);
    const unlinked = gcOldGenerations(connectionsDir, [...keep]);
    return { outcome: 'published' as const, unlinked };
  });

/** Checkpoint-TRUNCATE a db so it is self-contained + readonly-openable, and
 *  its -wal stats ~0. Returns the checkpoint result row for diagnostics. */
export const checkpointTruncate = (
  db: SqliteLikeDb,
): { readonly busy: number; readonly log: number; readonly checkpointed: number } => {
  const row = db.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as
    | { busy?: number; log?: number; checkpointed?: number }
    | undefined;
  return {
    busy: Number(row?.busy ?? 0),
    log: Number(row?.log ?? 0),
    checkpointed: Number(row?.checkpointed ?? 0),
  };
};

/** Compose a stable generation id from the write_seq + a short revision. */
export const composeGenId = (writeSeq: number, revision: string): string => {
  const rev = revision.replace(/[^a-zA-Z0-9]/gu, '').slice(0, 16) || 'norev';
  return `${String(writeSeq)}-${rev}`;
};

/**
 * First-boot migration: if no POINTER exists but a legacy `current.db` does,
 * clonefile it into `current.<gen0>.db` (APFS `cp -c` is ~0ms — measured),
 * checkpoint-TRUNCATE the clone, and write POINTER→gen0. The legacy
 * `current.db` is LEFT UNTOUCHED here as the rollback ANCHOR (D6/§7).
 *
 * On a KILL-SWITCH downgrade the legacy open no longer serves this frozen
 * migration seed: reconcileLegacyToPublished refreshes current.db FROM the
 * latest published generation before the legacy handle opens it, so the seed's
 * retention now has a live purpose (it becomes the current graph on downgrade,
 * not an arbitrarily-old snapshot). Since the retained current.db is refreshed
 * to the served gen on downgrade, keeping it is justified — it is NOT dead
 * storage. Idempotent.
 *
 * `openReadwrite` opens a readwrite handle for the one-time checkpoint of the
 * seed clone. Returns the resolved gen0 (or null if nothing to migrate — a
 * genuinely fresh vault with neither pointer nor legacy db).
 */
export const migrateLegacyToGeneration = (
  connectionsDir: string,
  openReadwrite: (path: string) => SqliteLikeDb,
): ResolvedGeneration | null => {
  const existingGen = readPointer(connectionsDir);
  if (existingGen !== null && existsSync(genFilePath(connectionsDir, existingGen))) {
    return { path: genFilePath(connectionsDir, existingGen), genId: existingGen };
  }
  const legacyPath = join(connectionsDir, LEGACY_DB_FILENAME);
  if (!existsSync(legacyPath)) {
    return null; // fresh vault — the child seeds gen0 on the first write
  }
  mkdirSync(connectionsDir, { recursive: true });
  const gen0 = composeGenId(0, 'legacyseed');
  const gen0Path = genFilePath(connectionsDir, gen0);
  if (!existsSync(gen0Path)) {
    // clonefile (zero-cost on APFS); copyFileSync falls back to a real copy on
    // non-APFS. Bun/Node copyFileSync uses COPYFILE_CLONE opportunistically.
    copyFileSync(legacyPath, gen0Path);
    const db = openReadwrite(gen0Path);
    try {
      checkpointTruncate(db);
    } finally {
      db.close?.();
    }
  }
  writePointer(connectionsDir, gen0);
  return { path: gen0Path, genId: gen0 };
};

/**
 * Kill-switch downgrade reconciliation (D6 rollback). When the operator reverts
 * to legacy single-file mode (SIDETRACK_CONNECTIONS_DOUBLE_BUFFER=0), the store
 * opens `current.db`. But under double-buffer NO writer ever updates
 * `current.db` again — publishes only ever write `current.<gen>.db` + flip the
 * POINTER — so `current.db` is frozen at whatever it held when double-buffer
 * was first enabled. Serving it after generations advanced would silently
 * revert the graph to an arbitrarily-old state (the rollback-is-broken blocker).
 *
 * Fix: on legacy open, if a POINTER exists and names a resident generation,
 * refresh `current.db` from that published gen (clonefile — ~0ms on APFS) BEFORE
 * the legacy handle opens it, so the downgrade serves the latest published
 * graph, not the stale seed. Idempotent + best-effort: if anything fails the
 * legacy open still proceeds against whatever `current.db` holds. Only ever
 * COPIES a published (checkpoint-TRUNCATE'd, quiescent) gen — never a shadow.
 *
 * Returns the gen id reconciled from, or null if there was nothing to reconcile
 * (no pointer, or current.db is already the published gen's clone).
 */
export const reconcileLegacyToPublished = (connectionsDir: string): string | null => {
  const publishedGen = readPointer(connectionsDir);
  if (publishedGen === null) return null;
  const genPath = genFilePath(connectionsDir, publishedGen);
  if (!existsSync(genPath)) return null;
  const legacyPath = join(connectionsDir, LEGACY_DB_FILENAME);
  // A marker records which gen current.db was last refreshed from, so a repeat
  // downgrade on an unchanged pointer is a cheap no-op (no needless re-clone).
  const markerPath = join(connectionsDir, 'current.db.reconciled-from');
  try {
    if (existsSync(legacyPath) && readFileSync(markerPath, 'utf8').trim() === publishedGen) {
      return null;
    }
  } catch {
    /* no marker yet — fall through and refresh */
  }
  try {
    // Refresh current.db from the published gen. Remove stale sidecars first so
    // the legacy open recreates its own -wal/-shm against the fresh main file.
    safeUnlink(`${legacyPath}-wal`);
    safeUnlink(`${legacyPath}-shm`);
    copyFileSync(genPath, legacyPath);
    writeFileSync(markerPath, publishedGen, { encoding: 'utf8', mode: 0o600 });
    return publishedGen;
  } catch {
    return null; // best-effort — legacy open proceeds against existing current.db
  }
};

/**
 * The child's shadow generation: clone the currently-published generation into
 * a fresh `current.<newgen>.db` and return its path. All the store's normal
 * writers then land there (they read prior rows from the clone transparently).
 * `newGenId` should be a fresh unique id (composed after the write completes,
 * or a provisional one; the pointer only publishes after checkpoint).
 *
 * If no generation is published yet (fresh vault), the shadow starts empty and
 * the store's schema init + write populate it.
 */
export const createShadowGeneration = (
  connectionsDir: string,
  newGenId: string,
): { readonly path: string; readonly genId: string; readonly seededFrom: string | null } => {
  mkdirSync(connectionsDir, { recursive: true });
  const shadowPath = genFilePath(connectionsDir, newGenId);
  const publishedGen = readPointer(connectionsDir);
  const seedPath =
    publishedGen !== null && existsSync(genFilePath(connectionsDir, publishedGen))
      ? genFilePath(connectionsDir, publishedGen)
      : existsSync(join(connectionsDir, LEGACY_DB_FILENAME))
        ? join(connectionsDir, LEGACY_DB_FILENAME)
        : null;
  if (existsSync(shadowPath)) {
    // A prior aborted publish left this shadow behind; remove it so we start
    // from a clean clone of the published gen (never inherit a torn shadow).
    safeUnlink(shadowPath);
    safeUnlink(`${shadowPath}-wal`);
    safeUnlink(`${shadowPath}-shm`);
  }
  if (seedPath !== null) {
    copyFileSync(seedPath, shadowPath);
    // The seed may carry an un-checkpointed -wal (if it was the legacy db); the
    // store opens it readwrite and its own checkpoint at publish folds it. We
    // do NOT copy the sidecars: a fresh readwrite open recreates them, and the
    // seed gens are always published post-checkpoint so their -wal is ~0.
  }
  return { path: shadowPath, genId: newGenId, seededFrom: publishedGen };
};

/**
 * GC old generations after a publish. Keep the pointer target (just published)
 * and, defensively, the single immediately-prior generation the parent may
 * still hold a handle on until it reopens; unlink every OTHER `current.<gen>.db`
 * (+ its sidecars). Called by the child on its NEXT publish, so any generation
 * older than `keepAlso` has been superseded for at least one full drain cycle —
 * the parent reopens on pointer change within one request, so it long ago moved
 * its handle past anything this GC removes.
 *
 * Returns the list of gen ids unlinked (for diagnostics).
 */
export const gcOldGenerations = (
  connectionsDir: string,
  keepGenIds: readonly string[],
): readonly string[] => {
  const keep = new Set(keepGenIds);
  // Defensive invariant: NEVER unlink whatever the pointer currently names,
  // regardless of the caller's keep-set. Two uncoordinated publishers can
  // diverge on which gen is "current"; re-reading the live pointer here is the
  // last line of defence against unlinking the file the pointer points at
  // (which would strand every reader on a dangling handle). Cheap: one ~40-byte
  // read, only on the (rare) publish path.
  const livePointer = readPointer(connectionsDir);
  if (livePointer !== null) keep.add(livePointer);
  const unlinked: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(connectionsDir);
  } catch {
    return unlinked;
  }
  for (const name of entries) {
    const genId = genIdFromFilename(name);
    if (genId === null || keep.has(genId)) continue;
    const base = genFilePath(connectionsDir, genId);
    safeUnlink(base);
    safeUnlink(`${base}-wal`);
    safeUnlink(`${base}-shm`);
    unlinked.push(genId);
  }
  return unlinked;
};

/** Discard a single orphaned shadow generation (a publish that lost the CAS or
 *  rolled back): unlink ONLY that gen's file + sidecars, and REFUSE if it is
 *  the gen the live pointer names (defensive — a lost-CAS shadow is never the
 *  pointer target, but never unlink the served file under any circumstance). */
export const discardShadowGeneration = (connectionsDir: string, genId: string): void => {
  if (readPointer(connectionsDir) === genId) return;
  const base = genFilePath(connectionsDir, genId);
  safeUnlink(base);
  safeUnlink(`${base}-wal`);
  safeUnlink(`${base}-shm`);
};

/** List resident generation ids (for diagnostics). */
export const residentGenerations = (connectionsDir: string): readonly string[] => {
  try {
    return readdirSync(connectionsDir)
      .map(genIdFromFilename)
      .filter((g): g is string => g !== null);
  } catch {
    return [];
  }
};

export const generationDbPath = (connectionsDir: string, genId: string): string =>
  genFilePath(connectionsDir, genId);

/** Best-effort existence check for a generation db path (never throws). */
export const generationExists = (connectionsDir: string, genId: string): boolean => {
  try {
    return existsSync(genFilePath(connectionsDir, genId));
  } catch {
    return false;
  }
};
