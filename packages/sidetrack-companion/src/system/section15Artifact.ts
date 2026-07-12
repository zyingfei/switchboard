// Drain-time §15 falsifiability artifact.
//
// collectSection15Report does typed event reads + a bounded audit-file
// scan — cheap, but still not something to run on every /v1/system/health
// request on a cold process. Same pattern as workGraphHealthArtifact.ts:
// the connections materializer's onDrainSuccess hook materializes this
// after each successful drain, and GET /v1/system/section15 serves it
// from disk. Drain cadence is the freshness contract.
//
// Beyond the report, the artifact PERSISTS the per-day clean ledger
// (criterion 6, consecutive-clean-days streak) so the streak survives
// companion restarts: the collector reads the prior ledger from here,
// folds today's dataLoss.clean, recomputes, and the writer stores the
// folded ledger alongside the fresh report.
//
// Same small-JSON state-file discipline as workGraphHealthArtifact.ts:
// tmp+rename atomic write, lenient schemaVersion-checked reader that
// treats corrupt/mismatched files as absent so the route falls back to a
// live collect.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  type Section15CleanDayRecord,
  type Section15Report,
  foldCleanDay,
} from './section15Counters.js';
import { collectSection15Report } from './section15Collector.js';
import type { EventLog } from '../sync/eventLog.js';

export const SECTION15_ARTIFACT_SCHEMA_VERSION = 1;

// Serve-side freshness bound — identical rationale to the workGraph
// artifact: the writer only refreshes while drains succeed, so bound the
// served snapshot's age so a wedged/disabled writer can't serve a frozen
// table forever with every other health surface green. 24h is loose;
// drain cadence is the real contract.
export const SECTION15_ARTIFACT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Sibling of connections/workgraph-health.json, under system/.
const SECTION15_ARTIFACT_RELATIVE_PATH = '_BAC/system/section15.json';

export interface Section15Artifact {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly report: Section15Report;
  // The folded per-day clean ledger this collect produced. Persisted so
  // the next collect can extend the streak instead of re-deriving it
  // (dataLoss.clean is a point-in-time snapshot — the past is not
  // re-readable from the current health surface).
  readonly cleanDays: readonly Section15CleanDayRecord[];
}

export const section15ArtifactPath = (vaultRoot: string): string =>
  join(vaultRoot, SECTION15_ARTIFACT_RELATIVE_PATH);

const writeAtomic = async (path: string, body: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${String(process.pid)}.tmp`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, path);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isCleanDayRecord = (value: unknown): value is Section15CleanDayRecord =>
  isRecord(value) && typeof value['day'] === 'string' && typeof value['clean'] === 'boolean';

// Lenient reader. Missing file / bad JSON / divergent schemaVersion /
// malformed envelope ⇒ null so the route treats the artifact as absent
// and falls back to a live collect. The report is trusted (same-build
// writer; a shape change bumps SECTION15_ARTIFACT_SCHEMA_VERSION), but
// the ledger IS validated element-wise because the collector re-folds
// it: a malformed ledger would silently corrupt the streak.
export const readSection15Artifact = async (
  vaultRoot: string,
): Promise<Section15Artifact | null> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(section15ArtifactPath(vaultRoot), 'utf8'));
    if (!isRecord(parsed)) return null;
    if (parsed['schemaVersion'] !== SECTION15_ARTIFACT_SCHEMA_VERSION) return null;
    if (typeof parsed['generatedAt'] !== 'string') return null;
    const report = parsed['report'];
    if (!isRecord(report) || !Array.isArray(report['criteria'])) return null;
    const rawCleanDays = parsed['cleanDays'];
    const cleanDays = Array.isArray(rawCleanDays) ? rawCleanDays.filter(isCleanDayRecord) : [];
    return {
      schemaVersion: SECTION15_ARTIFACT_SCHEMA_VERSION,
      generatedAt: parsed['generatedAt'],
      report: report as unknown as Section15Report,
      cleanDays,
    };
  } catch {
    return null;
  }
};

// Age gate — an unparseable generatedAt counts as stale (fail toward the
// live fallback, matching the lenient reader).
export const isSection15ArtifactFresh = (
  artifact: Section15Artifact,
  now: () => Date = () => new Date(),
): boolean => {
  const generatedAtMs = Date.parse(artifact.generatedAt);
  if (!Number.isFinite(generatedAtMs)) return false;
  return now().getTime() - generatedAtMs <= SECTION15_ARTIFACT_MAX_AGE_MS;
};

export interface WriteSection15ArtifactOptions {
  readonly vaultRoot: string;
  readonly eventLog?: EventLog;
  // dataLoss.clean at drain time (from the health surface). Folded into
  // the per-day ledger for criterion 6. Undefined ⇒ ledger unchanged
  // (the streak neither advances nor breaks — a collect that couldn't
  // read durability shouldn't fabricate a clean day).
  readonly dataLossClean?: boolean;
  readonly now?: () => Date;
}

// Collect + fold + write in one atomic pass. Returns the written
// artifact so callers (and tests) can assert on it without re-reading.
export const writeSection15Artifact = async (
  options: WriteSection15ArtifactOptions,
): Promise<Section15Artifact> => {
  const now = options.now ?? (() => new Date());
  const prior = await readSection15Artifact(options.vaultRoot);
  const priorCleanDays = prior?.cleanDays ?? [];
  // Fold today's durability observation into the ledger BEFORE collecting
  // so criterion 6 reads the updated streak. Undefined dataLossClean ⇒
  // carry the prior ledger forward untouched.
  const cleanDays =
    options.dataLossClean === undefined
      ? priorCleanDays
      : foldCleanDay(priorCleanDays, { clean: options.dataLossClean, now });
  const report = await collectSection15Report({
    vaultRoot: options.vaultRoot,
    ...(options.eventLog === undefined ? {} : { eventLog: options.eventLog }),
    cleanDays,
    now,
  });
  const artifact: Section15Artifact = {
    schemaVersion: SECTION15_ARTIFACT_SCHEMA_VERSION,
    generatedAt: now().toISOString(),
    report,
    cleanDays,
  };
  await writeAtomic(
    section15ArtifactPath(options.vaultRoot),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  return artifact;
};
