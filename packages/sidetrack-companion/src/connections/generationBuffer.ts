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
//
// CROSS-PROCESS IN-FLIGHT SHADOWS (live P0, 2026-07-29). Measurement (3) has a
// hole that bit in production: the GC keep-set was assembled from the
// publisher's OWN in-process state (SqliteConnectionsStore#inFlightShadowGenIds
// + its open/retired handle gens). A WRITE SHADOW is a `current.<gen>.db` like
// any other generation, so a publisher in ANOTHER process readdir's it, finds
// it in neither its keep-set nor the pointer, and unlinks it — out from under a
// live writer. Both directions happen on the real vault:
//   - the parent's projection-overlay / scoped-delta shadow-publish (seconds)
//     is GC'd by the fork-per-drain child's publish;
//   - the child's drain shadow (MINUTES — it is open for the whole reconcile)
//     is GC'd by any parent overlay publish that lands mid-drain.
// The victim's next query throws literally "disk I/O error", which is neither a
// lock error nor corruption, so nothing retried it: it surfaced as
// `sync.materializers.connections {status:'failed', lastError:'disk I/O error'}`
// recurring AFTER successful drains (lastSuccessAt advances, a later attempt
// dies) with both dbs passing `PRAGMA quick_check` and 20GB free.
// FIX: every shadow registers an on-disk IN-FLIGHT MARKER (`current.<gen>.db
// .inflight`, holding the writer's pid) at creation and clears it at
// publish/discard. gcOldGenerations keeps any generation whose marker names a
// LIVE foreign pid. The marker is deliberately outside this process's memory —
// that is the entire point; an in-memory set can never be seen by the other
// process.

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
/** Suffix of a shadow generation's cross-process in-flight marker. Appended to
 *  the generation FILENAME (`current.<gen>.db.inflight`) so it sorts beside its
 *  db and can never itself be mistaken for a generation: isGenerationFilename
 *  requires the name to END in `.db`, and this does not. */
const INFLIGHT_SUFFIX = '.inflight';

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

// ---------------------------------------------------------------------------
// Cross-process in-flight shadow markers (see the CROSS-PROCESS IN-FLIGHT
// SHADOWS note in the header). A marker is `current.<gen>.db.inflight` holding
// `<pid> <epochMs>`; its ONLY consumer is gcOldGenerations.
// ---------------------------------------------------------------------------

const inflightMarkerPath = (connectionsDir: string, genId: string): string =>
  `${genFilePath(connectionsDir, genId)}${INFLIGHT_SUFFIX}`;

/**
 * Absolute ceiling on how long a marker pins a generation, as a LEAK backstop
 * only — liveness is decided by pid, not age. It exists purely for pid reuse:
 * if a long-dead writer's pid is recycled by an unrelated process, its marker
 * would otherwise pin a ~300MB generation forever.
 *
 * The asymmetry is deliberate and this number is chosen for it: a false KEEP
 * costs one stale file that the next GC (once the pid dies) collects, while a
 * false COLLECT is the P0 "disk I/O error" this whole mechanism exists to
 * prevent. So the ceiling is set far above any legitimate writer lifetime — a
 * drain child is watchdogged at 10 min of no progress
 * (DEFAULT_NO_PROGRESS_TIMEOUT_MS in connectionsReconcileChildClient.ts) and a
 * parent overlay shadow lives milliseconds — rather than tuned tight.
 */
const INFLIGHT_MARKER_MAX_AGE_MS = 6 * 60 * 60_000;

/** Does this pid name a live process? `kill(pid, 0)` sends no signal; it only
 *  probes existence. EPERM means the pid EXISTS but belongs to another user —
 *  alive for our purposes. Any other throw (ESRCH) means dead. */
const processAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown } | null)?.code === 'EPERM';
  }
};

/** Register a shadow generation as in-flight for THIS process. Best-effort: a
 *  marker that fails to write only restores the pre-fix behaviour for that one
 *  shadow — it must never fail the write that is about to happen. */
