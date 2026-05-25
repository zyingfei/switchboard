// Recall v2 — query analysis.
//
// The dogfood case study showed that lexical drift starts at the
// tokenization layer: every term in the selection contributes equally
// to MiniSearch's BM25, so "is/not/your" stopwords AND fuzzy-dangerous
// stems like "architect" (which match "architecture") flood the
// candidate list with off-topic pages.
//
// This module classifies each query token before retrieval so the
// candidate generators can compose a smarter FTS5 query:
//   - `weak` (stopwords / generic) → strip from query
//   - `fuzzy-dangerous` → disable fuzzy variant matching
//   - `domain` (host-like) → boost matches in URL/host fields
//   - `rare` → IDF-strong; protect from being out-voted
//   - `normal` → standard behavior
//
// Phase 6 deliverable. Used by all lexical candidate generators in
// pipeline.ts via a thin query-composer adapter that respects each
// token's classification.

import { analyze } from '../search/analyzer.js';

/** English stopwords. Conservative list — only the highest-frequency
 *  function words. Stopwords get stripped from queries entirely;
 *  documents keep them in their bodies. */
const STOPWORDS: ReadonlySet<string> = new Set<string>([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by',
  'do', 'does', 'for', 'from', 'has', 'have', 'he', 'her', 'his',
  'i', 'if', 'in', 'is', 'it', 'its', 'me', 'my', 'no', 'not',
  'of', 'on', 'or', 'our', 'she', 'so', 'than', 'that', 'the',
  'their', 'them', 'then', 'there', 'they', 'this', 'to', 'too',
  'us', 'was', 'we', 'were', 'what', 'when', 'which', 'who',
  'why', 'will', 'with', 'would', 'you', 'your', 'yours',
  // Selection-prose joiners we observed in the case study.
  'stop', 'just', 'let', 'lets', 'letting', 'pretend',
]);

/** Short stems that fuzzy-match dangerous variants. Built from the
 *  patterns observed in dogfood: a 5-7-char rare stem that fuzzy-
 *  matches a 10+ char common word and pulls the wrong-topic pages.
 *  Extend as new drift cases appear in the eval. */
const FUZZY_DANGEROUS: ReadonlySet<string> = new Set<string>([
  'architect',   // → architecture
  'network',     // → networking
  'model',       // → modeling / modelling
  'service',     // → services
  'process',     // → processing
  'security',    // → securities (rare risk but worth flagging)
]);

/** Token kinds the rest of the pipeline reasons about. */
export type QueryTokenKind = 'rare' | 'weak' | 'fuzzy-dangerous' | 'domain' | 'normal';

export interface QueryToken {
  readonly text: string;
  readonly kind: QueryTokenKind;
  /** Inverse document frequency from the corpus, when available. Higher = rarer. */
  readonly idf?: number;
  /** Whether this token should be queried with fuzzy matching enabled. */
  readonly fuzzyEligible: boolean;
}

export interface QueryAnalysis {
  readonly raw: string;
  readonly tokens: readonly QueryToken[];
  /** Host-like tokens extracted from the query (e.g. "hollandtech.net").
   *  Lexical generators MAY boost documents matching these in their
   *  host field. */
  readonly hostMentions: readonly string[];
  /** True when the selection reads as a quoted phrase (≥3 tokens, ≥1
   *  rare/domain token). Drives the "rare-term-rescue" path. */
  readonly looksQuoted: boolean;
}

/** Cheap IDF estimate from a token's length + suspected rarity.
 *  Real IDF (corpus-derived) comes online in Phase 3 once SQLite is in;
 *  this stub keeps the API stable + good enough for Phase 6 routing. */
const stubIdf = (token: string): number => {
  if (STOPWORDS.has(token)) return 0;
  if (token.length <= 3) return 0.5;
  if (token.length <= 5) return 1.0;
  if (token.length <= 8) return 2.5;
  return 4.0;
};

/** A token is "rare" enough to deserve protection when its stub-IDF
 *  exceeds the median of non-stopword tokens in the query. */
const classifyTokens = (tokens: readonly string[]): readonly QueryToken[] => {
  const nonStopwords = tokens.filter((t) => !STOPWORDS.has(t));
  if (nonStopwords.length === 0) {
    return tokens.map((t) => ({
      text: t,
      kind: 'weak' as const,
      idf: 0,
      fuzzyEligible: false,
    }));
  }
  const idfs = nonStopwords.map((t) => stubIdf(t)).sort((a, b) => a - b);
  const median = idfs[Math.floor(idfs.length / 2)] ?? 1;
  return tokens.map((t): QueryToken => {
    if (STOPWORDS.has(t)) {
      return { text: t, kind: 'weak', idf: 0, fuzzyEligible: false };
    }
    const idf = stubIdf(t);
    if (FUZZY_DANGEROUS.has(t)) {
      return { text: t, kind: 'fuzzy-dangerous', idf, fuzzyEligible: false };
    }
    // Host-like: contains a dot AND a TLD-ish suffix (2-6 chars).
    if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(t) && /\.[a-z]{2,6}$/.test(t)) {
      return { text: t, kind: 'domain', idf, fuzzyEligible: false };
    }
    if (idf > median + 0.5) {
      return { text: t, kind: 'rare', idf, fuzzyEligible: t.length >= 5 };
    }
    return { text: t, kind: 'normal', idf, fuzzyEligible: t.length >= 5 };
  });
};

export const analyzeQuery = (q: string): QueryAnalysis => {
  const tokens = analyze(q);
  const classified = classifyTokens(tokens);
  const hostMentions = classified.filter((t) => t.kind === 'domain').map((t) => t.text);
  const nonWeak = classified.filter((t) => t.kind !== 'weak');
  const hasRareOrDomain = nonWeak.some((t) => t.kind === 'rare' || t.kind === 'domain');
  const looksQuoted = nonWeak.length >= 3 && hasRareOrDomain;
  return { raw: q, tokens: classified, hostMentions, looksQuoted };
};

/** Compose a query string suitable for lexical retrievers from the
 *  analysis. Currently produces a space-joined non-stopword string;
 *  Phase 3 swaps this for FTS5 MATCH syntax that disables fuzzy on
 *  fuzzy-dangerous tokens and column-boosts host on domain tokens. */
export const composeLexicalQuery = (analysis: QueryAnalysis): string => {
  const kept = analysis.tokens.filter((t) => t.kind !== 'weak').map((t) => t.text);
  if (kept.length === 0) {
    // All-stopwords selection: degrade to the raw input so the lexical
    // ranker still has SOMETHING (better than zero hits).
    return analysis.raw;
  }
  return kept.join(' ');
};
