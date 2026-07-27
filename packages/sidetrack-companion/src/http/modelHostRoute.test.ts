import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadOrCreateReplica } from '../sync/replicaId.js';
import { createEventLog } from '../sync/eventLog.js';
import { createVaultWriter } from '../vault/writer.js';
import { createIdempotencyStore } from './idempotency.js';
import { isModelHostPath, resolveModelFileTarget } from './modelHostRoute.js';
import { createCompanionHttpServer, startHttpServer } from './server.js';

describe('resolveModelFileTarget (path confinement)', () => {
  const modelsDir = '/models';

  it('maps org/repo/resolve/{rev}/{file} to modelsDir/org/repo/file (revision ignored)', () => {
    const t = resolveModelFileTarget('/v1/models/onnx-community/gemma-3-1b/resolve/main/config.json', modelsDir);
    expect(t).not.toBeNull();
    expect(t!.org).toBe('onnx-community');
    expect(t!.repo).toBe('gemma-3-1b');
    expect(t!.revision).toBe('main');
    expect(t!.filePath).toBe('config.json');
    expect(t!.absolutePath).toBe('/models/onnx-community/gemma-3-1b/config.json');
  });

  it('supports nested file paths in the tail', () => {
    const t = resolveModelFileTarget('/v1/models/org/repo/resolve/main/onnx/model_q4.onnx', modelsDir);
    expect(t!.absolutePath).toBe('/models/org/repo/onnx/model_q4.onnx');
    expect(t!.filePath).toBe('onnx/model_q4.onnx');
  });

  it('rejects `..` traversal in the file tail', () => {
    expect(
      resolveModelFileTarget('/v1/models/org/repo/resolve/main/../../etc/passwd', modelsDir),
    ).toBeNull();
  });

  it('rejects percent-encoded `..%2f` traversal', () => {
    expect(
      resolveModelFileTarget('/v1/models/org/repo/resolve/main/%2e%2e%2f%2e%2e%2fetc%2fpasswd', modelsDir),
    ).toBeNull();
  });

  it('rejects `..` smuggled into the org / repo segment', () => {
    expect(resolveModelFileTarget('/v1/models/../repo/resolve/main/x', modelsDir)).toBeNull();
    expect(resolveModelFileTarget('/v1/models/org/..%2f/resolve/main/x', modelsDir)).toBeNull();
  });

  it('rejects a non-model path', () => {
    expect(resolveModelFileTarget('/v1/models/org/repo/config.json', modelsDir)).toBeNull();
    expect(resolveModelFileTarget('/v1/health', modelsDir)).toBeNull();
  });
});

describe('isModelHostPath', () => {
  it('matches the /v1/models/ prefix only', () => {
    expect(isModelHostPath('/v1/models/org/repo/resolve/main/x')).toBe(true);
    expect(isModelHostPath('/v1/health')).toBe(false);
    expect(isModelHostPath('/v1/model')).toBe(false);
  });
});

describe('GET /v1/models/... (streamed, unauthenticated)', () => {
  let vaultRoot: string;
  let modelsDir: string;
  let serverUrl: string;
  let close: (() => Promise<void>) | null = null;
  const prevModelsDir = process.env['SIDETRACK_MODELS_DIR'];
  const FIXTURE = 'hello onnx model bytes\n';

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-modelhost-vault-'));
    modelsDir = await mkdtemp(join(tmpdir(), 'sidetrack-modelhost-models-'));
    // The route resolves via resolveModelsDir(), which reads SIDETRACK_MODELS_DIR.
    process.env['SIDETRACK_MODELS_DIR'] = modelsDir;
    await mkdir(join(modelsDir, 'onnx-community', 'gemma-3-1b', 'onnx'), { recursive: true });
    await writeFile(join(modelsDir, 'onnx-community', 'gemma-3-1b', 'config.json'), FIXTURE);

    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const server = createCompanionHttpServer({
      bridgeKey: 'unused-for-this-route',
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
    if (prevModelsDir === undefined) delete process.env['SIDETRACK_MODELS_DIR'];
    else process.env['SIDETRACK_MODELS_DIR'] = prevModelsDir;
    await rm(vaultRoot, { recursive: true, force: true });
    await rm(modelsDir, { recursive: true, force: true });
  });

  const url = (path: string): string => `${serverUrl}${path}`;

  it('streams a small fixture file WITHOUT a bridge key (unauthenticated)', async () => {
    const r = await fetch(url('/v1/models/onnx-community/gemma-3-1b/resolve/main/config.json'));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-length')).toBe(String(Buffer.byteLength(FIXTURE)));
    expect(r.headers.get('content-type')).toBe('application/json');
    expect(r.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(r.headers.get('etag')).toMatch(/^"m-/);
    expect(await r.text()).toBe(FIXTURE);
  });

  it('HEAD returns the headers (incl. content-length) with no body', async () => {
    const r = await fetch(url('/v1/models/onnx-community/gemma-3-1b/resolve/main/config.json'), {
      method: 'HEAD',
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-length')).toBe(String(Buffer.byteLength(FIXTURE)));
    expect(await r.text()).toBe('');
  });

  it('returns 304 for a matching If-None-Match (browser cache validation)', async () => {
    const first = await fetch(url('/v1/models/onnx-community/gemma-3-1b/resolve/main/config.json'));
    const etag = first.headers.get('etag')!;
    const second = await fetch(url('/v1/models/onnx-community/gemma-3-1b/resolve/main/config.json'), {
      headers: { 'if-none-match': etag },
    });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
  });

  it('404s a missing file with a typed JSON body', async () => {
    const r = await fetch(url('/v1/models/onnx-community/gemma-3-1b/resolve/main/nope.bin'));
    expect(r.status).toBe(404);
    const body: any = await r.json();
    expect(body.code).toBe('MODEL_FILE_NOT_FOUND');
  });

  it('400s a traversal attempt (never reads outside modelsDir)', async () => {
    const r = await fetch(url('/v1/models/org/repo/resolve/main/%2e%2e%2f%2e%2e%2fetc%2fpasswd'));
    expect(r.status).toBe(400);
    const body: any = await r.json();
    expect(body.code).toBe('MODEL_PATH_REJECTED');
  });

  it('rejects a non-GET/HEAD method (GET-only contract; not intercepted → auth-gated)', async () => {
    // The model-host interception is GET/HEAD-only (streaming concern), so a
    // DELETE falls through to the normal auth gate and is rejected there (401)
    // rather than being served. Either way it never streams a file.
    const r = await fetch(url('/v1/models/onnx-community/gemma-3-1b/resolve/main/config.json'), {
      method: 'DELETE',
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).not.toBe(200);
  });
});
