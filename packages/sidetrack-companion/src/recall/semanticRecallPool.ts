// W4(b-lite) — E as a GATED, LAZY, READ-ONLY semantic recall pool.
//
// E (the 5-blind-round semantic winner: content e5-embedding → kNN →
// leiden-cpm) failed as a DISPLAYED topic producer because of churn
// (W0c 0.327). Recall/search has no stability contract, so E is
// allowed here — strictly as an additive, labeled candidate source
// for search/"More Related"/Context-Pack expansion.
//
// HARD BOUNDARIES (the W4 acceptance contract):
//  - never displayed as topics; never the served producer
//  - never computed in the materializer drain (lazy/offline only)
//  - never writes ranker labels / user assertions / topicRevisionStore
//  - one-step reversible via SIDETRACK_ENABLE_SEMANTIC_RECALL_POOL
//
// Artifact is anchor-based (per-url cluster + nearest neighbours) — NO
// stored vectors, so it is tiny and queries need no request-time
// embedding (bounded latency). Reuses the existing e5 embedder and
// the W2 leidenCpmPartition (no new algorithm).

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { leidenCpmPartition } from '../connections/leidenCpm.js';
import type { VisitSimilarityEdge } from '../connections/topicClusterer.js';

export const SEMANTIC_RECALL_POOL_ENV = 'SIDETRACK_ENABLE_SEMANTIC_RECALL_POOL';
const SEMANTIC_RECALL_POOL_FEATURE_VERSION = 1;
const DEFAULT_K = 10;
// Mild cosine floor: content-embedding kNN edges below this are noise
// (the leiden-cpm step further cuts weak bridges).
const NEIGHBOR_COSINE_FLOOR = 0.5;

const DISABLED = new Set(['off', 'false', '0', 'none']);
// Default ON for the single-user dogfood (aggressive), one-step off.
export const semanticRecallPoolEnabled = (): boolean => {
  const raw = process.env[SEMANTIC_RECALL_POOL_ENV];
  if (raw === undefined) return true;
  return !DISABLED.has(raw.trim().toLowerCase());
};

export interface SemanticRecallNeighbor {
  readonly canonicalUrl: string;
  readonly cosine: number;
}
export interface SemanticRecallEntry {
  readonly canonicalUrl: string;
  readonly clusterId: string;
  readonly neighbors: readonly SemanticRecallNeighbor[];
}
export interface SemanticRecallPool {
  readonly signature: string;
  readonly modelId: string;
  readonly featureVersion: number;
  readonly producedAtMs: number;
  readonly entryCount: number;
  readonly clusterCount: number;
  readonly byUrl: Readonly<Record<string, SemanticRecallEntry>>;
}

export type SemanticRecallEmbed = (
  texts: readonly string[],
) => Promise<readonly Float32Array[]>;

export interface SemanticRecallTextItem {
  readonly canonicalUrl: string;
  readonly text: string;
}

export const semanticRecallPoolSignature = (
  items: readonly SemanticRecallTextItem[],
  modelId: string,
): string => {
  const h = createHash('sha256');
  h.update(
    JSON.stringify({
      modelId,
      featureVersion: SEMANTIC_RECALL_POOL_FEATURE_VERSION,
      k: DEFAULT_K,
      floor: NEIGHBOR_COSINE_FLOOR,
      items: [...items]
        .map((i) => ({
          u: i.canonicalUrl,
          t: createHash('sha1').update(i.text).digest('hex').slice(0, 12),
        }))
        .sort((a, b) => (a.u < b.u ? -1 : a.u > b.u ? 1 : 0)),
    }),
  );
  return h.digest('hex').slice(0, 16);
};

const l2normalize = (v: Float32Array): Float32Array => {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 1) out[i] = v[i]! / n;
  return out;
};
const dot = (a: Float32Array, b: Float32Array): number => {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) s += a[i]! * b[i]!;
  return s;
};

// Pure compute (no I/O). NEVER call from the materializer drain.
export const buildSemanticRecallPool = async (params: {
  readonly items: readonly SemanticRecallTextItem[];
  readonly embed: SemanticRecallEmbed;
  readonly modelId: string;
  readonly k?: number;
}): Promise<SemanticRecallPool> => {
  const items = params.items.filter(
    (i) => i.canonicalUrl.length > 0 && i.text.trim().length > 0,
  );
  const k = params.k ?? DEFAULT_K;
  const signature = semanticRecallPoolSignature(items, params.modelId);
  if (items.length < 2) {
    return {
      signature,
      modelId: params.modelId,
      featureVersion: SEMANTIC_RECALL_POOL_FEATURE_VERSION,
      producedAtMs: Date.now(),
      entryCount: items.length,
      clusterCount: 0,
      byUrl: {},
    };
  }
  const raw = await params.embed(items.map((i) => `query: ${i.text}`));
  const vecs = raw.map(l2normalize);
  const urls = items.map((i) => i.canonicalUrl);
  const neighbors = new Map<string, SemanticRecallNeighbor[]>();
  const edges: VisitSimilarityEdge[] = [];
  for (let i = 0; i < urls.length; i += 1) {
    const sims: SemanticRecallNeighbor[] = [];
    for (let j = 0; j < urls.length; j += 1) {
      if (i === j) continue;
      const c = dot(vecs[i]!, vecs[j]!);
      if (c >= NEIGHBOR_COSINE_FLOOR) sims.push({ canonicalUrl: urls[j]!, cosine: c });
    }
    sims.sort((a, b) => b.cosine - a.cosine);
    const top = sims.slice(0, k);
    neighbors.set(urls[i]!, top);
    for (const nb of top) {
      edges.push({
        fromVisitKey: urls[i]!,
        toVisitKey: nb.canonicalUrl,
        cosine: nb.cosine,
      });
    }
  }
  const groups = leidenCpmPartition([...urls].sort(), edges);
  const clusterByUrl = new Map<string, string>();
  for (const g of groups) {
    if (g.length < 2) continue;
    const id = `e:${createHash('sha1').update([...g].sort().join('\n')).digest('hex').slice(0, 12)}`;
    for (const u of g) clusterByUrl.set(u, id);
  }
  const byUrl: Record<string, SemanticRecallEntry> = {};
  for (const u of urls) {
    byUrl[u] = {
      canonicalUrl: u,
      clusterId: clusterByUrl.get(u) ?? `e:singleton:${u}`,
      neighbors: (neighbors.get(u) ?? []).map((n) => ({
        canonicalUrl: n.canonicalUrl,
        cosine: Number(n.cosine.toFixed(4)),
      })),
    };
  }
  return {
    signature,
    modelId: params.modelId,
    featureVersion: SEMANTIC_RECALL_POOL_FEATURE_VERSION,
    producedAtMs: Date.now(),
    entryCount: urls.length,
    clusterCount: new Set(clusterByUrl.values()).size,
    byUrl,
  };
};

