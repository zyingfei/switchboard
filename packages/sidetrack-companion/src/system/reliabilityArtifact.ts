// Drain-time per-surface reliability artifact (north-star §5 S1, P9).
//
// collectReliabilityReport does a typed event read (recall.served +
// recall.action) plus per-surface calibrator fits — cheap, but still not
// something to run on every /v1/system/reliability request on a cold
// process. Same pattern as workGraphHealthArtifact.ts / section15Artifact.ts:
// the connections materializer's onDrainSuccess hook materializes this
// after each successful drain, and GET /v1/system/reliability serves it
// from disk. Drain cadence is the freshness contract.
//
// Same small-JSON state-file discipline: tmp+rename atomic write, lenient
// schemaVersion-checked reader that treats corrupt/mismatched files as
// absent so the route falls back to a live collect.
//
// FREEZE-SAFE (ADR-0011): observability only. No serving consumer reads it.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  collectReliabilityReport,
  type ReliabilityReport,
} from '../calibration/reliabilityCollector.js';
import type { EventLog } from '../sync/eventLog.js';

export const RELIABILITY_ARTIFACT_SCHEMA_VERSION = 1;

// Serve-side freshness bound — identical rationale to the workGraph /
// section15 artifacts: the writer only refreshes while drains succeed AND
// the shared event store is enabled, so bound the served snapshot's age so
// a wedged/disabled writer can't serve a frozen table forever. 24h is
// loose; drain cadence is the real contract.
export const RELIABILITY_ARTIFACT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Sibling of connections/workgraph-health.json and system/section15.json.
const RELIABILITY_ARTIFACT_RELATIVE_PATH = '_BAC/system/reliability.json';

export interface ReliabilityArtifact {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly report: ReliabilityReport;
}

export const reliabilityArtifactPath = (vaultRoot: string): string =>
  join(vaultRoot, RELIABILITY_ARTIFACT_RELATIVE_PATH);

const writeAtomic = async (path: string, body: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${String(process.pid)}.tmp`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, path);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Lenient reader. Missing file / bad JSON / divergent schemaVersion /
// malformed envelope ⇒ null so the route treats the artifact as absent and
// falls back to a live collect. The report is trusted (same-build writer; a
// shape change bumps RELIABILITY_ARTIFACT_SCHEMA_VERSION), so we validate
// only the envelope, mirroring workGraphHealthArtifact's trust boundary.
export const readReliabilityArtifact = async (
  vaultRoot: string,
): Promise<ReliabilityArtifact | null> => {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(reliabilityArtifactPath(vaultRoot), 'utf8'),
    );
    if (!isRecord(parsed)) return null;
    if (parsed['schemaVersion'] !== RELIABILITY_ARTIFACT_SCHEMA_VERSION) return null;
    if (typeof parsed['generatedAt'] !== 'string') return null;
    const report = parsed['report'];
    if (!isRecord(report) || !Array.isArray(report['surfaces'])) return null;
    return {
      schemaVersion: RELIABILITY_ARTIFACT_SCHEMA_VERSION,
      generatedAt: parsed['generatedAt'],
      report: report as unknown as ReliabilityReport,
    };
  } catch {
    return null;
  }
};

// Age gate — an unparseable generatedAt counts as stale (fail toward the
// live fallback, matching the lenient reader).
export const isReliabilityArtifactFresh = (
  artifact: ReliabilityArtifact,
  now: () => Date = () => new Date(),
): boolean => {
  const generatedAtMs = Date.parse(artifact.generatedAt);
  if (!Number.isFinite(generatedAtMs)) return false;
  return now().getTime() - generatedAtMs <= RELIABILITY_ARTIFACT_MAX_AGE_MS;
};

export interface WriteReliabilityArtifactOptions {
  readonly vaultRoot: string;
  readonly eventLog?: EventLog;
  readonly numBins?: number;
  readonly now?: () => Date;
}

// Collect + write in one atomic pass. Returns the written artifact so
// callers (and tests) can assert on it without re-reading.
export const writeReliabilityArtifact = async (
  options: WriteReliabilityArtifactOptions,
): Promise<ReliabilityArtifact> => {
  const now = options.now ?? (() => new Date());
  const report = await collectReliabilityReport({
    vaultRoot: options.vaultRoot,
    ...(options.eventLog === undefined ? {} : { eventLog: options.eventLog }),
    ...(options.numBins === undefined ? {} : { numBins: options.numBins }),
    now,
  });
  const artifact: ReliabilityArtifact = {
    schemaVersion: RELIABILITY_ARTIFACT_SCHEMA_VERSION,
    generatedAt: now().toISOString(),
    report,
  };
  await writeAtomic(
    reliabilityArtifactPath(options.vaultRoot),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  return artifact;
};
