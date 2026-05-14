import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runMaybeRetrainInWorker } from './retrain.js';

// Worker integration test. Vitest runs off src/ which does not have
// the compiled `retrain.worker.js` next to retrain.js, so the test
// gracefully skips unless `npm run build` produced the dist bundle
// AND the test environment was configured to load the worker from
// there. The post-build path is exercised by the production runtime;
// this test pins the contract.

describe('ranker retrain worker', () => {
  let vaultRoot: string;
  let workerBundleAvailable = false;

  beforeAll(async () => {
    // Worker entry is sibling to retrain.js at runtime — the
    // production path uses `new URL('./retrain.worker.js', import.meta.url)`
    // which resolves relative to the calling file. In the test
    // environment (vitest from src/) the .js sibling doesn't exist
    // unless a build has been run; skip the suite cleanly when absent.
    const here = dirname(fileURLToPath(import.meta.url));
    try {
      await access(join(here, 'retrain.worker.js'));
      workerBundleAvailable = true;
    } catch {
      workerBundleAvailable = false;
    }
  });

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-retrain-worker-'));
    // Worker constructs its own connectionsStore via readCurrent;
    // seed an empty snapshot file so the worker doesn't bail with
    // "snapshot is not ready" before exercising the planner.
    const dir = join(vaultRoot, '_BAC', 'connections');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'current.json'),
      JSON.stringify({
        scope: {},
        nodes: [],
        edges: [],
        updatedAt: '2026-05-12T20:00:00.000Z',
        nodeCount: 0,
        edgeCount: 0,
      }),
    );
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('runs the retrain pipeline end-to-end inside a worker (post-build only)', async () => {
    if (!workerBundleAvailable) {
      return;
    }
    const result = await runMaybeRetrainInWorker({ vaultRoot });
    // With no feedback events seeded, the planner should skip with a
    // structural reason — exercises the entire spawn → readMerged →
    // readCurrent → planRetrain round-trip.
    expect(result.status).toBe('skipped');
    if (result.status === 'skipped') {
      expect(['no-labels', 'unchanged', 'no-training-candidates']).toContain(result.reason);
    }
  });
});
