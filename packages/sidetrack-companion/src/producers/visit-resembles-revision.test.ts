// Round-2 corpus-flapping fix — coverage for the revision-store read that
// R1 (reuse) and R2 (bootstrap) depend on. The materializer must be able to
// recover the LAST non-empty persisted revision from the visit-similarity
// store even when the empty-corpus revision (a stable hash id) is the most
// recently written file. The store is the source of truth for recovery
// because current.db — the surface the flapping bug wipes — cannot be.

import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RECALL_MODEL } from '../recall/modelManifest.js';
import type { VisitSimilarityRevision } from '../connections/types.js';
import {
  readLatestNonEmptyVisitSimilarityRevision,
  visitSimilarityRevisionPath,
  writeVisitSimilarityRevision,
} from './visit-resembles-revision.js';

const revision = (input: {
  revisionId: string;
  edgeCount: number;
}): VisitSimilarityRevision => ({
  revisionId: input.revisionId,
  modelId: 'Xenova/multilingual-e5-small',
  modelRevision: RECALL_MODEL.revision,
  featureSchemaVersion: 1,
  threshold: 0.5,
  producedAt: 1,
  edges: Array.from({ length: input.edgeCount }, (_unused, i) => ({
    fromVisitKey: `visit:a-${String(i)}`,
    toVisitKey: `visit:b-${String(i)}`,
    cosine: 0.9,
  })),
});

describe('readLatestNonEmptyVisitSimilarityRevision', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-simrev-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('returns null on a fresh vault (revision dir absent)', async () => {
    expect(await readLatestNonEmptyVisitSimilarityRevision(vaultRoot)).toBeNull();
  });

  it('returns null when only an empty revision is persisted', async () => {
    await writeVisitSimilarityRevision(vaultRoot, revision({ revisionId: 'empty', edgeCount: 0 }));
    expect(await readLatestNonEmptyVisitSimilarityRevision(vaultRoot)).toBeNull();
  });

  it('returns the non-empty revision even when the empty one is written LAST', async () => {
    // The live failure: the good ~51k revision was written first, then an
    // empty-corpus drain wrote the (stable-id) empty revision after it.
    const good = revision({ revisionId: 'good', edgeCount: 51 });
    await writeVisitSimilarityRevision(vaultRoot, good);
    // Backdate the good revision so the empty one is strictly newer by mtime.
    await utimes(visitSimilarityRevisionPath(vaultRoot, 'good'), new Date(1000), new Date(1000));
    await writeVisitSimilarityRevision(vaultRoot, revision({ revisionId: 'empty', edgeCount: 0 }));

    const latest = await readLatestNonEmptyVisitSimilarityRevision(vaultRoot);
    expect(latest?.revisionId).toBe('good');
    expect(latest?.edges.length).toBe(51);
  });

  it('returns the NEWEST non-empty revision when several exist', async () => {
    const older = revision({ revisionId: 'older', edgeCount: 10 });
    const newer = revision({ revisionId: 'newer', edgeCount: 20 });
    await writeVisitSimilarityRevision(vaultRoot, older);
    await utimes(visitSimilarityRevisionPath(vaultRoot, 'older'), new Date(1000), new Date(1000));
    await writeVisitSimilarityRevision(vaultRoot, newer);
    await utimes(visitSimilarityRevisionPath(vaultRoot, 'newer'), new Date(5000), new Date(5000));

    const latest = await readLatestNonEmptyVisitSimilarityRevision(vaultRoot);
    expect(latest?.revisionId).toBe('newer');
    expect(latest?.edges.length).toBe(20);
  });
});
