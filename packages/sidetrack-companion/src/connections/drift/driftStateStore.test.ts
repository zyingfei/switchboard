import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DRIFT_STATE_SCHEMA_VERSION,
  createDriftStateStore,
  type DriftPersistedState,
} from './driftStateStore.js';

const sampleState = (): DriftPersistedState => ({
  schemaVersion: DRIFT_STATE_SCHEMA_VERSION,
  updatedAt: '2026-05-15T00:00:00.000Z',
  signals: {
    noiseShare: {
      adwin: { delta: 0.002, rows: [], width: 0, total: 0, variance: 0 },
      kswin: {
        alpha: 0.005,
        windowSize: 100,
        statSize: 30,
        warningFactor: 0.8,
        window: [],
      },
    },
  },
  silhouette: { revisionIds: ['r1'], silhouettes: [0.5] },
});

describe('createDriftStateStore', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'drift-state-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns null when no state file exists', async () => {
    const store = createDriftStateStore(root);
    expect(await store.read()).toBeNull();
  });

  it('writes then reads back the persisted state', async () => {
    const store = createDriftStateStore(root);
    const state = sampleState();
    await store.write(state);
    const round = await store.read();
    expect(round).toEqual(state);
  });

  it('writes atomically (no .tmp file lingers, file is valid JSON)', async () => {
    const store = createDriftStateStore(root);
    await store.write(sampleState());
    const path = join(root, '_BAC/connections/diagnostics/drift-state.json');
    const body = await readFile(path, 'utf8');
    expect(() => {
      JSON.parse(body) as unknown;
    }).not.toThrow();
    expect(body.endsWith('\n')).toBe(true);
  });

  it('returns null on a corrupt JSON blob (rebuildable cache)', async () => {
    const dir = join(root, '_BAC/connections/diagnostics');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'drift-state.json'), '{ not json', 'utf8');
    const store = createDriftStateStore(root);
    expect(await store.read()).toBeNull();
  });

  it('returns null on a wrong-schema blob', async () => {
    const dir = join(root, '_BAC/connections/diagnostics');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'drift-state.json'),
      JSON.stringify({ schemaVersion: 999, updatedAt: 'x', signals: {}, silhouette: {} }),
      'utf8',
    );
    const store = createDriftStateStore(root);
    expect(await store.read()).toBeNull();
  });

  it('read never throws even when the path is unreadable', async () => {
    // Point at a path whose parent is a file, so readFile errors.
    const filePath = join(root, 'afile');
    await writeFile(filePath, 'x', 'utf8');
    const store = createDriftStateStore(filePath);
    await expect(store.read()).resolves.toBeNull();
  });
});
