import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { RankerRevision } from '../ranker/train.js';

const CLOSEST_VISIT_REVISION_DIR = '_BAC/connections/closest-visit';

export interface ClosestVisitRankerRevisionManifest {
  readonly revisionId: string;
  readonly modelVersion: RankerRevision['modelVersion'];
  readonly featureSchemaVersion: RankerRevision['featureSchemaVersion'];
  readonly trainingDatasetHash: string;
  readonly trainedAt: number;
  readonly modelByteLength: number;
  readonly modelSha256: string;
}

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
  };
};

const writeAtomic = async (path: string, body: string): Promise<void> => {
  await mkdir(join(path, '..'), { recursive: true });
  const tmp = `${path}.${String(process.pid)}.tmp`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, path);
};

const isManifest = (value: unknown): value is ClosestVisitRankerRevisionManifest => {
  if (!isRecord(value)) return false;
  return (
    typeof value['revisionId'] === 'string' &&
    value['revisionId'].length > 0 &&
    value['modelVersion'] === 'lightgbm-lambdamart-v1' &&
    value['featureSchemaVersion'] === 1 &&
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

export const readClosestVisitRankerRevisionManifest = async (
  vaultRoot: string,
  revisionId: string,
): Promise<ClosestVisitRankerRevisionManifest | null> => {
  try {
    const parsed = JSON.parse(
      await readFile(closestVisitRevisionManifestPath(vaultRoot, revisionId), 'utf8'),
    ) as unknown;
    return isManifest(parsed) ? parsed : null;
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
    return isManifest(parsed) ? parsed : null;
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
