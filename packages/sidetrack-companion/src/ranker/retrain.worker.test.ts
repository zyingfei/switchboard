import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ConnectionsSnapshot } from '../connections/types.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { runMaybeRetrainInWorker } from './retrain.js';

// Empty snapshot — no edges, no nodes. With no feedback events either,
// the retrain plan should land on `no-labels` skip immediately. That's
// enough to prove the worker spawns, runs the planner, and round-trips
// a result without crashing.
const EMPTY_SNAPSHOT: ConnectionsSnapshot = {
  scope: {},
  nodes: [],
  edges: [],
  updatedAt: '2026-05-12T20:00:00.000Z',
  nodeCount: 0,
  edgeCount: 0,
};

describe('ranker retrain worker', () => {
  let vaultRoot: string;
  let workerBundleAvailable = false;

  beforeAll(async () => {
    // The worker spawns from the compiled `retrain.worker.js` next to
    // `retrain.js`. Vitest runs off src/ which has the .ts file but
    // not the compiled .js, so this test only runs when a fresh
    // `npm run build` has produced the dist bundle. Mirror that
    // gating here — production code (post-build) always has the .js
    // file, but the unit suite without a build step does not.
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
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('round-trips an empty-input retrain through the worker thread (post-build only)', async () => {
    if (!workerBundleAvailable) {
      return;
    }
    const merged: readonly AcceptedEvent[] = [];
    const result = await runMaybeRetrainInWorker({
      vaultRoot,
      merged,
      snapshot: EMPTY_SNAPSHOT,
    });
    // Acceptable skip outcomes for an empty input — proves the worker
    // spawned, ran the planner, and round-tripped a structured result.
    expect(result.status).toBe('skipped');
    if (result.status === 'skipped') {
      expect(['no-labels', 'unchanged', 'no-training-candidates']).toContain(result.reason);
    }
  });
});
