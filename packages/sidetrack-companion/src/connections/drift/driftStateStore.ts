// Connections drift layer — detector-state persistence.
//
// The change detectors are stateful: ADWIN/KSWIN windows and the
// temporal-silhouette series must survive across materializer drains
// (each drain is one observation per signal). This store persists a
// small JSON blob using the same atomic temp-write + rename pattern as
// `materializerDiagnostics.ts` / `writeShadowTopicRevision`.
//
// The state is a rebuildable cache: on a missing or corrupt file the
// reader returns null and the monitor starts fresh. Like the existing
// diagnostics artifact, *no* I/O path here is allowed to throw into the
// drain — both read and write swallow errors and degrade to "no
// persisted state" / "state not written this drain".

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AdwinState } from './adwin.js';
import type { KswinState } from './kswin.js';
import type { TemporalSilhouetteState } from './temporalSilhouette.js';

export const DRIFT_STATE_SCHEMA_VERSION = 1;

const DRIFT_STATE_RELATIVE_DIR = '_BAC/connections/diagnostics';
const DRIFT_STATE_FILENAME = 'drift-state.json';

export interface PersistedSignalDetectors {
  readonly adwin: AdwinState;
  readonly kswin: KswinState;
}

export interface DriftPersistedState {
  readonly schemaVersion: typeof DRIFT_STATE_SCHEMA_VERSION;
  readonly updatedAt: string;
  /** Detector pair per signal name. */
  readonly signals: Readonly<Record<string, PersistedSignalDetectors>>;
  readonly silhouette: TemporalSilhouetteState;
}

export interface DriftStateStore {
  readonly read: () => Promise<DriftPersistedState | null>;
  readonly write: (state: DriftPersistedState) => Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Shape-check only the envelope. Individual detector states are
// re-validated by their own `fromState` guards, so a partially corrupt
// signal degrades to a fresh detector rather than discarding the whole
// blob.
const isDriftPersistedState = (value: unknown): value is DriftPersistedState => {
  if (!isRecord(value)) return false;
  if (value['schemaVersion'] !== DRIFT_STATE_SCHEMA_VERSION) return false;
  if (typeof value['updatedAt'] !== 'string') return false;
  if (!isRecord(value['signals'])) return false;
  if (!isRecord(value['silhouette'])) return false;
  return true;
};

export const createDriftStateStore = (vaultRoot: string): DriftStateStore => {
  const dir = join(vaultRoot, DRIFT_STATE_RELATIVE_DIR);
  const path = join(dir, DRIFT_STATE_FILENAME);

  const read = async (): Promise<DriftPersistedState | null> => {
    try {
      const raw = await readFile(path, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      return isDriftPersistedState(parsed) ? parsed : null;
    } catch {
      // Missing file / parse error / IO error — rebuildable cache, so
      // a fresh start is correct and must never fail the drain.
      return null;
    }
  };

  const write = async (state: DriftPersistedState): Promise<void> => {
    await mkdir(dir, { recursive: true });
    const body = `${JSON.stringify(state, null, 2)}\n`;
    const tmpPath = `${path}.${String(process.pid)}.${String(Date.now())}.tmp`;
    await writeFile(tmpPath, body, 'utf8');
    await rename(tmpPath, path);
  };

  return { read, write };
};
