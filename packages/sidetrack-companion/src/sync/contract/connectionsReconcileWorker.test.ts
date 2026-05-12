// Stage 5.2 W1 — worker harness round-trip tests.
//
// We don't spin up the full materializer here (that would couple this
// test to every materializer dep in a worker context). Instead, point
// the harness at a tiny throwaway script that echoes the seq token
// back. This verifies the round-trip, the seq passthrough, the
// error-path on exit-without-message, and the catch on script error.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  runReconcileInWorker,
  setWorkerScriptOverride,
} from './connectionsReconcileWorker.js';

describe('Stage 5.2 W1 — runReconcileInWorker harness', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'sidetrack-w1-'));
  });

  afterEach(async () => {
    setWorkerScriptOverride(undefined);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('round-trips seq token + snapshotRevision from the worker', async () => {
    const scriptPath = join(tmpDir, 'echo.mjs');
    await writeFile(
      scriptPath,
      `import { parentPort, workerData } from 'node:worker_threads';
parentPort.postMessage({
  seq: workerData.seq,
  ok: true,
  snapshotRevision: 'rev-' + String(workerData.seq),
});
`,
    );
    setWorkerScriptOverride(scriptPath);
    const result = await runReconcileInWorker({ vaultRoot: tmpDir, seq: 7 });
    expect(result).toEqual({ seq: 7, ok: true, snapshotRevision: 'rev-7' });
  });

  it('surfaces exit-without-message as an error result', async () => {
    const scriptPath = join(tmpDir, 'silent-exit.mjs');
    await writeFile(scriptPath, `process.exit(0);\n`);
    setWorkerScriptOverride(scriptPath);
    const result = await runReconcileInWorker({ vaultRoot: tmpDir, seq: 1 });
    expect(result.ok).toBe(false);
    expect(result.seq).toBe(1);
    expect(result.error).toContain('without posting result');
  });

  it('surfaces thrown errors from the worker script', async () => {
    const scriptPath = join(tmpDir, 'throws.mjs');
    await writeFile(scriptPath, `throw new Error('boom');\n`);
    setWorkerScriptOverride(scriptPath);
    const result = await runReconcileInWorker({ vaultRoot: tmpDir, seq: 2 });
    expect(result.ok).toBe(false);
    expect(result.seq).toBe(2);
    expect(result.error).toContain('boom');
  });
});
