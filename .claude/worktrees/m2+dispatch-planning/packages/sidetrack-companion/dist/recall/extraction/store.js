import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRevision } from '../../domain/ids.js';
// Sync Contract v1 / Class E — extraction store layout.
//
//   _BAC/extractions/
//     sources/<base64url(sourceUnitId)>.json     ← active revision pointer + status + history
//     revisions/<extractionRevisionId>.json       ← full revision content
//
// The sources/<id> file is the durable signal recall reads to
// decide whether to source-replace its index — the pointer split
// between `latestExtractionRevision` (declared by the extraction
// materializer) and `indexedExtractionRevision` (echoed by recall
// after replaceEntriesForSourceUnit succeeds) makes "I owe a
// source-scoped update" observable across crashes.
//
// All writes go through .tmp + rename for atomicity. Reads silently
// return null on missing/corrupt files; the materializer recovers
// from the event log.
const SOURCES_DIR = 'sources';
const REVISIONS_DIR = 'revisions';
// Filesystem-safe encoding for sourceUnitId (which contains : and /).
const encodeSourceUnitId = (id) => Buffer.from(id, 'utf8').toString('base64url');
export const createExtractionStore = (vaultRoot) => {
    const root = join(vaultRoot, '_BAC', 'extractions');
    const sourcesDir = join(root, SOURCES_DIR);
    const revisionsDir = join(root, REVISIONS_DIR);
    const writeAtomic = async (path, body) => {
        await mkdir(join(path, '..'), { recursive: true });
        const tmp = `${path}.${createRevision()}.tmp`;
        await writeFile(tmp, body, 'utf8');
        await rename(tmp, path);
    };
    const sourcePath = (id) => join(sourcesDir, `${encodeSourceUnitId(id)}.json`);
    const revisionPath = (id) => join(revisionsDir, `${id}.json`);
    const readJsonOrNull = async (path) => {
        try {
            const raw = await readFile(path, 'utf8');
            return JSON.parse(raw);
        }
        catch {
            return null;
        }
    };
    const putRevision = async (revision) => {
        await writeAtomic(revisionPath(revision.extractionRevisionId), JSON.stringify(revision, null, 2));
    };
    const readRevision = async (id) => readJsonOrNull(revisionPath(id));
    const putSourceState = async (state) => {
        await writeAtomic(sourcePath(state.sourceUnitId), JSON.stringify(state, null, 2));
    };
    const readSourceState = async (id) => readJsonOrNull(sourcePath(id));
    const listAllSources = async () => {
        const files = await readdir(sourcesDir).catch(() => []);
        const out = [];
        for (const name of files) {
            if (!name.endsWith('.json'))
                continue;
            const state = await readJsonOrNull(join(sourcesDir, name));
            if (state !== null)
                out.push(state);
        }
        return out;
    };
    const listStaleSources = async () => {
        const all = await listAllSources();
        return all.filter((s) => s.status === 'stale');
    };
    const markIndexed = async (id, extractionRevisionId) => {
        const state = await readSourceState(id);
        if (state === null)
            return;
        if (state.latestExtractionRevision !== extractionRevisionId) {
            // Caller indexed an older revision; the latest is still stale.
            // Update indexed pointer but keep status='stale'.
            await putSourceState({
                ...state,
                indexedExtractionRevision: extractionRevisionId,
            });
            return;
        }
        await putSourceState({
            ...state,
            indexedExtractionRevision: extractionRevisionId,
            status: 'current',
        });
    };
    return {
        putRevision,
        readRevision,
        putSourceState,
        readSourceState,
        listStaleSources,
        listAllSources,
        markIndexed,
    };
};
//# sourceMappingURL=store.js.map