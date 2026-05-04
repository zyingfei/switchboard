import type { McpServerConfig } from './types';

const STORAGE_KEY = 'sidetrack.mcpHost.servers';

const readStored = async (): Promise<readonly McpServerConfig[]> => {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const value = result[STORAGE_KEY];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is McpServerConfig => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return false;
    }
    const record = item as { readonly id?: unknown; readonly url?: unknown; readonly transport?: unknown };
    return (
      typeof record.id === 'string' &&
      typeof record.url === 'string' &&
      (record.transport === 'http' || record.transport === 'sse')
    );
  });
};

const writeStored = async (servers: readonly McpServerConfig[]): Promise<void> => {
  await chrome.storage.local.set({ [STORAGE_KEY]: servers });
};

export const listConfiguredServers = readStored;

export const getServer = async (id: string): Promise<McpServerConfig | undefined> =>
  (await readStored()).find((server) => server.id === id);

export const addServer = async (server: McpServerConfig): Promise<void> => {
  // TODO: move bearerToken into a dedicated secret-storage adapter when the
  // extension grows one; chrome.storage.local is the only existing persistence
  // port in this package today.
  const existing = (await readStored()).filter((candidate) => candidate.id !== server.id);
  await writeStored([...existing, server]);
};

export const removeServer = async (id: string): Promise<void> => {
  await writeStored((await readStored()).filter((server) => server.id !== id));
};
