// Shared substring ranking — the single source of truth for the
// lexical title/label scoring that was duplicated verbatim (modulo
// two tuning constants) in SearchTab and NodeSearchBox.
//
// Lowercase substring match with a small score bias: an exact prefix
// match sorts above a mid-string match; a shorter primary line sorts
// above a longer one (so a hit on "Hacker News" beats a hit on
// "(775) I was laid off… - YouTube" when both match "ne").
//
// Parameterised — each call site passes its historical constants so
// this extraction is a strict no-op refactor. Unifying the constants
// is a separate, deliberate, verifiable change, not a silent one.

export interface SubstringRankOptions {
  /** Score ceiling before penalties/bonuses. SearchTab: 250, NodeSearchBox: 200. */
  readonly base?: number;
  /** Max characters of the primary line that count against the score.
   *  SearchTab: 80, NodeSearchBox: 50. */
  readonly maxLengthPenalty?: number;
  /** Added when the query matches at index 0. Both call sites: 100. */
  readonly prefixBonus?: number;
}

const DEFAULTS: Required<SubstringRankOptions> = {
  base: 250,
  maxLengthPenalty: 80,
  prefixBonus: 100,
};

/** Returns a score, or -1 when `primary` does not contain `query`. */
export const rankSubstring = (
  query: string,
  primary: string,
  options: SubstringRankOptions = {},
): number => {
  const base = options.base ?? DEFAULTS.base;
  const maxLengthPenalty = options.maxLengthPenalty ?? DEFAULTS.maxLengthPenalty;
  const prefixBonus = options.prefixBonus ?? DEFAULTS.prefixBonus;
  const p = primary.toLowerCase();
  const q = query.toLowerCase();
  const idx = p.indexOf(q);
  if (idx === -1) return -1;
  const lengthPenalty = Math.min(maxLengthPenalty, p.length);
  return base - lengthPenalty + (idx === 0 ? prefixBonus : 0);
};

/** Historical NodeSearchBox profile (base 200, length cap 50). */
export const NODE_SEARCH_RANK: SubstringRankOptions = { base: 200, maxLengthPenalty: 50 };
