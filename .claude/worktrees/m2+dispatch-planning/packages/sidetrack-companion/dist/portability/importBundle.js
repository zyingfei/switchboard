import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { settingsBundleSchema, } from './schemas.js';
const exists = async (path) => {
    try {
        await access(path);
        return true;
    }
    catch {
        return false;
    }
};
const writeJson = async (path, value) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};
const importRecords = async (root, kind, records) => {
    let applied = 0;
    const conflicts = [];
    for (const record of records) {
        const path = join(root, `${record.bac_id}.json`);
        if (await exists(path)) {
            conflicts.push({ kind, bac_id: record.bac_id, reason: 'already_exists' });
            continue;
        }
        await writeJson(path, record);
        applied += 1;
    }
    return { applied, conflicts };
};
export const importSettings = async (vaultRoot, input) => {
    const bundle = settingsBundleSchema.parse(input);
    let applied = 0;
    const conflicts = [];
    await writeJson(join(vaultRoot, '_BAC', '.config', 'settings.json'), bundle.settings);
    applied += 1;
    const workstreams = await importRecords(join(vaultRoot, '_BAC', 'workstreams'), 'workstream', bundle.workstreams);
    applied += workstreams.applied;
    conflicts.push(...workstreams.conflicts);
    const templates = await importRecords(join(vaultRoot, '_BAC', 'templates'), 'template', bundle.templates);
    applied += templates.applied;
    conflicts.push(...templates.conflicts);
    return { applied, skipped: conflicts.length, conflicts };
};
//# sourceMappingURL=importBundle.js.map