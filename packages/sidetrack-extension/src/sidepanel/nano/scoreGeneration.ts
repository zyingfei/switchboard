// Deterministic quality signals for on-device generated text.
//
// The user's question was "can you measure based on the quality of output?".
// This module is the honest answer: NOT an ML judge, NOT entailment — a handful
// of cheap, explainable signals that would each, on their own, have caught the
// live 2026-07-27 failure ("2 224 6 224 6 224 6 …" saved as a gist). Two
// consumers:
//
//   * validateGeneration.ts turns these numbers into an accept/reject verdict
//     on the write path, so degenerate text never reaches the companion;
//   * the Health panel's on-device eval renders them next to each output, so
//     quality can be judged numerically instead of by eyeball.
//
// Everything here is PURE and synchronous. No model, no network, no I/O.

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

// Han codepoints are tokenized ONE CHARACTER PER TOKEN: Chinese prose has no
// spaces, so whitespace tokenization would collapse a whole sentence into a
// single "token" and every ratio below would read 1.0 — i.e. a Chinese
// repetition loop would score perfect. Per-character is the right granularity
// for Han (one glyph is roughly one morpheme).
const HAN_RANGES: readonly (readonly [number, number])[] = [
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
  [0x20000, 0x2a6df],
];

const isHanCodePoint = (cp: number): boolean => HAN_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);

// Letters for the character-class signal: Latin (incl. accented), Han, and
// kana. Digits, punctuation and symbols are deliberately NOT letters — the live
// failure was almost entirely digits, and that is the shape we must see.
const isLetterCodePoint = (cp: number): boolean =>
  (cp >= 0x41 && cp <= 0x5a) ||
  (cp >= 0x61 && cp <= 0x7a) ||
  (cp >= 0xc0 && cp <= 0x24f) ||
  (cp >= 0x3040 && cp <= 0x30ff) || // hiragana + katakana
  isHanCodePoint(cp);

/**
 * Split text into comparable tokens: whitespace/punctuation-delimited words,
 * lowercased, with each Han character standing alone. Pure.
 */
export const tokenizeForScoring = (text: string): readonly string[] => {
  const tokens: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current.length > 0) {
      tokens.push(current);
      current = '';
    }
  };
  for (const ch of text.toLowerCase()) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (isHanCodePoint(cp)) {
      flush();
      tokens.push(ch);
      continue;
    }
    // Word characters: letters, digits, and the intra-word joiners that would
    // otherwise shatter "cross-account" or "3.12" into noise.
    if (isLetterCodePoint(cp) || (cp >= 0x30 && cp <= 0x39) || ch === '-' || ch === '.') {
      current += ch;
      continue;
    }
    flush();
  }
  flush();
  // Trim joiners that ended up on a boundary ("accounts." → "accounts").
  return tokens
    .map((t) => t.replace(/^[-.]+/u, '').replace(/[-.]+$/u, ''))
    .filter((t) => t.length > 0);
};

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

/** Token n-gram width for the word-level repetition signal. */
export const REPETITION_NGRAM = 3;
/** Below this many tokens an n-gram statistic is noise; report 0 instead. */
export const MIN_TOKENS_FOR_REPETITION = 12;
/** Character n-gram width for the decode-loop signal. */
export const CHAR_LOOP_NGRAM = 8;
/** Below this many character n-grams the share statistic is noise. */
export const MIN_CHAR_NGRAMS_FOR_LOOP = 24;

// Build n-grams as joined keys. The separator is a parameter because the two
// callers need different ones: TOKEN n-grams join with a space (tokens never
// contain one, so the key is unambiguous), CHARACTER n-grams join with the
// empty string (single characters concatenate unambiguously by construction).
const ngrams = (items: readonly string[], n: number, sep: string): readonly string[] => {
  if (items.length < n) return [];
  const out: string[] = [];
  for (let i = 0; i + n <= items.length; i += 1) out.push(items.slice(i, i + n).join(sep));
  return out;
};

/**
 * Word-level repetition: the share of token 3-grams that are NOT new.
 * 0 = every 3-gram is distinct (healthy prose); →1 = the same few 3-grams over
 * and over (a decode loop). Returns 0 for text too short to measure.
 *
 * On the live failure ("2 224 6 224 6 …") the token stream cycles through two
 * distinct 3-grams, so this lands just under 1.0.
 */
export const repetitionScore = (tokens: readonly string[]): number => {
  if (tokens.length < MIN_TOKENS_FOR_REPETITION) return 0;
  const grams = ngrams(tokens, REPETITION_NGRAM, ' ');
  if (grams.length === 0) return 0;
  return 1 - new Set(grams).size / grams.length;
};

/**
 * Character-level decode-loop signal: the share of all 8-character n-grams
 * taken by the single MOST frequent one. Healthy prose spreads its 8-grams thin
 * (typically < 0.05); a text built from one repeating unit ("zzzz…", "abcabc…")
 * concentrates them and approaches 1.0. Complements repetitionScore, which
 * cannot see repetition inside a text that has no token boundaries.
 * Returns 0 for text too short to measure.
 */
