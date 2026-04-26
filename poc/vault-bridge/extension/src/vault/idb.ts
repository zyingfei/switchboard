const DB_NAME = 'bac-vault-bridge';
const DB_VERSION = 1;
const STORE_NAME = 'handles';
const VAULT_KEY = 'vault';

const openDatabase = async (): Promise<IDBDatabase> =>
  await new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open vault bridge IndexedDB'));
    request.onsuccess = () => resolve(request.result);
  });

const transact = async <TValue>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<TValue>,
): Promise<TValue> => {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const request = run(tx.objectStore(STORE_NAME));
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
      request.onsuccess = () => resolve(request.result);
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    });
  } finally {
    db.close();
  }
};

export const saveVaultHandle = async (handle: FileSystemDirectoryHandle): Promise<void> => {
  await transact('readwrite', (store) => store.put(handle, VAULT_KEY));
};

export const loadVaultHandle = async (): Promise<FileSystemDirectoryHandle | null> => {
  const handle = await transact<FileSystemDirectoryHandle | undefined>('readonly', (store) => store.get(VAULT_KEY));
  return handle ?? null;
};
