// Output validation for on-device generation — the gate that had to exist.
//
// On 2026-07-27 a gist ran for 61.5 seconds on an ordinary web page and
// produced "2 224 6 224 6 224 6 …" repeating. Nothing looked at it. It was
// POSTed to the companion as a gist, stored, and now feeds retrieval. The
// pipeline's only checks were "is it empty" and "is it the literal string
// SKIP" — neither of which a degenerate decode trips.
//
// So: NOTHING generated on-device reaches the companion unvalidated. This
// module is the single gate, pure and unit-tested, returning a TYPED verdict so
// the caller can say what happened instead of failing silently or, worse,
// saving garbage. It is deliberately conservative — every rule targets a shape
// that no usable title or gist has, so a false reject costs one retry while a
// false accept poisons the corpus permanently.
//
// The statistical rules are thin policy over scoreGeneration.ts, which owns the
// (observe-only) measurement. Thresholds live here.

import { detectContentLanguage, type ContentLanguage } from './language';
import {
  MIN_TOKENS_FOR_REPETITION,
  charLoopScore,
  letterRatio,
  repetitionScore,
  tokenizeForScoring,
  uniqueTokenRatio,
} from './scoreGeneration';

/** What is being generated — each kind has its own shape budget. */
export type GenerationKind = 'title' | 'gist' | 'chunk-gist';

/** Every way generated text can be unusable. One reason, one honest sentence. */
export type GenerationRejectionReason =
  | 'empty'
  | 'too-short'
  | 'too-long'
  | 'single-token'
  | 'multi-line'
  | 'control-chars'
  | 'markup'
  | 'repetitive'
  | 'low-diversity'
  | 'low-letter-ratio'
  | 'wrong-language';

export type GenerationVerdict =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: GenerationRejectionReason };

export interface ValidationContext {
  readonly kind: GenerationKind;
  /**
   * The language the output is REQUIRED to be in — the detected language of the
   * source content. English source must not come back as Chinese prose and vice
   * versa; a wrong-language gist is worse than no gist because it silently
   * poisons the multilingual retrieval corpus.
   */
  readonly language: ContentLanguage;
}

// --- Shape budgets per kind -------------------------------------------------

interface ShapeBudget {
  readonly minChars: number;
  readonly maxChars: number;
  readonly minTokens: number;
  readonly singleLine: boolean;
}

const SHAPE: Record<GenerationKind, ShapeBudget> = {
  // 4-10 words on one line; the contract caps titles at 200 chars.
  title: { minChars: 3, maxChars: 200, minTokens: 2, singleLine: true },
  // 2-3 sentences + entities; the content contract caps gists at 2000 chars.
  gist: { minChars: 24, maxChars: 2000, minTokens: 5, singleLine: false },
  // One sentence about one section of a document.
  'chunk-gist': { minChars: 16, maxChars: 400, minTokens: 3, singleLine: false },
};

// --- Statistical thresholds -------------------------------------------------

/**
 * Word 3-gram repetition above this is a decode loop. Healthy prose of any
 * length scores ~0.0-0.1 (a 2-3 sentence summary essentially never repeats a
 * whole 3-gram); the live failure scores ~0.98.
 */
export const MAX_REPETITION_SCORE = 0.35;
/**
 * Share of the single most frequent 8-character n-gram. Healthy prose < 0.05;
 * a text built from one repeating unit approaches 1.0. Catches loops that have
 * no token boundaries at all ("zzzz…", Han loops).
 */
export const MAX_CHAR_LOOP_SCORE = 0.15;
/**
 * Distinct-token floor, applied only once there are enough tokens to measure.
 * A long English gist still sits above 0.5; a loop collapses toward 0.
 */
export const MIN_UNIQUE_TOKEN_RATIO = 0.3;
/**
 * Letters over visible characters. The live failure was digits and spaces —
 * letterRatio 0.0. Even a version-number-heavy summary stays above 0.75.
 */
export const MIN_LETTER_RATIO = 0.5;

// --- Shape detectors --------------------------------------------------------

// C0 control characters (and DEL) must never appear in stored text. Tab, LF and
// CR are deliberately allowed. Written as a codepoint scan rather than a regex
// so no control character — literal OR escaped — appears in this source file.
const TAB = 9;
const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;
const FIRST_PRINTABLE = 0x20;
const DEL = 0x7f;

