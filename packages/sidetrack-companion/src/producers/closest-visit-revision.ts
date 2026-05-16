import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { FEATURE_SCHEMA_VERSION } from '../ranker/feature-schema.js';
import {
  RANKER_MODEL_VERSION,
  type RankerRevision,
  type RankerTrainQuality,
} from '../ranker/train.js';

const CLOSEST_VISIT_REVISION_DIR = '_BAC/connections/closest-visit';

export interface ClosestVisitRankerRevisionManifest {
  readonly revisionId: string;
  readonly modelVersion: RankerRevision['modelVersion'];
  readonly featureSchemaVersion: RankerRevision['featureSchemaVersion'];
  readonly trainingDatasetHash: string;
  readonly trainedAt: number;
  readonly modelByteLength: number;
  readonly modelSha256: string;
  /**
   * Optional train-time observability. Absent on manifests written
   * before this field existed; readers must treat it as best-effort.
   * Its presence/absence never gates scoring (featureSchemaVersion is
   * unchanged) so the refuse-to-score invariant is preserved.
   */
  readonly trainQuality?: RankerTrainQuality;
}

export interface ClosestVisitRankerRevisionManifestProbe {
  readonly revisionId: string | null;
  readonly activeModelVersion: string | null;
  readonly expectedModelVersion: typeof RANKER_MODEL_VERSION;
  readonly activeFeatureSchemaVersion: number | null;
  readonly expectedFeatureSchemaVersion: typeof FEATURE_SCHEMA_VERSION;
  readonly staleModelSchema: boolean;
}

export const expectedClosestVisitRankerSchema = {
  modelVersion: RANKER_MODEL_VERSION,
  featureSchemaVersion: FEATURE_SCHEMA_VERSION,
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const toOwnedArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
};

const modelBytesFor = (revision: RankerRevision): Uint8Array => new Uint8Array(revision.modelBytes);

export const closestVisitRevisionDir = (vaultRoot: string): string =>
  join(vaultRoot, CLOSEST_VISIT_REVISION_DIR);

export const closestVisitRevisionManifestPath = (vaultRoot: string, revisionId: string): string =>
  join(closestVisitRevisionDir(vaultRoot), `${revisionId}.json`);

export const closestVisitRevisionModelPath = (vaultRoot: string, revisionId: string): string =>
  join(closestVisitRevisionDir(vaultRoot), `${revisionId}.model.b64`);

export const activeClosestVisitRevisionManifestPath = (vaultRoot: string): string =>
  join(closestVisitRevisionDir(vaultRoot), 'current.json');

const manifestForRevision = (revision: RankerRevision): ClosestVisitRankerRevisionManifest => {
  const modelBytes = modelBytesFor(revision);
  return {
    revisionId: revision.revisionId,
    modelVersion: revision.modelVersion,
    featureSchemaVersion: revision.featureSchemaVersion,
    trainingDatasetHash: revision.trainingDatasetHash,
    trainedAt: revision.trainedAt,
    modelByteLength: modelBytes.byteLength,
    modelSha256: sha256Hex(modelBytes),
    ...(revision.trainQuality === undefined ? {} : { trainQuality: revision.trainQuality }),
  };
};

const writeAtomic = async (path: string, body: string): Promise<void> => {
  await mkdir(join(path, '..'), { recursive: true });
  const tmp = `${path}.${String(process.pid)}.tmp`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, path);
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const stringOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const isGradeHistogram = (value: unknown): value is RankerTrainQuality['gradeHistogram'] => {
  if (!isRecord(value)) return false;
  return (['0', '1', '2', '3', '4'] as const).every(
    (grade) =>
      typeof value[grade] === 'number' && Number.isInteger(value[grade]) && value[grade] >= 0,
  );
};

