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
// The served artifact is anchor-based (per-url cluster + nearest
// neighbours + text-hash) so queries need no request-time embedding
// (bounded latency). A SIDECAR vector store (L2-normalized embeddings,
// url-keyed) persists alongside it — read/written ONLY on a rebuild —
// to make rebuilds INCREMENTAL. Every steady-state delta (add /
// change / remove a page while browsing) re-embeds ONLY the dirty
// items, recomputes neighbours only for the affected set (O(Δ·N),
// bit-identical to a from-scratch build), and updates clusters
// WITHOUT leiden (kept urls keep their community; a dirty url joins
// its best kept neighbour's). The cost that actually starved the
// event loop is leidenCpmPartition itself (~8 passes ×
// O(communities·edges) ≈ ~7s loop block at ~900 records, measured) —
// so leiden runs ONLY on the full build (cold start / model change /
// version migration / a delta so large a fresh partition is warranted
// anyway), a bounded one-time cost. Δ=1 over ~900 records ≈ ~75ms /
// ~20ms loop blip (measured), vs the ~7s freeze of a full rebuild —
// so steady-state browsing no longer starves /status. Reuses the
// existing e5 embedder + W2 leidenCpmPartition (no new algorithm).

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { leidenCpmPartition } from '../connections/leidenCpm.js';
import type { VisitSimilarityEdge } from '../connections/topicClusterer.js';

export const SEMANTIC_RECALL_POOL_ENV = 'SIDETRACK_ENABLE_SEMANTIC_RECALL_POOL';
// v2: entries carry textHash (delta detection) + a sidecar vector
// store enables incremental rebuild. A v1 pool on disk has no
// textHash; the version is in the signature, so it naturally
// mismatches and is rebuilt once (full) into v2 — clean migration,
// no special-casing.
const SEMANTIC_RECALL_POOL_FEATURE_VERSION = 2;
const DEFAULT_K = 10;
// Mild cosine floor: content-embedding kNN edges below this are noise
// (the leiden-cpm step further cuts weak bridges).
const NEIGHBOR_COSINE_FLOOR = 0.5;

const DISABLED = new Set(['off', 'false', '0', 'none']);
// Default ON — opt-OUT via SIDETRACK_ENABLE_SEMANTIC_RECALL_POOL=off.
// History: the FULL rebuild (re-embed all + O(N²) all-pairs cosine +
// leidenCpmPartition) on the companion's single JS event loop pegged
// it at the dogfood vault size (~900 records) → /status 45s
// starvation (proven by live sample(1): main-thread JIT'd JS, all Bun
// workers in __ulock_wait2). Cooperative yielding the cosine alone
// was not enough — every Déjà-vu query re-ran the WHOLE thing, and
// the dominant block was leidenCpmPartition, not the cosine.
// Resolved by making the rebuild INCREMENTAL (see header): steady
// state re-embeds only the dirty items, recomputes only affected
// neighbours, and skips leiden entirely (~75ms / ~20ms loop blip at
// ~900, measured) — so it no longer starves the loop. leiden (the
// ~7s block) runs only on the rare full build. Safe back on by
// default; opt out with the env flag if ever needed (graceful: empty
// pool ⇒ no "Similar" chip).
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
  /** sha1(text)[:12] — lets the incremental rebuild detect whether
   * this url's text changed (⇒ full rebuild) vs untouched (⇒ reuse
   * its cached vector + prior neighbours). */
  readonly textHash: string;
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

// ── Shared compute pieces (pure; NEVER call from the materializer
// drain). The full and incremental builders both end at assemblePool
// so they produce an identically-shaped pool for the same neighbour
// graph. ──

const textHash12 = (text: string): string =>
  createHash('sha1').update(text).digest('hex').slice(0, 12);

const embedNormalized = async (
  embed: SemanticRecallEmbed,
  items: readonly SemanticRecallTextItem[],
): Promise<Float32Array[]> =>
  (await embed(items.map((i) => `query: ${i.text}`))).map(l2normalize);

