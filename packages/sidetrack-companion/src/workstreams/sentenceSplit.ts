// Sentence splitter — "the attention of sentence matters"
// (docs/plans/2026-08-16-category-flexibility-hyde.md §12, USER DESIGN
// DIRECTIVE 2026-08-17).
//
// WHY THIS EXISTS. Single-vector-per-gist pooling (mean-pool the whole
// gist+title into one embedding) produced two independently-verified
// failure modes: (1) a noise sentence pollutes the pooled mean — the
// pineapple-cake incident (prototypeMedoids.ts's header): a food page's
// terminology sentence landed in an ML workstream's prototype set because
// nothing separated "this workstream's actual topic sentence" from "one
// throwaway aside in the same gist"; (2) a generic sentence DOMINATES the
// pool — three unrelated workstreams tied at ~0.82 because meta-register
// prose ("this page covers various topics related to...") is close to
// every tech page in pooled-cosine space (prototypeContrastMargin.ts's
// header). Splitting into sentences and scoring per-sentence (see
// sentenceInteraction.ts) lets a downstream max/top-k operate over
// INDIVIDUAL claims instead of one blurred average — a noise sentence can
// no longer drag a good match down, and a generic sentence can no longer
// masquerade as a confident match on its own (it is one vote among several,
// not the whole page).
//
// DELIBERATELY SIMPLE, DETERMINISTIC, NO NLP LIBRARY. Same bar as
// suggestions/tokens.ts's normalizeTokens and keywordExtract.ts's
// deterministic fallback — this is not a sentence-boundary-disambiguation
// research project, it is "split on the punctuation/newlines that actually
// end a sentence in the common case, cheaply enough to run inline on every
// resolve." CJK-aware: `。` `！` `？` (and their ASCII-width siblings `！`
// `？` already covered by the same codepoints) end a sentence immediately,
// no trailing space required — unlike ASCII `.`/`!`/`?`, which DO require a
// following whitespace-or-EOF to count (so "3.14" and "e.g. next" don't
// fragment on every period). A bare newline is always a boundary — gists
// are short synthesized summaries, not prose where mid-thought line wraps
// are common.

export const SENTENCE_SPLIT_MAX_ENV = 'SIDETRACK_SENTENCE_SPLIT_MAX';
export const DEFAULT_SENTENCE_SPLIT_MAX = 6;

/** Parse SIDETRACK_SENTENCE_SPLIT_MAX — a >=1 integer cap on sentences per
 *  page (title + gist sentences combined). Absent/garbage/<1 falls back to
 *  the default, same silent-fallback idiom as every other env knob in this
 *  feature area (resolveKeywordClusterWeight, resolvePrototypeKeywordWeight,
 *  etc.). */
export const resolveSentenceSplitMax = (): number => {
  const raw = process.env[SENTENCE_SPLIT_MAX_ENV];
  if (raw === undefined || raw === '') return DEFAULT_SENTENCE_SPLIT_MAX;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_SENTENCE_SPLIT_MAX;
  return parsed;
};

export const SENTENCE_MAX_CHARS_ENV = 'SIDETRACK_SENTENCE_MAX_CHARS';
export const DEFAULT_SENTENCE_MAX_CHARS = 240;

/** Parse SIDETRACK_SENTENCE_MAX_CHARS — a >=1 integer per-sentence length
 *  cap (a very long run-on "sentence" — no terminator found for a while —
 *  must not become an oversized embed input). */
export const resolveSentenceMaxChars = (): number => {
  const raw = process.env[SENTENCE_MAX_CHARS_ENV];
  if (raw === undefined || raw === '') return DEFAULT_SENTENCE_MAX_CHARS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_SENTENCE_MAX_CHARS;
  return parsed;
};

/** Below this many characters, a "sentence" is noise (stray punctuation, a
 *  lone word fragment from an aggressive split) — dropped rather than
 *  embedded. Small on purpose: short CJK sentences are legitimately dense
 *  (few characters carry real meaning), so this must not filter those out. */
const SENTENCE_MIN_CHARS = 3;

