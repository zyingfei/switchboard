import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadOrCreateReplica } from '../sync/replicaId.js';
import { createEventLog } from '../sync/eventLog.js';
import { createVaultWriter } from '../vault/writer.js';
import { createIdempotencyStore } from './idempotency.js';
import { isModelHostPath } from './modelHostRoute.js';
import {
  MODEL_FETCH_ENV,
  MODEL_FETCH_HOST,
  MODEL_FETCH_MAX_FILES,
  __modelFetchJobDoneForTest,
  __resetModelFetchJobsForTest,
  handleModelFetchStart,
  huggingFaceFileUrl,
  isModelFetchPath,
  modelFetchStatus,
  resolveModelFetchTarget,
} from './modelFetchRoute.js';
import { createCompanionHttpServer, startHttpServer } from './server.js';

// THE NETWORK IS NEVER TOUCHED BY THIS SUITE. Every download path is driven
// through the `fetchImpl` seam with an in-memory table of fake files; the two
// HTTP-level cases that exercise the real route either have the kill switch OFF
// or send a path that fails validation before any fetch is built. If a future
// edit makes a test here reach huggingface.co, that is the bug.

const BRIDGE_KEY = 'test-bridge-key-model-fetch';
const ORG = 'onnx-community';
const REPO = 'Llama-3.2-3B-Instruct-ONNX';
const MODEL_ID = `${ORG}/${REPO}`;

interface FakeFile {
  readonly body: string;
  /** Status for the GET; 200 unless the test wants a failure. */
  readonly status?: number;
}

interface FakeFetch {
  readonly impl: (url: string, init?: { method?: string }) => Promise<Response>;
  readonly gets: string[];
  readonly heads: string[];
}

