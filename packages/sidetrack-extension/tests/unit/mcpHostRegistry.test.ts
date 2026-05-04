import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addServer,
  getServer,
  listConfiguredServers,
  removeServer,
} from '../../src/mcpHost/registry';

const installChromeStorage = (): void => {
  const values = new Map<string, unknown>();
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: (key: string) => Promise.resolve({ [key]: values.get(key) }),
        set: (next: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(next)) {
            values.set(key, value);
          }
          return Promise.resolve();
        },
      },
    },
  });
};

describe('MCP host registry', () => {
  beforeEach(() => {
    installChromeStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('round-trips configured servers and removes by id', async () => {
    await addServer({
      id: 'local',
      url: 'https://mcp.example.test',
      transport: 'http',
      bearerToken: 'secret',
    });

    await expect(listConfiguredServers()).resolves.toEqual([
      {
        id: 'local',
        url: 'https://mcp.example.test',
        transport: 'http',
        bearerToken: 'secret',
      },
    ]);
    await expect(getServer('local')).resolves.toMatchObject({ id: 'local' });
    await removeServer('local');
    await expect(listConfiguredServers()).resolves.toEqual([]);
  });
});
