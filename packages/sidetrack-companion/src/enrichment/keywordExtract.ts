// Keyword extraction — the parser + deterministic-extractor half of the
// keyword layer (docs/plans/2026-08-16-category-flexibility-hyde.md,
// "Keywords as sparse-data clustering features" section).
//
// SAME SHAPE AS entityExtract.ts, DELIBERATELY. entityExtract.ts already
// proved the pattern this repo wants for "get more structure out of a gist
// without a second model call": the gist-synthesis prompt asks the model to
// append a labelled section to the SAME text it already generates, and a
// PURE, REPLAYABLE parser recovers it downstream. That buys the same three
// properties here it bought there:
//   1. RETROACTIVE — covers every gist already in the vault the moment the
//      deterministic path (below) ships, no backfill event needed.
//   2. RETRACTION-SAFE — a caller folds this over the SAME retraction-aware
//      GistLookup contentEnrichment.ts already produces; nothing here needs
//      its own tombstone logic.
//   3. RE-PARSEABLE — a better extractor improves history, not just new
//      gists.
//
// TWO PATHS, chosen by what is actually IN the gist text — not by a second
// model call:
//
//   1. LLM-AUTHORED. `titleSynthesis.ts`'s GIST_PROMPT_PREFIX /
//      GIST_SYNTHESIS_PROMPT_PREFIX (packages/sidetrack-extension) now ask
//      an EN gist to end with one line, "Keywords: term, term, term" —
//      mirroring how GIST_SYNTHESIS_PROMPT_PREFIX already asks for "the key
//      entities" in the very same call. When that line is found AND the
//      gist's own detected language is 'en', it is parsed and trusted.
//   2. DETERMINISTIC. Frequency-ranked, stopword-filtered extraction
//      straight over the gist text, CJK-aware (no segmentation library —
//      Han runs + adjacent-character bigrams, the same fallback strategy
//      search/analyzer.ts uses for CJK substring queries). Used whenever
//      (1) doesn't apply:
//        - zh / mixed-en-zh gists — the model is never trusted to emit a
//          reliable "Keywords:" line for zh in this codebase (the same "zh
//          hazard" paid for repeatedly elsewhere: appleFmEngine.ts never
//          receives zh input at all, prototypeGeneration.ts selects real
//          excerpts instead of generating for zh-dominant workstreams). If a
//          zh/mixed gist happens to contain something that LOOKS like a
//          "Keywords:" line, it is still ignored — the deterministic path is
//          taken unconditionally for non-English gists.
//        - EN gists with no "Keywords:" line at all — every gist saved
//          BEFORE this feature shipped, or one where the model skipped the
//          section. This is exactly what makes the backfill lane
//          (keywordBackfillLane.ts) a plain re-run of this SAME function
//          rather than a special case: backfill and "the zh path" are one
//          code path, not two.
//
// NORMALIZATION. Unlike entities (which preserve display casing because a
// user reads them as proper nouns), a keyword is a DISCRETE FEATURE fed into
// an inverted index and a concept-similarity fold — lowercased always, so
// "Kubernetes" and "kubernetes" are the same posting-list entry from the
// start rather than relying on a downstream case-fold to unify them.
//
// TYPED EMPTINESS + BOUNDED + DROP-REPORTED, same house rules as
// entityExtract.ts: `found` distinguishes "no Keywords: section" from "the
// section exists and said none"; every candidate the length/count bounds
// reject is COUNTED in `dropped`, never silently discarded.

// ---- contract ---------------------------------------------------------

export type GistLanguage = 'en' | 'zh' | 'mixed-en-zh';

export interface ExtractedKeywords {
  readonly keywords: readonly string[];
  // Was an LLM-authored "Keywords:" section found at all? Only meaningful
  // for the LLM path — the deterministic path always reports `found: true`
  // (it always "finds" something to compute over, even if the result is
  // empty because the gist had no usable content words).
  readonly found: boolean;
  // Candidates rejected by length bounds or the per-gist cap. REPORT, NOT
  // SILENT — same discipline as entityExtract.ts's `dropped`.
  readonly dropped: number;
}

export interface ExtractKeywordsResult extends ExtractedKeywords {
  readonly source: 'llm' | 'deterministic';
  readonly language: GistLanguage;
}

// Below this a "keyword" is punctuation or an initial; above it, it is a
// clause the model glued into the list rather than a term. Narrower than
// entityExtract's 80 — a keyword is a short term/phrase, not a name.
export const KEYWORD_MIN_LENGTH = 2;
export const KEYWORD_MAX_LENGTH = 40;

