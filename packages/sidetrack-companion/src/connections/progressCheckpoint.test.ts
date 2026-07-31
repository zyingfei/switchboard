import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { EMPTY_PROGRESS } from '../sync/contract/materializerProgress.js';
import {
  PROGRESS_CHECKPOINT_FILENAME,
  mergeMaterializerProgress,
  parseGenerationProgressCheckpoint,
  progressFromCheckpoint,
  readGenerationProgressCheckpoint,
  writeGenerationProgressCheckpoint,
} from './progressCheckpoint.js';

const progress = (end: number, snapshotRevisionId = 'snapshot-1') => ({
  ...EMPTY_PROGRESS('connections', 'connections@test'),
  appliedDotIntervals: { replica: [[1, end] as const] },
  appliedFrontier: { replica: end },
  snapshotRevisionId,
});

describe('generation-bound progress checkpoint', () => {
  let root: string | null = null;

  afterEach(async () => {
    if (root !== null) await rm(root, { recursive: true, force: true });
    root = null;
  });

  it('round-trips an atomically written, validated checkpoint', async () => {
    root = await mkdtemp(join(tmpdir(), 'connections-progress-'));
    await writeGenerationProgressCheckpoint(
      root,
      'gen-1',
      progress(4),
      new Date('2026-07-31T20:00:00.000Z'),
    );

    expect(await readGenerationProgressCheckpoint(root)).toEqual({
      schemaVersion: 1,
      generationId: 'gen-1',
      recordedAt: '2026-07-31T20:00:00.000Z',
      progress: progress(4),
    });
  });

  it('treats malformed boundary data as absent instead of empty progress', async () => {
    root = await mkdtemp(join(tmpdir(), 'connections-progress-'));
    await writeFile(
      join(root, PROGRESS_CHECKPOINT_FILENAME),
      JSON.stringify({
        schemaVersion: 1,
        generationId: 'gen-1',
        recordedAt: '2026-07-31T20:00:00.000Z',
        progress: {
          ...progress(4),
          appliedDotIntervals: { replica: [[4, 1]] },
        },
      }),
      'utf8',
    );

    expect(await readGenerationProgressCheckpoint(root)).toBeNull();
    expect(parseGenerationProgressCheckpoint({})).toBeNull();
  });

  it('merges monotonic intervals without expanding ranges into individual dots', () => {
    const merged = mergeMaterializerProgress(
      {
        ...progress(3),
        appliedDotIntervals: { replica: [[1, 3]], peer: [[1, 2]] },
        appliedFrontier: { replica: 3, peer: 2 },
      },
      {
        ...progress(7),
        appliedDotIntervals: { replica: [[5, 7]], peer: [[3, 4]] },
        appliedFrontier: { peer: 4 },
      },
      'snapshot-1',
    );

    expect(merged).toEqual({
      ...progress(7),
      appliedDotIntervals: {
        peer: [[1, 4]],
        replica: [
          [1, 3],
          [5, 7],
        ],
      },
      appliedFrontier: { peer: 4, replica: 3 },
    });
  });

  it('accepts only a monotonic checkpoint for the exact served generation and revision', () => {
    const checkpoint = {
      schemaVersion: 1 as const,
      generationId: 'gen-1',
      recordedAt: '2026-07-31T20:00:00.000Z',
      progress: progress(4),
    };
    const embedded = progress(2);

    expect(
      progressFromCheckpoint({
        checkpoint,
        generationId: 'gen-1',
        snapshotRevisionId: 'snapshot-1',
        embedded,
      }),
    ).toEqual(progress(4));
    expect(
      progressFromCheckpoint({
        checkpoint,
        generationId: 'gen-2',
        snapshotRevisionId: 'snapshot-1',
        embedded,
      }),
    ).toBeNull();
    expect(
      progressFromCheckpoint({
        checkpoint,
        generationId: 'gen-1',
        snapshotRevisionId: 'snapshot-2',
        embedded,
      }),
    ).toBeNull();
    expect(
      progressFromCheckpoint({
        checkpoint: { ...checkpoint, progress: progress(1) },
        generationId: 'gen-1',
        snapshotRevisionId: 'snapshot-1',
        embedded,
      }),
    ).toBeNull();
  });
});
