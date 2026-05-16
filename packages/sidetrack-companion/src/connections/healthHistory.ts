import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { createRevision } from '../domain/ids.js';

/**
 * A single observability sample of connections-pipeline health, captured
 * once per drain. Every metric is nullable so a partial drain (or a metric
 * that was not computed this cycle) can still record a sample.
 */
export interface HealthHistorySample {
  readonly at: string; // ISO timestamp
  readonly adjacentPerVisitChurn: number | null;
  readonly shadowMaxTopicShare: number | null;
  readonly noiseShare: number | null;
  readonly shadowTopicCount: number | null;
  readonly runtimeMs: number | null;
  readonly vaultBytes: number | null;
}

/**
 * Dumb fixed window. ~96 samples is roughly a day of 15-minute drains;
 * we keep it deliberately small so the whole history is one tiny JSON
 * file and never needs pagination or a directory scan.
 */
export const HEALTH_HISTORY_MAX = 96;

const historyPath = (vaultRoot: string): string =>
  join(vaultRoot, '_BAC', 'connections', 'diagnostics', 'health-history.json');

const isFiniteNumberOrNull = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isFinite(value));

const isHealthHistorySample = (value: unknown): value is HealthHistorySample => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['at'] === 'string' &&
    isFiniteNumberOrNull(record['adjacentPerVisitChurn']) &&
    isFiniteNumberOrNull(record['shadowMaxTopicShare']) &&
    isFiniteNumberOrNull(record['noiseShare']) &&
    isFiniteNumberOrNull(record['shadowTopicCount']) &&
    isFiniteNumberOrNull(record['runtimeMs']) &&
    isFiniteNumberOrNull(record['vaultBytes'])
  );
};

const normalizeSample = (sample: HealthHistorySample): HealthHistorySample => ({
  at: sample.at,
  adjacentPerVisitChurn: sample.adjacentPerVisitChurn,
  shadowMaxTopicShare: sample.shadowMaxTopicShare,
  noiseShare: sample.noiseShare,
  shadowTopicCount: sample.shadowTopicCount,
  runtimeMs: sample.runtimeMs,
  vaultBytes: sample.vaultBytes,
});

const atomicWriteJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = join(dirname(path), `.${basename(path)}.${createRevision()}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempPath, path);
};

/**
 * Read the persisted history, newest-last. A missing or unparseable file
 * (or a file whose contents are not a clean array of samples) yields [].
 * `limit` returns at most the newest `limit` samples.
 */
export const readHealthHistory = async (
  vaultRoot: string,
  limit?: number,
): Promise<readonly HealthHistorySample[]> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(historyPath(vaultRoot), 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const samples = parsed
    .filter(isHealthHistorySample)
    .map(normalizeSample);
  if (limit !== undefined && limit >= 0 && samples.length > limit) {
    return samples.slice(samples.length - limit);
  }
  return samples;
};

/**
 * Append one sample to the ring buffer (newest-last) and atomically
 * persist it, trimming the oldest entries so at most HEALTH_HISTORY_MAX
 * samples remain. A corrupt/missing file is treated as an empty buffer.
 */
export const appendHealthHistory = async (
  vaultRoot: string,
  sample: HealthHistorySample,
): Promise<void> => {
  const existing = await readHealthHistory(vaultRoot);
  const next = [...existing, normalizeSample(sample)];
  const trimmed =
    next.length > HEALTH_HISTORY_MAX
      ? next.slice(next.length - HEALTH_HISTORY_MAX)
      : next;
  await atomicWriteJson(historyPath(vaultRoot), trimmed);
};