// The prompt asks for 3-7; this is generous headroom above that so a
// slightly chatty model doesn't lose keywords to truncation — overflow is
// COUNTED in `dropped`, never silently dropped.
export const KEYWORD_MAX_PER_GIST = 10;

export const DEFAULT_KEYWORD_TARGET_MIN = 3;
export const DEFAULT_KEYWORD_TARGET_MAX = 7;

// ---------------------------------------------------------------------------
// Language detection — a 4th port of the same Han-range/share constants
// already ported byte-identically twice in this codebase (extension's
// nano/language.ts is the canonical source; workstreams/prototypeEvidence.ts
// is the first companion-side port, for the prototype lane's own evidence
// budget). Kept LOCAL rather than imported from prototypeEvidence.ts on
// purpose: enrichment/ sits BELOW workstreams/ in this package's own
// dependency direction (workstreams/prototypeEvidence.ts already imports
// FROM enrichment/contentEnrichment.ts), so importing the other way would
// invert that layering. A ~20-line pure port is cheaper than a layering
// violation — the same trade-off appleFmEngine.ts's header documents for
// the extension/companion boundary, one level down.
// ---------------------------------------------------------------------------

const HAN_RANGES: readonly (readonly [number, number])[] = [
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
  [0x20000, 0x2a6df],
];

const isHan = (codePoint: number): boolean =>
  HAN_RANGES.some(([lo, hi]) => codePoint >= lo && codePoint <= hi);

const isLatinLetter = (codePoint: number): boolean =>
  (codePoint >= 0x41 && codePoint <= 0x5a) ||
  (codePoint >= 0x61 && codePoint <= 0x7a) ||
  (codePoint >= 0xc0 && codePoint <= 0x24f);

export const ZH_DOMINANT_SHARE = 0.6;
export const ZH_MIXED_SHARE = 0.08;
export const ZH_MIXED_MIN_CHARS = 12;

/** Han-vs-Latin codepoint ratio over the gist text (gists are already
 *  bounded to ENRICHED_GIST_MAX_LENGTH=2000 chars, so no sampling is
 *  needed — unlike the extension's page-text detector, which samples a
 *  much longer document). */
export const detectGistLanguage = (text: string): GistLanguage => {
  let han = 0;
  let latin = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (isHan(cp)) han += 1;
    else if (isLatinLetter(cp)) latin += 1;
  }
  const scripted = han + latin;
  if (scripted === 0) return 'en';
  const share = han / scripted;
  if (share >= ZH_DOMINANT_SHARE) return 'zh';
  if (share >= ZH_MIXED_SHARE && han >= ZH_MIXED_MIN_CHARS) return 'mixed-en-zh';
  return 'en';
};

// ---------------------------------------------------------------------------
// Normalization — lowercase always (a keyword is a feature key, not a
// display name), trimmed, markup/punctuation stripped from the edges.
// ---------------------------------------------------------------------------

const LEADING_TRIM = new Set([
  '*', '_', '`', '"', "'", '“', '‘', '(', '[', '{', '#', '-', '–', '—',
]);
const TRAILING_TRIM = new Set([
  '*', '_', '`', '"', "'", '”', '’', ')', ']', '}', '.', ',', ';', ':', '!', '?',
]);
const TRIM_PASSES = 4;

export const normalizeKeyword = (raw: string): string => {
  let value = raw.replace(/\s+/gu, ' ').trim().toLowerCase();
  for (let pass = 0; pass < TRIM_PASSES; pass += 1) {
    const before = value;
    let start = 0;
    while (start < value.length && LEADING_TRIM.has(value.charAt(start))) start += 1;
    let end = value.length;
    while (end > start && TRAILING_TRIM.has(value.charAt(end - 1))) end -= 1;
    value = value.slice(start, end).trim();
    if (value === before) break;
  }
  return value;
};

// A model asked for keywords and finding nothing meaningful says so IN THE
// LIST — "None", "N/A" — the honest answer, not a keyword called "none".
// Matched on the normalized (already-lowercased) candidate, same prefix
// discipline as entityExtract.ts's isPlaceholderName.
const isPlaceholderKeyword = (lower: string): boolean => {
  if (lower === 'n/a' || lower === 'na' || lower === 'unknown' || lower === 'unspecified') {
    return true;
  }
  return (
    lower.startsWith('none') ||
    lower.startsWith('not ') ||
    lower.startsWith('no keyword') ||
    lower.startsWith('nothing')
  );
};

// ---------------------------------------------------------------------------
// Path 1 — LLM-authored "Keywords: ..." line.
// ---------------------------------------------------------------------------

// Leading markdown/list noise a header line may carry ("### ", "**", "- ").
const isHeaderNoise = (ch: string): boolean =>
  ch === '#' || ch === '*' || ch === '-' || ch === ' ' || ch === '\t' || ch === '•';