const ASCII_TERMINATORS = new Set(['.', '!', '?']);
const CJK_TERMINATORS = new Set(['。', '！', '？']);

export interface SplitSentencesOptions {
  readonly max?: number;
  readonly maxCharsPerSentence?: number;
}

const clampLength = (text: string, maxChars: number): string =>
  text.length > maxChars ? text.slice(0, maxChars).trim() : text;

/**
 * Deterministic, CJK-aware sentence splitter over one text block. Pure, no
 * I/O. Boundaries: a CJK terminator ends a sentence immediately; an ASCII
 * terminator ends a sentence only when followed by whitespace or
 * end-of-string (so "3.14" / "U.S." / "e.g." don't fragment); a newline is
 * always a boundary. Sentences shorter than SENTENCE_MIN_CHARS (after
 * trimming) are dropped as noise. Capped at `max` sentences (default
 * resolveSentenceSplitMax()) and `maxCharsPerSentence` (default
 * resolveSentenceMaxChars()) — a sentence longer than the cap is truncated,
 * never dropped (a truncated real sentence still carries more signal than
 * omitting it).
 */
export const splitIntoSentences = (
  text: string,
  options: SplitSentencesOptions = {},
): readonly string[] => {
  const max = options.max ?? resolveSentenceSplitMax();
  const maxChars = options.maxCharsPerSentence ?? resolveSentenceMaxChars();
  const trimmed = text.trim();
  if (trimmed.length === 0 || max <= 0) return [];

  const sentences: string[] = [];
  let start = 0;
  const pushCandidate = (rawEnd: number, nextStart: number): void => {
    const candidate = trimmed.slice(start, rawEnd).trim();
    if (candidate.length >= SENTENCE_MIN_CHARS) {
      sentences.push(clampLength(candidate, maxChars));
    }
    start = nextStart;
  };

  for (let i = 0; i < trimmed.length && sentences.length < max; i += 1) {
    const ch = trimmed[i]!;
    if (CJK_TERMINATORS.has(ch)) {
      pushCandidate(i + 1, i + 1);
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      pushCandidate(i, i + 1);
      continue;
    }
    if (ASCII_TERMINATORS.has(ch)) {
      const next = trimmed[i + 1];
      if (next === undefined || /\s/u.test(next)) {
        pushCandidate(i + 1, i + 1);
      }
    }
  }
  if (sentences.length < max && start < trimmed.length) {
    pushCandidate(trimmed.length, trimmed.length);
  }
  return sentences.slice(0, max);
};

export type PageSentenceSource = 'title' | 'gist';

export interface PageSentence {
  readonly source: PageSentenceSource;
  readonly text: string;
}

/**
 * Page-level composition: the title is its own sentence (never
 * further split — a title is already a single unit), followed by the
 * gist's own sentences, combined bounded at `max` total. Either input may
 * be null/empty; a page with neither yields []. Deterministic — the SAME
 * (title, gist) pair always yields the SAME sentence list in the SAME
 * order (title first), which is what makes this safe to call repeatedly
 * (serve-time per-resolve, and backfill re-runs) without a stability
 * mechanism of its own.
 */
export const splitPageIntoSentences = (
  title: string | null | undefined,
  gist: string | null | undefined,
  options: SplitSentencesOptions = {},
): readonly PageSentence[] => {
  const max = options.max ?? resolveSentenceSplitMax();
  const maxChars = options.maxCharsPerSentence ?? resolveSentenceMaxChars();
  if (max <= 0) return [];
  const out: PageSentence[] = [];
  const trimmedTitle = (title ?? '').trim();
  if (trimmedTitle.length >= SENTENCE_MIN_CHARS) {
    out.push({ source: 'title', text: clampLength(trimmedTitle, maxChars) });
  }
  const remaining = max - out.length;
  if (remaining > 0 && gist !== null && gist !== undefined && gist.trim().length > 0) {
    for (const sentence of splitIntoSentences(gist, { max: remaining, maxCharsPerSentence: maxChars })) {
      out.push({ source: 'gist', text: sentence });
    }
  }
  return out.slice(0, max);
};
