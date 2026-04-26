import { describe, expect, it } from 'vitest';
import { chunkDocument } from '../../src/recall/chunking';

describe('chunkDocument', () => {
  it('splits long markdown into bounded chunks', () => {
    const document = {
      id: 'note-1',
      sourcePath: 'Projects/Recall.md',
      sourceKind: 'markdown' as const,
      title: 'Recall note',
      text: [
        'Calibrated freshness should surface the right memory tier without drowning the user in stale context.',
        'When the vault is canonical, the vector layer can stay a rebuildable cache instead of becoming another source of truth.',
        'Cold-start numbers matter because they determine whether PGlite is necessary or whether a plain in-memory scan stays under budget.',
      ].join('\n\n'),
      capturedAt: '2026-04-25T12:00:00.000Z',
    };

    const chunks = chunkDocument(document, { maxChars: 120 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.text.length <= 120)).toBe(true);
    expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(chunks.length);
  });
});
