import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
const reviewDraftsDir = (vaultRoot) => join(vaultRoot, '_BAC', 'review-drafts');
const reviewDraftPath = (vaultRoot, threadId) => join(reviewDraftsDir(vaultRoot), `${threadId}.json`);
const isMissingError = (error) => error instanceof Error && 'code' in error && error.code === 'ENOENT';
const writeJsonAtomic = async (path, value) => {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true });
    const tempPath = join(directory, `.${basename(path)}.${String(process.pid)}.${String(Date.now())}.tmp`);
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(tempPath, path);
};
export const writeReviewDraft = async (vaultRoot, threadId, projection) => {
    await writeJsonAtomic(reviewDraftPath(vaultRoot, threadId), projection);
};
export const readReviewDraft = async (vaultRoot, threadId) => {
    try {
        const raw = await readFile(reviewDraftPath(vaultRoot, threadId), 'utf8');
        return JSON.parse(raw);
    }
    catch (error) {
        if (isMissingError(error))
            return null;
        throw error;
    }
};
export const deleteReviewDraft = async (vaultRoot, threadId) => {
    try {
        await unlink(reviewDraftPath(vaultRoot, threadId));
    }
    catch (error) {
        if (isMissingError(error))
            return;
        throw error;
    }
};
export const listReviewDrafts = async (vaultRoot, sinceMs) => {
    let entries;
    try {
        entries = await readdir(reviewDraftsDir(vaultRoot));
    }
    catch (error) {
        if (isMissingError(error))
            return [];
        throw error;
    }
    const items = [];
    for (const entry of entries) {
        if (!entry.endsWith('.json'))
            continue;
        const threadId = entry.slice(0, -'.json'.length);
        if (threadId.startsWith('.'))
            continue;
        let parsed;
        try {
            const raw = await readFile(join(reviewDraftsDir(vaultRoot), entry), 'utf8');
            parsed = JSON.parse(raw);
        }
        catch {
            continue;
        }
        const updatedAtMs = typeof parsed.updatedAtMs === 'number' ? parsed.updatedAtMs : 0;
        if (sinceMs !== undefined && sinceMs !== null && updatedAtMs <= sinceMs)
            continue;
        const vector = typeof parsed.vector === 'object' && parsed.vector !== null
            ? parsed.vector
            : {};
        items.push({ threadId, updatedAtMs, vector });
    }
    items.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    return items;
};
//# sourceMappingURL=reviewDrafts.js.map