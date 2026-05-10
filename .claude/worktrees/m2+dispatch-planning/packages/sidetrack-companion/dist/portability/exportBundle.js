import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { settingsDocumentSchema } from '../http/schemas.js';
import { settingsBundleSchema, templateBundleRecordSchema, workstreamBundleRecordSchema, } from './schemas.js';
const readJson = async (path) => {
    try {
        return JSON.parse(await readFile(path, 'utf8'));
    }
    catch {
        return null;
    }
};
const readRecords = async (root, parse) => {
    const names = await readdir(root).catch(() => []);
    const records = [];
    for (const name of names.filter((candidate) => candidate.endsWith('.json')).sort()) {
        const parsed = parse(await readJson(join(root, name)));
        if (parsed !== null) {
            records.push(parsed);
        }
    }
    return records.sort((left, right) => left.bac_id.localeCompare(right.bac_id));
};
// schemaVersion=1 is the stable portability contract for settings,
// workstream metadata, and dispatch templates only. Vault contents are
// intentionally excluded; future schema bumps must include migration logic.
export const exportSettings = async (vaultRoot) => {
    const settingsRaw = await readJson(join(vaultRoot, '_BAC', '.config', 'settings.json'));
    const settings = settingsDocumentSchema.parse(settingsRaw);
    const workstreams = await readRecords(join(vaultRoot, '_BAC', 'workstreams'), (value) => {
        const parsed = workstreamBundleRecordSchema.safeParse(value);
        return parsed.success ? parsed.data : null;
    });
    const templates = await readRecords(join(vaultRoot, '_BAC', 'templates'), (value) => {
        const parsed = templateBundleRecordSchema.safeParse(value);
        return parsed.success ? parsed.data : null;
    });
    return settingsBundleSchema.parse({
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        settings,
        workstreams,
        templates,
    });
};
//# sourceMappingURL=exportBundle.js.map