export const markShadowInFlight = (connectionsDir: string, genId: string): void => {
  try {
    writeFileSync(inflightMarkerPath(connectionsDir, genId), `${String(process.pid)} ${String(Date.now())}`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch {
    /* best-effort */
  }
};

/** Drop a shadow's in-flight marker (published, discarded, or superseded). */
export const clearShadowInFlight = (connectionsDir: string, genId: string): void => {
  safeUnlink(inflightMarkerPath(connectionsDir, genId));
};

/**
 * Is `genId` claimed by a live writer in ANOTHER process?
 *
 * Own-pid markers deliberately return false: within one process the store
 * already tracks its live shadows exactly (#inFlightShadowGenIds feeds every
 * casPublish keep-set), so honouring our own marker would add nothing and would
 * make a same-process GC unable to collect a shadow the caller has already
 * finalized. The marker's whole job is the blind spot BETWEEN processes.
 */
const foreignWriterHoldsGeneration = (connectionsDir: string, genId: string): boolean => {
  let raw: string;
  try {
    raw = readFileSync(inflightMarkerPath(connectionsDir, genId), 'utf8');
  } catch {
    return false; // absent == not in flight (the overwhelmingly common case)
  }
  const [pidText, atText] = raw.trim().split(/\s+/u);
  const pid = Number.parseInt(pidText ?? '', 10);
  const atMs = Number.parseInt(atText ?? '', 10);
  if (pid === process.pid) return false;
  if (Number.isFinite(atMs) && Date.now() - atMs > INFLIGHT_MARKER_MAX_AGE_MS) return false;
  return processAlive(pid);
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

/** Opaque handle returned by `acquirePublishLock` — `held` is false only when
 *  the deadline-fallback fired with `failClosed` unset (the historical
 *  deadlock-avoidance behaviour: proceed unlocked rather than hang forever). */
export interface PublishLockHandle {
  readonly held: boolean;
}

/**
 * Blocking-acquire half of the cross-process publish lock. Uses an O_EXCL
 * lockfile so contention is honoured across process boundaries (the parent
 * overlay/scoped-delta publishers and the fork-per-drain child all serialize
 * here). A lockfile older than PUBLISH_LOCK_STALE_MS is presumed orphaned by a
 * killed holder and stolen. Synchronous by design (a busy-spin, not an
 * async poll) so the caller's critical section — whatever it does with the
 * lock held — never yields the lock to another awaited publisher mid-section.
 *
 * Factored out of `withPublishLock` so a caller whose critical section spans
 * more than one synchronous callback (in-place publish: open a handle, hand
 * control back to the row-mutation caller, then finalize) can hold the lock
 * across that whole span via explicit acquire/release instead of being
 * forced into one big callback. `withPublishLock` is now a thin wrapper over
 * this pair — existing callers (`casPublish`, `sweepOrphanGenerations`) are
 * unchanged.
 */
export const acquirePublishLock = (
  connectionsDir: string,
  options: { readonly failClosed?: boolean } = {},
): PublishLockHandle => {
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
      if (Date.now() > deadline) {
        // Publishers preserve the historical deadlock-avoidance fallback.
        // Destructive maintenance passes fail closed instead: no reclamation is
        // worth racing an owner whose liveness we could not resolve.
        if (options.failClosed === true) {
          throw new Error('connections publish lock could not be acquired safely');
        }
        break;
      }
      sleepBusy(PUBLISH_LOCK_POLL_MS);
    }
  }
  return { held };
};

/** Release a lock acquired via `acquirePublishLock`. Idempotent-safe to call
 *  even when `handle.held` is false (the deadline-fallback case) — it simply
 *  does nothing, exactly like `withPublishLock`'s original `finally`. */
export const releasePublishLock = (connectionsDir: string, handle: PublishLockHandle): void => {
  if (handle.held) safeUnlink(publishLockPath(connectionsDir));
};

/**
 * Acquire the cross-process publish lock, run `fn` (the entire seed-read →
 * flip → GC critical section) with it held, and release it. `fn` is
 * synchronous by design — the whole critical section must complete without
 * yielding the lock to another awaited publisher (the flip + GC are pure fs
 * ops). See `acquirePublishLock` for the underlying primitive.
 */
export const withPublishLock = <T>(
  connectionsDir: string,
  fn: () => T,
  options: { readonly failClosed?: boolean } = {},
): T => {
  const handle = acquirePublishLock(connectionsDir, options);
  try {
    return fn();
  } finally {
    releasePublishLock(connectionsDir, handle);
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
    // The shadow is now the SERVED generation, not an in-flight write target.
    // Clearing here (inside the publish lock, before the GC readdir) keeps the
    // marker's lifetime exactly equal to the window in which unlinking the file
    // would break a writer, and stops published gens accumulating markers that
    // would pin them past their usefulness.
    clearShadowInFlight(connectionsDir, input.newGenId);
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
 * `current.db` again — publishes only ever write `current.<gen>.db` (in place,
 * or via a fresh shadow + POINTER flip) — so `current.db` is frozen at whatever
 * it held when double-buffer was first enabled. Serving it after generations
 * advanced would silently revert the graph to an arbitrarily-old state (the
 * rollback-is-broken blocker).
 *
 * Fix: on legacy open, if a POINTER exists and names a resident generation,
 * refresh `current.db` from that published gen (clonefile — ~0ms on APFS) BEFORE
 * the legacy handle opens it, so the downgrade serves the latest published
 * graph, not the stale seed. Idempotent + best-effort: if anything fails the
 * legacy open still proceeds against whatever `current.db` holds.
 *
 * 2026-08-16 (in-place child-drain channel widening): two changes from the
 * original clone-only-source invariant, both required now that the SAME
 * generation id can receive many in-place publishes instead of the pointer
 * always advancing to a fresh, already-checkpointed file:
 *   1. Checkpoint-TRUNCATE the published generation HERE, under the SAME
 *      cross-process publish lock every in-place writer holds during its own
 *      write, before copying it. In-place publish defers its own
 *      checkpoint (idle timer / every-N safety net — see
 *      `inPlaceCheckpointIdleMs`/`inPlaceCheckpointEveryN`), so the main
 *      `.db` file alone can be STALE relative to its own `-wal` sidecar;
 *      the old clone+CAS-flip path never had this problem because every
 *      published generation was ALREADY checkpoint-TRUNCATE'd before the
 *      pointer ever named it. Under the lock, no concurrent in-place
 *      publisher can land mid-checkpoint-mid-copy.
 *   2. The staleness marker now fingerprints (genId, post-checkpoint mtime),
 *      not genId alone. Genid alone was a valid freshness proof when a
 *      generation's content never changed after publish (the old world);
 *      under in-place publish the SAME genId's content changes across many
 *      publishes, so an unchanged genId no longer implies an unchanged
 *      `current.db` is still fresh.
 *
 * `openReadwrite` opens a readwrite handle for the checkpoint — mirrors
 * `migrateLegacyToGeneration`'s existing seam (this module has no sqlite
 * dependency of its own; the caller, which already loaded it, supplies one).
 *
 * Returns the gen id reconciled from, or null if there was nothing to reconcile
 * (no pointer, or current.db is already fresh for that generation's current
 * content).
 */
export const reconcileLegacyToPublished = (
  connectionsDir: string,
  openReadwrite: (path: string) => SqliteLikeDb,
): string | null =>
  withPublishLock(connectionsDir, () => {
    // Re-resolve the pointer INSIDE the lock — the same discipline casPublish
    // and #acquireInPlaceWriteHandle use — so a concurrent publish can never
    // be raced: either we observe what it just wrote, or it serializes behind
    // us (both hold this SAME lock).
    const publishedGen = readPointer(connectionsDir);
    if (publishedGen === null) return null;
    const genPath = genFilePath(connectionsDir, publishedGen);
    if (!existsSync(genPath)) return null;
    try {
      const db = openReadwrite(genPath);
      try {
        checkpointTruncate(db);
      } finally {
        db.close?.();
      }
    } catch {
      // Best-effort: the copy below still runs against whatever the main
      // file currently holds. A failed checkpoint only risks the legacy
      // snapshot lagging by the writes still sitting in the source's WAL —
      // never corruption (copyFileSync of the main file alone is always a
      // valid, just possibly stale, SQLite database).
    }
    let sourceMtimeMs: number;
    try {
      sourceMtimeMs = statSync(genPath).mtimeMs;
    } catch {
      return null; // vanished mid-reconcile — nothing to copy
    }
    const legacyPath = join(connectionsDir, LEGACY_DB_FILENAME);
    // A marker records (gen id, post-checkpoint mtime) so a repeat downgrade
    // against genuinely unchanged content is a cheap no-op (no needless
    // re-copy), while a repeat downgrade after MORE in-place publishes
    // landed on the SAME gen id correctly re-copies.
    const markerPath = join(connectionsDir, 'current.db.reconciled-from');
    const fingerprint = `${publishedGen}@${String(sourceMtimeMs)}`;
    try {
      if (existsSync(legacyPath) && readFileSync(markerPath, 'utf8').trim() === fingerprint) {
        return null;
      }
    } catch {
      /* no marker yet — fall through and refresh */
    }
    try {
      // Refresh current.db from the published gen. Remove stale sidecars first
      // so the legacy open recreates its own -wal/-shm against the fresh main
      // file (the source was just checkpoint-TRUNCATE'd above, so its own
      // -wal/-shm are empty/near-empty and never need copying).
      safeUnlink(`${legacyPath}-wal`);
      safeUnlink(`${legacyPath}-shm`);
      copyFileSync(genPath, legacyPath);
      writeFileSync(markerPath, fingerprint, { encoding: 'utf8', mode: 0o600 });
      return publishedGen;
    } catch {
      return null; // best-effort — legacy open proceeds against existing current.db
    }
  });

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
    clearShadowInFlight(connectionsDir, newGenId);
  }
  // Claim the shadow BEFORE any bytes land in it, so there is no window in
  // which the file is visible to another process's readdir-driven GC while
  // unclaimed. Marking here (rather than at each call site) means EVERY shadow
  // — child drain, parent overlay, parent scoped-delta — is covered by
  // construction, which is what makes the invariant hold.
  markShadowInFlight(connectionsDir, newGenId);
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
  const survivors = new Set<string>();
  for (const name of entries) {
    const genId = genIdFromFilename(name);
    if (genId === null) continue;
    if (keep.has(genId)) {
      survivors.add(genId);
      continue;
    }
    // CROSS-PROCESS INVARIANT (the live P0 fix). `keep` only knows what THIS
    // process holds. A shadow being written by the fork-per-drain child (open
    // for the whole reconcile — minutes) or by the parent's overlay publish is
    // an ordinary `current.<gen>.db` to this readdir, and unlinking it makes
    // its owner's next query throw "disk I/O error". The on-disk marker is the
    // only channel through which that other process can say "mine, still open".
    if (foreignWriterHoldsGeneration(connectionsDir, genId)) {
      survivors.add(genId);
      continue;
    }
    const base = genFilePath(connectionsDir, genId);
    safeUnlink(base);
    safeUnlink(`${base}-wal`);
    safeUnlink(`${base}-shm`);
    // The gen is gone; its marker (from a dead writer, or already cleared) must
    // not outlive it as a file-less orphan.
    clearShadowInFlight(connectionsDir, genId);
    unlinked.push(genId);
  }
  // Sweep markers whose generation file no longer exists at all (a writer killed
  // between markShadowInFlight and the clone, or a gen removed by an older
  // build). Same readdir, no extra syscall to find them.
  for (const name of entries) {
    if (!name.endsWith(INFLIGHT_SUFFIX)) continue;
    const genId = genIdFromFilename(name.slice(0, name.length - INFLIGHT_SUFFIX.length));
    if (genId === null || survivors.has(genId)) continue;
    if (existsSync(genFilePath(connectionsDir, genId))) continue;
    safeUnlink(join(connectionsDir, name));
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
  clearShadowInFlight(connectionsDir, genId);
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

// ---------------------------------------------------------------------------
// PUBLISH-INDEPENDENT ORPHAN SURVEY + SWEEP (live P0 follow-up, 2026-07-29).
//
// MEASURED on the dogfood vault: `_BAC/connections/` held FOUR generation dbs
// — the pointer target (292 MB) plus THREE orphans at ~323 MB each — i.e. ~970
// MB of dead generations, while the UI's GC inventory reported "10.7 MB / 1
// file". The orphans were minted AFTER the cross-process marker fix above
// shipped, so the marker protocol was not the gap. Two distinct gaps were:
//
//   (1) MINTING. All three orphan filenames had the child-writer's genId shape
//       (`<epochMs>-<pid><rev8>` from snapshot.ts's `#openHandleForRole`), and
//       two shared one pid. The child-writer's SUPERSEDED branch in
//       `#publishGeneration` cleared the in-flight marker but never unlinked
//       the shadow FILE — unlike the three parent-side shadow paths, which all
//       call discardShadowGeneration on a lost CAS. So every child drain whose
//       CAS lost left a full ~323 MB clone behind, deliberately delegating
//       collection to "some other process's GC".
//
//   (2) COLLECTING. gcOldGenerations is reachable ONLY from inside casPublish's
//       *published* branch. Its predicate is already correct (a non-pointer,
//       non-keep-set, not-live-marked generation IS unlinked) — but it only
//       ever RUNS when some later publisher wins a CAS. On an idle vault, or a
//       run of superseded CASes, or with double-buffer rolled back to legacy,
//       nothing sweeps and nothing counts. Marker-less orphans were therefore
//       unbounded in time, not unbounded in the predicate.
//
// This section adds the missing half: a survey that can run ANY time, off the
// publish path (feeding the vault ledger + a health counter so orphans are
// VISIBLE even when nothing is armed to delete them), and an armed sweep.
//
// THE ASYMMETRY IS UNCHANGED AND EXPLICIT: a false KEEP costs one stale file
// that the next survey re-offers; a false COLLECT is the P0 "disk I/O error"
// this whole mechanism exists to prevent (measurement (3) in the header —
// unlinking a generation under an open readonly handle throws on its next
// query). So the survey keeps, in addition to the pointer target:
//   - the newest `keepRecentGenerations - 1` non-pointer generations by mtime,
//     mirroring casPublish's pointer+seed keep-set. This is load-bearing, NOT
//     decoration: casPublish deliberately retains the immediately-prior
//     generation for the window in which a parent reader still holds a RETIRED
//     handle on it, and a survey running outside the publish critical section
//     cannot see that in-process handle set at all;
//   - anything whose marker names ANY live pid — including OUR OWN, which is
//     where this differs from foreignWriterHoldsGeneration. That function may
//     ignore own-pid markers because it only ever runs inside casPublish, where
//     the store's exact #inFlightShadowGenIds is unioned into the keep-set. The
//     survey has no such keep-set, so an own-pid marker is the only evidence it
//     gets that this process is mid-write on that generation;
//   - anything younger than the grace window, marker or not.
// ---------------------------------------------------------------------------

/**
 * How long a marker-LESS generation must sit untouched before the survey will
 * call it collectable.
 *
 * Sized off the longest legitimate writer lifetime, not tuned tight: a drain
 * child is watchdogged at 10 min of no progress
 * (DEFAULT_NO_PROGRESS_TIMEOUT_MS in connectionsReconcileChildClient.ts) and a
 * parent overlay shadow lives milliseconds. 60 min is 6x the watchdog, which
 * covers the only way a live writer can be marker-less: markShadowInFlight is
 * best-effort (it must never fail the write that is about to happen), so a
 * marker write that lost to ENOSPC/EPERM leaves a live shadow unclaimed. It
 * also covers generations left by builds older than the marker protocol.
 */
export const GENERATION_ORPHAN_GRACE_MS = 60 * 60_000;

/** Default number of newest generations the survey keeps regardless of markers:
 *  the pointer target + one prior, matching casPublish's keep-set (pointer +
 *  seed) and therefore the retired-handle window. */
export const GENERATION_KEEP_RECENT_DEFAULT = 2;

export type GenerationDisposition =
  /** The generation the POINTER names. Never collectable, under any flag. */
  | 'pointer'
  /** Within the newest-N window — the retired-handle safety margin. */
  | 'recent-prior'
  /** A marker names a live pid (ours or another process's): a writer owns it. */
  | 'live-marked'
  /** Marker-less (or dead-pid-marked) but younger than the grace window. */
  | 'orphan-young'
  /** Marker-less or dead-pid-marked, aged past grace, outside the keep window. */
  | 'orphan-collectable';

export interface GenerationSurveyEntry {
  readonly genId: string;
  /** Bytes of the generation db PLUS its -wal/-shm siblings — what collecting
   *  it actually reclaims. Siblings are never counted separately anywhere. */
  readonly bytes: number;
  /** Newest mtime across the db + siblings (ms epoch), or null if unstattable. */
  readonly mtimeMs: number | null;
  readonly disposition: GenerationDisposition;
  /** The marker's pid, when a marker file exists and parses. Typed emptiness:
   *  null = no marker (or unreadable), which is NOT the same as pid 0. */
  readonly markerPid: number | null;
  /** Whether that pid is currently alive. null when there is no marker pid. */
  readonly markerPidAlive: boolean | null;
  /** Human-readable WHY, for the ledger/health surface. */
  readonly note: string;
}

export interface GenerationSurvey {
  readonly producedAt: string;
  /** POINTER contents at survey time, or null on a vault with no pointer. */
  readonly pointerGenId: string | null;
  readonly entries: readonly GenerationSurveyEntry[];
  readonly totalBytes: number;
  /** Sum of bytes over `orphan-collectable` entries only. */
  readonly collectableBytes: number;
  readonly collectableCount: number;
  /** True when the destructive switch was requested. */
  readonly sweepRequested: boolean;
  /** True only when requested AND an S1 active-generation proof was supplied. */
  readonly sweepArmed: boolean;
}

export interface SurveyGenerationsOptions {
  readonly now?: Date;
  readonly graceMs?: number;
  readonly keepRecentGenerations?: number;
  /** Extra gen ids to treat as live (the store's in-process handle set, when a
   *  caller happens to have it). Purely additive caution. */
  readonly keepAlive?: readonly string[];
  /** Supplied only by the proof-gated S2 retirement boundary after validating
   * quick_check, strong content signature, pointer stability, and checkpoint
   * generation binding. An env flag alone must never authorize collection. */
  readonly s1SafetyVerified?: boolean;
}

/**
 * Is deletion of surveyed orphans permitted?
 *
 * DEFAULTS OFF because this deletes data. In S2 this flag is only the operator's
 * REQUEST: surveyGenerations also requires `s1SafetyVerified`, supplied by the
 * storage-retirement boundary after durable active-generation read-back. The
 * environment can no longer authorize deletion by itself.
 */
export const generationSweepArmed = (): boolean => {
  const raw = process.env['SIDETRACK_GENERATION_GC_SWEEP'];
  return raw === '1' || raw === 'true';
};

/** Bytes + newest mtime for a generation's db and its -wal/-shm siblings. */
const generationFootprint = (
  connectionsDir: string,
  genId: string,
): { readonly bytes: number; readonly mtimeMs: number | null } => {
  const base = genFilePath(connectionsDir, genId);
  let bytes = 0;
  let mtimeMs: number | null = null;
  for (const path of [base, `${base}-wal`, `${base}-shm`]) {
    try {
      const info = statSync(path);
      bytes += info.size;
      mtimeMs = mtimeMs === null ? info.mtimeMs : Math.max(mtimeMs, info.mtimeMs);
    } catch {
      /* sibling absent — the common case for a checkpoint-TRUNCATE'd gen */
    }
  }
  return { bytes, mtimeMs };
};

/** Read a generation's marker without judging it. Returns typed emptiness:
 *  null pid = no marker / unparseable, distinct from a dead pid. */
const readMarker = (
  connectionsDir: string,
  genId: string,
): { readonly pid: number | null; readonly atMs: number | null } => {
  let raw: string;
  try {
    raw = readFileSync(inflightMarkerPath(connectionsDir, genId), 'utf8');
  } catch {
    return { pid: null, atMs: null };
  }
  const [pidText, atText] = raw.trim().split(/\s+/u);
  const pid = Number.parseInt(pidText ?? '', 10);
  const atMs = Number.parseInt(atText ?? '', 10);
  return {
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    atMs: Number.isFinite(atMs) ? atMs : null,
  };
};

/**
 * Classify every resident generation. READ-ONLY: stats files, reads markers and
 * the pointer, deletes nothing. Cheap enough to run on a TTL — O(resident
 * generations) stats, and a real vault holds 2-4 of them.
 */
export const surveyGenerations = (
  connectionsDir: string,
  options: SurveyGenerationsOptions = {},
): GenerationSurvey => {
  const now = options.now ?? new Date();
  const graceMs = options.graceMs ?? GENERATION_ORPHAN_GRACE_MS;
  const keepRecent = Math.max(1, options.keepRecentGenerations ?? GENERATION_KEEP_RECENT_DEFAULT);
  const keepAlive = new Set(options.keepAlive ?? []);
  const pointerGenId = readPointer(connectionsDir);

  const measured = residentGenerations(connectionsDir).map((genId) => ({
    genId,
    ...generationFootprint(connectionsDir, genId),
    marker: readMarker(connectionsDir, genId),
  }));

  // Newest-first by mtime. An unstattable generation (mtimeMs null) sorts LAST
  // so it can never displace a real recent generation from the keep window —
  // but it is also never AGED past grace below (unknown age ⇒ keep), so it
  // simply survives as orphan-young. Absent ≠ zero ≠ unknown.
  const byRecency = [...measured].sort((left, right) => (right.mtimeMs ?? -1) - (left.mtimeMs ?? -1));
  const recentWindow = new Set<string>();
  for (const row of byRecency) {
    if (recentWindow.size >= keepRecent) break;
    recentWindow.add(row.genId);
  }
  // The pointer target occupies one keep slot by definition, so it must be IN
  // the window even if a fresher in-flight shadow out-ranks it by mtime.
  if (pointerGenId !== null) recentWindow.add(pointerGenId);

  const entries: GenerationSurveyEntry[] = measured
    .map((row): GenerationSurveyEntry => {
      const markerPid = row.marker.pid;
      const markerPidAlive = markerPid === null ? null : processAlive(markerPid);
      const ageMs = row.mtimeMs === null ? null : now.getTime() - row.mtimeMs;
      const base = {
        genId: row.genId,
        bytes: row.bytes,
        mtimeMs: row.mtimeMs,
        markerPid,
        markerPidAlive,
      };
      if (row.genId === pointerGenId) {
        return { ...base, disposition: 'pointer', note: 'the served generation' };
      }
      if (keepAlive.has(row.genId)) {
        return {
          ...base,
          disposition: 'live-marked',
          note: 'held by a live handle in this process',
        };
      }
      // A live marker wins over recency so the note explains the real reason.
      // Unlike foreignWriterHoldsGeneration this honours OUR OWN pid too (see
      // the section header): outside casPublish there is no in-process keep-set
      // to fall back on. The 6h marker ceiling still applies as a pid-reuse
      // backstop.
      if (
        markerPidAlive === true &&
        (row.marker.atMs === null || now.getTime() - row.marker.atMs <= INFLIGHT_MARKER_MAX_AGE_MS)
      ) {
        return {
          ...base,
          disposition: 'live-marked',
          note: `in-flight marker names live pid ${String(markerPid)}`,
        };
      }
      if (recentWindow.has(row.genId)) {
        return {
          ...base,
          disposition: 'recent-prior',
          note: `within the newest ${String(keepRecent)} generations (retired-handle window)`,
        };
      }
      if (ageMs === null || ageMs <= graceMs) {
        return {
          ...base,
          disposition: 'orphan-young',
          note:
            ageMs === null
              ? 'age unknown (unstattable) — kept'
              : `unclaimed but only ${String(Math.round(ageMs / 60_000))} min old (grace ${String(
                  Math.round(graceMs / 60_000),
                )} min)`,
        };
      }
      return {
        ...base,
        disposition: 'orphan-collectable',
        note:
          markerPid === null
            ? `no in-flight marker and ${String(Math.round(ageMs / 60_000))} min old — abandoned`
            : `marker names dead pid ${String(markerPid)}, ${String(
                Math.round(ageMs / 60_000),
              )} min old — abandoned`,
      };
    })
    .sort((left, right) => left.genId.localeCompare(right.genId));

  const collectable = entries.filter((entry) => entry.disposition === 'orphan-collectable');
  return {
    producedAt: now.toISOString(),
    pointerGenId,
    entries,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    collectableBytes: collectable.reduce((sum, entry) => sum + entry.bytes, 0),
    collectableCount: collectable.length,
    sweepRequested: generationSweepArmed(),
    sweepArmed: generationSweepArmed() && options.s1SafetyVerified === true,
  };
};

/**
 * Survey, then — only if SIDETRACK_GENERATION_GC_SWEEP is requested AND an S1
 * safety proof is supplied — unlink the `orphan-collectable` generations.
 *
 * Runs the whole survey→unlink sequence under the cross-process publish lock so
 * it cannot interleave with a publisher's clone/checkpoint/flip: without the
 * lock a shadow created between our readdir and our unlink could be collected
 * before its marker landed. Same lock every publisher contends on, so this is
 * genuinely serialized against them, not merely against other sweeps.
 *
 * Returns the survey (always) plus what was collected (empty when disarmed), so
 * a caller can report the orphans either way. `force` exists for tests only.
 */
export const sweepOrphanGenerations = (
  connectionsDir: string,
  options: SurveyGenerationsOptions & { readonly force?: boolean } = {},
): {
  readonly survey: GenerationSurvey;
  readonly collected: readonly string[];
  readonly collectedBytes: number;
} =>
  withPublishLock(connectionsDir, () => {
    const survey = surveyGenerations(connectionsDir, options);
    const armed = options.force === true || survey.sweepArmed;
    if (!armed) return { survey, collected: [] as readonly string[], collectedBytes: 0 };
    const collected: string[] = [];
    let collectedBytes = 0;
    // Re-read the pointer inside the lock as the same defensive invariant
    // gcOldGenerations keeps: never unlink what the pointer names, whatever the
    // survey concluded a moment ago.
    const livePointer = readPointer(connectionsDir);
    for (const entry of survey.entries) {
      if (entry.disposition !== 'orphan-collectable') continue;
      if (entry.genId === livePointer) continue;
      const base = genFilePath(connectionsDir, entry.genId);
      safeUnlink(base);
      safeUnlink(`${base}-wal`);
      safeUnlink(`${base}-shm`);
      clearShadowInFlight(connectionsDir, entry.genId);
      collected.push(entry.genId);
      collectedBytes += entry.bytes;
    }
    return { survey, collected, collectedBytes };
  });

export const generationDbPath = (connectionsDir: string, genId: string): string =>
  genFilePath(connectionsDir, genId);

// ---------------------------------------------------------------------------
// In-place publish (2026-08-16, widened 2026-08-16 to the child-writer full-
// rewrite channel) — see the "Storage-tier incremental publish" design note
// in docs/plans/2026-08-15-foundation-program.md for the full investigation,
// the empirical WAL-isolation verification, and the reasoning behind every
// decision below. Summary: a scoped-delta write (`replaceScopeRows`), a
// single-event overlay write (`applyProjectionEventOverlay`), OR a full
// content-replace write (`putCurrent`/`writeSnapshotAndProgress`) no longer
// clones the whole published generation file just to apply its SQL row
// mutation — it opens the CURRENT pointer's file `{ readwrite: true }`
// directly under this cross-process lock and lets the caller's own existing
// `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` block be the atomic unit for the
// mutation (see snapshot.ts's `#acquireInPlaceWriteHandle` doc comment for
// why a literal `SAVEPOINT` wasn't used). No new generation, no pointer
// flip, no GC — for EITHER writer role (`child-writer` or `parent-reader`),
// since both call the same store methods.
//
// Widened from the original scoped/overlay-only scope: the initial cut
// (PR #381) deliberately kept `putCurrent`/`writeSnapshotAndProgress` on
// clone+flip. Live measurement afterward showed that decision left the
// DOMINANT write channel uncovered — the reconcile child's "one full
// rebuild reconciles thread_in_workstream edges" pass
// (`connectionsMaterializer.ts`'s `catchUpDeferredThreadReconcile` →
// `forceFullRebuildForThreadReconcile`) runs via `writeSnapshotAndProgress`
// on essentially every real catch-up that touched thread/workstream
// membership — i.e. routinely, not rarely — and every one of those was
// still a full 437MB `copyFileSync`. The row-level mutation
// `#writeCurrentRows` runs is the SAME shape (a `BEGIN IMMEDIATE`-wrapped
// diff/upsert, no schema DDL) whether it targets a clone or the live
// published file, so the same WAL-isolation proof that justified in-place
// for scoped/overlay writes applies unchanged here — see the design note's
// 2026-08-16 addendum. Kept OFF this path (the only remaining clone+flip
// callers): the very first write to a fresh vault (no generation exists yet
// to open in place — `#acquireInPlaceWriteHandle` naturally falls back),
// `migrateLegacyToGeneration` (first-boot legacy migration), and
// `reconcileLegacyToPublished` (kill-switch downgrade reconciliation) —
// both of the latter run as their own dedicated clonefile operations,
// structurally separate from any writer's publish path, and are untouched
// by this change. Any future structural (non-`IF NOT EXISTS`) schema
// migration would also need a fresh generation deliberately, same as
// before.
// ---------------------------------------------------------------------------

/** `SIDETRACK_INPLACE_PUBLISH` — default ON (absent/non-`0`). `=0` reverts
 *  every scoped/overlay write to the pre-existing clone+CAS-flip path,
 *  byte-for-byte, for a soak-cycle kill switch. */
export const inPlacePublishEnabled = (): boolean =>
  process.env['SIDETRACK_INPLACE_PUBLISH'] !== '0';

/** How long (ms) an in-place-publish-capable store waits with no further
 *  publish before proactively folding the WAL back into the main db file
 *  (`PRAGMA wal_checkpoint(TRUNCATE)`). Chosen so a burst of scoped
 *  publishes (foreground-nav overlays fire on the order of once per
 *  navigation) doesn't pay TRUNCATE's stronger checkpoint cost on every
 *  single one, while an idle vault still reclaims WAL bytes promptly. See
 *  the design note's "WAL checkpoint policy" section for the measurement
 *  this default is based on. */
export const inPlaceCheckpointIdleMs = (): number => {
  const raw = process.env['SIDETRACK_INPLACE_CHECKPOINT_IDLE_MS'];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
};

/** Count-based checkpoint safety net, independent of the idle timer, so a
 *  vault under CONTINUOUS activity (idle timer never fires) still bounds WAL
 *  growth. Forces one TRUNCATE checkpoint every N in-place publishes. */
export const inPlaceCheckpointEveryN = (): number => {
  const raw = process.env['SIDETRACK_INPLACE_CHECKPOINT_EVERY_N'];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
};

/** Best-effort existence check for a generation db path (never throws). */
export const generationExists = (connectionsDir: string, genId: string): boolean => {
  try {
    return existsSync(genFilePath(connectionsDir, genId));
  } catch {
    return false;
  }
};

/** Best-effort on-disk byte footprint of a generation — the main db file
 *  plus its `-wal` sidecar (never throws; a missing file counts as 0).
 *  Used ONLY for the audible `[publish.in-place]`/`[publish.clone]`
 *  bytes-written diagnostic (a before/after diff around one publish's
 *  critical section) — never load-bearing for correctness. Mirrors the
 *  measurement `inPlacePublish.test.ts`'s write-volume case already uses. */
export const generationByteFootprint = (connectionsDir: string, genId: string): number => {
  const mainPath = genFilePath(connectionsDir, genId);
  let bytes = 0;
  try {
    bytes += statSync(mainPath).size;
  } catch {
    /* generation vanished mid-measurement — best-effort, count 0 */
  }
  try {
    bytes += statSync(`${mainPath}-wal`).size;
  } catch {
    /* no -wal sidecar (checkpointed/quiescent) — 0 is correct */
  }
  return bytes;
};
