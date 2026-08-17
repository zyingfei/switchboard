import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createSuggestionCandidateStore, type SuggestionCandidateStore } from './suggestionCandidateStore.js';
import {
  computeClusterCohesion,
  computeExternalBest,
  DEFAULT_MIN_CLUSTER_MEMBERS,
  DEFAULT_STABILITY_MIN_CONSECUTIVE,
  DEFAULT_SUGGESTION_MARGIN,
  hybridSimilarity,
  resolveSuggestionMargin,
  SUGGESTION_MARGIN_ENV,
  SUGGESTION_MIN_MEMBERS_ENV,
  SUGGESTION_MIN_MEMBERS_FLOOR,
  SUGGESTION_STABILITY_ENV,
  recomputeSuggestionCandidates,
  resolveSuggestionMinClusterMembers,
  resolveSuggestionStabilityMinConsecutive,
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

describe('recomputeSuggestionCandidates — split, stability gating (explicit stabilityMinConsecutive=3)', () => {
  // NOTE (2026-08-17): the engine's DEFAULT stability gate is now liberal
  // (stabilityMinConsecutive=1 — see the "liberal default" describe block
  // below and splitSuggestionEngine.ts's header). These two tests still
  // prove the GATING MECHANISM itself works correctly when a caller opts
  // into a stricter cadence via `options.stabilityMinConsecutive` (or the
  // SIDETRACK_SUGGESTION_STABILITY env knob) — the mechanism didn't change,
  // only what a bare call (no options) resolves to by default.
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
        options: { stabilityMinConsecutive: 3 },
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
        options: { stabilityMinConsecutive: 3 },
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
      const options = { stabilityMinConsecutive: 3 };

      const r1 = recomputeSuggestionCandidates(store, {
        scopeId: 'ws-1',
        kind: 'split',
        evidence,
        revisionId: 'r1',
        options,
      });
      expect(r1.newlyEmitted).toHaveLength(0);

      const r2 = recomputeSuggestionCandidates(store, {
        scopeId: 'ws-1',
        kind: 'split',
        evidence,
        revisionId: 'r2',
        options,
      });
      expect(r2.newlyEmitted).toHaveLength(0);
      expect(r2.allCandidates.every((c) => c.consecutiveStableCount === 2)).toBe(true);

      const r3 = recomputeSuggestionCandidates(store, {
        scopeId: 'ws-1',
        kind: 'split',
        evidence,
        revisionId: 'r3',
        options,
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
        options,
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

describe('recomputeSuggestionCandidates — liberal default (stabilityMinConsecutive=1)', () => {
  sqliteIt(
    'a qualifying cluster emits on its FIRST computation under the bare (no options) default',
    async () => {
      const store = await makeStore();
      try {
        const groupA = groupEvidence('a', 4, 0, 'alpha');
        const groupB = groupEvidence('b', 4, 1, 'beta');
        // NO options.stabilityMinConsecutive — exercises the real production
        // default (resolveSuggestionStabilityMinConsecutive(), same call
        // shape suggestionRecomputeLane.ts's runSuggestionRecomputeCycle
        // uses).
        const result = recomputeSuggestionCandidates(store, {
          scopeId: 'ws-liberal',
          kind: 'split',
          evidence: [...groupA, ...groupB],
          revisionId: 'r1',
        });
        expect(result.recomputed).toBe(true);
        expect(result.newlyEmitted).toHaveLength(2);
        expect(result.allCandidates.every((c) => c.emitted)).toBe(true);
        expect(result.allCandidates.every((c) => c.consecutiveStableCount === 1)).toBe(true);
      } finally {
        store.close();
      }
    },
  );

  sqliteIt(
    'a declined signature stays suppressed even though a fresh candidate would otherwise ' +
      'emit on its first computation (decline memory beats the liberal stability default)',
    async () => {
      const store = await makeStore();
      try {
        // Concept-ids required — isSuppressedByDecline only has a basis for
        // comparison when the candidate carries conceptIds (an empty set
        // never matches anything, by design: "no concept signal means no
        // basis for comparison").
        const declinedGroup: SuggestionEvidenceItem[] = Array.from({ length: 4 }, (_, i) => ({
          id: `d-${i}`,
          embedding: basis(0),
          conceptIds: ['concept-rust', 'concept-systems'],
          title: `rust systems evidence ${i}`,
        }));
        const stableGroup = groupEvidence('s', 4, 1, 'stable');

        const r1 = recomputeSuggestionCandidates(store, {
          scopeId: 'ws-decline',
          kind: 'split',
          evidence: [...declinedGroup, ...stableGroup],
          revisionId: 'r1',
        });
        // Liberal default: BOTH clusters emit on this first computation.
        expect(r1.newlyEmitted).toHaveLength(2);
        const declinedCandidate = r1.newlyEmitted.find((c) => c.memberIds[0]?.startsWith('d-'));
        expect(declinedCandidate).toBeDefined();

        // The user declines the rust/systems cluster — population-scoped
        // decline memory, keyed by its concept-id fingerprint at this
        // scope+kind (declineCandidate/declinedConceptSets), NOT the
        // per-fingerprint dismissCandidate mechanism.
        store.declineCandidate(
          'ws-decline',
          'split',
          declinedCandidate!.fingerprint,
          ['concept-rust', 'concept-systems'],
          5_000,
        );

        // A later recompute with a membership-drifted-but-concept-identical
        // version of the SAME declined cluster, alongside a genuinely NEW
        // stable-basis cluster that was never declined.
        const declinedDrifted: SuggestionEvidenceItem[] = [
          ...declinedGroup,
          { id: 'd-extra', embedding: basis(0), conceptIds: ['concept-rust', 'concept-systems'] },
        ];
        const freshGroup = groupEvidence('f', 4, 2, 'fresh');
        const r2 = recomputeSuggestionCandidates(store, {
          scopeId: 'ws-decline',
          kind: 'split',
          evidence: [...declinedDrifted, ...freshGroup],
          revisionId: 'r2',
        });

        // The declined cluster is suppressed — even under the liberal
        // default, decline memory still wins.
        const stillDeclined = r2.allCandidates.find((c) => c.memberIds.includes('d-0'));
        expect(stillDeclined?.emitted).toBe(false);
        expect(r2.newlyEmitted.some((c) => c.memberIds.includes('d-0'))).toBe(false);
        // The brand-new, never-declined cluster still emits on ITS first
        // computation — the liberal default is otherwise untouched.
        expect(r2.newlyEmitted.some((c) => c.memberIds.includes('f-0'))).toBe(true);
      } finally {
        store.close();
      }
    },
  );
});

describe('resolveSuggestionStabilityMinConsecutive / resolveSuggestionMinClusterMembers — env parsing', () => {
  const prevStability = process.env[SUGGESTION_STABILITY_ENV];
  const prevMinMembers = process.env[SUGGESTION_MIN_MEMBERS_ENV];

  afterEach(() => {
    if (prevStability === undefined) delete process.env[SUGGESTION_STABILITY_ENV];
    else process.env[SUGGESTION_STABILITY_ENV] = prevStability;
    if (prevMinMembers === undefined) delete process.env[SUGGESTION_MIN_MEMBERS_ENV];
    else process.env[SUGGESTION_MIN_MEMBERS_ENV] = prevMinMembers;
  });

  it('resolveSuggestionStabilityMinConsecutive defaults to 1 (liberal) when unset', () => {
    delete process.env[SUGGESTION_STABILITY_ENV];
    expect(resolveSuggestionStabilityMinConsecutive()).toBe(DEFAULT_STABILITY_MIN_CONSECUTIVE);
    expect(resolveSuggestionStabilityMinConsecutive()).toBe(1);
  });

  it('resolveSuggestionStabilityMinConsecutive accepts a valid override', () => {
    process.env[SUGGESTION_STABILITY_ENV] = '3';
    expect(resolveSuggestionStabilityMinConsecutive()).toBe(3);
  });

  it('resolveSuggestionStabilityMinConsecutive falls back to the default for garbage/below-1 values', () => {
    process.env[SUGGESTION_STABILITY_ENV] = '0';
    expect(resolveSuggestionStabilityMinConsecutive()).toBe(1);
    process.env[SUGGESTION_STABILITY_ENV] = 'not-a-number';
    expect(resolveSuggestionStabilityMinConsecutive()).toBe(1);
  });

  it('resolveSuggestionMinClusterMembers defaults to DEFAULT_MIN_CLUSTER_MEMBERS (unchanged) when unset', () => {
    delete process.env[SUGGESTION_MIN_MEMBERS_ENV];
    expect(resolveSuggestionMinClusterMembers()).toBe(DEFAULT_MIN_CLUSTER_MEMBERS);
  });

  it('resolveSuggestionMinClusterMembers accepts a valid override at/above the floor', () => {
    process.env[SUGGESTION_MIN_MEMBERS_ENV] = String(SUGGESTION_MIN_MEMBERS_FLOOR);
    expect(resolveSuggestionMinClusterMembers()).toBe(SUGGESTION_MIN_MEMBERS_FLOOR);
    process.env[SUGGESTION_MIN_MEMBERS_ENV] = '10';
    expect(resolveSuggestionMinClusterMembers()).toBe(10);
  });

  it('resolveSuggestionMinClusterMembers never goes below the floor — falls back to the default instead', () => {
    process.env[SUGGESTION_MIN_MEMBERS_ENV] = String(SUGGESTION_MIN_MEMBERS_FLOOR - 1);
    expect(resolveSuggestionMinClusterMembers()).toBe(DEFAULT_MIN_CLUSTER_MEMBERS);
    process.env[SUGGESTION_MIN_MEMBERS_ENV] = 'garbage';
    expect(resolveSuggestionMinClusterMembers()).toBe(DEFAULT_MIN_CLUSTER_MEMBERS);
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

describe('recomputeSuggestionCandidates — decline memory (dismissed) is sticky across recompute', () => {
  sqliteIt('a dismissed candidate stays dismissed after a later recompute with drifted-but-overlapping membership', async () => {
    const store = await makeStore();
    try {
      const groupA = groupEvidence('a', 4, 0, 'alpha');
      const groupB = groupEvidence('b', 4, 1, 'beta');
      const r1 = recomputeSuggestionCandidates(store, {
        scopeId: 'ws-1',
        kind: 'split',
        evidence: [...groupA, ...groupB],
        revisionId: 'r1',
      });
      const target = r1.allCandidates.find((c) => c.memberIds[0]?.startsWith('a-'));
      expect(target).toBeDefined();
      expect(store.dismissCandidate('ws-1', 'split', target!.fingerprint, 5_000)).toBe(true);

      // A tiny membership drift (one extra member) still overlaps well above
      // the 0.75 Jaccard match threshold, so the engine must recognize this
      // as "the same emerging cluster" and carry the dismissal forward.
      const groupADrifted = [...groupA, { id: 'a-extra', embedding: basis(0), title: 'alpha extra' }];
      const r2 = recomputeSuggestionCandidates(store, {
        scopeId: 'ws-1',
        kind: 'split',
        evidence: [...groupADrifted, ...groupB],
        revisionId: 'r2',
      });
      const carried = r2.allCandidates.find((c) => c.memberIds.includes('a-0'));
      expect(carried?.dismissed).toBe(true);
      expect(carried?.dismissedAtMs).toBe(5_000);
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

// ---- hybridSimilarity — sentence-level vector term (§12) -----------------

describe('hybridSimilarity — sentence-level vector term (§12), pooled fallback preserved', () => {
  const item = (
    id: string,
    embedding: Float32Array,
    sentenceEmbeddings?: readonly Float32Array[],
  ): SuggestionEvidenceItem => ({ id, embedding, ...(sentenceEmbeddings === undefined ? {} : { sentenceEmbeddings }) });

  it('uses sentence-level scoring when BOTH sides carry sentence vectors, even if pooled embeddings disagree', () => {
    const zero = new Float32Array(4); // pooled embedding absent/zero on both — the "16% coverage gap" case
    const left = item('l', zero, [basis(0, 4)]);
    const right = item('r', zero, [basis(0, 4)]);
    // Pooled cosine of two zero vectors is 0 (module's own zero-vector
    // floor); sentence vectors are IDENTICAL, so sentence-level scoring
    // still finds a perfect match despite neither side having a usable
    // pooled embedding at all.
    expect(hybridSimilarity(left, right, 0)).toBeCloseTo(1, 5);
  });

  it('falls back to pooled cosine, BYTE-IDENTICAL to the pre-§12 calculation, when either side lacks sentence vectors', () => {
    // Deliberately NON-unit-length vectors — this is the exact case that
    // would silently break if the pooled fallback ever routed through
    // sentenceInteraction.ts's pre-normalized-input assumption instead of
    // this module's own self-normalizing cosineSimilarity.
    const left = item('l', new Float32Array([2, 0, 0, 0]));
    const right = item('r', new Float32Array([0, 3, 0, 0]));
    expect(hybridSimilarity(left, right, 0)).toBeCloseTo(0, 10); // orthogonal, regardless of magnitude
    const same = item('s', new Float32Array([2, 0, 0, 0]));
    expect(hybridSimilarity(left, same, 0)).toBeCloseTo(1, 10); // parallel, regardless of magnitude
  });

  it('an empty sentenceEmbeddings array on one side is treated as "absent" — pooled fallback, not a zero score', () => {
    const left = item('l', basis(0, 4), []);
    const right = item('r', basis(0, 4), [basis(0, 4)]);
    expect(hybridSimilarity(left, right, 0)).toBeCloseTo(1, 5); // pooled cosine of identical vectors
  });
});

// ---- §12 calibrated new-category score (cohesion vs. external-best) -----

describe('computeClusterCohesion / computeExternalBest — pure functions', () => {
  it('cohesion is the mean pairwise late-interaction score among cluster members', () => {
    const members: SuggestionEvidenceItem[] = [
      { id: 'a', embedding: new Float32Array(0), sentenceEmbeddings: [basis(0, 4)] },
      { id: 'b', embedding: new Float32Array(0), sentenceEmbeddings: [basis(0, 4)] },
      { id: 'c', embedding: new Float32Array(0), sentenceEmbeddings: [basis(1, 4)] }, // orthogonal to a/b
    ];
    // Pairs: (a,b)=1.0, (a,c)=0, (b,c)=0 -> mean = 1/3.
    expect(computeClusterCohesion(members)).toBeCloseTo(1 / 3, 5);
  });

  it('cohesion of fewer than 2 members is 0 (nothing to pair)', () => {
    expect(computeClusterCohesion([{ id: 'a', embedding: new Float32Array(0) }])).toBe(0);
    expect(computeClusterCohesion([])).toBe(0);
  });

  it('externalBest is null when no existingWorkstreamSentenceVectors are supplied', () => {
    const members: SuggestionEvidenceItem[] = [
      { id: 'a', embedding: new Float32Array(0), sentenceEmbeddings: [basis(0, 4)] },
    ];
    expect(computeExternalBest(members, undefined, undefined)).toBeNull();
  });

  it('externalBest is null when no member carries sentence vectors, even with existing data supplied', () => {
    const members: SuggestionEvidenceItem[] = [{ id: 'a', embedding: basis(0, 4) }];
    const existing = new Map([['ws-x', [basis(0, 4)]]]);
    expect(computeExternalBest(members, existing, undefined)).toBeNull();
  });

  it('externalBest excludes the split candidate\'s OWN scope workstream', () => {
    const members: SuggestionEvidenceItem[] = [
      { id: 'a', embedding: new Float32Array(0), sentenceEmbeddings: [basis(0, 4)] },
    ];
    const existing = new Map([
      ['ws-own', [basis(0, 4)]], // identical, but excluded (own scope)
      ['ws-other', [basis(3, 4)]], // orthogonal, not excluded
    ]);
    expect(computeExternalBest(members, existing, 'ws-own')).toBeCloseTo(0, 5);
  });

  it('externalBest is the SINGLE largest member-to-workstream score across every member and workstream', () => {
    const members: SuggestionEvidenceItem[] = [
      { id: 'a', embedding: new Float32Array(0), sentenceEmbeddings: [basis(2, 4)] }, // weak match to ws-x
      { id: 'b', embedding: new Float32Array(0), sentenceEmbeddings: [basis(0, 4)] }, // strong match to ws-y
    ];
    const existing = new Map([
      ['ws-x', [basis(1, 4)]],
      ['ws-y', [basis(0, 4)]],
    ]);
    expect(computeExternalBest(members, existing, undefined)).toBeCloseTo(1, 5);
  });
});

describe('resolveSuggestionMargin — env parsing ("0 = emit on any positive margin — keep liberal")', () => {
  const original = process.env[SUGGESTION_MARGIN_ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[SUGGESTION_MARGIN_ENV];
    else process.env[SUGGESTION_MARGIN_ENV] = original;
  });

  it('defaults to DEFAULT_SUGGESTION_MARGIN when unset', () => {
    delete process.env[SUGGESTION_MARGIN_ENV];
    expect(resolveSuggestionMargin()).toBe(DEFAULT_SUGGESTION_MARGIN);
  });

  it('0 is a VALID, meaningful value — not treated as "unset"', () => {
    process.env[SUGGESTION_MARGIN_ENV] = '0';
    expect(resolveSuggestionMargin()).toBe(0);
  });

  it('negative/garbage falls back to the default', () => {
    process.env[SUGGESTION_MARGIN_ENV] = '-1';
    expect(resolveSuggestionMargin()).toBe(DEFAULT_SUGGESTION_MARGIN);
    process.env[SUGGESTION_MARGIN_ENV] = 'not-a-number';
    expect(resolveSuggestionMargin()).toBe(DEFAULT_SUGGESTION_MARGIN);
  });
});

describe('recomputeSuggestionCandidates — §12 calibrated new-category score (cohesion vs. external-best emit-rule margin)', () => {
  const withSentence = (items: readonly SuggestionEvidenceItem[], vec: Float32Array): SuggestionEvidenceItem[] =>
    items.map((item) => ({ ...item, sentenceEmbeddings: [vec] }));

  sqliteIt('a cohesive unfiled group with only a WEAK existing match emits, carrying both cohesion and externalBest', async () => {
    const store = await makeStore();
    try {
      const unfiled = withSentence(groupEvidence('u', 5, 0, 'unfiled'), basis(0));
      const result = recomputeSuggestionCandidates(store, {
        scopeId: '__unfiled__',
        kind: 'new-category',
        evidence: unfiled,
        revisionId: 'r1',
        existingWorkstreamSentenceVectors: new Map([['ws-existing', [basis(5)]]]), // near-orthogonal
      });
      const candidate = result.allCandidates[0]!;
      expect(candidate.emitted).toBe(true);
      expect(candidate.cohesion).toBeCloseTo(1, 5);
      expect(candidate.externalBest).toBeCloseTo(0, 5);
    } finally {
      store.close();
    }
  });

  sqliteIt('a cohesive unfiled group with a STRONG existing match does NOT emit (margin fails)', async () => {
    const store = await makeStore();
    try {
      const unfiled = withSentence(groupEvidence('u', 5, 0, 'unfiled'), basis(0));
      const result = recomputeSuggestionCandidates(store, {
        scopeId: '__unfiled__',
        kind: 'new-category',
        evidence: unfiled,
        revisionId: 'r1',
        existingWorkstreamSentenceVectors: new Map([['ws-existing', [basis(0)]]]), // identical
      });
      const candidate = result.allCandidates[0]!;
      expect(candidate.emitted).toBe(false);
      expect(candidate.externalBest).toBeCloseTo(candidate.cohesion, 5);
    } finally {
      store.close();
    }
  });

  sqliteIt('externalBest is null (margin gate never blocks) when no existingWorkstreamSentenceVectors are supplied — liberal, backfill-safe default', async () => {
    const store = await makeStore();
    try {
      const unfiled = withSentence(groupEvidence('u', 5, 0, 'unfiled'), basis(0));
      const result = recomputeSuggestionCandidates(store, {
        scopeId: '__unfiled__',
        kind: 'new-category',
        evidence: unfiled,
        revisionId: 'r1',
      });
      const candidate = result.allCandidates[0]!;
      expect(candidate.externalBest).toBeNull();
      expect(candidate.emitted).toBe(true);
    } finally {
      store.close();
    }
  });

  sqliteIt('an ALREADY-emitted candidate stays emitted even if a LATER recompute finds a strong external match (sticky — never retroactively un-emitted)', async () => {
    const store = await makeStore();
    try {
      const unfiled = withSentence(groupEvidence('u', 5, 0, 'unfiled'), basis(0));
      const first = recomputeSuggestionCandidates(store, {
        scopeId: '__unfiled__',
        kind: 'new-category',
        evidence: unfiled,
        revisionId: 'r1',
      });
      expect(first.allCandidates[0]?.emitted).toBe(true);
      const second = recomputeSuggestionCandidates(store, {
        scopeId: '__unfiled__',
        kind: 'new-category',
        evidence: unfiled,
        revisionId: 'r2',
        existingWorkstreamSentenceVectors: new Map([['ws-existing', [basis(0)]]]),
      });
      expect(second.allCandidates[0]?.emitted).toBe(true);
    } finally {
      store.close();
    }
  });

  sqliteIt('a SPLIT candidate excludes its OWN scope workstream from external-best comparison', async () => {
    const store = await makeStore();
    try {
      const groupA = withSentence(groupEvidence('a', 5, 0, 'kv-cache'), basis(0));
      const groupB = withSentence(groupEvidence('b', 5, 1, 'beta'), basis(1));
      const result = recomputeSuggestionCandidates(store, {
        scopeId: 'ws-1',
        kind: 'split',
        evidence: [...groupA, ...groupB],
        revisionId: 'r1',
        // ws-1 is THIS split's own scope — an identical vector under that
        // id must be excluded, not treated as a strong external match.
        existingWorkstreamSentenceVectors: new Map([
          ['ws-1', [basis(0)]],
          ['ws-other', [basis(5)]],
        ]),
      });
      const candidateA = result.allCandidates.find((c) => c.memberIds[0]?.startsWith('a-'))!;
      expect(candidateA.externalBest).toBeCloseTo(0, 5); // ws-1 excluded, ws-other is a weak/orthogonal match
      expect(candidateA.emitted).toBe(true);
    } finally {
      store.close();
    }
  });
});
