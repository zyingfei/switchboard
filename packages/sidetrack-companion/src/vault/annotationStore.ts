import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { createBacId, createRevision } from '../domain/ids.js';
import { serializedAnchorSchema, type SerializedAnchor } from '../http/schemas.js';

export interface Annotation {
  readonly bac_id: string;
  readonly url: string;
  readonly pageTitle: string;
  readonly anchor: SerializedAnchor;
  readonly note: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  readonly revisions: readonly { readonly at: string; readonly note: string }[];
}

const yamlString = (value: string): string => JSON.stringify(value);

const writeAtomic = async (path: string, body: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = join(dirname(path), `.${basename(path)}.${createRevision()}.tmp`);
  await writeFile(tempPath, body, 'utf8');
  await rename(tempPath, path);
};

const renderAnnotation = (annotation: Annotation): string =>
  [
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

const parseFrontmatterValue = (frontmatter: string, key: string): string | undefined => {
  const line = frontmatter.split('\n').find((candidate) => candidate.startsWith(`${key}:`));
  if (line === undefined) {
    return undefined;
  }
  const raw = line.slice(key.length + 1).trim();
  try {
    return JSON.parse(raw) as string;
  } catch {
    return raw;
  }
};

const parseAnnotation = (raw: string): Annotation | null => {
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
  const anchor = serializedAnchorSchema.safeParse(
    JSON.parse(body.slice(jsonStart + 1, fenceEnd)) as unknown,
  );
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
  if (
    bac_id === undefined ||
    url === undefined ||
    pageTitle === undefined ||
    createdAt === undefined ||
    updatedAt === undefined
  ) {
    return null;
  }
  let revisionsParsed: unknown = [];
  try {
    revisionsParsed = revisionsRaw === undefined ? [] : (JSON.parse(revisionsRaw) as unknown);
  } catch {
    revisionsParsed = [];
  }
  const revisions = Array.isArray(revisionsParsed)
    ? revisionsParsed
        .map((item): { readonly at: string; readonly note: string } | null => {
          if (
            typeof item === 'object' &&
            item !== null &&
            typeof (item as { readonly at?: unknown }).at === 'string' &&
            typeof (item as { readonly note?: unknown }).note === 'string'
          ) {
            return {
              at: (item as { readonly at: string }).at,
              note: (item as { readonly note: string }).note,
            };
          }
          return null;
        })
        .filter((item): item is { readonly at: string; readonly note: string } => item !== null)
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

export const writeAnnotation = async (
  vaultRoot: string,
  input: Omit<Annotation, 'bac_id' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'revisions'> & {
    readonly bac_id?: string;
    readonly createdAt?: string;
    readonly updatedAt?: string;
    readonly deletedAt?: string | null;
    readonly revisions?: readonly { readonly at: string; readonly note: string }[];
  },
): Promise<Annotation> => {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const annotation: Annotation = {
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
  await writeAtomic(
    join(vaultRoot, '_BAC', 'annotations', `${annotation.bac_id}.md`),
    renderAnnotation(annotation),
  );
  return annotation;
};

export const listAnnotations = async (
  vaultRoot: string,
  filter: { readonly url?: string; readonly includeDeleted?: boolean } = {},
): Promise<readonly Annotation[]> => {
  const root = join(vaultRoot, '_BAC', 'annotations');
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const annotations: Annotation[] = [];
  for (const name of names.filter((candidate) => candidate.endsWith('.md'))) {
    try {
      const parsed = parseAnnotation(await readFile(join(root, name), 'utf8'));
      if (
        parsed !== null &&
        (filter.includeDeleted === true || parsed.deletedAt === null) &&
        (filter.url === undefined || parsed.url === filter.url)
      ) {
        annotations.push(parsed);
      }
    } catch {
      // Skip malformed or mid-write annotation files.
    }
  }
  return annotations.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
};

const readAnnotation = async (vaultRoot: string, bac_id: string): Promise<Annotation> => {
  const parsed = parseAnnotation(
    await readFile(join(vaultRoot, '_BAC', 'annotations', `${bac_id}.md`), 'utf8'),
  );
  if (parsed === null) {
    throw new Error('Annotation not found.');
  }
  return parsed;
};

export const updateAnnotation = async (
  vaultRoot: string,
  bac_id: string,
  patch: { readonly note: string },
): Promise<Annotation> => {
  const current = await readAnnotation(vaultRoot, bac_id);
  if (current.deletedAt !== null) {
    throw new Error('Deleted annotation cannot be updated.');
  }
  const updatedAt = new Date().toISOString();
  const updated: Annotation = {
    ...current,
    note: patch.note,
    updatedAt,
    revisions: [{ at: updatedAt, note: current.note }, ...current.revisions],
  };
  await writeAtomic(join(vaultRoot, '_BAC', 'annotations', `${bac_id}.md`), renderAnnotation(updated));
  return updated;
};

export const softDeleteAnnotation = async (
  vaultRoot: string,
  bac_id: string,
): Promise<Annotation> => {
  const current = await readAnnotation(vaultRoot, bac_id);
  if (current.deletedAt !== null) {
    return current;
  }
  const deletedAt = new Date().toISOString();
  const updated: Annotation = { ...current, deletedAt, updatedAt: deletedAt };
  await writeAtomic(join(vaultRoot, '_BAC', 'annotations', `${bac_id}.md`), renderAnnotation(updated));
  return updated;
};
