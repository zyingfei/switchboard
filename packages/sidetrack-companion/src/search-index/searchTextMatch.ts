// Shared search-text matching primitives for W2 of the F8 IVM plan
// (docs/plans/2026-08-16-f8-ivm-designs.md). Extracted so the new
// incremental sidecar stores (searchQueryIndexStore, captureTextFtsStore)
// reproduce the FULL BUILD's existing search-query semantics exactly,
// rather than drifting from a second hand-copy of the same logic.
//
// AMENDMENT 1 (plan doc, W2 section) requires the equivalence test to
// pin tokenizer parity between FTS5 and the JS whole-word matcher. The
// only way to guarantee byte-identical edges is for both the full
// build and the incremental path to run the SAME predicate — so this
// module is the one true implementation, extracted verbatim from the
// full build rather than reimplemented.
//
// `matchesWholeWordQuery` / `escapeRegexForWholeWordMatch` are a
// byte-for-byte extraction of the inline predicate in
// src/connections/snapshot.ts Pass 6 ("search-query content match"),
// currently duplicated inline as (snapshot.ts:3014, 3036, 3048 as of
// 2026-08-16):
//   const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
//   new RegExp(`\\b${escapeRegex(query)}\\b`, 'iu').test(text)
// snapshot.ts should import this helper back so there is exactly ONE
// implementation (not done here — this task is standalone new files
// only, no wiring into the materializer/snapshot builder yet).
//
// NOTE on behavior: JS's `\b` is ASCII-`\w`-only even with the `u`
// flag — it does NOT treat Unicode letters as "word" characters. A
// query ending or starting on a non-ASCII letter (e.g. "café", "东京")
// can fail to match text where it's flanked by whitespace/punctuation,
// even on an exact literal occurrence. This is a real quirk of the
// CURRENT production matcher, not something this extraction fixes —
// parity means reproducing it exactly, including this quirk.
//
// `normalizeSearchQuery` is byte-for-byte the same normalization
// duplicated identically in src/ranker/candidates.ts:583-584 and
// src/ranker/features.ts:456-457 (both private, unexported). Those
// two ranker modules should also import this back eventually so the
// `same_search_query` candidate-key normalization has one home.

/** Escape regex metacharacters so a literal query string can be
 *  embedded in a `\b...\b` pattern. Verbatim copy of
 *  src/connections/snapshot.ts's inline `escapeRegex`. */
export const escapeRegexForWholeWordMatch = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-word, case-insensitive substring test — verbatim semantics
 *  of src/connections/snapshot.ts Pass 6's per-query compiled regex
 *  (`new RegExp(\`\\b${escapeRegex(query)}\\b\`, 'iu')`). `query` is
 *  expected to already be trimmed/lowercased by the caller, exactly
 *  as Pass 6 does before compiling — this function does not
 *  re-normalize so it stays a pure, literal port. */
export const matchesWholeWordQuery = (text: string, query: string): boolean => {
  if (text.length === 0 || query.length === 0) return false;
  const regex = new RegExp(`\\b${escapeRegexForWholeWordMatch(query)}\\b`, 'iu');
  return regex.test(text);
};

/** Search-query normalization for the `same_search_query` ranker
 *  candidate key. Verbatim copy of the identical private helper in
 *  src/ranker/candidates.ts:583-584 and src/ranker/features.ts:456-457
 *  (whitespace-collapse + trim + lowercase — a stricter normalization
 *  than snapshot.ts Pass 3's plain `.trim().toLowerCase()` used for
 *  the `metadata.searchQuery` node field). */
export const normalizeSearchQuery = (value: string): string =>
  value.replace(/\s+/gu, ' ').trim().toLowerCase();