const leadingNoiseWidth = (line: string): number => {
  let i = 0;
  while (i < line.length && isHeaderNoise(line.charAt(i))) i += 1;
  return i;
};

const KEYWORDS_MARKER = 'keywords';

/**
 * Where the "Keywords:" LABEL ends on its own line — LINE-ANCHORED, unlike
 * entityExtract's "key entities" phrase (which is matched anywhere): the bare
 * word "keywords" is common enough in ordinary prose ("...uses different
 * keywords for...") that matching it mid-sentence would comma-split real
 * prose into fake keywords. Scans every line and keeps the LAST match — the
 * prompt asks for the keywords line at the END of the gist, and keeping the
 * last (rather than first) occurrence is robust if the word coincidentally
 * appears earlier in the summary prose itself.
 */
const findKeywordsMarkerEnd = (gist: string): number | null => {
  const lower = gist.toLowerCase();
  let lineStart = 0;
  let found: number | null = null;
  for (;;) {
    const nl = lower.indexOf('\n', lineStart);
    const lineEnd = nl < 0 ? lower.length : nl;
    const line = lower.slice(lineStart, lineEnd);
    const offset = leadingNoiseWidth(line);
    if (line.startsWith(KEYWORDS_MARKER, offset)) {
      const rest = line.slice(offset + KEYWORDS_MARKER.length).trim();
      if (rest.length === 0 || rest.startsWith(':')) {
        found = lineStart + offset + KEYWORDS_MARKER.length;
      }
    }
    if (nl < 0) break;
    lineStart = nl + 1;
  }
  return found;
};

const HEADER_SEPARATORS = new Set([':', '*', '_', '-', '–', '—', ' ', '\t', '#', '•']);

const stripHeaderSeparators = (line: string): string => {
  let i = 0;
  while (i < line.length && HEADER_SEPARATORS.has(line.charAt(i))) i += 1;
  return line.slice(i).trim();
};

const splitSegments = (text: string): readonly string[] => {
  const out: string[] = [];
  for (const bySemi of text.split(';')) {
    for (const byComma of bySemi.split(',')) out.push(byComma);
  }
  return out;
};

/**
 * Parse the LLM-authored "Keywords: a, b, c" line, if present. Pure — same
 * text in, same result out. Only the REST OF THAT LINE is read (the format
 * this codebase's own prompt asks for is a single inline list, unlike
 * entities' multi-line bulleted-category shape) — a model that keeps writing
 * past the line break is not read as more keywords.
 */
export const extractLlmKeywords = (gist: string): ExtractedKeywords => {
  const markerEnd = findKeywordsMarkerEnd(gist);
  if (markerEnd === null) return { keywords: [], found: false, dropped: 0 };

  const rest = gist.slice(markerEnd);
  const firstBreak = rest.indexOf('\n');
  const line = firstBreak < 0 ? rest : rest.slice(0, firstBreak);
  const tail = stripHeaderSeparators(line);

  const keywords: string[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const raw of splitSegments(tail)) {
    const kw = normalizeKeyword(raw);
    if (kw.length === 0) continue; // pure punctuation/empty segment — not a drop
    if (isPlaceholderKeyword(kw)) continue; // honest emptiness — not a drop
    if (kw.length < KEYWORD_MIN_LENGTH || kw.length > KEYWORD_MAX_LENGTH) {
      dropped += 1;
      continue;
    }
    if (seen.has(kw)) continue;
    if (keywords.length >= KEYWORD_MAX_PER_GIST) {
      dropped += 1;
      continue;
    }
    seen.add(kw);
    keywords.push(kw);
  }
  return { keywords, found: true, dropped };
};

// ---------------------------------------------------------------------------
// Path 2 — deterministic frequency + stopword extraction, CJK-aware.
// ---------------------------------------------------------------------------

import { STOPWORDS } from '../suggestions/tokens.js';

const WORD_CHAR = /[\p{L}\p{N}]/u;
// Chinese has no inter-word spaces, so a "Han run" is a whole clause, not a
// word — there is no segmentation library in this codebase to split it
// properly. Sliding character n-grams are the cheapest deterministic proxy
// for "word-like" spans: width 2 catches short words ("训练", "算法"), width 4
// catches the very common 4-character compound technical terms this corpus
// actually contains ("神经网络", "深度学习", "机器学习", "人工智能"). Both widths
// fire over the SAME run on purpose (unlike an either/or split) — a 4-gram
// that repeats ties its constituent bigrams on raw count, and the ranking
// below breaks that tie toward the LONGER, more specific span.
const CJK_BIGRAM_WIDTH = 2;
const CJK_COMPOUND_WIDTH = 4;

