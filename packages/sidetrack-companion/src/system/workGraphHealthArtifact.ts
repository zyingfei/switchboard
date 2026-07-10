// Drain-time workGraph health artifact.
//
// collectWorkGraphHealth is too heavy for the request path on a cold
// process (typed event reads — or two FULL eventLog.readMerged passes
// without SIDETRACK_EVENT_STORE=1 — plus a usearch native load blow
// /v1/system/health's 5s budget, pinning the workGraph section on
// 'unavailable' for the whole-report TTL after every boot). Instead the
// connections materializer's onDrainSuccess hook (runtime/companion.ts)
// materializes the report here after each successful drain and the
// route serves it from disk. Drain cadence is the freshness contract;
// a frozen drain already surfaces as sync.materializers 'failed'.
//
// Same small-JSON state-file pattern as the closest-visit ranker files
// (ranker/onlineLabelLedger.ts): tmp+rename atomic write, lenient
// schemaVersion-checked reader that treats corrupt/mismatched files as
// absent so the caller falls back to the live compute.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { WorkGraphHealthReport } from './workGraphHealth.js';

export const WORKGRAPH_HEALTH_ARTIFACT_SCHEMA_VERSION = 1;

// Serve-side freshness bound. The writer only refreshes this file
// while the shared event store is enabled AND open — one restart
// without SIDETRACK_EVENT_STORE=1 (or with a broken store) stops
// refreshes while drains keep succeeding, so without an age bound the
// route would serve a frozen snapshot forever with every other health
// surface green. 24h is deliberately loose: drain cadence (+ the 30s
// scheduler floor) is the real freshness contract; this bound only
// catches the writer-disabled/wedged case.
export const WORKGRAPH_HEALTH_ARTIFACT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Sibling of diagnostics/latest.json and closest-visit/*.json.
const WORKGRAPH_HEALTH_ARTIFACT_RELATIVE_PATH = '_BAC/connections/workgraph-health.json';

export interface WorkGraphHealthArtifact {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly report: WorkGraphHealthReport;
}

export const workGraphHealthArtifactPath = (vaultRoot: string): string =>
  join(vaultRoot, WORKGRAPH_HEALTH_ARTIFACT_RELATIVE_PATH);

const writeAtomic = async (path: string, body: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${String(process.pid)}.tmp`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, path);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Lenient reader. Missing file / unparseable JSON / divergent
// schemaVersion / malformed envelope ⇒ null so the serve path treats
// the artifact as absent and falls back to the live
// collectWorkGraphHealth — the artifact is an accelerator, never a
// gate.
export const readWorkGraphHealthArtifact = async (
  vaultRoot: string,
): Promise<WorkGraphHealthArtifact | null> => {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(workGraphHealthArtifactPath(vaultRoot), 'utf8'),
    );
    if (!isRecord(parsed)) return null;
    if (parsed['schemaVersion'] !== WORKGRAPH_HEALTH_ARTIFACT_SCHEMA_VERSION) return null;
    if (typeof parsed['generatedAt'] !== 'string') return null;
    const report = parsed['report'];
    if (!isRecord(report)) return null;
    // Trust boundary: the writer is this same companion build. Deep-
    // validating the full report would duplicate WorkGraphHealthReport
    // for zero safety — a shape-divergent producer must bump
    // WORKGRAPH_HEALTH_ARTIFACT_SCHEMA_VERSION instead.
    return {
      schemaVersion: WORKGRAPH_HEALTH_ARTIFACT_SCHEMA_VERSION,
      generatedAt: parsed['generatedAt'],
      report: report as unknown as WorkGraphHealthReport,
    };
  } catch {
    return null;
  }
};

// Kept next to the reader so server.ts never inlines the age math:
// an unparseable generatedAt counts as stale (fail toward the live
// fallback, matching the lenient reader above).
export const isWorkGraphHealthArtifactFresh = (
  artifact: WorkGraphHealthArtifact,
  now: () => Date = () => new Date(),
): boolean => {
  const generatedAtMs = Date.parse(artifact.generatedAt);
  if (!Number.isFinite(generatedAtMs)) return false;
  return now().getTime() - generatedAtMs <= WORKGRAPH_HEALTH_ARTIFACT_MAX_AGE_MS;
};

export const writeWorkGraphHealthArtifact = async (
  vaultRoot: string,
  report: WorkGraphHealthReport,
  now: () => Date = () => new Date(),
): Promise<void> => {
  const artifact: WorkGraphHealthArtifact = {
    schemaVersion: WORKGRAPH_HEALTH_ARTIFACT_SCHEMA_VERSION,
    generatedAt: now().toISOString(),
    report,
  };
  await writeAtomic(
    workGraphHealthArtifactPath(vaultRoot),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
};
