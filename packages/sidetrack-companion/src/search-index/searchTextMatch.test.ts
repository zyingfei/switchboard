import { describe, expect, it } from 'vitest';

import { matchesWholeWordQuery, normalizeSearchQuery } from './searchTextMatch.js';

describe('matchesWholeWordQuery — verbatim port of snapshot.ts Pass 6', () => {
  it('matches a plain whole word case-insensitively', () => {
    expect(matchesWholeWordQuery('I love GraphQL apis', 'graphql')).toBe(true);
  });

  it('rejects a substring that is not a whole word ("go" vs "google")', () => {
    expect(matchesWholeWordQuery('google search results', 'go')).toBe(false);
  });

  it('matches "go" as a standalone word', () => {
    expect(matchesWholeWordQuery('let us go now', 'go')).toBe(true);
  });

  it('escapes regex metacharacters in the query (interior, so \\b anchors still land on ASCII letters)', () => {
    // '(' ')' would be interpreted as a capture group if unescaped —
    // that wouldn't change whether this specific case matches, so
    // assert the metacharacter is treated literally with a negative
    // control: unescaped '.' would act as a wildcard and match any
    // character, which this must NOT do.
    expect(matchesWholeWordQuery('call a(b)c now', 'a(b)c')).toBe(true);
    expect(matchesWholeWordQuery('call aXbYc now', 'a(b)c')).toBe(false);
  });

  it('returns false for empty text or query', () => {
    expect(matchesWholeWordQuery('', 'go')).toBe(false);
    expect(matchesWholeWordQuery('go', '')).toBe(false);
  });

  // Documented quirk (see module comment): JS `\b` is ASCII-\w-only,
  // even with the `u` flag, so a query edge sitting on a non-ASCII
  // letter can fail even on an exact literal occurrence. Parity means
  // reproducing this exactly, not "fixing" it.
  it('unicode quirk: accented word at a punctuation/whitespace edge does not match', () => {
    expect(matchesWholeWordQuery('I love café.', 'café')).toBe(false);
    expect(matchesWholeWordQuery('I love café now', 'café')).toBe(false);
  });

  it('unicode: a query with ASCII edges matches even with a unicode interior', () => {
    expect(matchesWholeWordQuery('I love café au lait today', 'café au lait')).toBe(true);
  });

  it('unicode: CJK sandwiched between ASCII word chars matches (boundary is symmetric)', () => {
    expect(matchesWholeWordQuery('x东京y', '东京')).toBe(true);
  });

  it('unicode: CJK surrounded by whitespace does not match (both sides non-ASCII-word)', () => {
    expect(matchesWholeWordQuery(' 东京 ', '东京')).toBe(false);
  });
});

describe('normalizeSearchQuery — verbatim port of ranker/candidates.ts + ranker/features.ts', () => {
  it('collapses internal whitespace, trims, and lowercases', () => {
    expect(normalizeSearchQuery('  Machine   Learning  ')).toBe('machine learning');
  });

  it('is idempotent', () => {
    const once = normalizeSearchQuery('  Foo   Bar ');
    expect(normalizeSearchQuery(once)).toBe(once);
  });
});
