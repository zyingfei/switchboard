import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createSuggestionCandidateStore, type SuggestionCandidateStore } from './suggestionCandidateStore.js';
import {
  recomputeSuggestionCandidates,
  type SuggestionEvidenceItem,
} from './splitSuggestionEngine.js';

const sqliteIt = process.versions['bun'] === undefined ? it.skip : it;

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

const makeStore = async (): Promise<SuggestionCandidateStore> => {
  const dir = await mkdtemp(join(tmpdir(), 'split-suggestion-engine-'));
  tempDirs.push(dir);
  await mkdir(join(dir, '_BAC', 'connections'), { recursive: true });
  return createSuggestionCandidateStore(dir);
};

// Orthogonal unit basis vectors — identical embedding within a group gives
// cosine=1 (well above threshold); orthogonal across groups gives cosine=0
// (well below), so cluster membership is unambiguous.
const basis = (index: number, dims = 8): Float32Array => {
  const v = new Float32Array(dims);
  v[index] = 1;
  return v;
};

const groupEvidence = (
  prefix: string,
  count: number,
  basisIndex: number,
  titlePrefix = 'x',
): SuggestionEvidenceItem[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    embedding: basis(basisIndex),
    title: `${titlePrefix} ${prefix} evidence ${i}`,
  }));

