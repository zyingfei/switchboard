import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  NEW_CATEGORY_SCOPE_ID,
  createSuggestionCandidateStore,
  type SuggestionCandidateStore,
} from './suggestionCandidateStore.js';
import { recomputeSuggestionCandidates, type SuggestionEvidenceItem } from './splitSuggestionEngine.js';

const sqliteIt = process.versions['bun'] === undefined ? it.skip : it;

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

const makeStore = async (): Promise<SuggestionCandidateStore> => {
  const dir = await mkdtemp(join(tmpdir(), 'split-suggestion-newtopic-'));
  tempDirs.push(dir);
  await mkdir(join(dir, '_BAC', 'connections'), { recursive: true });
  return createSuggestionCandidateStore(dir);
};

const noVector = (): Float32Array => new Float32Array(0);

const group = (prefix: string, count: number, conceptId: string): SuggestionEvidenceItem[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    embedding: noVector(),
    conceptIds: [conceptId],
    keywords: [conceptId.replace('concept-', '')],
  }));

const NEW_TOPIC_OPTIONS = {
  cosineThreshold: 0.5,
  minSamples: 2,
  minClusterMembers: 3,
  minEvidenceToAttempt: 5,
} as const;

describe('recomputeSuggestionCandidates — new-topic suggestions from unfiled pages', () => {
  sqliteIt('8 unfiled pages (2 clear groups + noise) -> exactly 2 new-topic candidates after stability', async () => {
    const store = await makeStore();
    try {
      const evidence: SuggestionEvidenceItem[] = [
        ...group('rust', 3, 'concept-rust'),
        ...group('baking', 3, 'concept-baking'),
        // Noise: two singleton pages sharing nothing with anyone — must
        // never form a qualifying cluster (below minClusterMembers=3).
        { id: 'noise-0', embedding: noVector(), conceptIds: ['concept-noise-a'] },
        { id: 'noise-1', embedding: noVector(), conceptIds: ['concept-noise-b'] },
      ];
      expect(evidence.length).toBe(8);

      // Three consecutive recomputations with UNCHANGED clustering (only the
      // revisionId advances) — the actual stability gate, not a shortcut.
      recomputeSuggestionCandidates(store, {
        scopeId: NEW_CATEGORY_SCOPE_ID,
        kind: 'new-category',
        evidence,
        revisionId: 'rev-1',
        options: NEW_TOPIC_OPTIONS,
      });
      recomputeSuggestionCandidates(store, {
        scopeId: NEW_CATEGORY_SCOPE_ID,
        kind: 'new-category',
        evidence,
        revisionId: 'rev-2',
        options: NEW_TOPIC_OPTIONS,
      });
      const third = recomputeSuggestionCandidates(store, {
        scopeId: NEW_CATEGORY_SCOPE_ID,
        kind: 'new-category',
        evidence,
        revisionId: 'rev-3',
        options: NEW_TOPIC_OPTIONS,
      });

      expect(third.newlyEmitted.length).toBe(2);
      const memberSets = third.newlyEmitted.map((c) => [...c.memberIds].sort());
      expect(memberSets).toContainEqual(['rust-0', 'rust-1', 'rust-2']);
      expect(memberSets).toContainEqual(['baking-0', 'baking-1', 'baking-2']);
      for (const candidate of third.newlyEmitted) {
        expect(candidate.structuralName).not.toBeNull();
      }
    } finally {
      store.close();
    }
  });

  sqliteIt('does not emit before the 3rd consecutive stable computation', async () => {
    const store = await makeStore();
    try {
      const evidence: SuggestionEvidenceItem[] = [
        ...group('rust', 4, 'concept-rust'),
        { id: 'noise-0', embedding: noVector(), conceptIds: ['concept-noise-a'] },
      ];
      const first = recomputeSuggestionCandidates(store, {
        scopeId: NEW_CATEGORY_SCOPE_ID,
        kind: 'new-category',
        evidence,
        revisionId: 'rev-1',
        options: NEW_TOPIC_OPTIONS,
      });
      expect(first.newlyEmitted.length).toBe(0);
      const second = recomputeSuggestionCandidates(store, {
        scopeId: NEW_CATEGORY_SCOPE_ID,
        kind: 'new-category',
        evidence,
        revisionId: 'rev-2',
        options: NEW_TOPIC_OPTIONS,
      });
      expect(second.newlyEmitted.length).toBe(0);
    } finally {
      store.close();
    }
  });

  sqliteIt('an unchanged revisionId short-circuits the whole clustering pass (incremental, no recompute)', async () => {
    const store = await makeStore();
    try {
      const evidence: SuggestionEvidenceItem[] = group('rust', 4, 'concept-rust');
      const first = recomputeSuggestionCandidates(store, {
        scopeId: NEW_CATEGORY_SCOPE_ID,
        kind: 'new-category',
        evidence,
        revisionId: 'rev-1',
        options: NEW_TOPIC_OPTIONS,
      });
      expect(first.recomputed).toBe(true);
      const second = recomputeSuggestionCandidates(store, {
        scopeId: NEW_CATEGORY_SCOPE_ID,
        kind: 'new-category',
        evidence: [], // even wildly different evidence is never looked at
        revisionId: 'rev-1', // SAME revisionId as before
        options: NEW_TOPIC_OPTIONS,
      });
      expect(second.recomputed).toBe(false);
      // allCandidates from the short-circuit reflect the PRIOR computation,
      // proving the pass never touched the (empty) new evidence.
      expect(second.allCandidates.length).toBe(first.allCandidates.length);
    } finally {
      store.close();
    }
  });
});

