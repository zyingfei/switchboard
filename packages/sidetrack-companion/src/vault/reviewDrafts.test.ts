import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  deleteReviewDraft,
  listReviewDrafts,
  readReviewDraft,
  writeReviewDraft,
} from './reviewDrafts.js';

const baseProjection = (
  overrides: { threadId: string; updatedAtMs?: number; threadUrl?: string } = { threadId: 't' },
) => ({
  threadId: overrides.threadId,
  threadUrl: overrides.threadUrl ?? '',
  vector: {} as Record<string, number>,
  spans: [] as never[],
  overall: { status: 'resolved' } as const,
  verdict: { status: 'resolved' } as const,
  tombstones: { spanIds: [] as never[] },
  discarded: false,
  updatedAtMs: overrides.updatedAtMs ?? 0,
});

describe('vault/reviewDrafts', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-review-drafts-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('writeReviewDraft + readReviewDraft round-trip', async () => {
    const projection = baseProjection({ threadId: 't1', updatedAtMs: 1_700_000_000_000 });
    await writeReviewDraft(vaultRoot, 't1', projection);
    expect(await readReviewDraft(vaultRoot, 't1')).toEqual(projection);

    const entries = await readdir(join(vaultRoot, '_BAC', 'review-drafts'));
    expect(entries).toEqual(['t1.json']);
  });

  it('readReviewDraft returns null for an absent thread', async () => {
    expect(await readReviewDraft(vaultRoot, 'missing')).toBeNull();
  });

  it('deleteReviewDraft removes the file and is idempotent on missing', async () => {
    await writeReviewDraft(vaultRoot, 't1', baseProjection({ threadId: 't1' }));
    await deleteReviewDraft(vaultRoot, 't1');
    await deleteReviewDraft(vaultRoot, 't1');
    expect(await readReviewDraft(vaultRoot, 't1')).toBeNull();
  });

  it('listReviewDrafts filters by sinceMs and sorts newest first', async () => {
    await writeReviewDraft(vaultRoot, 'a', baseProjection({ threadId: 'a', updatedAtMs: 100 }));
    await writeReviewDraft(vaultRoot, 'b', baseProjection({ threadId: 'b', updatedAtMs: 200 }));
    await writeReviewDraft(vaultRoot, 'c', baseProjection({ threadId: 'c', updatedAtMs: 300 }));

    expect(await listReviewDrafts(vaultRoot)).toEqual([
      { threadId: 'c', updatedAtMs: 300, vector: {} },
      { threadId: 'b', updatedAtMs: 200, vector: {} },
      { threadId: 'a', updatedAtMs: 100, vector: {} },
    ]);
    expect(await listReviewDrafts(vaultRoot, 150)).toEqual([
      { threadId: 'c', updatedAtMs: 300, vector: {} },
      { threadId: 'b', updatedAtMs: 200, vector: {} },
    ]);
  });

  it('listReviewDrafts ignores hidden tmp files left by atomic writers', async () => {
    await writeReviewDraft(vaultRoot, 'a', baseProjection({ threadId: 'a', updatedAtMs: 1 }));
    await writeFile(
      join(vaultRoot, '_BAC', 'review-drafts', '.a.json.junk.tmp'),
      'partial\n',
      'utf8',
    );
    expect((await listReviewDrafts(vaultRoot)).map((s) => s.threadId)).toEqual(['a']);
  });
});