const fakeFetch = (files: Record<string, FakeFile>): FakeFetch => {
  const gets: string[] = [];
  const heads: string[] = [];
  const impl = async (url: string, init?: { method?: string }): Promise<Response> => {
    const key = url.split('/resolve/main/')[1] ?? '';
    const file = files[key];
    if (init?.method === 'HEAD') {
      heads.push(key);
      if (file === undefined) return new Response(null, { status: 404 });
      return new Response(null, {
        status: 200,
        headers: { 'content-length': String(Buffer.byteLength(file.body)) },
      });
    }
    gets.push(key);
    if (file === undefined) return new Response('nope', { status: 404 });
    if (file.status !== undefined && file.status !== 200) {
      return new Response('nope', { status: file.status });
    }
    return new Response(file.body, { status: 200 });
  };
  return { impl, gets, heads };
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

describe('resolveModelFetchTarget (path confinement — the SAME defense as the serve route)', () => {
  const modelsDir = '/models';

  it('maps a declared relative path to modelsDir/org/repo/<path>', () => {
    const t = resolveModelFetchTarget(ORG, REPO, ['config.json', 'onnx/model_q4.onnx'], modelsDir);
    expect(t).not.toBeNull();
    expect(t!.modelId).toBe(MODEL_ID);
    expect(t!.files[0]!.absolutePath).toBe(`/models/${MODEL_ID}/config.json`);
    expect(t!.files[1]!.absolutePath).toBe(`/models/${MODEL_ID}/onnx/model_q4.onnx`);
    // The .part sibling is derived from the confined path, so it is confined too.
    expect(t!.files[1]!.partPath).toBe(`/models/${MODEL_ID}/onnx/model_q4.onnx.part`);
  });

  it('rejects `..` traversal in a declared file path', () => {
    expect(resolveModelFetchTarget(ORG, REPO, ['../../etc/passwd'], modelsDir)).toBeNull();
    expect(resolveModelFetchTarget(ORG, REPO, ['onnx/../../../etc/passwd'], modelsDir)).toBeNull();
  });

  it('rejects an absolute path (leading slash ⇒ empty segment)', () => {
    expect(resolveModelFetchTarget(ORG, REPO, ['/etc/passwd'], modelsDir)).toBeNull();
  });

  it('rejects a backslash-separated path and an embedded NUL', () => {
    expect(resolveModelFetchTarget(ORG, REPO, ['onnx\\..\\..\\etc'], modelsDir)).toBeNull();
    expect(
      resolveModelFetchTarget(ORG, REPO, [`config.json${String.fromCharCode(0)}.png`], modelsDir),
    ).toBeNull();
  });

  it('rejects `..` smuggled into org / repo (percent-encoded too)', () => {
    expect(resolveModelFetchTarget('..', REPO, ['config.json'], modelsDir)).toBeNull();
    expect(resolveModelFetchTarget(ORG, '%2e%2e', ['config.json'], modelsDir)).toBeNull();
    expect(resolveModelFetchTarget(ORG, '%2e%2e%2f', ['config.json'], modelsDir)).toBeNull();
  });

  it('rejects an empty list and one over the file cap', () => {
    expect(resolveModelFetchTarget(ORG, REPO, [], modelsDir)).toBeNull();
    const tooMany = Array.from({ length: MODEL_FETCH_MAX_FILES + 1 }, (_, i) => `f${String(i)}.bin`);
    expect(resolveModelFetchTarget(ORG, REPO, tooMany, modelsDir)).toBeNull();
  });
});

describe('huggingFaceFileUrl (the one outbound URL shape)', () => {
  it('names huggingface.co and pins revision main', () => {
    expect(huggingFaceFileUrl(ORG, REPO, 'onnx/model_q4.onnx')).toBe(
      `https://${MODEL_FETCH_HOST}/${ORG}/${REPO}/resolve/main/onnx/model_q4.onnx`,
    );
    expect(MODEL_FETCH_HOST).toBe('huggingface.co');
  });
});

describe('isModelFetchPath / isModelHostPath (the serve route must not swallow /fetch)', () => {
  it('claims the /fetch shape and nothing else', () => {
    expect(isModelFetchPath(`/v1/models/${MODEL_ID}/fetch`)).toBe(true);
    expect(isModelFetchPath(`/v1/models/${MODEL_ID}/resolve/main/config.json`)).toBe(false);
  });

  it('leaves /fetch OUT of the unauthenticated streaming interception', () => {
    expect(isModelHostPath(`/v1/models/${MODEL_ID}/fetch`)).toBe(false);
    // …while the serve shape is still claimed (serve route unaffected).
    expect(isModelHostPath(`/v1/models/${MODEL_ID}/resolve/main/config.json`)).toBe(true);
  });
});

describe('model fetch job (background download, .part + rename)', () => {
  let modelsDir: string;
  const prevFlag = process.env[MODEL_FETCH_ENV];

  beforeEach(async () => {
    modelsDir = await mkdtemp(join(tmpdir(), 'sidetrack-modelfetch-'));
    __resetModelFetchJobsForTest();
    delete process.env[MODEL_FETCH_ENV];
  });

  afterEach(async () => {
    __resetModelFetchJobsForTest();
    if (prevFlag === undefined) delete process.env[MODEL_FETCH_ENV];
    else process.env[MODEL_FETCH_ENV] = prevFlag;
    await rm(modelsDir, { recursive: true, force: true });
  });

  const start = (files: readonly string[], fetchImpl: FakeFetch) =>
    handleModelFetchStart(ORG, REPO, { files }, { modelsDir, fetchImpl: fetchImpl.impl, log: () => undefined });

  it('runs in the background: POST returns state running, then the job reaches done', async () => {
    const f = fakeFetch({
      'config.json': { body: '{"a":1}' },
      'onnx/model_q4.onnx': { body: 'ONNXBYTES' },
    });
    const outcome = start(['config.json', 'onnx/model_q4.onnx'], f);
    expect(outcome.ok).toBe(true);
    // The POST answer is SYNCHRONOUS — a multi-GB transfer cannot be awaited
    // inside a request.
    expect(outcome.ok && outcome.status.state).toBe('running');
    expect(outcome.ok && outcome.status.filesTotal).toBe(2);
    expect(outcome.ok && outcome.status.host).toBe(MODEL_FETCH_HOST);

    await __modelFetchJobDoneForTest(MODEL_ID);
    const status = modelFetchStatus(MODEL_ID);
    expect(status.state).toBe('done');
    expect(status.filesDone).toBe(2);
    expect(status.filesTotal).toBe(2);
    expect(status.currentFile).toBeNull();
    expect(status.bytesDone).toBe(Buffer.byteLength('{"a":1}') + Buffer.byteLength('ONNXBYTES'));
    // bytesTotal came from the HEAD sizing pass, before any body was read.
    expect(status.bytesTotal).toBe(status.bytesDone);
    expect(f.heads).toEqual(['config.json', 'onnx/model_q4.onnx']);

    // The files landed where the SERVE route looks for them, nested path included.
    expect(await readFile(join(modelsDir, MODEL_ID, 'config.json'), 'utf8')).toBe('{"a":1}');
    expect(await readFile(join(modelsDir, MODEL_ID, 'onnx', 'model_q4.onnx'), 'utf8')).toBe('ONNXBYTES');
    // No .part residue.
    expect(await exists(join(modelsDir, MODEL_ID, 'onnx', 'model_q4.onnx.part'))).toBe(false);
  });

  it('renames from .part only after the stream ends — a file in flight is INVISIBLE to the host', async () => {
    // A body that stalls until the test releases it: while it is stalled the
    // destination must not exist (the model host would serve a truncated file),
    // and the .part must.
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const impl = async (url: string, init?: { method?: string }): Promise<Response> => {
      if (init?.method === 'HEAD') {
        return new Response(null, { status: 200, headers: { 'content-length': '6' } });
      }
      void url;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode('abc'));
          await gate;
          controller.enqueue(new TextEncoder().encode('def'));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    };
    const outcome = handleModelFetchStart(
      ORG,
      REPO,
      { files: ['onnx/model_q4.onnx_data'] },
      { modelsDir, fetchImpl: impl, log: () => undefined },
    );
    expect(outcome.ok).toBe(true);

    const dest = join(modelsDir, MODEL_ID, 'onnx', 'model_q4.onnx_data');
    // Wait for the first chunk to have been written to the .part file.
    for (let i = 0; i < 200 && !(await exists(`${dest}.part`)); i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(await exists(`${dest}.part`)).toBe(true);
    expect(await exists(dest)).toBe(false);
    expect(modelFetchStatus(MODEL_ID).state).toBe('running');
    expect(modelFetchStatus(MODEL_ID).currentFile).toBe('onnx/model_q4.onnx_data');

    release?.();
    await __modelFetchJobDoneForTest(MODEL_ID);
    expect(modelFetchStatus(MODEL_ID).state).toBe('done');
    expect(await readFile(dest, 'utf8')).toBe('abcdef');
    expect(await exists(`${dest}.part`)).toBe(false);
  });

  it('is a SINGLETON per model id: a second POST while running returns the running job', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let getCount = 0;
    const impl = async (_url: string, init?: { method?: string }): Promise<Response> => {
      if (init?.method === 'HEAD') return new Response(null, { status: 200 });
      getCount += 1;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          await gate;
          controller.enqueue(new TextEncoder().encode('x'));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    };
    const first = handleModelFetchStart(
      ORG,
      REPO,
      { files: ['config.json'] },
      { modelsDir, fetchImpl: impl, log: () => undefined },
    );
    const second = handleModelFetchStart(
      ORG,
      REPO,
      { files: ['config.json'] },
      { modelsDir, fetchImpl: impl, log: () => undefined },
    );
    expect(first.ok && second.ok).toBe(true);
    expect(second.ok && second.status.state).toBe('running');
    // SAME job — identical start stamp, and only ONE download was ever issued.
    expect(second.ok && first.ok && second.status.startedAt).toBe(first.status.startedAt);

    release?.();
    await __modelFetchJobDoneForTest(MODEL_ID);
    expect(getCount).toBe(1);
    expect(modelFetchStatus(MODEL_ID).state).toBe('done');
  });

  it('skips files that are already present with a non-zero size (no GET issued)', async () => {
    await mkdir(join(modelsDir, MODEL_ID, 'onnx'), { recursive: true });
    await writeFile(join(modelsDir, MODEL_ID, 'config.json'), 'ALREADY');
    const f = fakeFetch({
      'config.json': { body: 'FRESH' },
      'onnx/model_q4.onnx': { body: 'ONNXBYTES' },
    });
    start(['config.json', 'onnx/model_q4.onnx'], f);
    await __modelFetchJobDoneForTest(MODEL_ID);

    expect(f.gets).toEqual(['onnx/model_q4.onnx']);
    // Not even sized — a present file costs zero requests.
    expect(f.heads).toEqual(['onnx/model_q4.onnx']);
    // The existing bytes were left untouched, not re-downloaded.
    expect(await readFile(join(modelsDir, MODEL_ID, 'config.json'), 'utf8')).toBe('ALREADY');
    const status = modelFetchStatus(MODEL_ID);
    expect(status.state).toBe('done');
    expect(status.filesDone).toBe(2);
    // Present bytes still count toward the bundle total, so progress is honest.
    expect(status.bytesDone).toBe(Buffer.byteLength('ALREADY') + Buffer.byteLength('ONNXBYTES'));
  });

  it('treats a ZERO-BYTE file as absent (a crashed writer must not pass as cached)', async () => {
    await mkdir(join(modelsDir, MODEL_ID), { recursive: true });
    await writeFile(join(modelsDir, MODEL_ID, 'config.json'), '');
    const f = fakeFetch({ 'config.json': { body: 'FRESH' } });
    start(['config.json'], f);
    await __modelFetchJobDoneForTest(MODEL_ID);
    expect(f.gets).toEqual(['config.json']);
    expect(await readFile(join(modelsDir, MODEL_ID, 'config.json'), 'utf8')).toBe('FRESH');
  });

  it('errors (naming the file) on a 404 and leaves NO file and NO .part behind', async () => {
    const f = fakeFetch({ 'config.json': { body: '{}' } });
    start(['config.json', 'onnx/missing.onnx'], f);
    await __modelFetchJobDoneForTest(MODEL_ID);

    const status = modelFetchStatus(MODEL_ID);
    expect(status.state).toBe('error');
    expect(status.error).toContain('onnx/missing.onnx');
    expect(status.error).toContain('404');
    expect(status.currentFile).toBeNull();
    // The file that DID succeed stays (a retry skips it); the failed one leaves
    // nothing a serve could mistake for a complete model.
    expect(await exists(join(modelsDir, MODEL_ID, 'config.json'))).toBe(true);
    expect(await exists(join(modelsDir, MODEL_ID, 'onnx', 'missing.onnx'))).toBe(false);
    expect(await exists(join(modelsDir, MODEL_ID, 'onnx', 'missing.onnx.part'))).toBe(false);
  });

  it('a POST after an errored job starts a NEW job (retry is just another POST)', async () => {
    const failing = fakeFetch({});
    start(['config.json'], failing);
    await __modelFetchJobDoneForTest(MODEL_ID);
    expect(modelFetchStatus(MODEL_ID).state).toBe('error');

    const ok = fakeFetch({ 'config.json': { body: '{}' } });
    const retry = start(['config.json'], ok);
    expect(retry.ok && retry.status.state).toBe('running');
    await __modelFetchJobDoneForTest(MODEL_ID);
    expect(modelFetchStatus(MODEL_ID).state).toBe('done');
  });

  it('KILL SWITCH off: 403, no job, and nothing requested from the host', async () => {
    process.env[MODEL_FETCH_ENV] = '0';
    const f = fakeFetch({ 'config.json': { body: '{}' } });
    const outcome = start(['config.json'], f);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.httpStatus).toBe(403);
    expect(!outcome.ok && outcome.code).toBe('MODEL_FETCH_DISABLED');
    expect(f.gets).toEqual([]);
    expect(f.heads).toEqual([]);
    expect(modelFetchStatus(MODEL_ID).state).toBe('idle');
  });

  it('rejects a malformed body and a traversal path before any fetch', async () => {
    const f = fakeFetch({ 'config.json': { body: '{}' } });
    const noFiles = handleModelFetchStart(ORG, REPO, {}, { modelsDir, fetchImpl: f.impl, log: () => undefined });
    expect(!noFiles.ok && noFiles.httpStatus).toBe(400);
    const nonString = handleModelFetchStart(
      ORG,
      REPO,
      { files: ['config.json', 7] },
      { modelsDir, fetchImpl: f.impl, log: () => undefined },
    );
    expect(!nonString.ok && nonString.httpStatus).toBe(400);
    const traversal = start(['../../../etc/passwd'], f);
    expect(!traversal.ok && traversal.httpStatus).toBe(400);
    expect(!traversal.ok && traversal.code).toBe('MODEL_PATH_REJECTED');
    expect(f.gets).toEqual([]);
  });

  it('logs the outbound host when a job starts', () => {
    const lines: string[] = [];
    const f = fakeFetch({ 'config.json': { body: '{}' } });
    handleModelFetchStart(
      ORG,
      REPO,
      { files: ['config.json'] },
      { modelsDir, fetchImpl: f.impl, log: (l) => lines.push(l) },
    );
    expect(lines.some((l) => l.includes(MODEL_FETCH_HOST) && l.includes(MODEL_ID))).toBe(true);
  });
});

