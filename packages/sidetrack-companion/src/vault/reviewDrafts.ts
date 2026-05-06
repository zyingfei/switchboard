import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { ReviewDraftProjection } from '../review/projection.js';

const reviewDraftsDir = (vaultRoot: string): string =>
  join(vaultRoot, '_BAC', 'review-drafts');

const reviewDraftPath = (vaultRoot: string, threadId: string): string =>
  join(reviewDraftsDir(vaultRoot), `${threadId}.json`);

const isMissingError = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

const writeJsonAtomic = async (path: string, value: unknown): Promise<void> => {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const tempPath = join(directory, `.${basename(path)}.${String(process.pid)}.${String(Date.now())}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempPath, path);
};

export const writeReviewDraft = async (
  vaultRoot: string,
  threadId: string,
  projection: ReviewDraftProjection,
): Promise<void> => {
  await writeJsonAtomic(reviewDraftPath(vaultRoot, threadId), projection);
};

export const readReviewDraft = async (
  vaultRoot: string,
  threadId: string,
): Promise<ReviewDraftProjection | null> => {
  try {
    const raw = await readFile(reviewDraftPath(vaultRoot, threadId), 'utf8');
    return JSON.parse(raw) as ReviewDraftProjection;
  } catch (error) {
    if (isMissingError(error)) return null;
    throw error;
  }
};

export const deleteReviewDraft = async (
  vaultRoot: string,
  threadId: string,
): Promise<void> => {
  try {
    await unlink(reviewDraftPath(vaultRoot, threadId));
  } catch (error) {
    if (isMissingError(error)) return;
    throw error;
  }
};

export interface ReviewDraftSummary {
  readonly threadId: string;
  readonly updatedAtMs: number;
  // The projection's version vector. Browsers use it to rebase
  // pending outbox events on the latest server snapshot — and to
  // verify a poll-style change feed is in causal order.
  readonly vector: Readonly<Record<string, number>>;
}

export const listReviewDrafts = async (
  vaultRoot: string,
  sinceMs?: number | null,
): Promise<readonly ReviewDraftSummary[]> => {
  let entries: readonly string[];
  try {
    entries = await readdir(reviewDraftsDir(vaultRoot));
  } catch (error) {
    if (isMissingError(error)) return [];
    throw error;
  }
  const items: ReviewDraftSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const threadId = entry.slice(0, -'.json'.length);
    if (threadId.startsWith('.')) continue;
    let parsed: { readonly updatedAtMs?: unknown; readonly vector?: unknown };
    try {
      const raw = await readFile(join(reviewDraftsDir(vaultRoot), entry), 'utf8');
      parsed = JSON.parse(raw) as { readonly updatedAtMs?: unknown; readonly vector?: unknown };
    } catch {
      continue;
    }
    const updatedAtMs = typeof parsed.updatedAtMs === 'number' ? parsed.updatedAtMs : 0;
    if (sinceMs !== undefined && sinceMs !== null && updatedAtMs <= sinceMs) continue;
    const vector =
      typeof parsed.vector === 'object' && parsed.vector !== null
        ? (parsed.vector as Readonly<Record<string, number>>)
        : {};
    items.push({ threadId, updatedAtMs, vector });
  }
  items.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  return items;
};
