export const DEFAULT_UNKNOWN_IDF = 2.2;
export const COLD_START_PRIOR_DOCUMENT_COUNT = 100;

// Cold-start priors are deliberately generic web/document words, not
// product names, domains, or expected dogfood topics. User-corpus DF
// takes over as soon as enough local evidence exists.
const PRIOR_IDF: Readonly<Record<string, number>> = {
  about: 0.8,
  blog: 0.8,
  docs: 0.8,
  introduction: 0.9,
  platform: 1.05,
  resources: 0.9,
  search: 0.8,
  system: 1.05,
  technology: 1.0,
};

export const priorIdf = (term: string): number =>
  PRIOR_IDF[term.toLowerCase()] ?? DEFAULT_UNKNOWN_IDF;

export const userIdf = (input: {
  readonly documentCount: number;
  readonly documentFrequency: number;
}): number =>
  Math.log((Math.max(0, input.documentCount) + 1) / (Math.max(0, input.documentFrequency) + 1)) + 1;

export const blendedIdf = (input: {
  readonly term: string;
  readonly userDocumentCount: number;
  readonly userDocumentFrequency?: number;
}): number => {
  const alpha = Math.max(
    0,
    Math.min(
      1,
      (COLD_START_PRIOR_DOCUMENT_COUNT - input.userDocumentCount) / COLD_START_PRIOR_DOCUMENT_COUNT,
    ),
  );
  const prior = priorIdf(input.term);
  const user =
    input.userDocumentFrequency === undefined
      ? prior
      : userIdf({
          documentCount: input.userDocumentCount,
          documentFrequency: input.userDocumentFrequency,
        });
  return alpha * prior + (1 - alpha) * user;
};

export interface WeightedItem {
  readonly normalized: string;
  readonly weight: number;
}

export const weightedJaccard = (
  leftItems: readonly WeightedItem[],
  rightItems: readonly WeightedItem[],
): number => {
  if (leftItems.length === 0 || rightItems.length === 0) return 0;
  const left = new Map<string, number>();
  const right = new Map<string, number>();
  for (const item of leftItems) {
    left.set(item.normalized, Math.max(left.get(item.normalized) ?? 0, item.weight));
  }
  for (const item of rightItems) {
    right.set(item.normalized, Math.max(right.get(item.normalized) ?? 0, item.weight));
  }
  const keys = new Set<string>([...left.keys(), ...right.keys()]);
  let intersection = 0;
  let union = 0;
  for (const key of keys) {
    const leftWeight = left.get(key) ?? 0;
    const rightWeight = right.get(key) ?? 0;
    intersection += Math.min(leftWeight, rightWeight);
    union += Math.max(leftWeight, rightWeight);
  }
  return union === 0 ? 0 : intersection / union;
};

export const weightedContainment = (
  leftItems: readonly WeightedItem[],
  rightItems: readonly WeightedItem[],
): number => {
  if (leftItems.length === 0 || rightItems.length === 0) return 0;
  const left = new Map<string, number>();
  const right = new Map<string, number>();
  for (const item of leftItems) {
    left.set(item.normalized, Math.max(left.get(item.normalized) ?? 0, item.weight));
  }
  for (const item of rightItems) {
    right.set(item.normalized, Math.max(right.get(item.normalized) ?? 0, item.weight));
  }
  let intersection = 0;
  let leftTotal = 0;
  let rightTotal = 0;
  for (const weight of left.values()) leftTotal += weight;
  for (const weight of right.values()) rightTotal += weight;
  for (const [key, leftWeight] of left) {
    intersection += Math.min(leftWeight, right.get(key) ?? 0);
  }
  const denominator = Math.min(leftTotal, rightTotal);
  return denominator === 0 ? 0 : intersection / denominator;
};
