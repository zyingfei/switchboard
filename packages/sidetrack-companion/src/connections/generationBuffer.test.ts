import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, utimesSync, writeFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  casPublish,
  checkpointTruncate,
  clearShadowInFlight,
  composeGenId,
  createShadowGeneration,
  discardShadowGeneration,
  gcOldGenerations,
  markShadowInFlight,
  generationDbPath,
  generationExists,
  migrateLegacyToGeneration,
  readPointer,
  reconcileLegacyToPublished,
  residentGenerations,
  surveyGenerations,
  sweepOrphanGenerations,
  withPublishLock,
  writePointer,
} from './generationBuffer.js';

const sqliteIt = process.versions['bun'] === undefined ? it.skip : it;

// A minimal WAL-mode db with a couple of rows, mirroring the connections
// schema surface the publish/read cycle touches (metadata + nodes).
const seedDb = (path: string, marker: string): void => {
  const db = new Database(path, { create: true, readwrite: true });
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  `);
  db.query('INSERT OR REPLACE INTO metadata (key, data) VALUES (?, ?)').run('marker', marker);
  db.query('INSERT OR REPLACE INTO nodes (id, data) VALUES (?, ?)').run('n:1', '{"id":"n:1"}');
  db.close();
};

const readMarker = (path: string, readonly = false): string | null => {
  const db = new Database(path, readonly ? { readonly: true } : { readwrite: true });
  try {
    const row = db.query("SELECT data FROM metadata WHERE key = 'marker'").get() as
      | { data: string }
      | undefined;
    return row?.data ?? null;
  } finally {
    db.close();
  }
};

describe('generationBuffer', () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir !== null) {
      await rm(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  sqliteIt('checkpoint-TRUNCATE makes a WAL db readonly-openable with a ~0 WAL', async () => {
    dir = await mkdtemp(join(tmpdir(), 'genbuf-ckpt-'));
    const path = join(dir, 'gen.db');
    seedDb(path, 'v1');
    const db = new Database(path, { readwrite: true });
    const result = checkpointTruncate(db);
    db.close();
    expect(result.busy).toBe(0);
    // WAL folded → readonly open reads the row without a sidecar writer.
    expect(readMarker(path, true)).toBe('v1');
  });

  sqliteIt('writePointer/readPointer round-trips atomically', async () => {
    dir = await mkdtemp(join(tmpdir(), 'genbuf-ptr-'));
    expect(readPointer(dir)).toBeNull();
    writePointer(dir, 'gen-abc');
    expect(readPointer(dir)).toBe('gen-abc');
    writePointer(dir, 'gen-def');
    expect(readPointer(dir)).toBe('gen-def');
  });

  sqliteIt('migrateLegacyToGeneration clones current.db → gen0 + POINTER, leaves legacy', async () => {
    dir = await mkdtemp(join(tmpdir(), 'genbuf-migrate-'));
    const legacy = join(dir, 'current.db');
    seedDb(legacy, 'legacy-v1');
    const resolved = migrateLegacyToGeneration(
      dir,
      (p) => new Database(p, { create: true, readwrite: true }) as never,
    );
    expect(resolved).not.toBeNull();
    // POINTER now names gen0, whose db is a checkpointed clone of the legacy db.
    const gen = readPointer(dir);
    expect(gen).not.toBeNull();
    expect(readMarker(generationDbPath(dir, gen!), true)).toBe('legacy-v1');
    // legacy current.db is UNTOUCHED (rollback seed).
    expect(existsSync(legacy)).toBe(true);
    // Idempotent: a second call returns the same gen, no new file.
    const again = migrateLegacyToGeneration(
      dir,
      (p) => new Database(p, { create: true, readwrite: true }) as never,
    );
    expect(again?.genId).toBe(resolved!.genId);
  });

  sqliteIt('createShadowGeneration clones the published gen (writes are isolated)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'genbuf-shadow-'));
    const gen0 = composeGenId(0, 'seed');
    seedDb(generationDbPath(dir, gen0), 'served-v1');
    const db0 = new Database(generationDbPath(dir, gen0), { readwrite: true });
    checkpointTruncate(db0);
    db0.close();
    writePointer(dir, gen0);

    const shadow = createShadowGeneration(dir, composeGenId(1, 'shadow'));
    expect(shadow.seededFrom).toBe(gen0);
    // Write to the shadow; the served gen0 is UNCHANGED (inode isolation).
    const shadowDb = new Database(shadow.path, { readwrite: true });
    shadowDb.query('INSERT OR REPLACE INTO metadata (key, data) VALUES (?, ?)').run(
      'marker',
      'shadow-v2',
    );
    shadowDb.close();
    expect(readMarker(generationDbPath(dir, gen0), true)).toBe('served-v1');
    expect(readMarker(shadow.path)).toBe('shadow-v2');
  });

  sqliteIt('gcOldGenerations unlinks superseded gens, keeps the ones asked', async () => {
    dir = await mkdtemp(join(tmpdir(), 'genbuf-gc-'));
    for (const id of ['a', 'b', 'c']) {
      seedDb(generationDbPath(dir, id), id);
      writeFileSync(`${generationDbPath(dir, id)}-wal`, '');
    }
    const unlinked = gcOldGenerations(dir, ['c', 'b']);
    expect(unlinked).toEqual(['a']);
    expect(generationExists(dir, 'a')).toBe(false);
    expect(existsSync(`${generationDbPath(dir, 'a')}-wal`)).toBe(false);
    expect(generationExists(dir, 'b')).toBe(true);
    expect(generationExists(dir, 'c')).toBe(true);
    expect([...residentGenerations(dir)].sort()).toEqual(['b', 'c']);
  });

  // Read-back semantics (doctrine rule 10): a reader that opened gen-A keeps
  // reading gen-A after the pointer flips to gen-B (inode isolation), while a
  // fresh reader opens gen-B. This is acceptance (b): consistent old-or-new
  // answer across a swap, never torn.
  sqliteIt('existing reader stays on its generation across a pointer flip; a fresh reader sees the new one', async () => {
    dir = await mkdtemp(join(tmpdir(), 'genbuf-swap-'));
    const genA = composeGenId(1, 'a');
    seedDb(generationDbPath(dir, genA), 'gen-A');
    const dbA = new Database(generationDbPath(dir, genA), { readwrite: true });
    checkpointTruncate(dbA);
    dbA.close();
    writePointer(dir, genA);

    const readerA = new Database(generationDbPath(dir, readPointer(dir)!), { readonly: true });
    expect((readerA.query("SELECT data FROM metadata WHERE key='marker'").get() as { data: string }).data).toBe('gen-A');

    // Publish gen-B (a DISTINCT new file) and flip the pointer.
    const genB = composeGenId(2, 'b');
    seedDb(generationDbPath(dir, genB), 'gen-B');
    const dbB = new Database(generationDbPath(dir, genB), { readwrite: true });
    checkpointTruncate(dbB);
    dbB.close();
    writePointer(dir, genB);

    // readerA still reads gen-A (never torn); a fresh reader reads gen-B.
    expect((readerA.query("SELECT data FROM metadata WHERE key='marker'").get() as { data: string }).data).toBe('gen-A');
    const readerB = new Database(generationDbPath(dir, readPointer(dir)!), { readonly: true });
    expect((readerB.query("SELECT data FROM metadata WHERE key='marker'").get() as { data: string }).data).toBe('gen-B');
    readerA.close();
    readerB.close();
  });

  // Acceptance (c): a crash between shadow-build and pointer-flip leaves the
  // POINTER naming the PRIOR valid generation (the flip is last + atomic).
  sqliteIt('a shadow left un-published (crash before flip) does not change the served pointer', async () => {
    dir = await mkdtemp(join(tmpdir(), 'genbuf-crash-'));
    const genA = composeGenId(1, 'a');
    seedDb(generationDbPath(dir, genA), 'gen-A');
    writePointer(dir, genA);

    // Simulate a child that built a shadow but died BEFORE writePointer.
    const shadow = createShadowGeneration(dir, composeGenId(2, 'orphan'));
    const shadowDb = new Database(shadow.path, { readwrite: true });
    shadowDb.query('INSERT OR REPLACE INTO metadata (key, data) VALUES (?, ?)').run(
      'marker',
      'gen-orphan',
    );
    shadowDb.close();
    // No writePointer happened. The served pointer still names gen-A.
    expect(readPointer(dir)).toBe(genA);
    expect(readMarker(generationDbPath(dir, readPointer(dir)!), true)).toBe('gen-A');
    // The orphan shadow file exists but is not served; the next publish GCs it.
    expect(generationExists(dir, composeGenId(2, 'orphan'))).toBe(true);
  });

  // CAS publish (blocker): the flip lands only if the pointer still names the
  // gen the shadow was seeded from. A winner + a superseded loser cannot clobber
  // each other.
  sqliteIt('casPublish flips when the pointer still names the seed gen', async () => {
    dir = await mkdtemp(join(tmpdir(), 'genbuf-cas-win-'));
    const genA = composeGenId(1, 'a');
    seedDb(generationDbPath(dir, genA), 'gen-A');
    writePointer(dir, genA);
    const genB = composeGenId(2, 'b');
    seedDb(generationDbPath(dir, genB), 'gen-B');
    const res = casPublish(dir, { seedGenId: genA, newGenId: genB });
    expect(res.outcome).toBe('published');
    expect(readPointer(dir)).toBe(genB);
  });

  sqliteIt('casPublish is SUPERSEDED (pointer untouched) when the pointer moved off the seed', async () => {
    dir = await mkdtemp(join(tmpdir(), 'genbuf-cas-lose-'));
    const genA = composeGenId(1, 'a');
    const genC = composeGenId(3, 'c'); // a rival winner
    const genB = composeGenId(2, 'b'); // our (losing) shadow
    for (const [id, m] of [
      [genA, 'gen-A'],
      [genB, 'gen-B'],
      [genC, 'gen-C'],
    ] as const) {
      seedDb(generationDbPath(dir, id), m);
    }
    // A rival already advanced the pointer A -> C. Our shadow was seeded from A.
    writePointer(dir, genC);
    const res = casPublish(dir, { seedGenId: genA, newGenId: genB });
    expect(res.outcome).toBe('superseded');
    // The pointer is LEFT at the winner's gen — our stale flip was rejected.
    expect(readPointer(dir)).toBe(genC);
    // The winner's file is NOT unlinked (no GC on a superseded CAS).
    expect(generationExists(dir, genC)).toBe(true);
  });

  // GC keep-set (blocker): gcOldGenerations must NEVER unlink whatever the
  // pointer currently names, even if the caller's keep-set omits it.
  sqliteIt('gcOldGenerations refuses to unlink the live pointer target even if not in keep-set', async () => {
    dir = await mkdtemp(join(tmpdir(), 'genbuf-gc-guard-'));
    for (const id of ['live', 'old']) seedDb(generationDbPath(dir, id), id);
    writePointer(dir, 'live');
    // Caller passes a keep-set that (buggily) omits the live pointer target.
    const unlinked = gcOldGenerations(dir, ['old']);
    // Only 'old'... no — the caller kept 'old', so nothing else remains except
    // 'live' which the defensive guard protects. Nothing is unlinked.
    expect(unlinked).toEqual([]);
    expect(generationExists(dir, 'live')).toBe(true);
    expect(generationExists(dir, 'old')).toBe(true);
  });

  sqliteIt('casPublish keepAlive protects a live-held gen from GC', async () => {
    dir = await mkdtemp(join(tmpdir(), 'genbuf-cas-keepalive-'));
    const seed = composeGenId(1, 'seed');
    const held = composeGenId(9, 'held'); // an in-flight shadow a live handle holds
    const next = composeGenId(2, 'next');
    for (const id of [seed, held, next]) seedDb(generationDbPath(dir, id), id);
    writePointer(dir, seed);
    const res = casPublish(dir, { seedGenId: seed, newGenId: next, keepAlive: [held] });
    expect(res.outcome).toBe('published');
    // held is protected (live handle); seed is kept (prior); next is the pointer.
    expect(generationExists(dir, held)).toBe(true);
    expect(res.unlinked).not.toContain(held);
  });

  // discardShadowGeneration: removes ONLY the named orphan, and REFUSES the
  // pointer target.
  sqliteIt('discardShadowGeneration unlinks the orphan but never the pointer target', async () => {
    dir = await mkdtemp(join(tmpdir(), 'genbuf-discard-'));
    const live = composeGenId(1, 'live');
    const orphan = composeGenId(2, 'orphan');
    for (const id of [live, orphan]) {
      seedDb(generationDbPath(dir, id), id);
      writeFileSync(`${generationDbPath(dir, id)}-wal`, '');
    }
    writePointer(dir, live);
    discardShadowGeneration(dir, orphan);
    expect(generationExists(dir, orphan)).toBe(false);
    expect(existsSync(`${generationDbPath(dir, orphan)}-wal`)).toBe(false);
    // A misdirected discard of the LIVE pointer target is refused.
    discardShadowGeneration(dir, live);
    expect(generationExists(dir, live)).toBe(true);
  });

  // Cross-process publish lock: two casPublish calls serialize; the loser is
  // rejected, never a torn interleave.
  sqliteIt('withPublishLock serializes the critical section (mutual exclusion)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'genbuf-lock-'));
    const order: string[] = [];
    // Nested lock attempt would deadlock a naive impl; here the two calls are
    // sequential so we assert the section runs atomically start→end.
    withPublishLock(dir, () => {
      order.push('A-start');
      order.push('A-end');
    });
    withPublishLock(dir, () => {
      order.push('B-start');
      order.push('B-end');
    });
    expect(order).toEqual(['A-start', 'A-end', 'B-start', 'B-end']);
    // The lockfile is released (not leaked) after each section.
    expect(existsSync(join(dir, 'current.publish.lock'))).toBe(false);
  });

  // reconcileLegacyToPublished (blocker: rollback): refreshes current.db from
  // the latest published gen so a downgrade serves the CURRENT graph.
  sqliteIt('reconcileLegacyToPublished refreshes current.db from the published gen', async () => {
    dir = await mkdtemp(join(tmpdir(), 'genbuf-reconcile-'));
    // A frozen legacy seed (what current.db held at migration time).
    seedDb(join(dir, 'current.db'), 'seed-old');
    // Generations advanced under double-buffer to a fresh published gen.
    const genNew = composeGenId(3, 'new');
    seedDb(generationDbPath(dir, genNew), 'served-new');
    const genDb = new Database(generationDbPath(dir, genNew), { readwrite: true });
    checkpointTruncate(genDb);
    genDb.close();
    writePointer(dir, genNew);

    const from = reconcileLegacyToPublished(dir);
    expect(from).toBe(genNew);
    // current.db now reflects the published gen, not the stale seed. The legacy
    // store opens current.db READWRITE (its role is writable), so it can create
    // the -shm a copied WAL-mode db needs — read it back the same way.
    expect(readMarker(join(dir, 'current.db'), false)).toBe('served-new');
    // Idempotent: a second call on the unchanged pointer is a no-op.
    expect(reconcileLegacyToPublished(dir)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Cross-process in-flight shadow markers (the 2026-07-29 "disk I/O error" P0).
  //
  // The GC keep-set is assembled from the publisher's OWN process state, but a
  // write SHADOW is an ordinary `current.<gen>.db` on disk. So a publish in one
  // process readdir'd, found another process's live shadow in neither its
  // keep-set nor the pointer, and unlinked it — after which the victim's next
  // query threw "disk I/O error" (bun:sqlite's vnode-detached signature). Both
  // directions happened live: the fork-per-drain child's shadow is open for the
  // whole reconcile (minutes) and the parent's overlay publishes land inside it.
  // -------------------------------------------------------------------------

  /** Write an in-flight marker as if some OTHER process owned the shadow. */
  const writeForeignMarker = (
    dirPath: string,
    genId: string,
    pid: number,
    atMs = Date.now(),
  ): void => {
    writeFileSync(`${generationDbPath(dirPath, genId)}.inflight`, `${String(pid)} ${String(atMs)}`);
  };
  // Our parent process: a real, live pid that is definitively not us.
  const LIVE_FOREIGN_PID = process.ppid;
  // Above macOS' default pid_max (99998) ⇒ guaranteed ESRCH, i.e. dead.
  const DEAD_PID = 999_999;

  sqliteIt('gcOldGenerations does NOT unlink a shadow a LIVE foreign process holds', async () => {
    dir = await mkdtemp(join(tmpdir(), 'genbuf-inflight-live-'));
    const live = composeGenId(1, 'live');
    const childShadow = composeGenId(2, 'childshadow');
    for (const id of [live, childShadow]) seedDb(generationDbPath(dir, id), id);
    writePointer(dir, live);
    // The child claimed its shadow before writing a byte into it.
    writeForeignMarker(dir, childShadow, LIVE_FOREIGN_PID);

    // A parent overlay publishes mid-drain. Its keep-set cannot mention the
    // child's shadow — it has never heard of it. Pre-fix, this unlinked it.
    const unlinked = gcOldGenerations(dir, [live]);
    expect(unlinked).not.toContain(childShadow);
    expect(generationExists(dir, childShadow)).toBe(true);
    expect(existsSync(`${generationDbPath(dir, childShadow)}.inflight`)).toBe(true);
  });

  sqliteIt('gcOldGenerations collects a shadow whose owning process DIED (no leak)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'genbuf-inflight-dead-'));
    const live = composeGenId(1, 'live');
    const abandoned = composeGenId(2, 'abandoned');
    for (const id of [live, abandoned]) seedDb(generationDbPath(dir, id), id);
    writePointer(dir, live);
    // A child that was SIGKILLed mid-drain leaves its marker behind. Honouring
    // it forever would trade the P0 for an unbounded disk leak (each generation
    // is ~330MB on the real vault).
    writeForeignMarker(dir, abandoned, DEAD_PID);

    const unlinked = gcOldGenerations(dir, [live]);
    expect(unlinked).toContain(abandoned);
    expect(generationExists(dir, abandoned)).toBe(false);
    // The orphaned marker goes with the file it named.
    expect(existsSync(`${generationDbPath(dir, abandoned)}.inflight`)).toBe(false);
  });

  sqliteIt('an OWN-process marker does not block this process own GC', async () => {
    dir = await mkdtemp(join(tmpdir(), 'genbuf-inflight-self-'));
    const live = composeGenId(1, 'live');
    const mine = composeGenId(2, 'mine');
    for (const id of [live, mine]) seedDb(generationDbPath(dir, id), id);
    writePointer(dir, live);
    // markShadowInFlight always stamps OUR pid.
    markShadowInFlight(dir, mine);

    // Within one process the store already tracks its live shadows exactly
    // (#inFlightShadowGenIds feeds keepAlive), so a self-marker must not add a
    // second, weaker authority that outlives finalize().
    const unlinked = gcOldGenerations(dir, [live]);
    expect(unlinked).toContain(mine);
    expect(generationExists(dir, mine)).toBe(false);
  });

  sqliteIt('createShadowGeneration claims the shadow and casPublish releases it', async () => {
    dir = await mkdtemp(join(tmpdir(), 'genbuf-inflight-lifecycle-'));
    const gen0 = composeGenId(0, 'seed');
    seedDb(generationDbPath(dir, gen0), 'served-v1');
    writePointer(dir, gen0);

    const shadowGen = composeGenId(1, 'shadow');
    createShadowGeneration(dir, shadowGen);
    // Claimed at creation — there is no window in which the file exists on disk
    // unclaimed, which is what a foreign readdir would have collected.
    expect(existsSync(`${generationDbPath(dir, shadowGen)}.inflight`)).toBe(true);

    const res = casPublish(dir, { seedGenId: gen0, newGenId: shadowGen });
    expect(res.outcome).toBe('published');
    // Published ⇒ no longer a write target ⇒ claim released, so it cannot pin
    // itself once the pointer moves on.
    expect(existsSync(`${generationDbPath(dir, shadowGen)}.inflight`)).toBe(false);
  });

  sqliteIt('discardShadowGeneration and an aged-out marker both release the claim', async () => {
    dir = await mkdtemp(join(tmpdir(), 'genbuf-inflight-release-'));
    const live = composeGenId(1, 'live');
    seedDb(generationDbPath(dir, live), live);
    writePointer(dir, live);

    const lost = composeGenId(2, 'lostcas');
    createShadowGeneration(dir, lost);
    discardShadowGeneration(dir, lost);
    expect(existsSync(`${generationDbPath(dir, lost)}.inflight`)).toBe(false);

    // Pid-reuse backstop: a marker older than the ceiling is ignored even
    // though its pid is alive, so a recycled pid cannot pin a gen forever.
    const ancient = composeGenId(3, 'ancient');
    seedDb(generationDbPath(dir, ancient), ancient);
    writeForeignMarker(dir, ancient, LIVE_FOREIGN_PID, Date.now() - 7 * 60 * 60_000);
    expect(gcOldGenerations(dir, [live])).toContain(ancient);
    expect(generationExists(dir, ancient)).toBe(false);
  });

  sqliteIt('clearShadowInFlight is idempotent and sweeps file-less orphan markers', async () => {
    dir = await mkdtemp(join(tmpdir(), 'genbuf-inflight-sweep-'));
    const live = composeGenId(1, 'live');
    seedDb(generationDbPath(dir, live), live);
    writePointer(dir, live);
    // Double-clear must not throw (publish clears, then the finally clears).
    clearShadowInFlight(dir, composeGenId(9, 'never'));
    clearShadowInFlight(dir, composeGenId(9, 'never'));

    // A writer killed between the claim and the clone leaves a marker with no
    // db beside it. GC sweeps it in the same readdir it already does.
    const ghost = composeGenId(4, 'ghost');
    writeForeignMarker(dir, ghost, LIVE_FOREIGN_PID);
    expect(generationExists(dir, ghost)).toBe(false);
    gcOldGenerations(dir, [live]);
    expect(existsSync(`${generationDbPath(dir, ghost)}.inflight`)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // PUBLISH-INDEPENDENT ORPHAN SURVEY (the 2026-07-29 leak follow-up).
  //
  // MEASURED: `_BAC/connections/` held the pointer target plus THREE ~323 MB
  // orphans (~970 MB dead) while the UI's GC inventory said "10.7 MB / 1 file".
  // Two gaps: the child-writer's superseded branch never unlinked its own lost
  // shadow, and gcOldGenerations only ever ran inside a WINNING casPublish — so
  // an idle vault swept nothing and counted nothing.
  //
  // These tests pin exactly which dispositions the survey assigns and, in
  // particular, which generations it REFUSES to collect: a false keep costs one
  // file, a false collect is the "disk I/O error" P0.
  // -------------------------------------------------------------------------

  /** Backdate a generation's db + siblings so the grace window can be tested
   *  without sleeping. Mirrors what an abandoned gen looks like on disk. */
  const backdateGeneration = (dirPath: string, genId: string, ageMs: number): void => {
    const when = new Date(Date.now() - ageMs);
    for (const suffix of ['', '-wal', '-shm']) {
      const path = `${generationDbPath(dirPath, genId)}${suffix}`;
      if (existsSync(path)) utimesSync(path, when, when);
    }
  };

  sqliteIt('surveyGenerations classifies pointer / live-marked / dead-marked / marker-less', async () => {
    dir = await mkdtemp(join(tmpdir(), 'genbuf-survey-'));
    const HOUR = 60 * 60_000;
    // The four cases the brief names, built as they occur on disk.
    const pointer = composeGenId(10, 'pointer');
    const foreignLive = composeGenId(11, 'foreignlive');
    const deadMarked = composeGenId(12, 'deadmarked');
    const markerless = composeGenId(13, 'markerless');
    for (const id of [pointer, foreignLive, deadMarked, markerless]) {
      seedDb(generationDbPath(dir, id), id);
    }
    writePointer(dir, pointer);
    writeForeignMarker(dir, foreignLive, LIVE_FOREIGN_PID);
    writeForeignMarker(dir, deadMarked, DEAD_PID);
    // Age every non-pointer generation well past the grace window, and make the
    // pointer the NEWEST so the recent-prior slot is unambiguous. Ordering
    // matters: the survey's newest-N window is mtime-ranked, so the two aged
    // orphans must both be older than the live-marked one.
    backdateGeneration(dir, markerless, 5 * HOUR);
    backdateGeneration(dir, deadMarked, 4 * HOUR);
    backdateGeneration(dir, foreignLive, 3 * HOUR);

    const survey = surveyGenerations(dir);
    const disposition = (genId: string): string =>
      survey.entries.find((entry) => entry.genId === genId)?.disposition ?? 'MISSING';

    expect(survey.pointerGenId).toBe(pointer);
    expect(disposition(pointer)).toBe('pointer');
    // A live foreign writer owns it — the whole reason the marker protocol
    // exists. Must survive even though it is aged and not the pointer.
    expect(disposition(foreignLive)).toBe('live-marked');
    // Dead owner + aged ⇒ abandoned. Marker-less + aged ⇒ abandoned. These are
    // the two shapes the live vault actually had.
    expect(disposition(deadMarked)).toBe('orphan-collectable');
    expect(disposition(markerless)).toBe('orphan-collectable');
    expect(survey.collectableCount).toBe(2);
    expect(survey.collectableBytes).toBeGreaterThan(0);
    // The dead-pid marker is reported as such — typed, not just "no marker".
    const dead = survey.entries.find((entry) => entry.genId === deadMarked);
    expect(dead?.markerPid).toBe(DEAD_PID);
    expect(dead?.markerPidAlive).toBe(false);
    const orphan = survey.entries.find((entry) => entry.genId === markerless);
    expect(orphan?.markerPid).toBeNull();
    expect(orphan?.markerPidAlive).toBeNull();
  });

  sqliteIt('the survey keeps the newest prior generation and anything inside the grace window', async () => {
    dir = await mkdtemp(join(tmpdir(), 'genbuf-survey-keep-'));
    const pointer = composeGenId(20, 'pointer');
    const prior = composeGenId(21, 'prior');
    const young = composeGenId(22, 'young');
    const aged = composeGenId(23, 'aged');
    for (const id of [pointer, prior, young, aged]) seedDb(generationDbPath(dir, id), id);
    writePointer(dir, pointer);
    // `prior` is the immediately-preceding publish: casPublish keeps it for the
    // parent's retired-handle window, and a survey running OUTSIDE the publish
    // critical section cannot see that in-process handle set — so it must keep
    // the newest non-pointer gen on recency alone. `aged` is older still.
    backdateGeneration(dir, prior, 3 * 60 * 60_000);
    backdateGeneration(dir, aged, 4 * 60 * 60_000);
    // `young` is marker-less but recent: within grace, so never collected.

    const survey = surveyGenerations(dir, { keepRecentGenerations: 2, graceMs: 60 * 60_000 });
    const disposition = (genId: string): string =>
      survey.entries.find((entry) => entry.genId === genId)?.disposition ?? 'MISSING';
    expect(disposition(pointer)).toBe('pointer');
    // `young` has the newest mtime of the non-pointer gens ⇒ it takes the single
    // recent-prior slot; `prior` then falls through to the grace/age test.
    expect(disposition(young)).toBe('recent-prior');
    expect(disposition(prior)).toBe('orphan-collectable');
    expect(disposition(aged)).toBe('orphan-collectable');
    // With keepRecent 3 the next-newest is also protected — the knob is real.
    const wider = surveyGenerations(dir, { keepRecentGenerations: 3, graceMs: 60 * 60_000 });
    expect(
      wider.entries.find((entry) => entry.genId === prior)?.disposition,
    ).toBe('recent-prior');
  });

  sqliteIt('sweepOrphanGenerations REPORTS but deletes nothing while disarmed', async () => {
    dir = await mkdtemp(join(tmpdir(), 'genbuf-sweep-disarmed-'));
    const pointer = composeGenId(30, 'pointer');
    const prior = composeGenId(31, 'prior');
    const orphan = composeGenId(32, 'orphan');
    for (const id of [pointer, prior, orphan]) seedDb(generationDbPath(dir, id), id);
    writePointer(dir, pointer);
    backdateGeneration(dir, orphan, 5 * 60 * 60_000);

    // Default posture: SIDETRACK_GENERATION_GC_SWEEP unset. The whole point of
    // the first landing — the operator inspects the report before arming a
    // sweep that unlinks ~323 MB files.
    delete process.env['SIDETRACK_GENERATION_GC_SWEEP'];
    const disarmed = sweepOrphanGenerations(dir);
    expect(disarmed.survey.sweepArmed).toBe(false);
    expect(disarmed.survey.collectableCount).toBe(1);
    expect(disarmed.collected).toEqual([]);
    expect(generationExists(dir, orphan)).toBe(true);

    // Armed: collects exactly the reported orphan, and NOTHING else.
    process.env['SIDETRACK_GENERATION_GC_SWEEP'] = '1';
    try {
      const armed = sweepOrphanGenerations(dir);
      expect(armed.collected).toEqual([orphan]);
      expect(generationExists(dir, orphan)).toBe(false);
      // Siblings go with the main file.
      expect(existsSync(`${generationDbPath(dir, orphan)}-wal`)).toBe(false);
      expect(existsSync(`${generationDbPath(dir, orphan)}-shm`)).toBe(false);
      // The served generation and the retired-handle margin both survive.
      expect(generationExists(dir, pointer)).toBe(true);
      expect(generationExists(dir, prior)).toBe(true);
      expect(readPointer(dir)).toBe(pointer);
    } finally {
      delete process.env['SIDETRACK_GENERATION_GC_SWEEP'];
    }
  });

  sqliteIt('an armed sweep still refuses a generation a live writer claims — even our own', async () => {
    dir = await mkdtemp(join(tmpdir(), 'genbuf-sweep-live-'));
    const pointer = composeGenId(40, 'pointer');
    const mine = composeGenId(41, 'mine');
    const foreign = composeGenId(42, 'foreign');
    for (const id of [pointer, mine, foreign]) seedDb(generationDbPath(dir, id), id);
    writePointer(dir, pointer);
    // Own-pid marker: gcOldGenerations ignores these (inside casPublish the
    // store's exact #inFlightShadowGenIds is in the keep-set), but the SURVEY
    // has no such keep-set — an own-pid marker is its only evidence that this
    // process is mid-write. Collecting it would be the P0, from our own hand.
    markShadowInFlight(dir, mine);
    writeForeignMarker(dir, foreign, LIVE_FOREIGN_PID);
    backdateGeneration(dir, mine, 5 * 60 * 60_000);
    backdateGeneration(dir, foreign, 5 * 60 * 60_000);

    process.env['SIDETRACK_GENERATION_GC_SWEEP'] = '1';
    try {
      const result = sweepOrphanGenerations(dir);
      expect(result.collected).toEqual([]);
      expect(generationExists(dir, mine)).toBe(true);
      expect(generationExists(dir, foreign)).toBe(true);
    } finally {
      delete process.env['SIDETRACK_GENERATION_GC_SWEEP'];
    }
  });
});
