import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { VisitSimilarityRevision } from '../connections/types.js';

const VISIT_SIMILARITY_REVISION_DIR = '_BAC/connections/visit-similarity';

export const visitSimilarityRevisionDir = (vaultRoot: string): string =>
  join(vaultRoot, VISIT_SIMILARITY_REVISION_DIR);

export const visitSimilarityRevisionPath = (vaultRoot: string, revisionId: string): string =>
  join(visitSimilarityRevisionDir(vaultRoot), `${revisionId}.json`);

export const writeVisitSimilarityRevision = async (
  vaultRoot: string,
  revision: VisitSimilarityRevision,
): Promise<void> => {
  const dir = visitSimilarityRevisionDir(vaultRoot);
  await mkdir(dir, { recursive: true });
  const path = visitSimilarityRevisionPath(vaultRoot, revision.revisionId);
  const tmp = join(dir, `${revision.revisionId}.${String(process.pid)}.tmp`);
  await writeFile(tmp, `${JSON.stringify(revision, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isVisitSimilarityRevision = (value: unknown): value is VisitSimilarityRevision => {
  if (!isRecord(value)) return false;
  if (typeof value['revisionId'] !== 'string' || value['revisionId'].length === 0) {
    return false;
  }
  if (value['modelId'] !== 'Xenova/multilingual-e5-small') return false;
  if (typeof value['modelRevision'] !== 'string' || value['modelRevision'].length === 0) {
    return false;
  }
  if (typeof value['featureSchemaVersion'] !== 'number') return false;
  if (typeof value['threshold'] !== 'number' || !Number.isFinite(value['threshold'])) {
    return false;
  }
  if (typeof value['producedAt'] !== 'number' || !Number.isFinite(value['producedAt'])) {
    return false;
  }
  if (!Array.isArray(value['edges'])) return false;
  return value['edges'].every(
    (edge) =>
      isRecord(edge) &&
      typeof edge['fromVisitKey'] === 'string' &&
      typeof edge['toVisitKey'] === 'string' &&
      typeof edge['cosine'] === 'number' &&
      Number.isFinite(edge['cosine']),
  );
};

export const readVisitSimilarityRevision = async (
  vaultRoot: string,
  revisionId: string,
): Promise<VisitSimilarityRevision | null> => {
  try {
    const raw = await readFile(visitSimilarityRevisionPath(vaultRoot, revisionId), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return isVisitSimilarityRevision(parsed) ? parsed : null;
  } catch {
    return null;
  }
};
