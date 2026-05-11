import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createBacId, createRevision } from '../domain/ids.js';
import { serializedAnchorSchema } from '../http/schemas.js';
const yamlString = (value) => JSON.stringify(value);
const writeAtomic = async (path, body) => {
    await mkdir(dirname(path), { recursive: true });
    const tempPath = join(dirname(path), `.${basename(path)}.${createRevision()}.tmp`);
    await writeFile(tempPath, body, 'utf8');
    await rename(tempPath, path);
};
const renderAnnotation = (annotation) => [
    '---',
    `bac_id: ${annotation.bac_id}`,
    `url: ${yamlString(annotation.url)}`,
    `pageTitle: ${yamlString(annotation.pageTitle)}`,
    `createdAt: ${annotation.createdAt}`,
    `updatedAt: ${annotation.updatedAt}`,
    `deletedAt: ${annotation.deletedAt === null ? 'null' : yamlString(annotation.deletedAt)}`,
    `revisions: ${yamlString(JSON.stringify(annotation.revisions))}`,
    '---',
    '```sidetrack-anchor+json',
    JSON.stringify(annotation.anchor, null, 2),
    '```',
    '',
    annotation.note,
].join('\n');
const parseFrontmatterValue = (frontmatter, key) => {
    const line = frontmatter.split('\n').find((candidate) => candidate.startsWith(`${key}:`));
    if (line === undefined) {
        return undefined;
    }
    const raw = line.slice(key.length + 1).trim();
    try {
        return JSON.parse(raw);
    }
    catch {
        return raw;
    }
};
const parseAnnotation = (raw) => {
    if (!raw.startsWith('---\n')) {
        return null;
    }
    const frontmatterEnd = raw.indexOf('\n---', 4);
    if (frontmatterEnd < 0) {
        return null;
    }
    const frontmatter = raw.slice(4, frontmatterEnd);
    const body = raw.slice(frontmatterEnd + 5).trimStart();
    const fenceStart = body.indexOf('```sidetrack-anchor+json');
    if (fenceStart !== 0) {
        return null;
    }
    const jsonStart = body.indexOf('\n', fenceStart);
    const fenceEnd = body.indexOf('\n```', jsonStart);
    if (jsonStart < 0 || fenceEnd < 0) {
        return null;
    }
    const anchor = serializedAnchorSchema.safeParse(JSON.parse(body.slice(jsonStart + 1, fenceEnd)));
    if (!anchor.success) {
        return null;
    }
    const bac_id = parseFrontmatterValue(frontmatter, 'bac_id');
    const url = parseFrontmatterValue(frontmatter, 'url');
    const pageTitle = parseFrontmatterValue(frontmatter, 'pageTitle');
    const createdAt = parseFrontmatterValue(frontmatter, 'createdAt');
    const updatedAt = parseFrontmatterValue(frontmatter, 'updatedAt') ?? createdAt;
    const deletedAtRaw = parseFrontmatterValue(frontmatter, 'deletedAt');
    const revisionsRaw = parseFrontmatterValue(frontmatter, 'revisions');
    if (bac_id === undefined ||
        url === undefined ||
        pageTitle === undefined ||
        createdAt === undefined ||
        updatedAt === undefined) {
        return null;
    }
    let revisionsParsed = [];
    try {
        revisionsParsed = revisionsRaw === undefined ? [] : JSON.parse(revisionsRaw);
    }
    catch {
        revisionsParsed = [];
    }
    const revisions = Array.isArray(revisionsParsed)
        ? revisionsParsed
            .map((item) => {
            if (typeof item === 'object' &&
                item !== null &&
                typeof item.at === 'string' &&
                typeof item.note === 'string') {
                return {
                    at: item.at,
                    note: item.note,
                };
            }
            return null;
        })
            .filter((item) => item !== null)
        : [];
    return {
        bac_id,
        url,
        pageTitle,
        createdAt,
        updatedAt,
        deletedAt: deletedAtRaw === undefined || deletedAtRaw === 'null' ? null : deletedAtRaw,
        revisions,
        anchor: anchor.data,
        note: body.slice(fenceEnd + 5).trimStart(),
    };
};
export const writeAnnotation = async (vaultRoot, input) => {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const annotation = {
        bac_id: input.bac_id ?? createBacId(),
        url: input.url,
        pageTitle: input.pageTitle,
        anchor: input.anchor,
        note: input.note,
        createdAt,
        updatedAt: input.updatedAt ?? createdAt,
        deletedAt: input.deletedAt ?? null,
        revisions: input.revisions ?? [],
    };
    await writeAtomic(join(vaultRoot, '_BAC', 'annotations', `${annotation.bac_id}.md`), renderAnnotation(annotation));
    return annotation;
};
export const listAnnotations = async (vaultRoot, filter = {}) => {
    const root = join(vaultRoot, '_BAC', 'annotations');
    let names;
    try {
        names = await readdir(root);
    }
    catch {
        return [];
    }
    const annotations = [];
    for (const name of names.filter((candidate) => candidate.endsWith('.md'))) {
        try {
            const parsed = parseAnnotation(await readFile(join(root, name), 'utf8'));
            if (parsed !== null &&
                (filter.includeDeleted === true || parsed.deletedAt === null) &&
                (filter.url === undefined || parsed.url === filter.url)) {
                annotations.push(parsed);
            }
        }
        catch {
            // Skip malformed or mid-write annotation files.
        }
    }
    return annotations.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
};
const readAnnotation = async (vaultRoot, bac_id) => {
    const parsed = parseAnnotation(await readFile(join(vaultRoot, '_BAC', 'annotations', `${bac_id}.md`), 'utf8'));
    if (parsed === null) {
        throw new Error('Annotation not found.');
    }
    return parsed;
};
export const updateAnnotation = async (vaultRoot, bac_id, patch) => {
    const current = await readAnnotation(vaultRoot, bac_id);
    if (current.deletedAt !== null) {
        throw new Error('Deleted annotation cannot be updated.');
    }
    const updatedAt = new Date().toISOString();
    const updated = {
        ...current,
        note: patch.note,
        updatedAt,
        revisions: [{ at: updatedAt, note: current.note }, ...current.revisions],
    };
    await writeAtomic(join(vaultRoot, '_BAC', 'annotations', `${bac_id}.md`), renderAnnotation(updated));
    return updated;
};
export const softDeleteAnnotation = async (vaultRoot, bac_id) => {
    const current = await readAnnotation(vaultRoot, bac_id);
    if (current.deletedAt !== null) {
        return current;
    }
    const deletedAt = new Date().toISOString();
    const updated = { ...current, deletedAt, updatedAt: deletedAt };
    await writeAtomic(join(vaultRoot, '_BAC', 'annotations', `${bac_id}.md`), renderAnnotation(updated));
    return updated;
};
//# sourceMappingURL=annotationStore.js.map