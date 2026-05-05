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
    // Emit trigrams ONLY for words long enough to plausibly be
    // compound (hackernews, machinelearning) — the trigram tag is
    // prefixed with `#` so it can never collide with a real word
    // token. This lets jaccard score "hackernews" against
    // "hacker news" via shared substrings without losing the
    // word-level signal in normal cases.
    if (word.length >= 6) {
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
