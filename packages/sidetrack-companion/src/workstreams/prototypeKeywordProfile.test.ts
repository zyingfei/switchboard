import { describe, expect, it } from 'bun:test';

import {
  blendVectorAndKeywordScore,
  buildWorkstreamConceptProfiles,
  keywordMatchWhy,
  scorePageAgainstProfile,
  type WorkstreamKeywordMember,
} from './prototypeKeywordProfile.js';

const member = (pairs: readonly [string, string][]): WorkstreamKeywordMember => ({
  pairs: pairs.map(([keyword, conceptId]) => ({ keyword, conceptId })),
});

describe('buildWorkstreamConceptProfiles — idf over the workstream corpus', () => {
  it('a concept present in every workstream gets idf===0, contributing ~0 to every profile weight', () => {
    // 'concept-guide' (raw keyword "guide") appears in ALL THREE workstreams
    // below — the meta-register-prose failure mode restated in keyword form.
    const byWorkstream = new Map<string, readonly WorkstreamKeywordMember[]>([
      [
        'ws-ml',
        [
          member([
            ['guide', 'concept-guide'],
            ['duckdb', 'concept-duckdb'],
          ]),
          member([['olap', 'concept-olap']]),
        ],
      ],
      ['ws-cooking', [member([['guide', 'concept-guide']]), member([['recipe', 'concept-recipe']])]],
      ['ws-travel', [member([['guide', 'concept-guide']])]],
    ]);

    const { profiles, idf } = buildWorkstreamConceptProfiles(byWorkstream);
    expect(idf.get('concept-guide')).toBe(0);

    const mlProfile = profiles.get('ws-ml')!;
    expect(mlProfile.weights.get('concept-guide')).toBe(0);
    // A workstream-specific concept (duckdb, only in ws-ml) keeps a
    // strictly positive weight — the down-weighting is SELECTIVE, not a
    // blanket zeroing of every concept.
    expect(mlProfile.weights.get('concept-duckdb')).toBeGreaterThan(0);
  });

  it('a workstream-unique concept has the highest idf in the corpus', () => {
    const byWorkstream = new Map<string, readonly WorkstreamKeywordMember[]>([
      ['ws-a', [member([['duckdb', 'concept-duckdb']])]],
      ['ws-b', [member([['recipe', 'concept-recipe']])]],
      ['ws-c', [member([['travel', 'concept-travel']])]],
    ]);
    const { idf } = buildWorkstreamConceptProfiles(byWorkstream);
    // Every concept here is unique to one workstream (df=1) — all idf values
    // should agree exactly (symmetry check on the smoothing formula).
    expect(idf.get('concept-duckdb')).toBe(idf.get('concept-recipe'));
    expect(idf.get('concept-duckdb')).toBeGreaterThan(0);
  });

  it('displayKeyword picks the workstream-local most-frequent raw keyword for a concept', () => {
    const byWorkstream = new Map<string, readonly WorkstreamKeywordMember[]>([
      [
        'ws-ml',
        [
          member([['duckdb', 'concept-db']]),
          member([['duckdb', 'concept-db']]),
          member([['sql-db', 'concept-db']]),
        ],
      ],
    ]);
    const { profiles } = buildWorkstreamConceptProfiles(byWorkstream);
    expect(profiles.get('ws-ml')!.displayKeyword.get('concept-db')).toBe('duckdb');
  });
});

describe('scorePageAgainstProfile — weighted overlap, bounded [0,1]', () => {
  it('a concept present in every workstream (idf=0) does not inflate the score even with heavy raw overlap', () => {
    const byWorkstream = new Map<string, readonly WorkstreamKeywordMember[]>([
      ['ws-ml', [member([['guide', 'concept-guide']]), member([['duckdb', 'concept-duckdb']])]],
      ['ws-cooking', [member([['guide', 'concept-guide']])]],
    ]);
    const { profiles, idf } = buildWorkstreamConceptProfiles(byWorkstream);
    const mlProfile = profiles.get('ws-ml')!;

    // A cooking page that ONLY shares the universal "guide" concept with
    // ws-ml must score ~0 against it, not a false-positive high overlap.
    const result = scorePageAgainstProfile(['concept-guide'], idf, mlProfile);
    expect(result.score).toBe(0);
    expect(result.matchedConceptIds).toEqual([]);
  });

  it('a distinctive shared concept produces a strictly positive, bounded score', () => {
    const byWorkstream = new Map<string, readonly WorkstreamKeywordMember[]>([
      ['ws-ml', [member([['duckdb', 'concept-duckdb']]), member([['olap', 'concept-olap']])]],
      ['ws-cooking', [member([['recipe', 'concept-recipe']])]],
    ]);
    const { profiles, idf } = buildWorkstreamConceptProfiles(byWorkstream);
    const mlProfile = profiles.get('ws-ml')!;

    const result = scorePageAgainstProfile(['concept-duckdb', 'concept-olap'], idf, mlProfile);
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.matchedConceptIds).toContain('concept-duckdb');
    expect(result.matchedConceptIds).toContain('concept-olap');
  });

  it('a page whose concepts are entirely absent from the profile scores 0', () => {
    const byWorkstream = new Map<string, readonly WorkstreamKeywordMember[]>([
      ['ws-ml', [member([['duckdb', 'concept-duckdb']])]],
    ]);
    const { profiles, idf } = buildWorkstreamConceptProfiles(byWorkstream);
    const result = scorePageAgainstProfile(['concept-unrelated'], idf, profiles.get('ws-ml')!);
    expect(result).toEqual({ score: 0, matchedConceptIds: [] });
  });

  it('a page with no concepts at all scores 0, never throws', () => {
    const byWorkstream = new Map<string, readonly WorkstreamKeywordMember[]>([
      ['ws-ml', [member([['duckdb', 'concept-duckdb']])]],
    ]);
    const { profiles, idf } = buildWorkstreamConceptProfiles(byWorkstream);
    expect(scorePageAgainstProfile([], idf, profiles.get('ws-ml')!)).toEqual({
      score: 0,
      matchedConceptIds: [],
    });
  });
});

describe('keywordMatchWhy — self-explaining match strings', () => {
  it('names the matched concepts by their display keyword', () => {
    const displayKeyword = new Map([
      ['concept-duckdb', 'duckdb'],
      ['concept-olap', 'olap'],
    ]);
    const why = keywordMatchWhy(['concept-duckdb', 'concept-olap'], displayKeyword);
    expect(why).toBe('matches duckdb, olap from this workstream\'s pages');
  });

  it('returns null when nothing matched', () => {
    expect(keywordMatchWhy([], new Map())).toBeNull();
  });
});

describe('blendVectorAndKeywordScore — env-weighted, degrades cleanly', () => {
  it('degrades to pure vector score when the keyword score is 0 (vectors-only, identical to pre-change)', () => {
    expect(blendVectorAndKeywordScore(0.73, 0, 0.3)).toBe(0.73);
  });

  it('blends toward the keyword score as weight increases', () => {
    const low = blendVectorAndKeywordScore(0.5, 1, 0.1);
    const high = blendVectorAndKeywordScore(0.5, 1, 0.9);
    expect(high).toBeGreaterThan(low);
  });

  it('stays bounded [0,1]', () => {
    expect(blendVectorAndKeywordScore(1, 1, 0.5)).toBeLessThanOrEqual(1);
    expect(blendVectorAndKeywordScore(0, 0, 0.5)).toBeGreaterThanOrEqual(0);
  });
});
