import { type BufferedEvent, type EventBuffer } from './in-memory-event-buffer';

interface EventStoreDriver {
  put(event: BufferedEvent): Promise<void>;
  peek(limit: number): Promise<BufferedEvent[]>;
  peekByStream(streamName: BufferedEvent['streamName'], limit: number): Promise<BufferedEvent[]>;
  deleteByKey(key: string): Promise<boolean>;
  count(): Promise<number>;
}

const DB_NAME = 'sidetrack-event-buffer';
const STORE_NAME = 'events';
const DB_VERSION = 2;

const keyOf = (e: Pick<BufferedEvent, 'streamName' | 'lamport' | 'replicaId'>): string =>
  `${e.streamName}|${e.lamport}|${e.replicaId}`;

class IndexedDbDriver implements EventStoreDriver {
  private dbPromise: Promise<IDBDatabase> | null = null;

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

  async put(event: BufferedEvent): Promise<void> {
    const db = await this.openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({ id: keyOf(event), ...event });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('indexedDB put failed'));
    });
  }

  async peek(limit: number): Promise<BufferedEvent[]> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
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
  }

  async peekByStream(streamName: BufferedEvent['streamName'], limit: number): Promise<BufferedEvent[]> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const out: BufferedEvent[] = [];
      const tx = db.transaction(STORE_NAME, 'readonly');
      const range = IDBKeyRange.bound([streamName], [streamName, []]);
      const req = tx
        .objectStore(STORE_NAME)
        .index('by_stream_lamport_replica')
        .openCursor(range);
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
  }

  async deleteByKey(key: string): Promise<boolean> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const getReq = tx.objectStore(STORE_NAME).get(key);
      getReq.onsuccess = () => {
        if (getReq.result === undefined) return resolve(false);
        tx.objectStore(STORE_NAME).delete(key);
      };
      tx.oncomplete = () => resolve(getReq.result !== undefined);
      tx.onerror = () => reject(tx.error ?? new Error('indexedDB delete failed'));
    });
  }

  async count(): Promise<number> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('indexedDB count failed'));
    });
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
}