// Lenient: a malformed `trainQuality` is pure observability, so it is
// dropped rather than failing the whole manifest. A manifest without
// `trainQuality` (older writers) is also valid — returns undefined.
const normalizeTrainQuality = (value: unknown): RankerTrainQuality | undefined => {
  if (!isRecord(value)) return undefined;
  if (!isGradeHistogram(value['gradeHistogram'])) return undefined;
  const spreadRaw = value['scoreSpread'];
  const spread =
    isRecord(spreadRaw) &&
    isFiniteNumber(spreadRaw['p05']) &&
    isFiniteNumber(spreadRaw['p50']) &&
    isFiniteNumber(spreadRaw['p95']) &&
    isFiniteNumber(spreadRaw['stdDev']) &&
    isFiniteNumber(spreadRaw['distinctRatio'])
      ? {
          p05: spreadRaw['p05'],
          p50: spreadRaw['p50'],
          p95: spreadRaw['p95'],
          stdDev: spreadRaw['stdDev'],
          distinctRatio: spreadRaw['distinctRatio'],
        }
      : undefined;
  const metricRaw = value['inSampleMetric'];
  const metric =
    isRecord(metricRaw) &&
    typeof metricRaw['kind'] === 'string' &&
    isFiniteNumber(metricRaw['value'])
      ? { kind: metricRaw['kind'], value: metricRaw['value'] }
      : undefined;
  return {
    gradeHistogram: value['gradeHistogram'],
    ...(spread === undefined ? {} : { scoreSpread: spread }),
    ...(metric === undefined ? {} : { inSampleMetric: metric }),
  };
};

// Pinned to the *current* ranker constants (not inline literals): a
// manifest persisted under an older model version or feature-schema
// version fails validation, so `readClosestVisitRankerRevision`
// returns null and the caller treats it as "no usable model" and
// retrains. This is the back-compat gate — it prevents handing a
// stale-feature-count booster a wider feature row (which LightGBM
// would silently mis-score or the contribution decoder would throw
// on).
const isManifest = (value: unknown): value is ClosestVisitRankerRevisionManifest => {
  if (!isRecord(value)) return false;
  return (
    typeof value['revisionId'] === 'string' &&
    value['revisionId'].length > 0 &&
    value['modelVersion'] === RANKER_MODEL_VERSION &&
    value['featureSchemaVersion'] === FEATURE_SCHEMA_VERSION &&
    typeof value['trainingDatasetHash'] === 'string' &&
    /^[a-f0-9]{64}$/u.test(value['trainingDatasetHash']) &&
    typeof value['trainedAt'] === 'number' &&
    Number.isFinite(value['trainedAt']) &&
    typeof value['modelByteLength'] === 'number' &&
    Number.isInteger(value['modelByteLength']) &&
    value['modelByteLength'] >= 0 &&
    typeof value['modelSha256'] === 'string' &&
    /^[a-f0-9]{64}$/u.test(value['modelSha256'])
  );
};

// Coerce a validated manifest record into the typed shape, normalizing
// the optional `trainQuality` (drop if malformed/absent).
const finalizeManifest = (
  value: ClosestVisitRankerRevisionManifest,
): ClosestVisitRankerRevisionManifest => {
  const trainQuality = normalizeTrainQuality(
    (value as { readonly trainQuality?: unknown }).trainQuality,
  );
  if (trainQuality === undefined) {
    return {
      revisionId: value.revisionId,
      modelVersion: value.modelVersion,
      featureSchemaVersion: value.featureSchemaVersion,
      trainingDatasetHash: value.trainingDatasetHash,
      trainedAt: value.trainedAt,
      modelByteLength: value.modelByteLength,
      modelSha256: value.modelSha256,
    };
  }
  return { ...value, trainQuality };
};

export const readClosestVisitRankerRevisionManifest = async (
  vaultRoot: string,
  revisionId: string,
): Promise<ClosestVisitRankerRevisionManifest | null> => {
  try {
    const parsed = JSON.parse(
      await readFile(closestVisitRevisionManifestPath(vaultRoot, revisionId), 'utf8'),
    ) as unknown;
    return isManifest(parsed) ? finalizeManifest(parsed) : null;
  } catch {
    return null;
  }
};

export const readActiveClosestVisitRankerRevisionManifest = async (
  vaultRoot: string,
): Promise<ClosestVisitRankerRevisionManifest | null> => {
  try {
    const parsed = JSON.parse(
      await readFile(activeClosestVisitRevisionManifestPath(vaultRoot), 'utf8'),
    ) as unknown;
    return isManifest(parsed) ? finalizeManifest(parsed) : null;
  } catch {
    return null;
  }
};

