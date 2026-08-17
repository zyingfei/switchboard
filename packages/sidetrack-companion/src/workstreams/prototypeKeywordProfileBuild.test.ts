import { describe, expect, it } from 'bun:test';

import type { WorkstreamEvidenceItem } from './prototypeEvidence.js';
import { buildKeywordProfilesForWorkstreams, pageKeyForUrl } from './prototypeKeywordProfileBuild.js';

const item = (canonicalUrl: string): WorkstreamEvidenceItem => ({
  canonicalUrl,
  title: null,
  gist: null,
  firstSeenAtMs: 0,
});

describe('pageKeyForUrl', () => {
  it('matches the documented url:<canonicalUrl> convention', () => {
    expect(pageKeyForUrl('https://example.test/a')).toBe('url:https://example.test/a');
  });
});

describe('buildKeywordProfilesForWorkstreams — joins the keyword-concept layer', () => {
  it('builds a profile from members the keyword layer has indexed', () => {
    // Two workstreams so 'duckdb'/'olap' (unique to ws-ml) get a strictly
    // positive idf — a single-workstream corpus would give every concept
    // idf=0 by construction (see prototypeKeywordProfile.test.ts).
    const byWorkstream = new Map<string, readonly WorkstreamEvidenceItem[]>([
      ['ws-ml', [item('https://a.test/1'), item('https://a.test/2')]],
      ['ws-cooking', [item('https://b.test/1')]],
    ]);
    const keywordsByPage = new Map<string, readonly string[]>([
      ['url:https://a.test/1', ['duckdb', 'olap']],
      ['url:https://a.test/2', ['duckdb']],
      ['url:https://b.test/1', ['recipe']],
    ]);
    const conceptByKeyword = new Map<string, string>([
      ['duckdb', 'concept-duckdb'],
      ['olap', 'concept-olap'],
      ['recipe', 'concept-recipe'],
    ]);
    const { profiles, idf } = buildKeywordProfilesForWorkstreams(byWorkstream, {
      keywordsForPage: (key) => keywordsByPage.get(key),
      conceptForKeyword: (keyword) => conceptByKeyword.get(keyword),
    });
    expect(profiles.get('ws-ml')!.weights.get('concept-duckdb')).toBeGreaterThan(0);
    expect(idf.size).toBeGreaterThan(0);
  });

  it('a page never indexed by the keyword layer (undefined) contributes nothing, never throws', () => {
    const byWorkstream = new Map<string, readonly WorkstreamEvidenceItem[]>([
      ['ws-ml', [item('https://a.test/unindexed')]],
    ]);
    const { profiles } = buildKeywordProfilesForWorkstreams(byWorkstream, {
      keywordsForPage: () => undefined,
      conceptForKeyword: () => undefined,
    });
    expect(profiles.get('ws-ml')!.weights.size).toBe(0);
  });

  it('a keyword with no concept assignment yet is skipped, not a fatal join failure', () => {
    const byWorkstream = new Map<string, readonly WorkstreamEvidenceItem[]>([
      ['ws-ml', [item('https://a.test/1')]],
    ]);
    const { profiles } = buildKeywordProfilesForWorkstreams(byWorkstream, {
      keywordsForPage: () => ['unassigned-keyword'],
      conceptForKeyword: () => undefined,
    });
    expect(profiles.get('ws-ml')!.weights.size).toBe(0);
  });
});