describe('recomputeSuggestionCandidates — split, stability gating', () => {
  sqliteIt('an unstable cluster (never seen 3x in a row) never emits', async () => {
    const store = await makeStore();
    try {
      const groupA = groupEvidence('a', 4, 0, 'alpha');
      const groupB = groupEvidence('b', 4, 1, 'beta');
      const round1 = recomputeSuggestionCandidates(store, {
        scopeId: 'ws-1',
        kind: 'split',
        evidence: [...groupA, ...groupB],
        revisionId: 'r1',
      });
      expect(round1.recomputed).toBe(true);
      expect(round1.allCandidates).toHaveLength(2);
      expect(round1.allCandidates.every((c) => !c.emitted)).toBe(true);
      expect(round1.newlyEmitted).toHaveLength(0);

      // Evidence changes completely — the two candidates dissolve (no
      // overlap match), so their stability streak resets rather than
      // carrying over.
      const groupC = groupEvidence('c', 4, 2, 'gamma');
      const groupD = groupEvidence('d', 4, 3, 'delta');
      const round2 = recomputeSuggestionCandidates(store, {
        scopeId: 'ws-1',
        kind: 'split',
        evidence: [...groupC, ...groupD],
        revisionId: 'r2',
      });
      expect(round2.allCandidates.every((c) => c.consecutiveStableCount === 1)).toBe(true);
      expect(round2.allCandidates.every((c) => !c.emitted)).toBe(true);
      expect(round2.newlyEmitted).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  sqliteIt('a stable cluster (3 consecutive computations) emits exactly once', async () => {
    const store = await makeStore();
    try {
      const groupA = groupEvidence('a', 4, 0, 'alpha');
      const groupB = groupEvidence('b', 4, 1, 'beta');
      const evidence = [...groupA, ...groupB];

      const r1 = recomputeSuggestionCandidates(store, {
        scopeId: 'ws-1',
        kind: 'split',
        evidence,
        revisionId: 'r1',
      });
      expect(r1.newlyEmitted).toHaveLength(0);

      const r2 = recomputeSuggestionCandidates(store, {
        scopeId: 'ws-1',
        kind: 'split',
        evidence,
        revisionId: 'r2',
      });
      expect(r2.newlyEmitted).toHaveLength(0);
      expect(r2.allCandidates.every((c) => c.consecutiveStableCount === 2)).toBe(true);

      const r3 = recomputeSuggestionCandidates(store, {
        scopeId: 'ws-1',
        kind: 'split',
        evidence,
        revisionId: 'r3',
      });
      // NOW it crosses the threshold — this is the one round that emits.
      expect(r3.newlyEmitted).toHaveLength(2);
      expect(r3.allCandidates.every((c) => c.emitted)).toBe(true);

      // A further stable round must NOT re-emit — "emit once, not repeatedly".
      const r4 = recomputeSuggestionCandidates(store, {
        scopeId: 'ws-1',
        kind: 'split',
        evidence,
        revisionId: 'r4',
      });
      expect(r4.newlyEmitted).toHaveLength(0);
      expect(r4.allCandidates.every((c) => c.emitted)).toBe(true);
    } finally {
      store.close();
    }
  });

  sqliteIt('a legitimately cohesive workstream (one blob) never splits — negative control', async () => {
    const store = await makeStore();
    try {
      const oneBlob = groupEvidence('a', 8, 0, 'alpha');
      for (const revisionId of ['r1', 'r2', 'r3', 'r4']) {
        const result = recomputeSuggestionCandidates(store, {
          scopeId: 'ws-1',
          kind: 'split',
          evidence: oneBlob,
          revisionId,
        });
        expect(result.allCandidates).toHaveLength(0);
        expect(result.newlyEmitted).toHaveLength(0);
      }
    } finally {
      store.close();
    }
  });

  sqliteIt('below the minimum-evidence floor, never attempts clustering', async () => {
    const store = await makeStore();
    try {
      const tiny = groupEvidence('a', 2, 0, 'alpha');
      const result = recomputeSuggestionCandidates(store, {
        scopeId: 'ws-1',
        kind: 'split',
        evidence: tiny,
        revisionId: 'r1',
      });
      expect(result.recomputed).toBe(true);
      expect(result.allCandidates).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});

describe('recomputeSuggestionCandidates — dirty-marking (incremental recompute)', () => {
  sqliteIt('an untouched scope (same revisionId) never recomputes', async () => {
    const store = await makeStore();
    try {
      const groupA = groupEvidence('a', 4, 0, 'alpha');
      const groupB = groupEvidence('b', 4, 1, 'beta');
      const evidence = [...groupA, ...groupB];
      const first = recomputeSuggestionCandidates(store, {
        scopeId: 'ws-1',
        kind: 'split',
        evidence,
        revisionId: 'stable-rev',
      });
      expect(first.recomputed).toBe(true);

      // Same revisionId, even with DIFFERENT (garbage) evidence passed in —
      // if the engine actually re-clustered it, this would change the
      // result. It must not: the dirty-marking check short-circuits before
      // ever looking at `evidence`.
      const second = recomputeSuggestionCandidates(store, {
        scopeId: 'ws-1',
        kind: 'split',
        evidence: [],
        revisionId: 'stable-rev',
      });
      expect(second.recomputed).toBe(false);
      expect(second.newlyEmitted).toHaveLength(0);
      expect(second.allCandidates).toEqual(first.allCandidates);
    } finally {
      store.close();
    }
  });

  sqliteIt('a changed revisionId does recompute even with identical evidence', async () => {
    const store = await makeStore();
    try {
      const groupA = groupEvidence('a', 4, 0, 'alpha');
      const groupB = groupEvidence('b', 4, 1, 'beta');
      const evidence = [...groupA, ...groupB];
      const first = recomputeSuggestionCandidates(store, {
        scopeId: 'ws-1',
        kind: 'split',
        evidence,
        revisionId: 'r1',
      });
      expect(first.recomputed).toBe(true);
      const second = recomputeSuggestionCandidates(store, {
        scopeId: 'ws-1',
        kind: 'split',
        evidence,
        revisionId: 'r2',
      });
      expect(second.recomputed).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe('recomputeSuggestionCandidates — new-category', () => {
  sqliteIt('fires on a single qualifying cluster (no ">=2" requirement)', async () => {
    const store = await makeStore();
    try {
      const unfiled = groupEvidence('u', 5, 0, 'unfiled');
      for (const revisionId of ['r1', 'r2', 'r3']) {
        recomputeSuggestionCandidates(store, {
          scopeId: '__unfiled__',
          kind: 'new-category',
          evidence: unfiled,
          revisionId,
        });
      }
      const result = recomputeSuggestionCandidates(store, {
        scopeId: '__unfiled__',
        kind: 'new-category',
        evidence: unfiled,
        revisionId: 'r4',
      });
      expect(result.allCandidates).toHaveLength(1);
      expect(result.allCandidates[0]?.emitted).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe('recomputeSuggestionCandidates — structural naming', () => {
  sqliteIt('produces a non-null structural name from member titles when available', async () => {
    const store = await makeStore();
    try {
      const groupA = groupEvidence('a', 4, 0, 'kv-cache-recsys');
      const groupB = groupEvidence('b', 4, 1, 'beta');
      const result = recomputeSuggestionCandidates(store, {
        scopeId: 'ws-1',
        kind: 'split',
        evidence: [...groupA, ...groupB],
        revisionId: 'r1',
      });
      const named = result.allCandidates.find((c) => c.memberIds[0]?.startsWith('a-'));
      expect(named?.structuralName).not.toBeNull();
      // Titles are "kv-cache-recsys a evidence N" — hyphens split into
      // separate word tokens, so the structural name surfaces the
      // discriminative WORDS, not the literal hyphenated string.
      expect(named?.structuralName).toContain('recsys');
    } finally {
      store.close();
    }
  });
});
