import { describe, expect, it } from 'vitest';

import { runExtendedQuery } from '../../../src/sync/extendedQuery';

// Lane 3 / L3-G4 — extended-query fallback returns scope-marked
// results so the side panel renders the boundary truthfully.

describe('runExtendedQuery', () => {
  it('Mode P+C with reachable companion → companion-extended scope; merged active+remote, dedup by id', async () => {
    const result = await runExtendedQuery<{ id: string; label: string }>({
      companionReachable: async () => true,
      fetchFromCompanion: async () => [
        { id: 'b', label: 'remote-b' },
        { id: 'c', label: 'remote-c' },
      ],
      readActive: async () => [{ id: 'a', label: 'active-a' }, { id: 'b', label: 'active-b' }],
      idOf: (it) => it.id,
    });
    expect(result.scope).toBe('companion-extended');
    expect(result.items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    // Active item takes precedence on collision (b's label is
    // active-b, not remote-b).
    expect(result.items.find((i) => i.id === 'b')?.label).toBe('active-b');
  });

  it('Mode P (companion offline) → plugin-active-only-companion-unreachable + documented note', async () => {
    const result = await runExtendedQuery<{ id: string }>({
      companionReachable: async () => false,
      fetchFromCompanion: async () => null,
      readActive: async () => [{ id: 'a' }],
    });
    expect(result.scope).toBe('plugin-active-only-companion-unreachable');
    expect(result.note).toContain('companion unavailable');
    expect(result.items).toHaveLength(1);
  });

  it('archive-exported-not-imported scope when offline AND archive packs await import', async () => {
    const result = await runExtendedQuery<{ id: string }>({
      companionReachable: async () => false,
      fetchFromCompanion: async () => null,
      readActive: async () => [],
      archiveExportedAwaitingImport: async () => true,
    });
    expect(result.scope).toBe('archive-exported-not-imported');
    expect(result.note).toContain('exported archive packs');
  });

  it('companion reachable but request drops → falls back to plugin-active-only scope (honest boundary)', async () => {
    const result = await runExtendedQuery<{ id: string }>({
      companionReachable: async () => true,
      fetchFromCompanion: async () => null, // request dropped
      readActive: async () => [{ id: 'a' }],
    });
    expect(result.scope).toBe('plugin-active-only-companion-unreachable');
    expect(result.items.map((i) => i.id)).toEqual(['a']);
  });
});
