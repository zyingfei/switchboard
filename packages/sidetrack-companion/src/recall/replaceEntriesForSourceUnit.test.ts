import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readIndex, replaceEntriesForSourceUnit, writeIndex } from './indexFile.js';
import type { IndexEntry } from './ranker.js';

// Lane 2 — the no-rebuild primitive. Tests:
//   L2-G3 — unrelated source units untouched while the named one's
//           chunks are replaced.
//   L2-G1 — newer extraction revision returns only its chunks (the
//           "no-rebuild" claim).

const makeEntry = (input: {
  id: string;
  threadId: string;
  sourceUnitId?: string;
  extractionRevisionId?: string;
}): IndexEntry => ({
  id: input.id,
  threadId: input.threadId,
  capturedAt: '2026-05-07T00:00:00.000Z',
  embedding: new Float32Array(384),
  replicaId: 'local',
  lamport: 1,
  tombstoned: false,
  metadata: {
    sourceBacId: input.threadId,
    turnOrdinal: 0,
    headingPath: [],
    paragraphIndex: 0,
    charStart: 0,
    charEnd: 1,
    textHash: 'h',
    text: 't',
    ...(input.sourceUnitId === undefined ? {} : { sourceUnitId: input.sourceUnitId }),
    ...(input.extractionRevisionId === undefined
      ? {}
      : { extractionRevisionId: input.extractionRevisionId }),
  },
});

describe('replaceEntriesForSourceUnit', () => {
  let vault: string;
  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), 'sidetrack-l2-replace-'));
  });
  afterEach(async () => {
    await rm(vault, { recursive: true, force: true });
  });

  it('removes prior entries for the named sourceUnitId and inserts new ones; unrelated sources untouched', async () => {
    const path = join(vault, 'index.bin');
    // Seed: two source units, A and B. A has 2 chunks (revision v1),
    // B has 1 chunk (revision v1).
    await writeIndex(
      path,
      [
        makeEntry({
          id: 'a:0',
          threadId: 't-A',
          sourceUnitId: 'src:A',
          extractionRevisionId: 'rev-A-v1',
        }),
        makeEntry({
          id: 'a:1',
          threadId: 't-A',
          sourceUnitId: 'src:A',
          extractionRevisionId: 'rev-A-v1',
        }),
        makeEntry({
          id: 'b:0',
          threadId: 't-B',
          sourceUnitId: 'src:B',
          extractionRevisionId: 'rev-B-v1',
        }),
      ],
      'Xenova/multilingual-e5-small',
    );

    // Replace A with revision v2 producing 3 chunks. B must stay
    // exactly as it was.
    const result = await replaceEntriesForSourceUnit(
      path,
      {
        sourceUnitId: 'src:A',
        extractionRevisionId: 'rev-A-v2',
        entries: [
          makeEntry({ id: 'a:0:v2', threadId: 't-A' }),
          makeEntry({ id: 'a:1:v2', threadId: 't-A' }),
          makeEntry({ id: 'a:2:v2', threadId: 't-A' }),
        ],
      },
      'Xenova/multilingual-e5-small',
    );

    expect(result.removed).toBe(2);
    expect(result.inserted).toBe(3);

    const after = await readIndex(path);
    expect(after).not.toBeNull();
    const ids = after!.items.map((e) => e.id).sort();
    // Old A:0/A:1 gone; new a:0:v2/a:1:v2/a:2:v2 in; B intact.
    expect(ids).toEqual(['a:0:v2', 'a:1:v2', 'a:2:v2', 'b:0']);

    // Every A entry now carries revision v2 metadata; B unchanged.
    const aEntries = after!.items.filter((e) => e.metadata?.sourceUnitId === 'src:A');
    for (const entry of aEntries) {
      expect(entry.metadata?.extractionRevisionId).toBe('rev-A-v2');
    }
    const bEntry = after!.items.find((e) => e.metadata?.sourceUnitId === 'src:B');
    expect(bEntry?.metadata?.extractionRevisionId).toBe('rev-B-v1');
  });

  it('on a fresh index (no file), inserts entries and reports removed=0', async () => {
    const path = join(vault, 'index.bin');
    const result = await replaceEntriesForSourceUnit(
      path,
      {
        sourceUnitId: 'src:NEW',
        extractionRevisionId: 'rev-NEW-v1',
        entries: [makeEntry({ id: 'new:0', threadId: 't-NEW' })],
      },
      'Xenova/multilingual-e5-small',
    );
    expect(result.removed).toBe(0);
    expect(result.inserted).toBe(1);
    const after = await readIndex(path);
    expect(after?.items).toHaveLength(1);
  });

  it('does NOT trigger a full rebuild signal — preserves modelRevision header', async () => {
    const path = join(vault, 'index.bin');
    await writeIndex(
      path,
      [
        makeEntry({
          id: 'a:0',
          threadId: 't-A',
          sourceUnitId: 'src:A',
          extractionRevisionId: 'rev-A-v1',
        }),
      ],
      'Xenova/multilingual-e5-small',
      { modelRevision: 'commit-sha-123' },
    );
    await replaceEntriesForSourceUnit(
      path,
      {
        sourceUnitId: 'src:A',
        extractionRevisionId: 'rev-A-v2',
        entries: [makeEntry({ id: 'a:0:v2', threadId: 't-A' })],
      },
      'Xenova/multilingual-e5-small',
    );
    const after = await readIndex(path);
    expect(after?.modelRevision).toBe('commit-sha-123');
  });
});
