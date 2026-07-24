import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
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

// Round-2 corpus-flapping fix (R1/R2). Scan the visit-similarity revision
// store and return the most-recently-written revision whose edge set is
// non-empty. Used by the materializer to (a) REUSE the last good corpus
// when a warm delta-only drain assembles an empty window (so it never
// adopts hash(empty) while a corpus provably exists), and (b) BOOTSTRAP a
// live vault whose served snapshot has already been wiped to zero back to
// the last good persisted revision. The empty-corpus hash is a stable id
// (`f19d…`), so every empty build overwrites the SAME file; the good
// revisions each have distinct ids and survive alongside it. Ordering by
// mtime (not by scanning current.db, which is the wiped surface) is what
// lets the store be the source of truth for recovery.
//
// Boundary validation: each candidate file is parsed as `unknown` and
// validated by `isVisitSimilarityRevision` before it is trusted — a
// corrupt / partial file is skipped, never returned. Best-effort: a dir
// read failure (missing dir on a fresh vault) degrades to `null` so a
// genuinely-empty vault still builds empty legitimately.
export const readLatestNonEmptyVisitSimilarityRevision = async (
  vaultRoot: string,
): Promise<VisitSimilarityRevision | null> => {
  const dir = visitSimilarityRevisionDir(vaultRoot);
  let entries: readonly string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null; // Fresh vault (dir absent) — no persisted corpus to recover.
  }
  // Collect (revisionId, mtimeMs) for every finished revision file. Skip
  // the atomic-write temp files (`<id>.<pid>.tmp`) so we never read a
  // half-written revision mid-flight from a concurrent drain.
  const candidates: { readonly revisionId: string; readonly mtimeMs: number }[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const revisionId = name.slice(0, -'.json'.length);
    if (revisionId.length === 0) continue;
    try {
      const stats = await stat(join(dir, name));
      candidates.push({ revisionId, mtimeMs: stats.mtimeMs });
    } catch {
      // File vanished between readdir and stat (concurrent prune) — skip.
    }
  }
  // Newest first, so the FIRST non-empty revision we successfully parse is
  // the latest good corpus. `readdir` order is unspecified, so sort
  // explicitly rather than relying on it.
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const candidate of candidates) {
    const revision = await readVisitSimilarityRevision(vaultRoot, candidate.revisionId);
    if (revision !== null && revision.edges.length > 0) return revision;
  }
  return null;
};