describe('/v1/models/{org}/{repo}/fetch over HTTP (auth + wiring)', () => {
  let vaultRoot: string;
  let modelsDir: string;
  let serverUrl: string;
  let close: (() => Promise<void>) | null = null;
  const prevModelsDir = process.env['SIDETRACK_MODELS_DIR'];
  const prevFlag = process.env[MODEL_FETCH_ENV];

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-modelfetch-vault-'));
    modelsDir = await mkdtemp(join(tmpdir(), 'sidetrack-modelfetch-models-'));
    process.env['SIDETRACK_MODELS_DIR'] = modelsDir;
    __resetModelFetchJobsForTest();
    // EVERY HTTP case here runs with the kill switch OFF. The route is wired to
    // the real global fetch (no seam through HTTP), so this is what keeps the
    // suite off the network.
    process.env[MODEL_FETCH_ENV] = '0';
    await mkdir(join(modelsDir, ORG, REPO), { recursive: true });
    await writeFile(join(modelsDir, ORG, REPO, 'config.json'), '{"cached":true}');

    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const server = createCompanionHttpServer({
      bridgeKey: BRIDGE_KEY,
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
    __resetModelFetchJobsForTest();
    if (prevModelsDir === undefined) delete process.env['SIDETRACK_MODELS_DIR'];
    else process.env['SIDETRACK_MODELS_DIR'] = prevModelsDir;
    if (prevFlag === undefined) delete process.env[MODEL_FETCH_ENV];
    else process.env[MODEL_FETCH_ENV] = prevFlag;
    await rm(vaultRoot, { recursive: true, force: true });
    await rm(modelsDir, { recursive: true, force: true });
  });

  const url = (path: string): string => `${serverUrl}${path}`;
  const keyed = { 'x-bac-bridge-key': BRIDGE_KEY };

  it('POST requires the bridge key (unlike the GET serve route)', async () => {
    const r = await fetch(url(`/v1/models/${MODEL_ID}/fetch`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: ['config.json'] }),
    });
    expect(r.status).toBe(401);
  });

  it('GET status requires the bridge key — the serve route exemption does NOT extend to it', async () => {
    const r = await fetch(url(`/v1/models/${MODEL_ID}/fetch`));
    expect(r.status).toBe(401);
  });

  it('GET status reads idle for a model with no job (authenticated)', async () => {
    const r = await fetch(url(`/v1/models/${MODEL_ID}/fetch`), { headers: keyed });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { data: Record<string, unknown> };
    expect(body.data['state']).toBe('idle');
    expect(body.data['modelId']).toBe(MODEL_ID);
    expect(body.data['host']).toBe(MODEL_FETCH_HOST);
    expect(body.data['filesTotal']).toBe(0);
    expect(body.data['bytesDone']).toBe(0);
  });

  it('POST 403s with the kill switch off and starts nothing', async () => {
    const r = await fetch(url(`/v1/models/${MODEL_ID}/fetch`), {
      method: 'POST',
      headers: { ...keyed, 'content-type': 'application/json' },
      body: JSON.stringify({ files: ['config.json'] }),
    });
    expect(r.status).toBe(403);
    const body = (await r.json()) as { code?: string };
    expect(body.code).toBe('MODEL_FETCH_DISABLED');
    const status = await fetch(url(`/v1/models/${MODEL_ID}/fetch`), { headers: keyed });
    expect(((await status.json()) as { data: { state: string } }).data.state).toBe('idle');
  });

  it('SERVE ROUTE UNAFFECTED: the unauthenticated file GET still streams', async () => {
    const r = await fetch(url(`/v1/models/${MODEL_ID}/resolve/main/config.json`));
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('{"cached":true}');
  });

  it('SERVE ROUTE UNAFFECTED: an uncached file still 404s with the typed body', async () => {
    const r = await fetch(url(`/v1/models/${MODEL_ID}/resolve/main/onnx/model_q4.onnx`));
    expect(r.status).toBe(404);
    expect(((await r.json()) as { code?: string }).code).toBe('MODEL_FILE_NOT_FOUND');
  });
});
