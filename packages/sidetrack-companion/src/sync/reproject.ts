import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AcceptedEvent } from './causal.js';
import type { EventLog } from './eventLog.js';
import type { ProjectionChangeFeed } from './projectionChanges.js';
import { runImportProjectors } from './projectors.js';

// Bumped whenever a projector's output shape changes (new field,
// renamed field, fixed bug that altered the projection content). The
// startup pass compares this to the version recorded on disk and
// re-runs every projector if they diverge — guaranteeing that
// projection files always reflect the current projector logic, not
// whatever logic ran when the file was last written.
//
// Bump rules:
//   - bump the integer when ANY projection's output shape changes.
//   - never decrement (older companions reading newer projection files
//     are out of scope; users upgrade companion + extension together).
export const PROJECTOR_VERSION = 1;

const VERSION_FILE_REL = '_BAC/.projector-version';

interface VersionFile {
  readonly version: number;
  readonly writtenAt: string;
}

const readVersionFile = async (vaultRoot: string): Promise<number | null> => {
  try {
    const raw = await readFile(join(vaultRoot, ...VERSION_FILE_REL.split('/')), 'utf8');
    const parsed = JSON.parse(raw) as VersionFile;
    return typeof parsed.version === 'number' ? parsed.version : null;
  } catch {
    return null;
  }
};

const writeVersionFile = async (vaultRoot: string, version: number): Promise<void> => {
  const file = join(vaultRoot, ...VERSION_FILE_REL.split('/'));
  await mkdir(join(vaultRoot, '_BAC'), { recursive: true });
  const body: VersionFile = { version, writtenAt: new Date().toISOString() };
  await writeFile(file, JSON.stringify(body, null, 2), 'utf8');
};

// Pick the most recent event per aggregateId — runImportProjectors
// reads the merged log per aggregate, so feeding it the latest event
// for each aggregate is sufficient to re-emit the canonical projection
// file. Earlier events for the same aggregate would re-do the same
// work redundantly.
const latestPerAggregate = (events: readonly AcceptedEvent[]): readonly AcceptedEvent[] => {
  const byId = new Map<string, AcceptedEvent>();
  for (const event of events) {
    const prior = byId.get(event.aggregateId);
    if (prior === undefined) {
      byId.set(event.aggregateId, event);
      continue;
    }
    if (event.acceptedAtMs >= prior.acceptedAtMs) {
      byId.set(event.aggregateId, event);
    }
  }
  return [...byId.values()];
};

export interface ReprojectOnVersionMismatchDeps {
  readonly vaultRoot: string;
  readonly eventLog: EventLog;
  readonly projectionChanges?: ProjectionChangeFeed;
}

export interface ReprojectResult {
  readonly ranReproject: boolean;
  readonly priorVersion: number | null;
  readonly currentVersion: number;
  readonly aggregateCount: number;
}

// Idempotent. If the disk-recorded projector version equals
// PROJECTOR_VERSION, this is a noop. Otherwise it walks the merged
// log, runs `runImportProjectors` for the latest event of each
// aggregate, and writes the new version sentinel.
export const reprojectOnVersionMismatch = async (
  deps: ReprojectOnVersionMismatchDeps,
): Promise<ReprojectResult> => {
  const priorVersion = await readVersionFile(deps.vaultRoot);
  if (priorVersion === PROJECTOR_VERSION) {
    return {
      ranReproject: false,
      priorVersion,
      currentVersion: PROJECTOR_VERSION,
      aggregateCount: 0,
    };
  }
  const merged = await deps.eventLog.readMerged();
  const latest = latestPerAggregate(merged);
  for (const event of latest) {
    await runImportProjectors(
      {
        vaultRoot: deps.vaultRoot,
        eventLog: deps.eventLog,
        ...(deps.projectionChanges === undefined
          ? {}
          : { projectionChanges: deps.projectionChanges }),
      },
      event,
    ).catch(() => undefined);
  }
  await writeVersionFile(deps.vaultRoot, PROJECTOR_VERSION);
  return {
    ranReproject: true,
    priorVersion,
    currentVersion: PROJECTOR_VERSION,
    aggregateCount: latest.length,
  };
};