// COOPERATIVE yield: the cold-start full build's all-pairs cosine is
// O(N²) (≈800k iters at ~900 records). One synchronous block pegged
// the single JS event loop for seconds → /status starvation (the
// recurring crash; proven by a live sample). Yielding every
// YIELD_EVERY subjects spreads it over many ticks so /status
// interleaves. Steady state takes the O(Δ·N) incremental path below
// (so this big loop is now rare AND non-blocking).
const YIELD_EVERY = 32;
const yieldToLoop = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

const topKNeighborsFull = async (
  urls: readonly string[],
  vecs: readonly Float32Array[],
  k: number,
): Promise<Map<string, SemanticRecallNeighbor[]>> => {
  const neighbors = new Map<string, SemanticRecallNeighbor[]>();
  for (let i = 0; i < urls.length; i += 1) {
    if (i > 0 && i % YIELD_EVERY === 0) await yieldToLoop();
    const sims: SemanticRecallNeighbor[] = [];
    for (let j = 0; j < urls.length; j += 1) {
      if (i === j) continue;
      const c = dot(vecs[i]!, vecs[j]!);
      if (c >= NEIGHBOR_COSINE_FLOOR) sims.push({ canonicalUrl: urls[j]!, cosine: c });
    }
    sims.sort((a, b) => b.cosine - a.cosine);
    neighbors.set(urls[i]!, sims.slice(0, k));
  }
  return neighbors;
};

// neighbour map → edges → leiden-cpm → per-url cluster id. THE
// expensive step: leidenCpmPartition is ~8 passes ×
// O(communities·edges) refinement — multiple seconds at ~900 nodes,
// one synchronous block. So it runs ONLY on the (rare) full build;
// the incremental path keeps clusters up to date without it. Pure.
const clustersFromNeighbors = (
  urls: readonly string[],
  neighbors: ReadonlyMap<string, readonly SemanticRecallNeighbor[]>,
): Map<string, string> => {
  const edges: VisitSimilarityEdge[] = [];
  for (const u of urls) {
    for (const nb of neighbors.get(u) ?? []) {
      edges.push({ fromVisitKey: u, toVisitKey: nb.canonicalUrl, cosine: nb.cosine });
    }
  }
  const groups = leidenCpmPartition([...urls].sort(), edges);
  const clusterByUrl = new Map<string, string>();
  for (const g of groups) {
    if (g.length < 2) continue;
    const id = `e:${createHash('sha1').update([...g].sort().join('\n')).digest('hex').slice(0, 12)}`;
    for (const u of g) clusterByUrl.set(u, id);
  }
  return clusterByUrl;
};

// Pure assembly from an ALREADY-decided cluster map (no leiden). Used
// by every path: the full build feeds it clustersFromNeighbors; the
// incremental path feeds it an incrementally-maintained map. A url
// absent from clusterByUrl is a singleton. No I/O.
const assembleFromClusters = (args: {
  readonly urls: readonly string[];
  readonly neighbors: ReadonlyMap<string, readonly SemanticRecallNeighbor[]>;
  readonly textHashByUrl: ReadonlyMap<string, string>;
  readonly clusterByUrl: ReadonlyMap<string, string>;
  readonly modelId: string;
  readonly signature: string;
}): SemanticRecallPool => {
  const { urls, neighbors, textHashByUrl, clusterByUrl, modelId, signature } = args;
  if (urls.length < 2) {
    return {
      signature,
      modelId,
      featureVersion: SEMANTIC_RECALL_POOL_FEATURE_VERSION,
      producedAtMs: Date.now(),
      entryCount: urls.length,
      clusterCount: 0,
      byUrl: {},
    };
  }
  const byUrl: Record<string, SemanticRecallEntry> = {};
  const liveClusters = new Set<string>();
  for (const u of urls) {
    const cid = clusterByUrl.get(u);
    if (cid !== undefined && cid.length > 0 && !cid.startsWith('e:singleton:')) {
      liveClusters.add(cid);
    }
    byUrl[u] = {
      canonicalUrl: u,
      clusterId: cid !== undefined && cid.length > 0 ? cid : `e:singleton:${u}`,
      neighbors: (neighbors.get(u) ?? []).map((n) => ({
        canonicalUrl: n.canonicalUrl,
        cosine: Number(n.cosine.toFixed(4)),
      })),
      textHash: textHashByUrl.get(u) ?? '',
    };
  }
  return {
    signature,
    modelId,
    featureVersion: SEMANTIC_RECALL_POOL_FEATURE_VERSION,
    producedAtMs: Date.now(),
    entryCount: urls.length,
    clusterCount: liveClusters.size,
    byUrl,
  };
};

