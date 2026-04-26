import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ensureBridgeKey } from '../../src/auth/keyfile';
import { BridgeRuntime } from '../../src/runtime';
import { HttpTransportServer } from '../../src/transport/http';
import { eventLogPath } from '../../src/vault/events';

describe('HTTP companion transport', () => {
  let vaultPath: string;
  let key: string;
  let server: HttpTransportServer;

  beforeEach(async () => {
    vaultPath = await mkdtemp(path.join(os.tmpdir(), 'bac-local-bridge-http-'));
    key = await ensureBridgeKey(vaultPath);
    server = new HttpTransportServer(new BridgeRuntime(vaultPath, 'http'), key, 0);
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    await rm(vaultPath, { recursive: true, force: true });
  });

  it('rejects unauthorized writes', async () => {
    const response = await fetch(`${server.url}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(401);
  });

  it('writes events to the vault through HTTP', async () => {
    const response = await fetch(`${server.url}/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bac-bridge-key': key,
      },
      body: JSON.stringify({
        id: 'event-1',
        timestamp: '2026-04-26T12:00:00.000Z',
        sequenceNumber: 1,
        payload: 'synthetic',
        source: 'manual',
      }),
    });
    expect(response.status).toBe(200);
    const lines = (await readFile(eventLogPath(vaultPath), 'utf8')).trim().split('\n');
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ id: 'event-1', source: 'manual' });
  });
});
