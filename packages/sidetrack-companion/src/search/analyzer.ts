/**
 * Shared text analyzer for cross-source search consistency.
 *
 * One tokenizer, used by every retriever that backs `/v1/content/query`
 * (chat-turn recall MiniSearch + page-content MiniSearch + any future
 * lexical index). Tokenization rules:
 *
 *   - lowercase everything
 *   - split on whitespace + ASCII/CJK punctuation + `/` + `\`
 *   - CJK ↔ Latin boundary split for the no-separator case
 *     ("故障注入Jepsen" → ["故障注入", "jepsen"])
 *   - dotted/kebab/snake identifiers kept whole AND split into parts
 *     ("sidetrack.threads.move" →
 *      ["sidetrack.threads.move", "sidetrack", "threads", "move"])
 *   - pure-CJK tokens fan out to {phrase + bigrams + unigrams},
 *     deduplicated, so substring queries (the natural case for CJK
 *     prose where one paragraph is one giant token after punctuation
 *     splits) actually hit. Same expansion is applied to queries —
 *     MiniSearch ORs them, so any term in the fan-out is a hit. This
 *     is the same approach Lucene's CJKBigramAnalyzer and
 *     Elasticsearch's `cjk_bigram` filter take, plus unigram for
 *     single-character queries.
 *
 * `ANALYZER_VERSION` is bumped any time these rules change.
 * Consumers that persist a tokenized index (recall MiniSearch,
 * page-content MiniSearch) MUST check it on load and force-rebuild on
 * mismatch.
 */

export const ANALYZER_VERSION = 1;

// CJK character ranges: Unified Ideographs Extension A + Basic
// Unified Ideographs + Hiragana + Katakana. Covers the dogfood
// Chinese/Japanese content. Used both for boundary detection and for
// the unigram/bigram fan-out.
const CJK_CLASS = '\\u3400-\\u9fff\\u3040-\\u30ff';
const CJK_ONLY_RE = new RegExp(`^[${CJK_CLASS}]+$`, 'u');
const CJK_BOUNDARY_RE = new RegExp(
  `(?<=[${CJK_CLASS}])(?=[a-z0-9])|(?<=[a-z0-9])(?=[${CJK_CLASS}])`,
  'u',
);

// Splitter regex. Includes ASCII whitespace, ideographic space,
// ASCII punctuation, common CJK punctuation, full-width brackets,
// and `/` + `\` so English terms embedded in CJK-dominant text
// surface as their own tokens ("Jepsen、Elle、TLA+" →
// ["jepsen", "elle", "tla+"]; "故障注入/检查器" →
// ["故障注入", "检查器"]).
// eslint-disable-next-line no-irregular-whitespace -- CJK punctuation deliberate
const SPLIT_RE = /[\s　,;:!?()[\]{}<>"'`/\\，、。：；！？（）【】「」『』《》〈〉…—／]+/;

const expandIdentifier = (token: string): readonly string[] => {
  const trimmed = token.replace(/^[.\-_]+|[.\-_]+$/g, '');
  if (trimmed.length === 0) return [];
  if (/[.\-_]/.test(trimmed)) return [trimmed, ...trimmed.split(/[.\-_]+/)];
  return [trimmed];
};

const expandCjk = (token: string): readonly string[] => {
  if (!CJK_ONLY_RE.test(token)) return [token];
  if (token.length === 1) return [token];
  const chars = Array.from(token);
  const out = new Set<string>([token]);
  // bigrams: overlapping length-2 substrings
  for (let i = 0; i + 1 < chars.length; i += 1) out.add(chars[i]! + chars[i + 1]!);
  // unigrams: individual characters — so a single-char query still hits
  for (const c of chars) out.add(c);
  return [...out];
};

/**
 * Tokenize `input` into a flat array of search terms. Used by every
 * lexical index in the /v1/content/query pipeline. Stable + pure;
 * the only side-effect is array allocation.
 */
export const analyze = (input: string): string[] =>
  input
    .toLowerCase()
    .split(SPLIT_RE)
    .flatMap((token) => token.split(CJK_BOUNDARY_RE))
    .flatMap(expandIdentifier)
    .flatMap(expandCjk)
    .filter((token) => token.length > 0);