// FULL (cold-start) build. Returns the pool AND per-url vectors so the
// caller can persist the vector store that makes later rebuilds
// incremental. NEVER call from the materializer drain.
export const buildSemanticRecallPoolWithVectors = async (params: {
  readonly items: readonly SemanticRecallTextItem[];
  readonly embed: SemanticRecallEmbed;
  readonly modelId: string;
  readonly k?: number;
}): Promise<{ pool: SemanticRecallPool; vectors: Map<string, Float32Array> }> => {
  const items = params.items.filter(
    (i) => i.canonicalUrl.length > 0 && i.text.trim().length > 0,
  );
  const k = params.k ?? DEFAULT_K;
  const signature = semanticRecallPoolSignature(items, params.modelId);
  const textHashByUrl = new Map(items.map((i) => [i.canonicalUrl, textHash12(i.text)]));
  const urls = items.map((i) => i.canonicalUrl);
  if (items.length < 2) {
    return {
      pool: assembleFromClusters({
        urls,
        neighbors: new Map(),
        textHashByUrl,
        clusterByUrl: new Map(),
        modelId: params.modelId,
        signature,
      }),
      vectors: new Map(),
    };
  }
  const vecs = await embedNormalized(params.embed, items);
  const neighbors = await topKNeighborsFull(urls, vecs, k);
  const clusterByUrl = clustersFromNeighbors(urls, neighbors); // leiden — full only
  const vectors = new Map<string, Float32Array>();
  for (let i = 0; i < urls.length; i += 1) vectors.set(urls[i]!, vecs[i]!);
  return {
    pool: assembleFromClusters({
      urls,
      neighbors,
      textHashByUrl,
      clusterByUrl,
      modelId: params.modelId,
      signature,
    }),
    vectors,
  };
};

// Back-compat: pool only (callers/tests that don't persist vectors).
export const buildSemanticRecallPool = async (params: {
  readonly items: readonly SemanticRecallTextItem[];
  readonly embed: SemanticRecallEmbed;
  readonly modelId: string;
  readonly k?: number;
}): Promise<SemanticRecallPool> =>
  (await buildSemanticRecallPoolWithVectors(params)).pool;

