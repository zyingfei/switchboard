import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
// Lightweight on-disk readers for the connections materializer.
//
// The companion vault layout is the source of truth for everything
// except the merged event log and timeline projections, which the
// materializer already has via its EventLog + TimelineStore deps.
//
//   _BAC/threads/<id>.json
//   _BAC/workstreams/<id>.json
//   _BAC/dispatches/<YYYY-MM-DD>.jsonl   ← append-only daily JSONL
//   _BAC/queue/<id>.json
//   _BAC/reminders/<id>.json
//   _BAC/coding/sessions/<id>.json
//
// Dispatches are the only kind written as JSONL (append-only event
// records), so we walk all daily files and dedup by bac_id (last
// row per id wins). Without this, dispatches written through the
// HTTP route never surface in the connections snapshot.
//
// We treat the on-disk records as authoritative when they exist;
// the materializer's reducer merges them with event-derived nodes.
const readJsonDirectory = async (rootPath, relative) => {
    const dir = join(rootPath, relative);
    let entries;
    try {
        entries = (await readdir(dir, { withFileTypes: true }))
            .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
            .map((entry) => entry.name);
    }
    catch {
        return [];
    }
    const out = [];
    for (const name of entries.sort()) {
        try {
            const raw = await readFile(join(dir, name), 'utf8');
            out.push(JSON.parse(raw));
        }
        catch {
            // skip unreadable / malformed files; the materializer's
            // health surface will still report success — partial reads
            // are tolerable for a derived view.
        }
    }
    return out;
};
const readDispatchJsonlDirectory = async (rootPath, relative) => {
    const dir = join(rootPath, relative);
    let entries;
    try {
        entries = (await readdir(dir, { withFileTypes: true }))
            .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/u.test(entry.name))
            .map((entry) => entry.name);
    }
    catch {
        return [];
    }
    const byId = new Map();
    for (const name of entries.sort()) {
        let raw;
        try {
            raw = await readFile(join(dir, name), 'utf8');
        }
        catch {
            continue;
        }
        for (const line of raw.split('\n')) {
            if (line.length === 0)
                continue;
            try {
                const record = JSON.parse(line);
                if (typeof record.bac_id === 'string' && record.bac_id.length > 0) {
                    byId.set(record.bac_id, record);
                }
            }
            catch {
                // malformed line — skip
            }
        }
    }
    return [...byId.values()];
};
export const readVaultStores = async (vaultRoot) => {
    const [threads, workstreams, dispatches, queueItems, reminders, codingSessions] = await Promise.all([
        readJsonDirectory(vaultRoot, '_BAC/threads'),
        readJsonDirectory(vaultRoot, '_BAC/workstreams'),
        readDispatchJsonlDirectory(vaultRoot, '_BAC/dispatches'),
        readJsonDirectory(vaultRoot, '_BAC/queue'),
        readJsonDirectory(vaultRoot, '_BAC/reminders'),
        readJsonDirectory(vaultRoot, '_BAC/coding/sessions'),
    ]);
    return { threads, workstreams, dispatches, queueItems, reminders, codingSessions };
};
export const readAllTimelineDays = async (store) => {
    const dates = await store.listDays();
    const out = [];
    for (const date of dates) {
        const day = await store.readDay(date);
        if (day !== null)
            out.push(day);
    }
    return out;
};
//# sourceMappingURL=loader.js.map