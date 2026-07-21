import {
  DEFAULT_KEEP_INTERVALS,
  INTERVAL_STREAM_NAME,
  runEventBufferCompaction,
  type CompactionStagingArea,
  type EventBufferCompactionResult,
} from './event-buffer-compaction';
import { type BufferedEvent, type EventBuffer } from './in-memory-event-buffer';

export type { EventBufferCompactionResult } from './event-buffer-compaction';

interface EventStoreDriver {
  put(event: BufferedEvent): Promise<void>;
  peek(limit: number): Promise<BufferedEvent[]>;
  peekByStream(streamName: BufferedEvent['streamName'], limit: number): Promise<BufferedEvent[]>;
  deleteByKey(key: string): Promise<boolean>;
  count(): Promise<number>;
  compact?(keepIntervals: number): Promise<EventBufferCompactionResult>;
}

const DB_NAME = 'sidetrack-event-buffer';
const STORE_NAME = 'events';
const DB_VERSION = 2;
// chrome.storage.local write-ahead key holding the compaction survivor set
// during the fast (deleteDatabase + re-append) path. If the SW is evicted
// mid-compaction the survivors persist here and the next boot's compact()
// replays them before doing anything else — so aggregates cannot be lost.
const COMPACTION_STAGING_KEY = 'sidetrack.event-buffer.compaction-survivors';
// Cursor-delete chunk size for the slow path — one readwrite transaction
// per chunk so a huge delete never holds a single long-lived transaction.
const COMPACTION_CURSOR_CHUNK = 5_000;

const keyOf = (e: Pick<BufferedEvent, 'streamName' | 'lamport' | 'replicaId'>): string =>
  `${e.streamName}|${e.lamport}|${e.replicaId}`;

// chrome.storage.local staging area for the fast-path survivor set. When
// chrome.storage is unavailable (unit env without a stub) the driver's
// caller supplies a fake; the driver never falls back to the crash-unsafe
// deleteDatabase path without a working staging area.
const chromeStorageStagingArea = (): CompactionStagingArea | null => {
  const local = (
    globalThis as unknown as {
      chrome?: { storage?: { local?: {
        get: (key: string) => Promise<Record<string, unknown>>;
        set: (entries: Record<string, unknown>) => Promise<void>;
        remove: (key: string) => Promise<void>;
      } } };
    }
  ).chrome?.storage?.local;
  if (local === undefined) return null;
  return {
    read: async () => {
      const got = await local.get(COMPACTION_STAGING_KEY);
      const raw = got[COMPACTION_STAGING_KEY];
      return Array.isArray(raw) ? (raw as BufferedEvent[]) : null;
    },
    write: async (survivors) => local.set({ [COMPACTION_STAGING_KEY]: survivors }),
    clear: async () => local.remove(COMPACTION_STAGING_KEY),
  };
};

class IndexedDbDriver implements EventStoreDriver {
  private dbPromise: Promise<IDBDatabase> | null = null;
  // Compaction serialization gate. put/peek/deleteByKey/count await this so
  // beacons arriving via onMessage during boot never race the deleteDatabase
  // fast path (which closes and drops the connection mid-flight). Resolved
  // when no compaction is in progress.
  private compactionGate: Promise<void> = Promise.resolve();

  constructor(private readonly staging: CompactionStagingArea | null = chromeStorageStagingArea()) {}

  // Await any in-progress compaction before touching the store. Compaction
  // itself does NOT go through this (it sets the gate directly), so its
  // internal reads/deletes are not self-blocked.
  private async guarded<T>(run: () => Promise<T>): Promise<T> {
    // Swallow a rejected gate (a failed prior compaction must not wedge the
    // buffer) — the store is still usable, compaction just didn't finish.
    await this.compactionGate.catch(() => undefined);
    return run();
  }