export const charLoopScore = (text: string): number => {
  const compact = Array.from(text.replace(/\s+/gu, ' ').trim());
  const grams = ngrams(compact, CHAR_LOOP_NGRAM, '');
  if (grams.length < MIN_CHAR_NGRAMS_FOR_LOOP) return 0;
  const counts = new Map<string, number>();
  let max = 0;
  for (const g of grams) {
    const next = (counts.get(g) ?? 0) + 1;
    counts.set(g, next);
    if (next > max) max = next;
  }
  return max / grams.length;
};

/**
 * Share of non-whitespace characters that are letters (Latin / Han / kana).
 * The live failure scored 0.0 — it was digits and spaces only. Healthy prose
 * sits above 0.75 even when it quotes version numbers. Empty text scores 0.
 */
export const letterRatio = (text: string): number => {
  let letters = 0;
  let visible = 0;
  for (const ch of text) {
    if (/\s/u.test(ch)) continue;
    visible += 1;
    const cp = ch.codePointAt(0);
    if (cp !== undefined && isLetterCodePoint(cp)) letters += 1;
  }
  if (visible === 0) return 0;
  return letters / visible;
};

/** Distinct tokens over total tokens. A loop drives this toward 0. */
export const uniqueTokenRatio = (tokens: readonly string[]): number => {
  if (tokens.length === 0) return 0;
  return new Set(tokens).size / tokens.length;
};

/** Minimum content-word length for the groundedness signal. */
export const GROUNDEDNESS_MIN_WORD_CHARS = 4;

/**
 * Fraction of the output's CONTENT WORDS (tokens of >= 4 characters, or any Han
 * character, case-folded) that also occur in the source text.
 *
 * HEURISTIC, NOT ENTAILMENT. A high score means the output reuses the source's
 * vocabulary; it does NOT mean the output is true, and a faithful paraphrase
 * that uses synonyms will score low. It is useful as a RELATIVE signal (a
 * hallucinated or degenerate output scores far lower than a grounded one on the
 * same source), not as an absolute threshold — which is why nothing gates on it.
 * Returns 0 when there are no content words to measure.
 */
export const groundedness = (text: string, sourceText: string): number => {
  const contentWords = tokenizeForScoring(text).filter(
    (t) => t.length >= GROUNDEDNESS_MIN_WORD_CHARS || isHanCodePoint(t.codePointAt(0) ?? 0),
  );
  if (contentWords.length === 0) return 0;
  const sourceTokens = new Set(tokenizeForScoring(sourceText));
  if (sourceTokens.size === 0) return 0;
  let hits = 0;
  for (const w of contentWords) if (sourceTokens.has(w)) hits += 1;
  return hits / contentWords.length;
};

// ---------------------------------------------------------------------------
// The bundle
// ---------------------------------------------------------------------------

/** Length window used by `lengthOk` — anything usable as a title or a gist. */
export const MIN_USEFUL_CHARS = 12;
export const MAX_USEFUL_CHARS = 2000;

export interface GenerationScores {
  /** Word 3-gram repetition, 0 (healthy) → 1 (loop). Higher is worse. */
  readonly repetitionScore: number;
  /** Share of the most frequent 8-char n-gram, 0 → 1. Higher is worse. */
  readonly charLoopScore: number;
  /** Letters / visible characters, 0 → 1. Lower is worse. */
  readonly letterRatio: number;
  /** Distinct / total tokens, 0 → 1. Lower is worse. */
  readonly uniqueTokenRatio: number;
  /** Trimmed length inside [MIN_USEFUL_CHARS, MAX_USEFUL_CHARS]. */
  readonly lengthOk: boolean;
  /** Heuristic source-vocabulary overlap, 0 → 1. NOT entailment. */
  readonly groundedness: number;
}

/**
 * Score one generated text against the source it was generated from. Pure,
 * deterministic, observe-only — no thresholds are applied here; see
 * validateGeneration.ts for the accept/reject policy that uses these numbers.
 */
export const scoreGeneration = (text: string, sourceText: string): GenerationScores => {
  const trimmed = text.trim();
  const tokens = tokenizeForScoring(trimmed);
  return {
    repetitionScore: repetitionScore(tokens),
    charLoopScore: charLoopScore(trimmed),
    letterRatio: letterRatio(trimmed),
    uniqueTokenRatio: uniqueTokenRatio(tokens),
    lengthOk: trimmed.length >= MIN_USEFUL_CHARS && trimmed.length <= MAX_USEFUL_CHARS,
    groundedness: groundedness(trimmed, sourceText),
  };
};

/** One-line, fixed-width-ish rendering of the scores for the eval surface. */
export const formatScores = (s: GenerationScores): string =>
  [
    `rep ${s.repetitionScore.toFixed(2)}`,
    `loop ${s.charLoopScore.toFixed(2)}`,
    `letters ${s.letterRatio.toFixed(2)}`,
    `uniq ${s.uniqueTokenRatio.toFixed(2)}`,
    `ground ${s.groundedness.toFixed(2)}`,
    s.lengthOk ? 'len ok' : 'len bad',
  ].join(' · ');
