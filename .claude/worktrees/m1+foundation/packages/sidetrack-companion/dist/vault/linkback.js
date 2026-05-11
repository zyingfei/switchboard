import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';
const MAX_NOTE_BYTES = 1024 * 1024;
export const nodeFsPort = {
    readdir: (path) => readdir(path, { withFileTypes: true }),
    lstat,
    stat,
    readFile: (path) => readFile(path, 'utf8'),
};
const isHiddenPathPart = (path) => path.split('/').some((part) => part.startsWith('.') && part.length > 1);
const parseFrontmatter = (raw) => {
    if (!raw.startsWith('---\n')) {
        return null;
    }
    const end = raw.indexOf('\n---', 4);
    if (end < 0) {
        return null;
    }
    const frontmatter = raw.slice(4, end);
    const parsed = {};
    for (const line of frontmatter.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith('#')) {
            continue;
        }
        const separator = trimmed.indexOf(':');
        if (separator <= 0) {
            return null;
        }
        const key = trimmed.slice(0, separator).trim();
        const value = trimmed
            .slice(separator + 1)
            .trim()
            .replace(/^["']|["']$/gu, '');
        parsed[key] = value;
    }
    return parsed;
};
export const scanVaultForLinkedNotes = async (vaultRoot, fs = nodeFsPort) => {
    const root = resolve(vaultRoot);
    const results = [];
    const walk = async (directory) => {
        let entries;
        try {
            entries = await fs.readdir(directory);
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (entry.name === '_BAC' || entry.name.startsWith('.')) {
                continue;
            }
            const path = resolve(directory, entry.name);
            const relativePath = relative(root, path);
            if (relativePath.startsWith('..') || isHiddenPathPart(relativePath)) {
                continue;
            }
            const linkStat = await fs.lstat(path).catch(() => undefined);
            if (linkStat?.isSymbolicLink() !== false) {
                continue;
            }
            if (entry.isDirectory()) {
                await walk(path);
                continue;
            }
            if (!entry.isFile() || !entry.name.endsWith('.md')) {
                continue;
            }
            const fileStat = await fs.stat(path).catch(() => undefined);
            if (fileStat === undefined || fileStat.size > MAX_NOTE_BYTES) {
                continue;
            }
            const frontmatter = parseFrontmatter(await fs.readFile(path).catch(() => ''));
            const workstreamId = frontmatter?.['bac_workstream'];
            if (typeof workstreamId !== 'string' || workstreamId.trim().length === 0) {
                continue;
            }
            results.push({
                workstreamId: workstreamId.trim(),
                notePath: relativePath,
                title: typeof frontmatter?.['title'] === 'string' && frontmatter['title'].trim().length > 0
                    ? frontmatter['title'].trim()
                    : basename(entry.name, '.md'),
                updatedAt: fileStat.mtime.toISOString(),
            });
        }
    };
    await walk(root);
    return results.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
};
//# sourceMappingURL=linkback.js.map