  private openDb(): Promise<IDBDatabase> {
    if (this.dbPromise !== null) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        const store = db.objectStoreNames.contains(STORE_NAME)
          ? req.transaction?.objectStore(STORE_NAME)
          : db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        if (store !== undefined) {
          if (!store.indexNames.contains('by_lamport_replica')) {
            store.createIndex('by_lamport_replica', ['lamport', 'replicaId'], { unique: false });
          }
          if (!store.indexNames.contains('by_stream_lamport_replica')) {
            store.createIndex('by_stream_lamport_replica', ['streamName', 'lamport', 'replicaId'], {
              unique: false,
            });
          }
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'));
    });
    return this.dbPromise;
  }

  put(event: BufferedEvent): Promise<void> {
    return this.guarded(() => this.putUnguarded(event));
  }

  private async putUnguarded(event: BufferedEvent): Promise<void> {
    const db = await this.openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({ id: keyOf(event), ...event });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('indexedDB put failed'));
    });
  }

  peek(limit: number): Promise<BufferedEvent[]> {
    return this.guarded(async () => {
      const db = await this.openDb();
      return new Promise<BufferedEvent[]>((resolve, reject) => {
        const out: BufferedEvent[] = [];
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).index('by_lamport_replica').openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor === null || out.length >= limit) return;
          const { id: _id, ...event } = cursor.value as { id: string } & BufferedEvent;
          out.push(event);
          cursor.continue();
        };
        tx.oncomplete = () => resolve(out);
        tx.onerror = () => reject(tx.error ?? new Error('indexedDB peek failed'));
      });
    });
  }

  peekByStream(streamName: BufferedEvent['streamName'], limit: number): Promise<BufferedEvent[]> {
    return this.guarded(async () => {
      const db = await this.openDb();
      return new Promise<BufferedEvent[]>((resolve, reject) => {
        const out: BufferedEvent[] = [];
        const tx = db.transaction(STORE_NAME, 'readonly');
        const range = IDBKeyRange.bound([streamName], [streamName, []]);
        const req = tx.objectStore(STORE_NAME).index('by_stream_lamport_replica').openCursor(range);
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor === null || out.length >= limit) return;
          const { id: _id, ...event } = cursor.value as { id: string } & BufferedEvent;
          out.push(event);
          cursor.continue();
        };
        tx.oncomplete = () => resolve(out);
        tx.onerror = () => reject(tx.error ?? new Error('indexedDB peekByStream failed'));
      });
    });
  }

  deleteByKey(key: string): Promise<boolean> {
    return this.guarded(async () => {
      const db = await this.openDb();
      return new Promise<boolean>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const getReq = tx.objectStore(STORE_NAME).get(key);
        getReq.onsuccess = () => {
          if (getReq.result === undefined) return resolve(false);
          tx.objectStore(STORE_NAME).delete(key);
        };
        tx.oncomplete = () => resolve(getReq.result !== undefined);
        tx.onerror = () => reject(tx.error ?? new Error('indexedDB delete failed'));
      });
    });
  }

  count(): Promise<number> {
    return this.guarded(() => this.countUnguarded());
  }

  private async countUnguarded(): Promise<number> {
    const db = await this.openDb();
    return new Promise<number>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('indexedDB count failed'));
    });
  }

  compact(keepIntervals: number): Promise<EventBufferCompactionResult> {
    // Take the gate directly (not via `guarded`) so concurrent
    // put/peek/delete queue behind this run. Store the running promise so
    // waiters and a second concurrent compact() coalesce onto it.
    const run = this.compactionGate
      .catch(() => undefined)
      .then(() => this.compactUnguarded(keepIntervals));
    this.compactionGate = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // --- compaction internals (run while the gate is held) ---
  //
  // These deliberately avoid ever materializing the full buffer in heap. The
  // production backlog is ~1.2M interval events; a full readAll would hold
  // ~600MB-1GB of live objects in a constrained MV3 SW heap and could OOM the
  // worker mid-read (which, since compact() re-runs on every wake, would be a
  // crash loop). The coordinator instead plans from a cheap index count and
  // reads only the survivors.

  private intervalKeyRange(): IDBKeyRange {
    return IDBKeyRange.bound([INTERVAL_STREAM_NAME], [INTERVAL_STREAM_NAME, []]);
  }

  // Count interval events via an index count — O(index), materializes no rows.
  private async countIntervalsUnguarded(): Promise<number> {
    const db = await this.openDb();
    return new Promise<number>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx
        .objectStore(STORE_NAME)
        .index('by_stream_lamport_replica')
        .count(this.intervalKeyRange());
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('indexedDB countIntervals failed'));
    });
  }

  // Read only the NEWEST `keep` interval events (descending lamport via a
  // `prev` cursor). Working set bounded by `keep`, never the full backlog.
  private async readNewestIntervalsUnguarded(keep: number): Promise<BufferedEvent[]> {
    const limit = Math.max(0, Math.floor(keep));
    if (limit === 0) return [];
    const db = await this.openDb();
    return new Promise<BufferedEvent[]>((resolve, reject) => {
      const out: BufferedEvent[] = [];
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx
        .objectStore(STORE_NAME)
        .index('by_stream_lamport_replica')
        .openCursor(this.intervalKeyRange(), 'prev');
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor === null || out.length >= limit) return;
        const { id: _id, ...event } = cursor.value as { id: string } & BufferedEvent;
        out.push(event);
        cursor.continue();
      };
      // Restore ascending (lamport) order so re-append and staging match the
      // buffer's natural order — cosmetic, but keeps the survivor set stable.
      tx.oncomplete = () => resolve(out.reverse());
      tx.onerror = () => reject(tx.error ?? new Error('indexedDB readNewestIntervals failed'));
    });
  }

  // Read every NON-interval event (always-kept survivors). Cursors the whole
  // store but pushes only non-interval rows, so peak heap is bounded by the
  // (small) non-interval count, not the interval backlog. Skipped interval
  // rows are transient cursor values, immediately GC-eligible.
  private async readNonIntervalEventsUnguarded(): Promise<BufferedEvent[]> {
    const db = await this.openDb();
    return new Promise<BufferedEvent[]>((resolve, reject) => {
      const out: BufferedEvent[] = [];
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).index('by_lamport_replica').openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor === null) return;
        const { id: _id, ...event } = cursor.value as { id: string } & BufferedEvent;
        if (event.streamName !== INTERVAL_STREAM_NAME) out.push(event);
        cursor.continue();
      };
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error ?? new Error('indexedDB readNonIntervalEvents failed'));
    });
  }

  private async closeDb(): Promise<void> {
    if (this.dbPromise === null) return;
    const db = await this.dbPromise.catch(() => null);
    this.dbPromise = null;
    db?.close();
  }

  private async deleteDatabase(): Promise<void> {
    await this.closeDb();
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error ?? new Error('indexedDB.deleteDatabase failed'));
      // `blocked` fires if another connection is still open; we already
      // closed ours, so this is only reached in pathological cases — resolve
      // and let the reopen recreate the schema.
      req.onblocked = () => resolve();
    });
  }

  private compactUnguarded(keepIntervals: number): Promise<EventBufferCompactionResult> {
    // Thin glue: supply the live IDB ops (all bounded — no full-buffer read);
    // the coordinator owns the crash-safe path selection + staging replay
    // (unit-tested directly in event-buffer-compaction.test.ts, which jsdom's
    // missing IndexedDB cannot exercise here).
    return runEventBufferCompaction(
      {
        countIntervals: () => this.countIntervalsUnguarded(),
        readNewestIntervals: (keep) => this.readNewestIntervalsUnguarded(keep),
        readNonIntervalEvents: () => this.readNonIntervalEventsUnguarded(),
        put: (event) => this.putUnguarded(event),
        cursorDropOldestIntervals: (dropCount) => this.cursorDropOldestIntervals(dropCount),
        deleteDatabase: () => this.deleteDatabase(),
        recreate: async () => {
          await this.openDb();
        },
        staging: this.staging,
      },
      keepIntervals,
    );
  }

  private async cursorDropOldestIntervals(dropCount: number): Promise<number> {
    let remaining = dropCount;
    let deleted = 0;
    while (remaining > 0) {
      const db = await this.openDb();
      const chunk = Math.min(remaining, COMPACTION_CURSOR_CHUNK);
      // One readwrite transaction per chunk by design — a huge delete must
      // not hold a single long-lived transaction.
      const deletedThisChunk = await new Promise<number>((resolve, reject) => {
        let n = 0;
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const range = IDBKeyRange.bound(
          [INTERVAL_STREAM_NAME],
          [INTERVAL_STREAM_NAME, []],
        );
        const req = tx
          .objectStore(STORE_NAME)
          .index('by_stream_lamport_replica')
          .openCursor(range);
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor === null || n >= chunk) return;
          cursor.delete();
          n += 1;
          cursor.continue();
        };
        tx.oncomplete = () => resolve(n);
        tx.onerror = () => reject(tx.error ?? new Error('indexedDB compaction delete failed'));
      });
      deleted += deletedThisChunk;
      remaining -= deletedThisChunk;
      if (deletedThisChunk === 0) break; // nothing left to delete
    }
    return deleted;
  }
}

