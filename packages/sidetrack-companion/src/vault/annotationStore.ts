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
  if (
    bac_id === undefined ||
    url === undefined ||
    pageTitle === undefined ||
    createdAt === undefined
  ) {
    return null;
  }
  return {
    bac_id,
    url,
    pageTitle,
    createdAt,
    anchor: anchor.data,
    note: body.slice(fenceEnd + 5).trimStart(),
  };
};

export const writeAnnotation = async (
  vaultRoot: string,
  input: Omit<Annotation, 'bac_id' | 'createdAt'> & {
    readonly bac_id?: string;
    readonly createdAt?: string;
  },
): Promise<Annotation> => {
  const annotation: Annotation = {
    bac_id: input.bac_id ?? createBacId(),
    url: input.url,
    pageTitle: input.pageTitle,
    anchor: input.anchor,
    note: input.note,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  await writeAtomic(
    join(vaultRoot, '_BAC', 'annotations', `${annotation.bac_id}.md`),
    renderAnnotation(annotation),
  );
  return annotation;
};

export const listAnnotations = async (
  vaultRoot: string,
  filter: { readonly url?: string } = {},
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
      if (parsed !== null && (filter.url === undefined || parsed.url === filter.url)) {
        annotations.push(parsed);
      }
    } catch {
      // Skip malformed or mid-write annotation files.
    }
  }
  return annotations.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
};
