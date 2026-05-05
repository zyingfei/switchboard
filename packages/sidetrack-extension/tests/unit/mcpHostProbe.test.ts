import { afterEach, describe, expect, it, vi } from 'vitest';

import { probeServer } from '../../src/mcpHost/probe';

describe('MCP host probe', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('marks 2xx and 3xx responses online', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(null, { status: 204 })));

    await expect(
      probeServer({ id: 'local', url: 'http://localhost:9876', transport: 'http' }),
    ).resolves.toMatchObject({ online: true });
  });

  it('marks failed probes offline', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('connection refused')));

    await expect(
      probeServer({ id: 'local', url: 'http://localhost:9876', transport: 'http' }),
    ).resolves.toMatchObject({ online: false, error: 'connection refused' });
  });
});
