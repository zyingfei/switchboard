import type {
  GraphStore,
  JsonValue,
  PromptRun,
  WorkstreamEdge,
  WorkstreamEvent,
  WorkstreamNode,
} from './model';

type StoreName = 'nodes' | 'edges' | 'promptRuns' | 'events' | 'meta';

const DB_NAME = 'browser-ai-companion-poc';
const DB_VERSION = 1;

interface MetaRecord {
  key: string;
  value: JsonValue;
}

const requestToPromise = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });

const transactionDone = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });

const openDatabase = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of ['nodes', 'edges', 'promptRuns', 'events'] as StoreName[]) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' });
        }
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
  });

export const createIndexedDbGraphStore = (): GraphStore => {
  let dbPromise: Promise<IDBDatabase> | null = null;
  const getDb = () => {
    dbPromise ??= openDatabase();
    return dbPromise;
  };

  const put = async <T>(storeName: StoreName, value: T): Promise<void> => {
    const db = await getDb();
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    await transactionDone(tx);
  };

  const get = async <T>(storeName: StoreName, key: string): Promise<T | null> => {
    const db = await getDb();
    const tx = db.transaction(storeName, 'readonly');
    const value = await requestToPromise<T | undefined>(tx.objectStore(storeName).get(key));
    await transactionDone(tx);
    return value ?? null;
  };

  const list = async <T>(storeName: StoreName): Promise<T[]> => {
    const db = await getDb();
    const tx = db.transaction(storeName, 'readonly');
    const values = await requestToPromise<T[]>(tx.objectStore(storeName).getAll());
    await transactionDone(tx);
    return values;
  };

  return {
    async saveNode(node) {
      await put<WorkstreamNode>('nodes', node);
    },
    async getNode(id) {
      return await get<WorkstreamNode>('nodes', id);
    },
    async listNodes() {
      return (await list<WorkstreamNode>('nodes')).sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      );
    },
    async saveEdge(edge) {
      await put<WorkstreamEdge>('edges', edge);
    },
    async listEdges() {
      return (await list<WorkstreamEdge>('edges')).sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      );
    },
    async savePromptRun(run) {
      await put<PromptRun>('promptRuns', run);
    },
    async getPromptRun(id) {
      return await get<PromptRun>('promptRuns', id);
    },
    async listPromptRuns() {
      return (await list<PromptRun>('promptRuns')).sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      );
    },
    async appendEvent(event) {
      await put<WorkstreamEvent>('events', event);
    },
    async listEvents() {
      return (await list<WorkstreamEvent>('events')).sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      );
    },
    async getMeta(key) {
      const record = await get<MetaRecord>('meta', key);
      return (record?.value ?? null) as never;
    },
    async setMeta(key, value) {
      const db = await getDb();
      const tx = db.transaction('meta', 'readwrite');
      if (value === null) {
        tx.objectStore('meta').delete(key);
      } else {
        tx.objectStore('meta').put({ key, value } satisfies MetaRecord);
      }
      await transactionDone(tx);
    },
    async clear() {
      const db = await getDb();
      const tx = db.transaction(['nodes', 'edges', 'promptRuns', 'events', 'meta'], 'readwrite');
      for (const name of ['nodes', 'edges', 'promptRuns', 'events', 'meta'] as StoreName[]) {
        tx.objectStore(name).clear();
      }
      await transactionDone(tx);
    },
  };
};
