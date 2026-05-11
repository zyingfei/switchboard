import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export const workstreamWriteTools = [
    'bac.move_item',
    'bac.queue_item',
    'bac.bump_workstream',
    'bac.archive_thread',
    'bac.unarchive_thread',
];
const isWorkstreamWriteTool = (value) => typeof value === 'string' &&
    workstreamWriteTools.some((candidate) => candidate === value);
const trustPath = (vaultRoot) => join(vaultRoot, '_BAC', 'trust.json');
export const readTrust = async (vaultRoot) => {
    try {
        const parsed = JSON.parse(await readFile(trustPath(vaultRoot), 'utf8'));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return [];
        }
        const list = parsed.workstreams;
        if (!Array.isArray(list)) {
            return [];
        }
        return list.flatMap((item) => {
            if (typeof item !== 'object' || item === null || Array.isArray(item)) {
                return [];
            }
            const record = item;
            if (typeof record.workstreamId !== 'string' || !Array.isArray(record.allowedTools)) {
                return [];
            }
            return [
                {
                    workstreamId: record.workstreamId,
                    allowedTools: new Set(record.allowedTools.filter(isWorkstreamWriteTool)),
                },
            ];
        });
    }
    catch {
        return [];
    }
};
export const writeTrust = async (vaultRoot, list) => {
    const serializable = {
        workstreams: list.map((record) => ({
            workstreamId: record.workstreamId,
            allowedTools: [...record.allowedTools],
        })),
    };
    await mkdir(join(vaultRoot, '_BAC'), { recursive: true });
    await writeFile(trustPath(vaultRoot), `${JSON.stringify(serializable, null, 2)}\n`, 'utf8');
};
export const isAllowed = (workstreamId, tool, list) => list.find((record) => record.workstreamId === workstreamId)?.allowedTools.has(tool) ?? false;
//# sourceMappingURL=workstreamTrust.js.map