describe('recomputeSuggestionCandidates — population-scoped decline memory (recurrence suppression)', () => {
  sqliteIt('a declined cluster does not recur while its concept makeup stays substantially the same', async () => {
    const store = await makeStore();
    try {
      // 3-member target cluster + 2 noise singletons — the noise pads total
      // evidence up to minEvidenceToAttempt=5 without joining the cluster
      // (each noise item carries a concept no one else shares).
      const evidence: SuggestionEvidenceItem[] = [
        ...group('rust', 3, 'concept-rust'),
        { id: 'noise-0', embedding: noVector(), conceptIds: ['concept-noise-a'] },
        { id: 'noise-1', embedding: noVector(), conceptIds: ['concept-noise-b'] },
      ];
      const options = NEW_TOPIC_OPTIONS;

      // Stabilize to first emission.
      recomputeSuggestionCandidates(store, {
        scopeId: NEW_CATEGORY_SCOPE_ID,
        kind: 'new-category',
        evidence,
        revisionId: 'rev-1',
        options,
      });
      recomputeSuggestionCandidates(store, {
        scopeId: NEW_CATEGORY_SCOPE_ID,
        kind: 'new-category',
        evidence,
        revisionId: 'rev-2',
        options,
      });
      const emitted = recomputeSuggestionCandidates(store, {
        scopeId: NEW_CATEGORY_SCOPE_ID,
        kind: 'new-category',
        evidence,
        revisionId: 'rev-3',
        options,
      });
      expect(emitted.newlyEmitted.length).toBe(1);
      const fingerprint = emitted.newlyEmitted[0]?.fingerprint ?? '';

      // User declines it — population-scoped, keyed by concept fingerprint.
      store.declineCandidate(NEW_CATEGORY_SCOPE_ID, 'new-category', fingerprint, ['concept-rust'], Date.now());

      // Recompute again — SAME cluster, new revisionId. Must NOT re-emit,
      // even though it is (by member-overlap) exactly as stable as before.
      const afterDecline = recomputeSuggestionCandidates(store, {
        scopeId: NEW_CATEGORY_SCOPE_ID,
        kind: 'new-category',
        evidence,
        revisionId: 'rev-4',
        options,
      });
      expect(afterDecline.newlyEmitted.length).toBe(0);

      // One more round for good measure — still suppressed, not just a
      // one-tick fluke.
      const stillSuppressed = recomputeSuggestionCandidates(store, {
        scopeId: NEW_CATEGORY_SCOPE_ID,
        kind: 'new-category',
        evidence,
        revisionId: 'rev-5',
        options,
      });
      expect(stillSuppressed.newlyEmitted.length).toBe(0);
    } finally {
      store.close();
    }
  });

  sqliteIt('a decline at one scope does not suppress an unrelated cluster at a DIFFERENT scope', async () => {
    const store = await makeStore();
    try {
      store.declineCandidate('other-scope', 'new-category', 'fp-1', ['concept-rust'], Date.now());

      const evidence: SuggestionEvidenceItem[] = [
        ...group('rust', 3, 'concept-rust'),
        { id: 'noise-0', embedding: noVector(), conceptIds: ['concept-noise-a'] },
        { id: 'noise-1', embedding: noVector(), conceptIds: ['concept-noise-b'] },
      ];
      const options = NEW_TOPIC_OPTIONS;
      recomputeSuggestionCandidates(store, {
        scopeId: NEW_CATEGORY_SCOPE_ID,
        kind: 'new-category',
        evidence,
        revisionId: 'rev-1',
        options,
      });
      recomputeSuggestionCandidates(store, {
        scopeId: NEW_CATEGORY_SCOPE_ID,
        kind: 'new-category',
        evidence,
        revisionId: 'rev-2',
        options,
      });
      const third = recomputeSuggestionCandidates(store, {
        scopeId: NEW_CATEGORY_SCOPE_ID,
        kind: 'new-category',
        evidence,
        revisionId: 'rev-3',
        options,
      });
      expect(third.newlyEmitted.length).toBe(1);
    } finally {
      store.close();
    }
  });
});
