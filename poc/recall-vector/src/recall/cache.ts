import type { EmbeddingCacheEntry, StorageKind } from './model';

export interface EmbeddingCacheStore {
  readonly kind: StorageKind;
  getMany(digests: string[]): Promise<Map<string, EmbeddingCacheEntry>>;
  putMany(entries: EmbeddingCacheEntry[]): Promise<void>;
}

export class MemoryEmbeddingCache implements EmbeddingCacheStore {
  readonly kind = 'memory' as const;
  private readonly entries = new Map<string, EmbeddingCacheEntry>();

  async getMany(digests: string[]): Promise<Map<string, EmbeddingCacheEntry>> {
    const hits = new Map<string, EmbeddingCacheEntry>();
    for (const digest of digests) {
      const entry = this.entries.get(digest);
      if (entry) {
        hits.set(digest, entry);
      }
    }
    return hits;
  }

  async putMany(entries: EmbeddingCacheEntry[]): Promise<void> {
    for (const entry of entries) {
      this.entries.set(entry.digest, entry);
    }
  }
}

const requestResult = <TValue>(request: IDBRequest<TValue>): Promise<TValue> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });

const transactionComplete = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });

export class IndexedDbEmbeddingCache implements EmbeddingCacheStore {
  readonly kind = 'indexeddb' as const;
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly dbName = 'bac-recall-vector',
    private readonly storeName = 'embeddings',
  ) {}

  private async openDb(): Promise<IDBDatabase> {
    if (this.dbPromise) {
      return await this.dbPromise;
    }
    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: 'digest' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Could not open IndexedDB'));
    });
    return await this.dbPromise;
  }

  async getMany(digests: string[]): Promise<Map<string, EmbeddingCacheEntry>> {
    const db = await this.openDb();
    const transaction = db.transaction(this.storeName, 'readonly');
    const store = transaction.objectStore(this.storeName);
    const hits = new Map<string, EmbeddingCacheEntry>();
    await Promise.all(
      digests.map(async (digest) => {
        const entry = await requestResult(store.get(digest) as IDBRequest<EmbeddingCacheEntry | undefined>);
        if (entry) {
          hits.set(digest, entry);
        }
      }),
    );
    await transactionComplete(transaction);
    return hits;
  }

  async putMany(entries: EmbeddingCacheEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    const db = await this.openDb();
    const transaction = db.transaction(this.storeName, 'readwrite');
    const store = transaction.objectStore(this.storeName);
    await Promise.all(entries.map(async (entry) => requestResult(store.put(entry))));
    await transactionComplete(transaction);
  }
}

export const createDefaultEmbeddingCache = (): EmbeddingCacheStore =>
  typeof indexedDB === 'undefined' ? new MemoryEmbeddingCache() : new IndexedDbEmbeddingCache();