const tokenizeForFrequency = (text: string): readonly string[] => {
  const chars = Array.from(text.toLowerCase());
  const tokens: string[] = [];
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i] ?? '';
    const cp = ch.codePointAt(0) ?? -1;
    if (isHan(cp)) {
      let j = i;
      while (j < chars.length) {
        const c2 = (chars[j] ?? '').codePointAt(0) ?? -1;
        if (!isHan(c2)) break;
        j += 1;
      }
      for (let k = i; k + CJK_BIGRAM_WIDTH <= j; k += 1) {
        tokens.push(chars.slice(k, k + CJK_BIGRAM_WIDTH).join(''));
      }
      for (let k = i; k + CJK_COMPOUND_WIDTH <= j; k += 1) {
        tokens.push(chars.slice(k, k + CJK_COMPOUND_WIDTH).join(''));
      }
      i = j;
      continue;
    }
    if (WORD_CHAR.test(ch)) {
      let j = i;
      while (j < chars.length && WORD_CHAR.test(chars[j] ?? '')) j += 1;
      const word = chars.slice(i, j).join('');
      if (word.length >= 3 && !STOPWORDS.has(word)) tokens.push(word);
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
};

/**
 * Frequency-ranked, stopword-filtered keywords straight from text — no LLM,
 * no section marker required. Ties break by first-seen order (stable,
 * deterministic — a term that appears first in the gist is marginally more
 * likely to be the subject than one first seen in a trailing clause).
 * `found` is always true here (there is always something to compute over,
 * even if it computes to nothing) — the caller (`extractKeywords`) is the
 * one that decides whether to prefer this over the LLM path.
 */
export const extractDeterministicKeywords = (
  text: string,
  maxCount: number = DEFAULT_KEYWORD_TARGET_MAX,
): ExtractedKeywords => {
  const tokens = tokenizeForFrequency(text);
  if (tokens.length === 0) return { keywords: [], found: true, dropped: 0 };

  const counts = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  tokens.forEach((token, index) => {
    counts.set(token, (counts.get(token) ?? 0) + 1);
    if (!firstSeen.has(token)) firstSeen.set(token, index);
  });

  const ranked = [...counts.entries()].sort((left, right) => {
    if (right[1] !== left[1]) return right[1] - left[1];
    // A count TIE between an n-gram and one of its own substrings (e.g. a
    // repeating 4-character CJK compound and its constituent bigram) is
    // broken toward the LONGER, more specific span — by construction, every
    // occurrence of the longer span is also an occurrence of the shorter
    // one, so an equal count means the longer span is fully supported.
    if (right[0].length !== left[0].length) return right[0].length - left[0].length;
    return (firstSeen.get(left[0]) ?? 0) - (firstSeen.get(right[0]) ?? 0);
  });

  const bound = Math.max(0, Math.min(maxCount, KEYWORD_MAX_PER_GIST));
  const keywords = ranked.slice(0, bound).map(([token]) => token);
  const dropped = Math.max(0, ranked.length - keywords.length);
  return { keywords, found: true, dropped };
};

// ---------------------------------------------------------------------------
// Composition — the one function callers use.
// ---------------------------------------------------------------------------

export interface ExtractKeywordsOptions {
  /** Skip detection when the caller already knows the language (e.g. it
   *  detected the same gist's language for another purpose already). */
  readonly language?: GistLanguage;
  readonly maxCount?: number;
}

/**
 * Extract 0..maxCount normalized keywords from a gist's text. Pure — same
 * text in, same result out, no I/O, no clock, no model call.
 *
 * Trusts the LLM-authored "Keywords:" line ONLY for 'en' gists that actually
 * carry one and produced at least one usable keyword from it; every other
 * case (zh, mixed-en-zh, an 'en' gist with no section, or one whose section
 * parsed to nothing usable) falls through to the deterministic path. This is
 * the SAME function the backfill lane calls over old gists — there is no
 * separate "backfill mode": an old gist simply never has a "Keywords:" line,
 * so it falls through exactly like a zh gist does.
 */
export const extractKeywords = (
  gist: string,
  options?: ExtractKeywordsOptions,
): ExtractKeywordsResult => {
  const language = options?.language ?? detectGistLanguage(gist);
  if (language === 'en') {
    const llm = extractLlmKeywords(gist);
    if (llm.found && llm.keywords.length > 0) {
      return { ...llm, source: 'llm', language };
    }
  }
  const deterministic = extractDeterministicKeywords(gist, options?.maxCount ?? DEFAULT_KEYWORD_TARGET_MAX);
  return { ...deterministic, source: 'deterministic', language };
};
