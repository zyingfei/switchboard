import { mkdtemp, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  HEALTH_HISTORY_MAX,
  appendHealthHistory,
  readHealthHistory,
  type HealthHistorySample,
} from './healthHistory.js';

const sampleAt = (n: number): HealthHistorySample => ({
  at: new Date(Date.UTC(2026, 4, 15, 0, 0, n)).toISOString(),
  adjacentPerVisitChurn: n,
  shadowMaxTopicShare: 0.5,
  noiseShare: null,
  shadowTopicCount: n + 1,
  runtimeMs: 1234,
  vaultBytes: null,
});

describe('healthHistory ring buffer', () => {
  let vaultRoot: string;
  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-health-history-'));
  });
  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  const diagnosticsDir = (): string =>
    join(vaultRoot, '_BAC', 'connections', 'diagnostics');
  const historyFile = (): string => join(diagnosticsDir(), 'health-history.json');

  it('returns [] when the history file is missing', async () => {
    expect(await readHealthHistory(vaultRoot)).toEqual([]);
  });

  it('appends samples newest-last', async () => {
    await appendHealthHistory(vaultRoot, sampleAt(0));
    await appendHealthHistory(vaultRoot, sampleAt(1));
    await appendHealthHistory(vaultRoot, sampleAt(2));
    const read = await readHealthHistory(vaultRoot);
    expect(read.map((s) => s.adjacentPerVisitChurn)).toEqual([0, 1, 2]);
  });

  it('trims to HEALTH_HISTORY_MAX keeping the newest samples', async () => {
    const overflow = HEALTH_HISTORY_MAX + 17;
    for (let n = 0; n < overflow; n += 1) {
      await appendHealthHistory(vaultRoot, sampleAt(n));
    }
    const read = await readHealthHistory(vaultRoot);
    expect(read).toHaveLength(HEALTH_HISTORY_MAX);
    // Oldest dropped: first kept sample is index (overflow - MAX).
    expect(read[0]?.adjacentPerVisitChurn).toBe(overflow - HEALTH_HISTORY_MAX);
    expect(read[read.length - 1]?.adjacentPerVisitChurn).toBe(overflow - 1);
  });

  it('honors an optional limit returning the newest entries', async () => {
    for (let n = 0; n < 10; n += 1) {
      await appendHealthHistory(vaultRoot, sampleAt(n));
    }
    const read = await readHealthHistory(vaultRoot, 3);
    expect(read.map((s) => s.adjacentPerVisitChurn)).toEqual([7, 8, 9]);
  });

  it('tolerates a corrupt file by returning []', async () => {
    await mkdir(diagnosticsDir(), { recursive: true });
    await writeFile(historyFile(), '{ this is not json', 'utf8');
    expect(await readHealthHistory(vaultRoot)).toEqual([]);
  });

  it('treats a corrupt file as an empty buffer on append', async () => {
    await mkdir(diagnosticsDir(), { recursive: true });
    await writeFile(historyFile(), 'not json at all', 'utf8');
    await appendHealthHistory(vaultRoot, sampleAt(42));
    const read = await readHealthHistory(vaultRoot);
    expect(read).toHaveLength(1);
    expect(read[0]?.adjacentPerVisitChurn).toBe(42);
  });

  it('drops non-conforming array entries when reading', async () => {
    await mkdir(diagnosticsDir(), { recursive: true });
    await writeFile(
      historyFile(),
      JSON.stringify([sampleAt(1), { at: 5, bogus: true }, sampleAt(2)]),
      'utf8',
    );
    const read = await readHealthHistory(vaultRoot);
    expect(read.map((s) => s.adjacentPerVisitChurn)).toEqual([1, 2]);
  });

  it('writes atomically leaving no .tmp file behind', async () => {
    await appendHealthHistory(vaultRoot, sampleAt(0));
    await appendHealthHistory(vaultRoot, sampleAt(1));
    const entries = await readdir(diagnosticsDir());
    expect(entries).toEqual(['health-history.json']);
    expect(entries.some((name) => name.includes('.tmp'))).toBe(false);
  });
});
