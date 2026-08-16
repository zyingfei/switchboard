// W5 review verdict binding note 1 — topic-revision file retention.
// putRevision never GC'd; W5's incremental producer mints revisions at
// a much higher rate than the old cadence-gated full rebuild, turning
// that into a real disk leak. This suite pins the retention contract:
// keep the current active/shadow/candidate-shadow-referenced revisions
// plus the last N minted ones (SIDETRACK_TOPIC_REVISION_KEEP), delete
// everything else on put.

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_TOPIC_REVISION_KEEP,
  TOPIC_REVISION_KEEP_ENV,
  TOPIC_UNION_FIND_REVISION_KEY,
  createTopicRevisionStore,
  resolveTopicRevisionKeep,
  type TopicRevision,
} from './topic-revision.js';

const revision = (revisionId: string): TopicRevision => ({
  revisionId,
  visitSimilarityRevisionId: `sim-${revisionId}`,
  cosineThreshold: 0.9,
  algorithmVersion: TOPIC_UNION_FIND_REVISION_KEY,
  topics: [],
  lineage: [],
  producedAt: 1,
});

describe('createTopicRevisionStore retention', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-topic-revision-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('keeps only the last N minted revisions when none are referenced', async () => {
    const store = createTopicRevisionStore(vaultRoot, { revisionKeep: 2 });
    for (const id of ['r1', 'r2', 'r3', 'r4', 'r5']) {
      await store.putRevision(revision(id));
    }
    const ids = await store.listRevisionIds();
    expect(ids).toEqual(['r4', 'r5']);
    expect(await store.readRevision('r1')).toBeNull();
    expect(await store.readRevision('r3')).toBeNull();
    expect(await store.readRevision('r4')).not.toBeNull();
    expect(await store.readRevision('r5')).not.toBeNull();
  });

  it('never GCs the current active revision, however old', async () => {
    const store = createTopicRevisionStore(vaultRoot, { revisionKeep: 2 });
    await store.putActiveRevision(revision('active-1'));
    for (const id of ['r2', 'r3', 'r4', 'r5']) {
      await store.putRevision(revision(id));
    }
    expect(await store.readRevision('active-1')).not.toBeNull();
    expect(await store.readActiveRevision()).toEqual(revision('active-1'));
    // The window revisions unrelated to the active pointer still GC normally.
    expect(await store.readRevision('r2')).toBeNull();
  });

  it('never GCs the current shadow revision, however old', async () => {
    const store = createTopicRevisionStore(vaultRoot, { revisionKeep: 2 });
    await store.putShadowRevision(revision('shadow-1'));
    for (const id of ['r2', 'r3', 'r4', 'r5']) {
      await store.putRevision(revision(id));
    }
    expect(await store.readRevision('shadow-1')).not.toBeNull();
  });

  it('never GCs a referenced candidate-shadow revision, however old', async () => {
    const store = createTopicRevisionStore(vaultRoot, { revisionKeep: 2 });
    await store.putCandidateShadowRevision('leiden-cpm', revision('cand-1'));
    for (const id of ['r2', 'r3', 'r4', 'r5']) {
      await store.putRevision(revision(id));
    }
    expect(await store.readRevision('cand-1')).not.toBeNull();
    expect(await store.readCandidateShadowRevision('leiden-cpm')).toEqual(revision('cand-1'));
  });

  it('GCs an old candidate-shadow revision once a newer one replaces it', async () => {
    const store = createTopicRevisionStore(vaultRoot, { revisionKeep: 1 });
    await store.putCandidateShadowRevision('leiden-cpm', revision('cand-old'));
    // Enough intervening puts to push cand-old out of the "last N" window.
    for (const id of ['r2', 'r3']) {
      await store.putRevision(revision(id));
    }
    await store.putCandidateShadowRevision('leiden-cpm', revision('cand-new'));
    expect(await store.readRevision('cand-new')).not.toBeNull();
    expect(await store.readRevision('cand-old')).toBeNull();
  });

  it('re-putting an existing revisionId refreshes recency instead of duplicating', async () => {
    const store = createTopicRevisionStore(vaultRoot, { revisionKeep: 2 });
    await store.putRevision(revision('r1'));
    await store.putRevision(revision('r2'));
    await store.putRevision(revision('r1')); // refresh r1 to the tail
    await store.putRevision(revision('r3'));
    // With keep=2 and r1 refreshed to the tail, order is [r2, r1, r3] →
    // last 2 = [r1, r3]; r2 (now oldest) is GC'd.
    expect(await store.readRevision('r1')).not.toBeNull();
    expect(await store.readRevision('r3')).not.toBeNull();
    expect(await store.readRevision('r2')).toBeNull();
  });

  it('respects SIDETRACK_TOPIC_REVISION_KEEP when no explicit option is given', async () => {
    const previous = process.env[TOPIC_REVISION_KEEP_ENV];
    process.env[TOPIC_REVISION_KEEP_ENV] = '1';
    try {
      const store = createTopicRevisionStore(vaultRoot);
      await store.putRevision(revision('r1'));
      await store.putRevision(revision('r2'));
      expect(await store.readRevision('r1')).toBeNull();
      expect(await store.readRevision('r2')).not.toBeNull();
    } finally {
      if (previous === undefined) delete process.env[TOPIC_REVISION_KEEP_ENV];
      else process.env[TOPIC_REVISION_KEEP_ENV] = previous;
    }
  });

  it('falls back to the default keep count on an invalid env value', () => {
    const previous = process.env[TOPIC_REVISION_KEEP_ENV];
    process.env[TOPIC_REVISION_KEEP_ENV] = 'not-a-number';
    try {
      expect(resolveTopicRevisionKeep()).toBe(DEFAULT_TOPIC_REVISION_KEEP);
    } finally {
      if (previous === undefined) delete process.env[TOPIC_REVISION_KEEP_ENV];
      else process.env[TOPIC_REVISION_KEEP_ENV] = previous;
    }
  });

  it('listRevisionIds excludes pointer files and the retention ledger', async () => {
    const store = createTopicRevisionStore(vaultRoot, { revisionKeep: 8 });
    await store.putActiveRevision(revision('active-1'));
    await store.putShadowRevision(revision('shadow-1'));
    await store.putCandidateShadowRevision('leiden-cpm', revision('cand-1'));
    await store.putRevision(revision('plain-1'));

    const ids = await store.listRevisionIds();
    expect(ids).toEqual(['active-1', 'cand-1', 'plain-1', 'shadow-1']);

    // Sanity: the pointer/ledger files really are on disk (proving the
    // exclusion in listRevisionIds is deliberate, not accidental).
    const root = join(vaultRoot, '_BAC', 'connections', 'topics');
    const entries = await readdir(root);
    expect(entries).toContain('current.json');
    expect(entries).toContain('current.shadow.json');
    expect(entries).toContain('retention.json');
    expect(entries.some((name) => /^current\.leiden-cpm\.shadow\.json$/u.test(name))).toBe(true);
  });
});