const poolPath = (vaultRoot: string): string =>
  join(vaultRoot, '_BAC', 'recall', 'semantic-pool', 'current.json');

export const readSemanticRecallPool = async (
  vaultRoot: string,
): Promise<SemanticRecallPool | null> => {
  try {
    return JSON.parse(await readFile(poolPath(vaultRoot), 'utf8')) as SemanticRecallPool;
  } catch {
    return null;
  }
};

export const writeSemanticRecallPool = async (
  vaultRoot: string,
  pool: SemanticRecallPool,
): Promise<void> => {
  const path = poolPath(vaultRoot);
  await mkdir(join(path, '..'), { recursive: true });
  const tmp = `${path}.${String(process.pid)}.${String(Date.now())}.tmp`;
  await writeFile(tmp, `${JSON.stringify(pool)}\n`, 'utf8');
  await rename(tmp, path);
};

// Lazy build-if-stale + persist. Returns the current pool (or null if
// it cannot be built — offline / embed failure: graceful, never
// throws into a caller). NEVER invoked from the materializer drain;
// callers are the gated rebuild endpoint / a non-blocking refresh.
export const getOrBuildSemanticRecallPool = async (
  vaultRoot: string,
  params: {
    readonly items: readonly SemanticRecallTextItem[];
    readonly embed: SemanticRecallEmbed;
    readonly modelId: string;
  },
): Promise<SemanticRecallPool | null> => {
  const expected = semanticRecallPoolSignature(
    params.items.filter((i) => i.canonicalUrl.length > 0 && i.text.trim().length > 0),
    params.modelId,
  );
  const current = await readSemanticRecallPool(vaultRoot);
  if (current !== null && current.signature === expected) return current;
  try {
    const pool = await buildSemanticRecallPool(params);
    await writeSemanticRecallPool(vaultRoot, pool);
    return pool;
  } catch {
    return current; // offline / embed unavailable — keep last good (or null)
  }
};

export interface SemanticRecallHit {
  readonly canonicalUrl: string;
  readonly cosine: number;
  readonly clusterId: string;
  readonly via: 'cluster' | 'neighbor';
}

// READ-ONLY candidate expansion: given anchor urls (e.g. the page
// hits a query already returned), return their E-cluster co-members +
// nearest neighbours, cosine-ranked, excluding the anchors / already
// seen. No embedding at request time. Empty if the pool is absent
// (graceful) — callers must also gate on semanticRecallPoolEnabled().
export const expandSemanticRecallCandidates = (
  pool: SemanticRecallPool | null,
  anchorUrls: readonly string[],
  options: { readonly limit?: number; readonly exclude?: ReadonlySet<string> } = {},
): readonly SemanticRecallHit[] => {
  if (pool === null) return [];
  const limit = options.limit ?? 20;
  const exclude = new Set(options.exclude ?? []);
  for (const a of anchorUrls) exclude.add(a);
  const best = new Map<string, SemanticRecallHit>();
  const consider = (url: string, cosine: number, clusterId: string, via: 'cluster' | 'neighbor') => {
    if (exclude.has(url)) return;
    const prev = best.get(url);
    if (prev === undefined || cosine > prev.cosine) best.set(url, { canonicalUrl: url, cosine, clusterId, via });
  };
  for (const anchor of anchorUrls) {
    const entry = pool.byUrl[anchor];
    if (entry === undefined) continue;
    for (const nb of entry.neighbors) consider(nb.canonicalUrl, nb.cosine, entry.clusterId, 'neighbor');
    if (!entry.clusterId.startsWith('e:singleton:')) {
      for (const url of Object.keys(pool.byUrl)) {
        if (pool.byUrl[url]?.clusterId === entry.clusterId) consider(url, 0, entry.clusterId, 'cluster');
      }
    }
  }
  return [...best.values()]
    .sort((a, b) => b.cosine - a.cosine || (a.canonicalUrl < b.canonicalUrl ? -1 : 1))
    .slice(0, limit);
};
