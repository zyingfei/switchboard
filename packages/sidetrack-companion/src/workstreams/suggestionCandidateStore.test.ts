import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createSuggestionCandidateStore, type SuggestionCandidateRecord } from './suggestionCandidateStore.js';

const sqliteIt = process.versions['bun'] === undefined ? it.skip : it;

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

const makeVault = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'suggestion-candidate-store-'));
  tempDirs.push(dir);
  await mkdir(join(dir, '_BAC', 'connections'), { recursive: true });
  return dir;
};

const candidate = (
  over: Partial<SuggestionCandidateRecord> & { readonly fingerprint: string },
): SuggestionCandidateRecord => ({
  scopeId: 'ws-1',
  kind: 'split',
  memberIds: ['a', 'b'],
  consecutiveStableCount: 1,
  emitted: false,
  structuralName: null,
  createdAtMs: 1_000,
  updatedAtMs: 1_000,
  dismissed: false,
  dismissedAtMs: null,
  ...over,
});

describe('suggestionCandidateStore', () => {
  sqliteIt('round-trips candidates and the last-computed revision', async () => {
    const vaultRoot = await makeVault();
    const store = await createSuggestionCandidateStore(vaultRoot);
    try {
      expect(store.lastComputedRevision('ws-1', 'split')).toBeUndefined();
      store.replaceScope('ws-1', 'split', 'rev-1', [candidate({ fingerprint: 'a b' })]);
      expect(store.lastComputedRevision('ws-1', 'split')).toBe('rev-1');
      const rows = store.candidatesFor('ws-1', 'split');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ fingerprint: 'a b', memberIds: ['a', 'b'] });
    } finally {
      store.close();
    }
  });

  sqliteIt('replaceScope fully replaces the prior candidate set', async () => {
    const vaultRoot = await makeVault();
    const store = await createSuggestionCandidateStore(vaultRoot);
    try {
      store.replaceScope('ws-1', 'split', 'rev-1', [candidate({ fingerprint: 'a b' })]);
      store.replaceScope('ws-1', 'split', 'rev-2', [candidate({ fingerprint: 'c d', memberIds: ['c', 'd'] })]);
      const rows = store.candidatesFor('ws-1', 'split');
      expect(rows.map((r) => r.fingerprint)).toEqual(['c d']);
    } finally {
      store.close();
    }
  });

  sqliteIt('scopes are independent by (scopeId, kind)', async () => {
    const vaultRoot = await makeVault();
    const store = await createSuggestionCandidateStore(vaultRoot);
    try {
      store.replaceScope('ws-1', 'split', 'rev-1', [candidate({ fingerprint: 'a b' })]);
      store.replaceScope('ws-1', 'new-category', 'rev-1', [
        candidate({ fingerprint: 'x y', kind: 'new-category', memberIds: ['x', 'y'] }),
      ]);
      store.replaceScope('ws-2', 'split', 'rev-1', [
        candidate({ fingerprint: 'p q', scopeId: 'ws-2', memberIds: ['p', 'q'] }),
      ]);
      expect(store.candidatesFor('ws-1', 'split').map((r) => r.fingerprint)).toEqual(['a b']);
      expect(store.candidatesFor('ws-1', 'new-category').map((r) => r.fingerprint)).toEqual(['x y']);
      expect(store.candidatesFor('ws-2', 'split').map((r) => r.fingerprint)).toEqual(['p q']);
    } finally {
      store.close();
    }
  });

  sqliteIt('round-trips dismissed=false by default', async () => {
    const vaultRoot = await makeVault();
    const store = await createSuggestionCandidateStore(vaultRoot);
    try {
      store.replaceScope('ws-1', 'split', 'rev-1', [candidate({ fingerprint: 'a b' })]);
      const rows = store.candidatesFor('ws-1', 'split');
      expect(rows[0]).toMatchObject({ dismissed: false, dismissedAtMs: null });
    } finally {
      store.close();
    }
  });

  sqliteIt('dismissCandidate marks a matching fingerprint dismissed and returns true', async () => {
    const vaultRoot = await makeVault();
    const store = await createSuggestionCandidateStore(vaultRoot);
    try {
      store.replaceScope('ws-1', 'split', 'rev-1', [candidate({ fingerprint: 'a b', emitted: true })]);
      const changed = store.dismissCandidate('ws-1', 'split', 'a b', 2_000);
      expect(changed).toBe(true);
      const rows = store.candidatesFor('ws-1', 'split');
      expect(rows[0]).toMatchObject({ dismissed: true, dismissedAtMs: 2_000 });
    } finally {
      store.close();
    }
  });

  sqliteIt('dismissCandidate is a no-op (returns false) for an unknown fingerprint', async () => {
    const vaultRoot = await makeVault();
    const store = await createSuggestionCandidateStore(vaultRoot);
    try {
      store.replaceScope('ws-1', 'split', 'rev-1', [candidate({ fingerprint: 'a b' })]);
      const changed = store.dismissCandidate('ws-1', 'split', 'nope', 2_000);
      expect(changed).toBe(false);
      expect(store.candidatesFor('ws-1', 'split')[0]).toMatchObject({ dismissed: false });
    } finally {
      store.close();
    }
  });
});