// INCREMENTAL rebuild — the steady-state path (add / change / remove).
// Neighbours stay EXACT (bit-identical to a from-scratch
// topKNeighborsFull over the current vectors); only CLUSTERS are
// approximate between full rebuilds. Cost:
//
//  - Embed ONLY changed+added items (kept reuse cached vectors).
//  - Recompute neighbour lists fully only for R = changed∪added plus
//    any kept url whose stored top-k referenced a removed/changed url
//    (its top-k could shift). O(|R|·N). Every other kept url's vector
//    AND top-k members are unchanged, so its prior list is still
//    valid — we only splice in changed/added that now rank (reusing
//    the dot products already computed for R). A non-top-k prior
//    candidate cannot rise (none of that url's top-k left). ⇒ exact.
//  - Clusters: NO leiden (that is the multi-second block). Kept urls
//    keep their cluster; changed/added join their best kept
//    neighbour's community (else singleton). Precise re-partition is
//    deferred to the rare full build (cold / model / version). The
//    drift is bounded and benign — clusters are the looser "co-member"
//    recall bonus; the exact neighbours carry the precision.
//
// Δ=1 over ~900 records ≈ 900 dot products + O(N) assembly, no leiden
// — sub-100ms, so it never starves the event loop.
const incrementalRebuild = async (args: {
  readonly prevPool: SemanticRecallPool;
  readonly prevVectors: ReadonlyMap<string, Float32Array>;
  readonly items: readonly SemanticRecallTextItem[];
  readonly embed: SemanticRecallEmbed;
  readonly modelId: string;
  readonly signature: string;
  readonly k?: number;
}): Promise<{ pool: SemanticRecallPool; vectors: Map<string, Float32Array> }> => {
  const k = args.k ?? DEFAULT_K;
  const prev = args.prevPool.byUrl;
  const curHash = new Map(args.items.map((i) => [i.canonicalUrl, textHash12(i.text)]));
  const dirtyItems: SemanticRecallTextItem[] = [];
  const dirtySet = new Set<string>();
  const changedSet = new Set<string>();
  for (const it of args.items) {
    const p = prev[it.canonicalUrl];
    if (p === undefined) {
      dirtyItems.push(it);
      dirtySet.add(it.canonicalUrl);
    } else if (curHash.get(it.canonicalUrl) !== p.textHash) {
      dirtyItems.push(it);
      dirtySet.add(it.canonicalUrl);
      changedSet.add(it.canonicalUrl);
    }
  }
  const removedOrChanged = new Set<string>(changedSet);
  for (const u of Object.keys(prev)) if (!curHash.has(u)) removedOrChanged.add(u);

  const dVecs = await embedNormalized(args.embed, dirtyItems);
  const vectors = new Map<string, Float32Array>();
  const allUrls: string[] = [];
  const textHashByUrl = new Map<string, string>();
  for (const it of args.items) {
    allUrls.push(it.canonicalUrl);
    textHashByUrl.set(it.canonicalUrl, curHash.get(it.canonicalUrl)!);
  }
  for (let i = 0; i < dirtyItems.length; i += 1) {
    vectors.set(dirtyItems[i]!.canonicalUrl, dVecs[i]!);
  }
  for (const u of allUrls) {
    if (!vectors.has(u)) vectors.set(u, args.prevVectors.get(u)!); // kept ⇒ cached
  }

  // R = dirty ∪ kept urls whose stored top-k touched a removed/changed
  // url (their top-k may shift). Everyone else keeps their prior list.
  const recompute = new Set<string>(dirtySet);
  for (const u of allUrls) {
    if (recompute.has(u)) continue;
    for (const nb of prev[u]?.neighbors ?? []) {
      if (removedOrChanged.has(nb.canonicalUrl)) {
        recompute.add(u);
        break;
      }
    }
  }
  const neighbors = new Map<string, SemanticRecallNeighbor[]>();
  for (const u of allUrls) {
    if (recompute.has(u)) {
      neighbors.set(u, []);
    } else {
      // Prior list is still valid (vector + top-k members unchanged);
      // dirty items get spliced in below if they now rank.
      neighbors.set(
        u,
        (prev[u]?.neighbors ?? []).map((n) => ({ ...n })),
      );
    }
  }
  // Full O(N) rescan for each R member; reuse each dirty member's scan
  // to splice it into kept-not-in-R urls (the reverse direction).
  let processed = 0;
  for (const x of recompute) {
    if (processed > 0 && processed % YIELD_EVERY === 0) await yieldToLoop();
    processed += 1;
    const vx = vectors.get(x)!;
    const xList: SemanticRecallNeighbor[] = [];
    const xIsDirty = dirtySet.has(x);
    for (const u of allUrls) {
      if (u === x) continue;
      const c = dot(vx, vectors.get(u)!);
      if (c < NEIGHBOR_COSINE_FLOOR) continue;
      xList.push({ canonicalUrl: u, cosine: c });
      if (xIsDirty && !recompute.has(u)) {
        neighbors.get(u)!.push({ canonicalUrl: x, cosine: c }); // reverse splice
      }
    }
    xList.sort((a, b) => b.cosine - a.cosine);
    neighbors.set(x, xList.slice(0, k));
  }
  for (const [u, list] of neighbors) {
    if (recompute.has(u)) continue; // already top-k
    list.sort((a, b) => b.cosine - a.cosine);
    if (list.length > k) neighbors.set(u, list.slice(0, k));
  }

  // Clusters WITHOUT leiden: kept urls keep their community; dirty
  // urls join their best kept neighbour's community (else singleton).
  const clusterByUrl = new Map<string, string>();
  for (const u of allUrls) {
    if (dirtySet.has(u)) continue;
    const cid = prev[u]?.clusterId;
    if (cid !== undefined && cid.length > 0 && !cid.startsWith('e:singleton:')) {
      clusterByUrl.set(u, cid);
    }
  }
  for (const x of dirtySet) {
    for (const nb of neighbors.get(x) ?? []) {
      if (dirtySet.has(nb.canonicalUrl)) continue; // anchor on a stable (kept) url
      const cid = clusterByUrl.get(nb.canonicalUrl);
      if (cid !== undefined) {
        clusterByUrl.set(x, cid);
        break;
      }
    }
  }
  return {
    pool: assembleFromClusters({
      urls: allUrls,
      neighbors,
      textHashByUrl,
      clusterByUrl,
      modelId: args.modelId,
      signature: args.signature,
    }),
    vectors,
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

// ── Vector store (sidecar) — persisted L2-normalized embeddings,
// url-keyed. Read/written ONLY on a rebuild (never on the cache-hit
// serve path, which only reads the small pool for its signature).
// Vectors round to 6dp (≈halves the file; re-normalized on load to
// undo rounding drift). textHash authority is the pool, not here. ──
interface SemanticRecallVectorStore {
  readonly modelId: string;
  readonly byUrl: Readonly<Record<string, readonly number[]>>;
}
const vectorStorePath = (vaultRoot: string): string =>
  join(vaultRoot, '_BAC', 'recall', 'semantic-pool', 'vectors.json');

const readVectorStore = async (
  vaultRoot: string,
  modelId: string,
): Promise<Map<string, Float32Array> | null> => {
  try {
    const raw = JSON.parse(
      await readFile(vectorStorePath(vaultRoot), 'utf8'),
    ) as SemanticRecallVectorStore;
    if (raw.modelId !== modelId) return null; // model changed ⇒ unusable
    const out = new Map<string, Float32Array>();
    for (const [u, v] of Object.entries(raw.byUrl)) {
      out.set(u, l2normalize(Float32Array.from(v)));
    }
    return out;
  } catch {
    return null;
  }
};

const writeVectorStore = async (
  vaultRoot: string,
  modelId: string,
  vectors: ReadonlyMap<string, Float32Array>,
): Promise<void> => {
  const byUrl: Record<string, number[]> = {};
  for (const [u, v] of vectors) byUrl[u] = Array.from(v, (x) => Number(x.toFixed(6)));
  const path = vectorStorePath(vaultRoot);
  await mkdir(join(path, '..'), { recursive: true });
  const tmp = `${path}.${String(process.pid)}.${String(Date.now())}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ modelId, byUrl })}\n`, 'utf8');
  await rename(tmp, path);
};

// Decide full vs incremental from the delta vs the persisted pool, and
// produce the next pool + the vectors to persist. The incremental
// path (no leiden — sub-100ms at ~900) handles add / change / remove,
// i.e. ALL steady-state browsing. The cooperative full build (with
// leiden) runs only on cold start / model change / version migration /
// an unusable vector store / a delta so large that a fresh partition
// is warranted anyway (then incremental savings are marginal).
const LARGE_DELTA_FLOOR = 8;
const buildOrExtend = async (
  vaultRoot: string,
  current: SemanticRecallPool | null,
  filtered: readonly SemanticRecallTextItem[],
  expected: string,
  params: { readonly embed: SemanticRecallEmbed; readonly modelId: string },
): Promise<{ pool: SemanticRecallPool; vectors: Map<string, Float32Array> }> => {
  const full = (): Promise<{ pool: SemanticRecallPool; vectors: Map<string, Float32Array> }> =>
    buildSemanticRecallPoolWithVectors({
      items: filtered,
      embed: params.embed,
      modelId: params.modelId,
    });
  if (
    current === null ||
    current.featureVersion !== SEMANTIC_RECALL_POOL_FEATURE_VERSION ||
    current.modelId !== params.modelId ||
    Object.keys(current.byUrl).length === 0
  ) {
    return full();
  }
  const prevUrls = Object.keys(current.byUrl);
  const curHash = new Map(filtered.map((i) => [i.canonicalUrl, textHash12(i.text)]));
  let dirty = 0; // added or text-changed
  for (const i of filtered) {
    const p = current.byUrl[i.canonicalUrl];
    if (p === undefined || curHash.get(i.canonicalUrl) !== p.textHash) dirty += 1;
  }
  let removed = 0;
  for (const u of prevUrls) if (!curHash.has(u)) removed += 1;
  if (dirty === 0 && removed === 0) return full(); // signature drift w/o item delta (k/floor)
  // Large delta ⇒ R approaches N (O(N²)) and a fresh leiden partition
  // is worth it anyway. Otherwise stay incremental.
  if (dirty + removed > Math.max(LARGE_DELTA_FLOOR, Math.floor(prevUrls.length / 2))) {
    return full();
  }
  const prevVectors = await readVectorStore(vaultRoot, params.modelId);
  if (prevVectors === null) return full();
  for (const i of filtered) {
    const p = current.byUrl[i.canonicalUrl];
    const kept = p !== undefined && curHash.get(i.canonicalUrl) === p.textHash;
    if (kept && !prevVectors.has(i.canonicalUrl)) return full(); // store/pool out of sync
  }
  return incrementalRebuild({
    prevPool: current,
    prevVectors,
    items: filtered,
    embed: params.embed,
    modelId: params.modelId,
    signature: expected,
  });
};

// Lazy build-if-stale + persist. Steady state is the O(Δ·N)
// incremental path (a newly visited page); the cooperative O(N²) full
// build runs only on cold start / model change / the rare text-change
// or removal — never blocking enough to starve /status. Returns the
// current pool (or null if it cannot be built — offline / embed
// failure: graceful, never throws into a caller). NEVER invoked from
// the materializer drain; callers are the gated rebuild endpoint / a
// non-blocking refresh.
export const getOrBuildSemanticRecallPool = async (
  vaultRoot: string,
  params: {
    readonly items: readonly SemanticRecallTextItem[];
    readonly embed: SemanticRecallEmbed;
    readonly modelId: string;
  },
): Promise<SemanticRecallPool | null> => {
  const filtered = params.items.filter(
    (i) => i.canonicalUrl.length > 0 && i.text.trim().length > 0,
  );
  const expected = semanticRecallPoolSignature(filtered, params.modelId);
  const current = await readSemanticRecallPool(vaultRoot);
  if (current !== null && current.signature === expected) return current;
  try {
    const built = await buildOrExtend(vaultRoot, current, filtered, expected, params);
    await writeSemanticRecallPool(vaultRoot, built.pool);
    await writeVectorStore(vaultRoot, params.modelId, built.vectors);
    return built.pool;
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
