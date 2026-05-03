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

export const normalizeTokens = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(/\s+/u)
      .filter((token) => token.length >= 3 && !STOPWORDS.has(token)),
  );

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
