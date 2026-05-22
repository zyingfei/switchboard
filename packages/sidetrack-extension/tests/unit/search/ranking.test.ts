import { describe, expect, it } from 'vitest';

import { NODE_SEARCH_RANK, rankSubstring } from '../../../src/sidepanel/search/ranking';

describe('rankSubstring', () => {
  it('returns -1 when the query is not a substring', () => {
    expect(rankSubstring('zzz', 'Hacker News')).toBe(-1);
  });

  it('is case-insensitive', () => {
    expect(rankSubstring('HACKER', 'hacker news')).toBeGreaterThan(0);
    expect(rankSubstring('hacker', 'HACKER NEWS')).toBeGreaterThan(0);
  });

  it('a prefix match outranks a mid-string match (default profile)', () => {
    const prefix = rankSubstring('hack', 'Hacker News');
    const mid = rankSubstring('news', 'Hacker News');
    expect(prefix).toBeGreaterThan(mid);
  });

  it('a shorter primary outranks a longer one for the same query', () => {
    const short = rankSubstring('ne', 'Hacker News');
    const long = rankSubstring('ne', '(775) I was laid off… - YouTube');
    expect(short).toBeGreaterThan(long);
  });

  it('preserves the exact historical SearchTab numbers (base 250, cap 80, bonus 100)', () => {
    // prefix hit on a 11-char string: 250 - 11 + 100
    expect(rankSubstring('hacker', 'hacker news')).toBe(250 - 11 + 100);
    // mid hit, no prefix bonus: 250 - 11
    expect(rankSubstring('news', 'hacker news')).toBe(250 - 11);
    // length penalty caps at 80
    expect(rankSubstring('x', 'x'.repeat(200))).toBe(250 - 80 + 100);
  });

  it('preserves the exact historical NodeSearchBox numbers (base 200, cap 50)', () => {
    expect(rankSubstring('hacker', 'hacker news', NODE_SEARCH_RANK)).toBe(200 - 11 + 100);
    expect(rankSubstring('news', 'hacker news', NODE_SEARCH_RANK)).toBe(200 - 11);
    expect(rankSubstring('x', 'x'.repeat(200), NODE_SEARCH_RANK)).toBe(200 - 50 + 100);
  });
});
