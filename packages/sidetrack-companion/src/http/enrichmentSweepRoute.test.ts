import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LOCAL_LLM_ENV, resetTitleSweepForTest } from '../enrichment/localLlm.js';
import { createEventLog, type EventLog } from '../sync/eventLog.js';
import { loadOrCreateReplica } from '../sync/replicaId.js';
import { createVaultWriter } from '../vault/writer.js';
import { createIdempotencyStore } from './idempotency.js';
import { createCompanionHttpServer, startHttpServer } from './server.js';

// The sweep route starts a background job that (when the flag is on) would try
// to fork the real model child. These tests keep the vault empty so the sweep
// selects ZERO candidates and finishes immediately WITHOUT spawning a child —
// exercising the route contract (disabled / started / already-running / status
// shapes) without ever loading a model. The unit tests in
// enrichment/localLlm.test.ts cover generation with an injected fake runner.

describe('POST/GET /v1/enrichment/titles/sweep', () => {
  let vaultRoot: string;
  let serverUrl: string;
  let eventLog: EventLog;
  let close: (() => Promise<void>) | null = null;
  const bridgeKey = 'sweep-bridge-key';

  beforeEach(async () => {
    resetTitleSweepForTest();
    delete process.env[LOCAL_LLM_ENV];
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-sweep-http-'));
    const replica = await loadOrCreateReplica(vaultRoot);
    eventLog = createEventLog(vaultRoot, replica);
    const server = createCompanionHttpServer({
      bridgeKey,
      vaultWriter: createVaultWriter(vaultRoot),
      vaultRoot,
      idempotencyStore: createIdempotencyStore(vaultRoot),
      replica,
      eventLog,
    });
    const started = await startHttpServer(server, 0);
    serverUrl = started.url;
    close = started.close;
  });

  afterEach(async () => {
    if (close !== null) await close();
    close = null;
    delete process.env[LOCAL_LLM_ENV];
    resetTitleSweepForTest();
    await rm(vaultRoot, { recursive: true, force: true });
  });

  const post = async (body: unknown = {}): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${serverUrl}/v1/enrichment/titles/sweep`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bac-bridge-key': bridgeKey },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  const get = async (): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${serverUrl}/v1/enrichment/titles/sweep`, {
      headers: { 'x-bac-bridge-key': bridgeKey },
    });
    return { status: response.status, body: await response.json() };
  };

  it('flag off ⇒ POST 200 { disabled: true } (no job started)', async () => {
    const r = await post({ budget: 5 });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ disabled: true, flag: LOCAL_LLM_ENV });
  });

  it('flag off ⇒ GET 200 status with disabled:true and state idle', async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ disabled: true, state: 'idle' });
  });

  it('flag on, empty vault ⇒ POST returns a status object (started) and GET reflects it', async () => {
    process.env[LOCAL_LLM_ENV] = '1';
    const r = await post({ budget: 3 });
    expect(r.status).toBe(200);
    // Returns immediately with a status object; state is running or already
    // done (empty vault → zero candidates → finishes fast). Never disabled.
    expect(r.body.data.disabled).toBeUndefined();
    expect(['running', 'done', 'idle']).toContain(r.body.data.state);
    expect(typeof r.body.data.modelId).toBe('string');
    expect(r.body.data.accepted).toBe(0);

    const g = await get();
    expect(g.status).toBe(200);
    expect(['running', 'done']).toContain(g.body.data.state);
    expect(g.body.data.accepted).toBe(0);
  });

  it('surfaces the local-llm block on /v1/system/health', async () => {
    process.env[LOCAL_LLM_ENV] = '1';
    const response = await fetch(`${serverUrl}/v1/system/health`, {
      headers: { 'x-bac-bridge-key': bridgeKey },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.localLlm).toBeDefined();
    expect(body.data.localLlm.enabled).toBe(true);
    expect(body.data.localLlm.flag).toBe(LOCAL_LLM_ENV);
    expect(typeof body.data.localLlm.modelId).toBe('string');
    expect(body.data.localLlm.sweep).toBeDefined();
  });
});
