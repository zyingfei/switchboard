import type { EvidenceGraph } from './evidenceGraph.js';

export interface PprCacheEntry {
  readonly createdAtMs: number;
  readonly result: ReadonlyMap<string, number>;
}

export interface PprCache {
  readonly get: (key: string, nowMs: number) => ReadonlyMap<string, number> | null;
  readonly set: (key: string, result: ReadonlyMap<string, number>, nowMs: number) => void;
}

export const createPprCache = (ttlMs = 5 * 60 * 1000): PprCache => {
  const entries = new Map<string, PprCacheEntry>();
  return {
    get: (key, nowMs) => {
      const entry = entries.get(key);
      if (entry === undefined) return null;
      if (nowMs - entry.createdAtMs > ttlMs) {
        entries.delete(key);
        return null;
      }
      return entry.result;
    },
    set: (key, result, nowMs) => {
      entries.set(key, { createdAtMs: nowMs, result });
    },
  };
};

const normalizeSeed = (seedVector: ReadonlyMap<string, number>): Map<string, number> => {
  let total = 0;
  for (const value of seedVector.values()) total += Math.abs(value);
  if (total === 0) return new Map();
  return new Map([...seedVector.entries()].map(([key, value]) => [key, value / total]));
};

const diff = (left: ReadonlyMap<string, number>, right: ReadonlyMap<string, number>): number => {
  const keys = new Set([...left.keys(), ...right.keys()]);
  let sum = 0;
  for (const key of keys) sum += Math.abs((left.get(key) ?? 0) - (right.get(key) ?? 0));
  return sum;
};

export const seedHash = (seedVector: ReadonlyMap<string, number>): string =>
  [...seedVector.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}:${value.toFixed(6)}`)
    .join('|');

export const runPPR = (
  evidence: EvidenceGraph,
  seedVector: ReadonlyMap<string, number>,
  alpha = 0.15,
  tol = 1e-6,
  maxIter = 50,
  timeoutMs = 25,
): Map<string, number> => {
  const seed = normalizeSeed(seedVector);
  const nodes = evidence.graph.nodes().map(String).sort();
  const startedAtMs = Date.now();
  let scores = new Map<string, number>(
    nodes.map((node): [string, number] => [node, seed.get(node) ?? 0]),
  );

  for (let iter = 0; iter < maxIter; iter += 1) {
    const next = new Map<string, number>(
      nodes.map((node): [string, number] => [node, alpha * (seed.get(node) ?? 0)]),
    );
    for (const node of nodes) {
      const score = scores.get(node) ?? 0;
      const outgoing = evidence.adjacency.get(node) ?? [];
      const totalWeight = outgoing.reduce((sum, edge) => sum + Math.abs(edge.weight), 0);
      if (outgoing.length === 0 || totalWeight === 0) {
        next.set(node, (next.get(node) ?? 0) + (1 - alpha) * score);
        continue;
      }
      for (const edge of outgoing) {
        next.set(
          edge.to,
          (next.get(edge.to) ?? 0) + (1 - alpha) * score * (edge.weight / totalWeight),
        );
      }
    }
    if (diff(next, scores) <= tol) return next;
    scores = next;
    if (Date.now() - startedAtMs > timeoutMs) return scores;
  }

  return scores;
};