export const readActiveClosestVisitRankerRevisionManifestProbe = async (
  vaultRoot: string,
): Promise<ClosestVisitRankerRevisionManifestProbe | null> => {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(activeClosestVisitRevisionManifestPath(vaultRoot), 'utf8'),
    );
    if (!isRecord(parsed)) {
      return {
        revisionId: null,
        activeModelVersion: null,
        expectedModelVersion: RANKER_MODEL_VERSION,
        activeFeatureSchemaVersion: null,
        expectedFeatureSchemaVersion: FEATURE_SCHEMA_VERSION,
        staleModelSchema: false,
      };
    }
    const activeModelVersion = stringOrNull(parsed['modelVersion']);
    const activeFeatureSchemaVersion = numberOrNull(parsed['featureSchemaVersion']);
    return {
      revisionId: stringOrNull(parsed['revisionId']),
      activeModelVersion,
      expectedModelVersion: RANKER_MODEL_VERSION,
      activeFeatureSchemaVersion,
      expectedFeatureSchemaVersion: FEATURE_SCHEMA_VERSION,
      staleModelSchema:
        (activeModelVersion !== null && activeModelVersion !== RANKER_MODEL_VERSION) ||
        (activeFeatureSchemaVersion !== null &&
          activeFeatureSchemaVersion !== FEATURE_SCHEMA_VERSION),
    };
  } catch {
    return null;
  }
};

export const writeClosestVisitRankerRevision = async (
  vaultRoot: string,
  revision: RankerRevision,
): Promise<void> => {
  const dir = closestVisitRevisionDir(vaultRoot);
  await mkdir(dir, { recursive: true });
  const manifest = manifestForRevision(revision);
  await writeAtomic(
    closestVisitRevisionManifestPath(vaultRoot, revision.revisionId),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeAtomic(
    closestVisitRevisionModelPath(vaultRoot, revision.revisionId),
    `${Buffer.from(modelBytesFor(revision)).toString('base64')}\n`,
  );
};

export const writeActiveClosestVisitRankerRevision = async (
  vaultRoot: string,
  revision: RankerRevision,
): Promise<void> => {
  await writeClosestVisitRankerRevision(vaultRoot, revision);
  await writeAtomic(
    activeClosestVisitRevisionManifestPath(vaultRoot),
    `${JSON.stringify(manifestForRevision(revision), null, 2)}\n`,
  );
};

export const readClosestVisitRankerRevision = async (
  vaultRoot: string,
  revisionId: string,
): Promise<RankerRevision | null> => {
  const manifest = await readClosestVisitRankerRevisionManifest(vaultRoot, revisionId);
  if (manifest === null) return null;
  try {
    const bytes = Buffer.from(
      (await readFile(closestVisitRevisionModelPath(vaultRoot, revisionId), 'utf8')).trim(),
      'base64',
    );
    if (
      bytes.byteLength !== manifest.modelByteLength ||
      sha256Hex(bytes) !== manifest.modelSha256
    ) {
      return null;
    }
    return {
      revisionId: manifest.revisionId,
      modelVersion: manifest.modelVersion,
      featureSchemaVersion: manifest.featureSchemaVersion,
      trainingDatasetHash: manifest.trainingDatasetHash,
      trainedAt: manifest.trainedAt,
      modelBytes: toOwnedArrayBuffer(bytes),
      ...(manifest.trainQuality === undefined ? {} : { trainQuality: manifest.trainQuality }),
    };
  } catch {
    return null;
  }
};

export const listClosestVisitRankerRevisionIds = async (
  vaultRoot: string,
): Promise<readonly string[]> => {
  const entries = await readdir(closestVisitRevisionDir(vaultRoot)).catch(
    () => [] as readonly string[],
  );
  return entries
    .filter((name) => name.endsWith('.json') && name !== 'current.json')
    .map((name) => name.replace(/\.json$/u, ''))
    .sort();
};