export class IndexedDbEventBuffer implements EventBuffer {
  constructor(private readonly driver: EventStoreDriver = new IndexedDbDriver()) {}

  async appendMany(events: readonly BufferedEvent[]): Promise<void> {
    for (const event of events) await this.driver.put(event);
  }

  peek(limit: number): Promise<BufferedEvent[]> {
    return this.driver.peek(limit);
  }

  peekByStream(streamName: BufferedEvent['streamName'], limit: number): Promise<BufferedEvent[]> {
    return this.driver.peekByStream(streamName, limit);
  }

  async deleteMany(
    keys: readonly Pick<BufferedEvent, 'streamName' | 'lamport' | 'replicaId'>[],
  ): Promise<number> {
    let deleted = 0;
    for (const key of keys) if (await this.driver.deleteByKey(keyOf(key))) deleted += 1;
    return deleted;
  }

  count(): Promise<number> {
    return this.driver.count();
  }

  /**
   * One-shot boot-time backlog compaction: keep every non-interval event
   * and only the newest `keepIntervals` `engagement.interval.observed`
   * events, dropping the rest. No-op when the driver has no compaction
   * support (e.g. an in-memory test driver). See event-buffer-compaction.ts
   * for the policy and the crash-safety reasoning.
   */
  async compact(
    keepIntervals: number = DEFAULT_KEEP_INTERVALS,
  ): Promise<EventBufferCompactionResult | null> {
    if (this.driver.compact === undefined) return null;
    return this.driver.compact(keepIntervals);
  }
}