const hasControlChars = (text: string): boolean => {
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (cp === TAB || cp === LINE_FEED || cp === CARRIAGE_RETURN) continue;
    if (cp < FIRST_PRINTABLE || cp === DEL) return true;
  }
  return false;
};

const HTML_TAG = /<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?>/giu;
const CLOSING_TAG = /<\/[a-z][a-z0-9]*\s*>/iu;
const DOC_MARKUP = /<!doctype|<html\b|<script\b|<style\b|<\/body>/iu;
/** Below this many stray tag-shaped matches we assume generics ("List<String>"). */
const MARKUP_TAG_TOLERANCE = 3;

const looksLikeMarkup = (text: string): boolean => {
  if (DOC_MARKUP.test(text)) return true;
  if (CLOSING_TAG.test(text)) return true;
  const matches = text.match(HTML_TAG);
  return matches !== null && matches.length >= MARKUP_TAG_TOLERANCE;
};

/**
 * Language agreement. `mixed-en-zh` sources legitimately produce either script,
 * so nothing is rejected there. Otherwise the output's own detected bucket must
 * not be the OPPOSITE of the requested one — the detector's 'mixed' verdict is
 * accepted in both directions so a summary that quotes a foreign term survives.
 */
const languageDisagrees = (text: string, requested: ContentLanguage): boolean => {
  if (requested === 'mixed-en-zh') return false;
  const got = detectContentLanguage(text);
  if (requested === 'en') return got === 'zh';
  return got === 'en';
};

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Validate one generated string. Returns the trimmed text on success, or the
 * FIRST rule it violates. Order is cheapest-and-most-specific first, with the
 * repetition rules ahead of the character-class rule so a decode loop is named
 * as a loop (the actionable diagnosis) rather than as "mostly digits".
 *
 * Pure — no I/O, no model, no clock.
 */
export const validateGeneration = (raw: string, ctx: ValidationContext): GenerationVerdict => {
  const text = raw.trim();
  const budget = SHAPE[ctx.kind];

  if (text.length === 0) return { ok: false, reason: 'empty' };
  if (hasControlChars(text)) return { ok: false, reason: 'control-chars' };
  if (looksLikeMarkup(text)) return { ok: false, reason: 'markup' };
  if (budget.singleLine && /[\r\n]/u.test(text)) return { ok: false, reason: 'multi-line' };
  if (text.length > budget.maxChars) return { ok: false, reason: 'too-long' };
  if (text.length < budget.minChars) return { ok: false, reason: 'too-short' };

  const tokens = tokenizeForScoring(text);
  if (tokens.length < budget.minTokens) {
    return { ok: false, reason: tokens.length <= 1 ? 'single-token' : 'too-short' };
  }

  if (repetitionScore(tokens) > MAX_REPETITION_SCORE) return { ok: false, reason: 'repetitive' };
  if (charLoopScore(text) > MAX_CHAR_LOOP_SCORE) return { ok: false, reason: 'repetitive' };
  if (
    tokens.length >= MIN_TOKENS_FOR_REPETITION &&
    uniqueTokenRatio(tokens) < MIN_UNIQUE_TOKEN_RATIO
  ) {
    return { ok: false, reason: 'low-diversity' };
  }
  if (letterRatio(text) < MIN_LETTER_RATIO) return { ok: false, reason: 'low-letter-ratio' };
  if (languageDisagrees(text, ctx.language)) return { ok: false, reason: 'wrong-language' };

  return { ok: true, text };
};

/** Short human copy per reason — what the row tells the user, verbatim. */
export const rejectionCopy = (reason: GenerationRejectionReason): string => {
  switch (reason) {
    case 'empty':
      return 'the model returned nothing';
    case 'too-short':
      return 'the model returned too little text';
    case 'too-long':
      return 'the model ran past the length limit';
    case 'single-token':
      return 'the model returned a single word';
    case 'multi-line':
      return 'the model returned more than one line';
    case 'control-chars':
      return 'the model returned control characters';
    case 'markup':
      return 'the model returned markup instead of prose';
    case 'repetitive':
      return 'the model got stuck repeating itself';
    case 'low-diversity':
      return 'the model repeated the same few words';
    case 'low-letter-ratio':
      return 'the model returned mostly digits and punctuation';
    case 'wrong-language':
      return 'the model answered in the wrong language';
  }
};
