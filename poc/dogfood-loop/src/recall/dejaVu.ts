import type { WorkstreamNode } from '../graph/model';

export interface DejaVuHit {
  nodeId: string;
  title: string;
  provider?: string;
  ageDays: number;
  score: number;
  excerpt: string;
}

const tokenize = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/gu, ' ')
      .split(/\s+/u)
      .filter((token) => token.length >= 4),
  );

const jaccard = (left: Set<string>, right: Set<string>): number => {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }
  return intersection / (left.size + right.size - intersection);
};

export const findDejaVuHits = (
  probeText: string,
  nodes: WorkstreamNode[],
  now: Date,
  minAgeDays = 3,
  maxAgeDays = 21,
): DejaVuHit[] => {
  const probeTokens = tokenize(probeText);
  return nodes
    .filter((node) => node.content && (node.type === 'note' || node.type === 'chat_response'))
    .map((node) => {
      const ageDays = Math.max(
        0,
        Math.floor((now.getTime() - new Date(node.updatedAt).getTime()) / 86_400_000),
      );
      const recencyBoost = ageDays >= minAgeDays && ageDays <= maxAgeDays ? 0.18 : -0.08;
      return {
        node,
        ageDays,
        score: Math.max(0, jaccard(probeTokens, tokenize(node.content ?? '')) + recencyBoost),
      };
    })
    .filter((hit) => hit.score >= 0.22)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5)
    .map(({ node, ageDays, score }) => ({
      nodeId: node.id,
      title: node.title,
      provider: node.provider,
      ageDays,
      score: Number(score.toFixed(3)),
      excerpt: (node.content ?? '').slice(0, 240),
    }));
};
