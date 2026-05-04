import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  listAnnotations,
  softDeleteAnnotation,
  updateAnnotation,
  writeAnnotation,
} from './annotationStore.js';

const anchor = {
  textQuote: { exact: 'hello', prefix: '', suffix: ' world' },
  textPosition: { start: 0, end: 5 },
  cssSelector: 'body',
};

describe('annotationStore', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-annotation-test-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('round-trips an annotation as markdown', async () => {
    const written = await writeAnnotation(vaultRoot, {
      url: 'https://example.test/page',
      pageTitle: 'Page',
      anchor,
      note: 'Remember this',
      createdAt: '2026-04-26T22:00:00.000Z',
    });

    await expect(listAnnotations(vaultRoot)).resolves.toEqual([written]);
  });

  it('filters annotations by url', async () => {
    await writeAnnotation(vaultRoot, {
      url: 'https://example.test/a',
      pageTitle: 'A',
      anchor,
      note: '',
    });
    await writeAnnotation(vaultRoot, {
      url: 'https://example.test/b',
      pageTitle: 'B',
      anchor,
      note: '',
    });

    const annotations = await listAnnotations(vaultRoot, { url: 'https://example.test/a' });

    expect(annotations).toHaveLength(1);
    expect(annotations[0]?.url).toBe('https://example.test/a');
  });

  it('skips bad frontmatter', async () => {
    await mkdir(join(vaultRoot, '_BAC', 'annotations'), { recursive: true });
    await writeFile(join(vaultRoot, '_BAC', 'annotations', 'bad.md'), '---\nbad\n---\n');

    await expect(listAnnotations(vaultRoot)).resolves.toEqual([]);
  });

  it('updates notes with most-recent-first revision history', async () => {
    const written = await writeAnnotation(vaultRoot, {
      url: 'https://example.test/page',
      pageTitle: 'Page',
      anchor,
      note: 'first',
    });

    const updated = await updateAnnotation(vaultRoot, written.bac_id, { note: 'second' });

    expect(updated.note).toBe('second');
    expect(updated.revisions[0]?.note).toBe('first');
    expect(updated.deletedAt).toBeNull();
  });

  it('soft-deletes idempotently and hides deleted records by default', async () => {
    const written = await writeAnnotation(vaultRoot, {
      url: 'https://example.test/page',
      pageTitle: 'Page',
      anchor,
      note: 'doomed',
    });

    const deleted = await softDeleteAnnotation(vaultRoot, written.bac_id);
    const deletedAgain = await softDeleteAnnotation(vaultRoot, written.bac_id);

    expect(deleted.deletedAt).not.toBeNull();
    expect(deletedAgain.deletedAt).toBe(deleted.deletedAt);
    await expect(listAnnotations(vaultRoot)).resolves.toEqual([]);
    await expect(listAnnotations(vaultRoot, { includeDeleted: true })).resolves.toHaveLength(1);
    await expect(updateAnnotation(vaultRoot, written.bac_id, { note: 'nope' })).rejects.toThrow(
      /deleted/iu,
    );
  });
});
