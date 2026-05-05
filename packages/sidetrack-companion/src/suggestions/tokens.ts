// Small NLTK-inspired English stopword subset; enough to keep common glue
// words from dominating workstream/thread title similarity.
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'that',
  'with',
  'this',
  'from',
  'are',
  'was',
  'were',
  'you',
  'your',
  'but',
  'not',
  'have',
  'has',
  'had',
  'what',
  'when',
  'where',
  'why',
  'how',
  'can',
  'could',
  'should',
  'would',
  'about',
  'into',
  'over',
  'under',
  'than',
  'then',
  'them',
  'they',
  'their',
  'our',
  'out',
  'all',
  'any',
  'too',
  'very',
  'just',
  'more',
  'most',
  'some',
  'such',
  'only',
  'own',
  'same',
  'both',
  'each',
  'few',
]);

// Character n-gram length used for "fuzzy" overlap between glued-
// together compound words ("hackernews") and their split-word
// counterparts ("hacker news"). 3 picks up shared morphemes
// without ballooning the token set.
const NGRAM = 3;

// Words shorter than this don't emit trigrams. 4 captures common
// short words like 'news', 'data', 'code' that often pair into
// compounds (hackernews, machinelearning, openapi) while still
// excluding 3-char tokens that would be too noisy.
const TRIGRAM_MIN_LEN = 4;

const trigrams = (token: string): readonly string[] => {
  const grams: string[] = [];
  for (let i = 0; i + NGRAM <= token.length; i += 1) {
    grams.push(`#${token.slice(i, i + NGRAM)}`);
  }
  return grams;
};

export const normalizeTokens = (text: string): Set<string> => {
  const out = new Set<string>();
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/u)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
  for (const word of words) {
    out.add(word);
    // Emit trigrams (tagged with `#` so they can't collide with
    // real words). Tagging means jaccard between a token set and
    // its character trigrams is meaningful — "hackernews" matches
    // "hacker news" through shared substring grams without losing
    // the word-level signal.
    if (word.length >= TRIGRAM_MIN_LEN) {
      for (const gram of trigrams(word)) out.add(gram);
    }
  }
  return out;
};

export const jaccard = (left: Set<string>, right: Set<string>): number => {
  if (left.size === 0 && right.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }
  return intersection / new Set([...left, ...right]).size;
};

// Asymmetric "is `needle` mostly inside `haystack`?" measure.
//   containment({hackernews, #hac, #ack, ...}, {hacker, news, summary, may, ...}) ≈ 0.67
// where the ~6 trigrams of "hackernews" overlap with "hacker"+"news" trigrams.
// Useful for the suggestion scorer because a workstream's name is
// usually short and concentrated, while a thread title carries
// noise tokens (dates, "summary", "may"). Jaccard divides by the
// union — so adding noise to the thread side hurts the score even
// when the workstream name IS fully present in the thread. The
// directed containment from ws → thread captures that case.
export const containment = (needle: Set<string>, haystack: Set<string>): number => {
  if (needle.size === 0) return 0;
  let intersection = 0;
  for (const token of needle) {
    if (haystack.has(token)) intersection += 1;
  }
  return intersection / needle.size;
};
