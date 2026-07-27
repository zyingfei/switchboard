// Guess lane 7 — 'content': query-time full-vector + BM25 comparison.
//
// THE GAP. The materialized similarity lane (visit-similarity revision) is
// ENGAGEMENT-GATED: a page must accrue focusedWindowMs ≥ 5s before it earns
// content-vector edges, so a page you just opened — or one the extension has
// only title-embedded — never gets a similarity opinion, even though the recall
// store already holds full-body vectors + BM25 rows for the corpus it COULD be
// compared against. The user's directive: "feature vectors comparison should be
// compared in full vector (maybe sliced for large chunks), not just the title."
//
// THE LANE. Lane 7 computes at QUERY TIME with zero drain dependency. For the
// page being resolved it acquires a query vector (its OWN stored page-content
// doc/chunk vectors when indexed; else a bounded on-the-fly embed of
// title + URL-tokens), runs a vector KNN + a BM25 FTS query over the recall
// store, RRF-combines the two rankings, joins each hit back to a workstream via
// the ConnectionsSnapshot the resolver already holds, and aggregates per
// workstream. It NEVER opens a second store connection (reuses the /v2 handle)
// and NEVER blocks the resolve hot path beyond a ~400ms embed race.
//
// PROVENANCE HONESTY. queryVector/queryChunkVector return `bodyIndexed` per hit
// (1 = content-derived vector, 0 = title+URL-only, e.g. timeline_visit /
// chat_turn docs). When the winning workstream's hits are title-vector-only we
// say so in the `why` rather than claiming a content match — the user's whole
// point is that title-only is the weaker signal.
//
// COST. Bounded and degrading: indexed/lexical-only paths ≤ ~50ms (two KNN/FTS
// round-trips + O(hits) join); worst case ≤ ~450ms (the embed race, capped by
// Promise.race). An in-memory LRU caps repeated on-the-fly embeds. Any failure
// (no store, embed timeout, empty corpus) degrades to a typed-empty lane — it
// never throws into the resolve.

import type { ConnectionsSnapshot } from '../connections/types.js';
import type { GuessLaneCandidate, GuessLaneResult } from './guessLanes.js';

// ---- env flag ---------------------------------------------------------

export const CONTENT_LANE_ENV = 'SIDETRACK_CONTENT_LANE';

// Default ON. Only an explicit '0' / 'false' disables — same pattern as the
// parent SIDETRACK_GUESS_LANES flag. When off, the caller omits the lane
// entirely (the lanes array stays 6 long).
export const contentLaneEnabled = (): boolean => {
  const raw = process.env[CONTENT_LANE_ENV];
  return raw !== '0' && raw !== 'false';
};

// ---- injectable store / embedder deps ---------------------------------
//
// Structural subsets of the real SqliteRecallStore + recall embedder, so tests
// inject deterministic fakes and production passes the live handles unchanged.

/** A vector KNN / chunk-vector KNN hit (queryVector / queryChunkVector shape). */
export interface ContentVectorHit {
  readonly entityId: string;
  readonly canonicalUrl: string | undefined;
  readonly title: string | undefined;
  readonly cosineDistance: number;
  readonly bodyIndexed: 0 | 1;
}

/** An FTS (BM25) hit (queryByCanonicalUrl / queryFts shape). */
export interface ContentFtsHit {
  readonly entityId: string;
  readonly canonicalUrl?: string;
  readonly title?: string;
  readonly threadId?: string;
  readonly bm25: number;
  readonly bodyIndexed?: 0 | 1;
}

/** The subset of RecallStore the content lane calls. All methods are the
 *  store's own — the caller passes the already-open /v2 handle. */
export interface ContentLaneStore {
  readonly vectorBackendAvailable: boolean;
  queryByCanonicalUrl(opts: {
    readonly canonicalUrl: string;
    readonly limit: number;
  }): readonly ContentFtsHit[];
  queryVector(opts: {
    readonly vec: Float32Array;
    readonly limit: number;
    readonly excludeEntityIds?: ReadonlySet<string>;
  }): readonly ContentVectorHit[];
  // Optional — only when chunk vectors + backend are available. Falls back to
  // queryVector when absent (older stores / test stubs).
  queryChunkVector?(opts: {
    readonly vec: Float32Array;
    readonly limit: number;
    readonly excludeEntityIds?: ReadonlySet<string>;
  }): readonly (ContentVectorHit & { readonly pooledChunkCount: number })[];
  queryFts(opts: {
    readonly q: string;
    readonly sourceKind: string | readonly string[];
    readonly limit: number;
  }): readonly ContentFtsHit[];
}

/** Query-time embed — the recall embedder's `embed([q])` narrowed to one text.
 *  Returns undefined on any failure so the lane degrades to lexical-only. */
export type ContentLaneEmbed = (text: string) => Promise<Float32Array | undefined>;

// ---- tunables (bounded per doctrine) ----------------------------------

const KNN_LIMIT = 12;
const FTS_LIMIT = 12;
// RRF constant — the standard Reciprocal Rank Fusion damping (Cormack et al.
// 2009). Recall has no exported shared constant (checked pipeline/rerank), so
// the canonical k=60 is used here.
const RRF_K = 60;
const EMBED_RACE_MS = 400;
const LRU_CAP = 200;
const OWN_VECTOR_KNN_LIMIT = 4; // how many of the page's own chunk/doc vectors seed the KNN
const MAX_LANE_CANDIDATES = 3;
const WHY_MAX_TITLES = 2;

// ---- LRU for on-the-fly query vectors ---------------------------------
//
// Keyed by a cheap hash of (url + NUL_SEPARATOR + title). Map preserves insertion
// order; we delete+reinsert on hit to make it LRU, and evict the oldest key
// when over cap. Module-scoped so it survives across resolves in one process;
// bounded at LRU_CAP entries (~200 × 384 floats ≈ 300KB).

const queryVectorLru = new Map<string, Float32Array>();

const hashKey = (url: string, title: string): string => {
  // FNV-1a over url\0title. Cheap, no allocation beyond the number, collisions
  // are harmless here (a collision just reuses a near-identical query vector).
  const s = `${url}\u0000${title}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};

const lruGet = (key: string): Float32Array | undefined => {
  const hit = queryVectorLru.get(key);
  if (hit === undefined) return undefined;
  queryVectorLru.delete(key);
  queryVectorLru.set(key, hit);
  return hit;
};

const lruSet = (key: string, vec: Float32Array): void => {
  if (queryVectorLru.has(key)) queryVectorLru.delete(key);
  queryVectorLru.set(key, vec);
  while (queryVectorLru.size > LRU_CAP) {
    const oldest = queryVectorLru.keys().next().value;
    if (oldest === undefined) break;
    queryVectorLru.delete(oldest);
  }
};

// Exposed for tests — reset the process-scoped LRU between cases.
export const __resetContentLaneLru = (): void => {
  queryVectorLru.clear();
};

// ---- URL-token extraction (for the embed text + FTS query) ------------
//
// Mirrors the intent of the recall pipeline's URL tokenization: keep the host
// labels + path segments as space-separated words so the FTS/embed sees the
// slug ("aws cloudtrail iam setup") not the punctuation. Best-effort — a
// non-URL string yields its own alnum-split words.

const urlTokens = (url: string): string => {
  let rest = url;
  const schemeIdx = rest.indexOf('://');
  if (schemeIdx >= 0) rest = rest.slice(schemeIdx + 3);
  // Drop query/hash — high-entropy, low-signal for topic matching.
  const q = rest.search(/[?#]/u);
  if (q >= 0) rest = rest.slice(0, q);
  return rest
    .split(/[^a-zA-Z0-9]+/u)
    .filter((tok) => tok.length >= 2 && tok.length <= 40 && !/^\d+$/u.test(tok))
    .join(' ');
};

// ---- workstream join (from the ConnectionsSnapshot) -------------------
//
// Two lookup maps built once per resolve from the snapshot the resolver already
// holds (no new I/O):
//   - canonicalUrl → workstreamId : via visit_(instance_)in_workstream edges,
//     resolving the visit node's metadata.canonicalUrl (and the
//     `timeline-visit:<url>` id convention as a fallback).
//   - threadId → workstreamId : via thread_in_workstream edges.

const VISIT_PREFIX = 'timeline-visit:';
const VISIT_INSTANCE_PREFIX = 'visit-instance:';
const THREAD_PREFIX = 'thread:';
const WORKSTREAM_PREFIX = 'workstream:';

interface WorkstreamJoin {
  readonly byUrl: ReadonlyMap<string, string>;
  readonly byThread: ReadonlyMap<string, string>;
}

const buildWorkstreamJoin = (snapshot: ConnectionsSnapshot): WorkstreamJoin => {
  // node id → canonicalUrl for visit nodes (so an edge's from-node maps to a URL).
  const urlOfVisitNode = new Map<string, string>();
  for (const node of snapshot.nodes) {
    if (node.id.startsWith(VISIT_PREFIX) || node.id.startsWith(VISIT_INSTANCE_PREFIX)) {
      const url = typeof node.metadata.canonicalUrl === 'string'
        ? node.metadata.canonicalUrl
        : typeof node.metadata.url === 'string'
          ? node.metadata.url
          : node.id.startsWith(VISIT_PREFIX)
            ? node.id.slice(VISIT_PREFIX.length)
            : undefined;
      if (url !== undefined && url.length > 0) urlOfVisitNode.set(node.id, url);
    }
  }
  const byUrl = new Map<string, string>();
  const byThread = new Map<string, string>();
  for (const edge of snapshot.edges) {
    if (!edge.toNodeId.startsWith(WORKSTREAM_PREFIX)) continue;
    const workstreamId = edge.toNodeId.slice(WORKSTREAM_PREFIX.length);
    if (workstreamId.length === 0) continue;
    if (edge.kind === 'visit_in_workstream' || edge.kind === 'visit_instance_in_workstream') {
      const url = urlOfVisitNode.get(edge.fromNodeId);
      if (url !== undefined && !byUrl.has(url)) byUrl.set(url, workstreamId);
    } else if (edge.kind === 'thread_in_workstream') {
      if (edge.fromNodeId.startsWith(THREAD_PREFIX)) {
        const threadId = edge.fromNodeId.slice(THREAD_PREFIX.length);
        if (threadId.length > 0 && !byThread.has(threadId)) byThread.set(threadId, workstreamId);
      }
    }
  }
  return { byUrl, byThread };
};

// ---- RRF combine ------------------------------------------------------
//
// Reciprocal Rank Fusion: a doc's fused score is Σ over rankings of
// 1/(k + rank), rank 1-based. Deduped by entityId. Each contributing ranking
// carries hit metadata (canonicalUrl/threadId/title/bodyIndexed) so the join
// + why-rendering downstream see the doc once with its best provenance.

interface FusedHit {
  readonly entityId: string;
  readonly canonicalUrl: string | undefined;
  readonly threadId: string | undefined;
  readonly title: string | undefined;
  // 1 iff any contributing ranking saw a content-derived vector for this doc.
  readonly bodyIndexed: boolean;
  readonly rrf: number;
}

interface RankedDoc {
  readonly entityId: string;
  readonly canonicalUrl: string | undefined;
  readonly threadId?: string | undefined;
  readonly title: string | undefined;
  readonly bodyIndexed: 0 | 1 | undefined;
}

const rrfCombine = (rankings: readonly (readonly RankedDoc[])[]): readonly FusedHit[] => {
  const acc = new Map<
    string,
    { canonicalUrl?: string; threadId?: string; title?: string; bodyIndexed: boolean; rrf: number }
  >();
  for (const ranking of rankings) {
    for (let rank = 0; rank < ranking.length; rank += 1) {
      const doc = ranking[rank]!;
      const contribution = 1 / (RRF_K + rank + 1);
      const prior = acc.get(doc.entityId);
      if (prior === undefined) {
        acc.set(doc.entityId, {
          ...(doc.canonicalUrl === undefined ? {} : { canonicalUrl: doc.canonicalUrl }),
          ...(doc.threadId === undefined ? {} : { threadId: doc.threadId }),
          ...(doc.title === undefined ? {} : { title: doc.title }),
          bodyIndexed: doc.bodyIndexed === 1,
          rrf: contribution,
        });
      } else {
        prior.rrf += contribution;
        prior.bodyIndexed = prior.bodyIndexed || doc.bodyIndexed === 1;
        if (prior.canonicalUrl === undefined && doc.canonicalUrl !== undefined) {
          prior.canonicalUrl = doc.canonicalUrl;
        }
        if (prior.threadId === undefined && doc.threadId !== undefined) prior.threadId = doc.threadId;
        if (prior.title === undefined && doc.title !== undefined) prior.title = doc.title;
      }
    }
  }
  return [...acc.entries()].map(([entityId, v]) => ({
    entityId,
    canonicalUrl: v.canonicalUrl,
    threadId: v.threadId,
    title: v.title,
    bodyIndexed: v.bodyIndexed,
    rrf: v.rrf,
  }));
};

// ---- query-vector acquisition -----------------------------------------

interface QueryVectorResult {
  // The seed vector to run KNN with, or undefined ⇒ lexical-only.
  readonly vector: Float32Array | undefined;
  // Whether a live embed was performed (vs an LRU / skipped path) — diagnostics.
  readonly embedded: boolean;
  // entityIds to exclude from KNN (the page's own rows).
  readonly ownEntityIds: ReadonlySet<string>;
}

// Query-vector acquisition. The store's vector methods take a query VECTOR and
// there is NO getVector(entityId) accessor (verified in sqlite.ts — only
// KNN-by-vector). So for BOTH indexed and un-indexed pages the query vector is
// a bounded on-the-fly embed of `title + ' ' + url-tokens`; the page's own
// stored rows serve as the KNN exclude set + FTS anchor + indexed
// classification. The "full-vector, not title" promise holds on the CORPUS
// side — a chunk/doc KNN returns full-body neighbor vectors (bodyIndexed=1) —
// while the query side is the page's title+url embed. The LRU (keyed by
// hash(url+title)) skips the embed on the second resolve of the same page.
const acquireQueryVector = async (input: {
  readonly canonicalUrl: string;
  readonly title: string | null;
  readonly embed: ContentLaneEmbed | undefined;
  readonly embedderUsable: boolean;
  readonly ownEntityIds: ReadonlySet<string>;
}): Promise<QueryVectorResult> => {
  if (!input.embedderUsable || input.embed === undefined) {
    return { vector: undefined, embedded: false, ownEntityIds: input.ownEntityIds };
  }
  const title = input.title ?? '';
  const embedText = `${title} ${urlTokens(input.canonicalUrl)}`.trim();
  if (embedText.length === 0) {
    return { vector: undefined, embedded: false, ownEntityIds: input.ownEntityIds };
  }
  const key = hashKey(input.canonicalUrl, title);
  const cached = lruGet(key);
  if (cached !== undefined) {
    return { vector: cached, embedded: false, ownEntityIds: input.ownEntityIds };
  }
  const raced = await Promise.race([
    input.embed(embedText),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), EMBED_RACE_MS)),
  ]);
  if (raced === undefined) {
    return { vector: undefined, embedded: false, ownEntityIds: input.ownEntityIds };
  }
  lruSet(key, raced);
  return { vector: raced, embedded: true, ownEntityIds: input.ownEntityIds };
};

// ---- lane assembly ----------------------------------------------------

export interface BuildContentLaneInput {
  readonly canonicalUrl: string;
  readonly snapshot: ConnectionsSnapshot;
  // Best-effort page title (titleHint → visit-record latestTitle → snapshot
  // lookup already resolved by the caller). Null ⇒ no title known.
  readonly title: string | null;
  // The already-open /v2 recall store handle. Undefined ⇒ typed-empty lane.
  readonly store: ContentLaneStore | undefined;
  // Query-time embed, or undefined when the embedder is not usable.
  readonly embed?: ContentLaneEmbed | undefined;
  readonly embedderUsable: boolean;
  // AUTHORITATIVE workstream lookup for NEIGHBOR urls — backed by the URL
  // attribution projection (user_asserted + inferred filings). The snapshot
  // the resolver holds is SCOPED to the query URL, so neighbors' membership
  // edges are usually NOT in it — joining on the snapshot alone reported
  // "none filed" while hatchet.run/blog/postgres-survival-guide (a live
  // neighbor) was user-filed (caught by the user, 2026-07-27). The lookup is
  // consulted FIRST; the snapshot join remains as a fallback for callers
  // that cannot supply a projection.
  readonly lookupWorkstreamByUrl?: (canonicalUrl: string) => string | undefined;
}

// Exact-URL keyed lookups drift on trailing slashes across stores (the
// projection vs recall-store key shapes) — try both spellings, the same
// urlSlashVariants discipline the panel uses.
const slashVariants = (url: string): readonly string[] =>
  url.endsWith('/') ? [url, url.slice(0, -1)] : [url, `${url}/`];

const typedEmpty = (emptyReason: string): GuessLaneResult => ({
  lane: 'content',
  candidates: [],
  emptyReason,
});

// FTS source kinds — all three doc kinds the store indexes.
const ALL_SOURCE_KINDS: readonly string[] = ['page_content', 'timeline_visit', 'chat_turn'];

export const buildContentLane = async (
  input: BuildContentLaneInput,
): Promise<GuessLaneResult> => {
  const { store, canonicalUrl, snapshot, title } = input;
  if (store === undefined) {
    return typedEmpty('recall store unavailable');
  }

  // The page's own stored rows (indexed pages) — used as the KNN exclude set +
  // an FTS anchor + the indexed/not-indexed classification. Cheap URL lookup
  // that bypasses the FTS tokenizer.
  let ownRows: readonly ContentFtsHit[] = [];
  try {
    ownRows = store.queryByCanonicalUrl({ canonicalUrl, limit: 8 });
  } catch {
    ownRows = [];
  }
  const isIndexed = ownRows.length > 0;
  const ownEntityIds = new Set(ownRows.map((r) => r.entityId));

  // (1) query-vector acquisition (bounded embed race + LRU); skipped when the
  // vector backend is unavailable (lexical-only).
  const qv = store.vectorBackendAvailable
    ? await acquireQueryVector({
        canonicalUrl,
        title,
        embed: input.embed,
        embedderUsable: input.embedderUsable,
        ownEntityIds,
      })
    : { vector: undefined, embedded: false, ownEntityIds };

  // (2) retrieval — vector KNN + FTS, each top-12.
  const vectorRanking: RankedDoc[] = [];
  if (qv.vector !== undefined) {
    const vec = qv.vector;
    let hits: readonly ContentVectorHit[] = [];
    try {
      // Prefer chunk KNN (passage-level, "sliced for large chunks") when the
      // store supports it; fall back to whole-doc KNN when chunk KNN is empty
      // (no chunk vectors) or unsupported.
      if (store.queryChunkVector !== undefined) {
        const chunkHits = store.queryChunkVector({ vec, limit: KNN_LIMIT, excludeEntityIds: ownEntityIds });
        hits =
          chunkHits.length > 0
            ? chunkHits
            : store.queryVector({ vec, limit: KNN_LIMIT, excludeEntityIds: ownEntityIds });
      } else {
        hits = store.queryVector({ vec, limit: KNN_LIMIT, excludeEntityIds: ownEntityIds });
      }
    } catch {
      hits = [];
    }
    for (const hit of hits) {
      vectorRanking.push({
        entityId: hit.entityId,
        canonicalUrl: hit.canonicalUrl,
        title: hit.title,
        bodyIndexed: hit.bodyIndexed,
      });
    }
  }

  const ftsQuery = composeFtsQuery(title, canonicalUrl);
  let ftsRanking: RankedDoc[] = [];
  if (ftsQuery.length > 0) {
    try {
      const hits = store.queryFts({ q: ftsQuery, sourceKind: ALL_SOURCE_KINDS, limit: FTS_LIMIT });
      ftsRanking = hits
        .filter((h) => !qv.ownEntityIds.has(h.entityId))
        .map((h) => ({
          entityId: h.entityId,
          canonicalUrl: h.canonicalUrl,
          threadId: h.threadId,
          title: h.title,
          bodyIndexed: h.bodyIndexed,
        }));
    } catch {
      ftsRanking = [];
    }
  }

  // (3) RRF combine.
  const fused = rrfCombine([vectorRanking, ftsRanking]);
  if (fused.length === 0) {
    if (!isIndexed && (title === null || title.length === 0)) {
      return typedEmpty('no title to compare and page not indexed');
    }
    if (qv.vector === undefined && !input.embedderUsable) {
      return typedEmpty('embedder cold — no lexical matches');
    }
    return typedEmpty('nothing indexed matches this page yet');
  }

  // (4) workstream join + per-workstream aggregation.
  const join = buildWorkstreamJoin(snapshot);
  interface Agg {
    sum: number;
    titles: string[];
    count: number;
    anyContent: boolean; // any hit had a content-derived (bodyIndexed=1) vector
  }
  const perWorkstream = new Map<string, Agg>();
  let droppedUnattributed = 0;
  for (const hit of fused) {
    let workstreamId: string | undefined;
    if (hit.canonicalUrl !== undefined) {
      // Projection lookup FIRST (authoritative filings, full-vault scope);
      // scoped-snapshot edges only as fallback. Slash variants on both.
      for (const variant of slashVariants(hit.canonicalUrl)) {
        workstreamId = input.lookupWorkstreamByUrl?.(variant);
        if (workstreamId !== undefined) break;
      }
      if (workstreamId === undefined) {
        for (const variant of slashVariants(hit.canonicalUrl)) {
          workstreamId = join.byUrl.get(variant);
          if (workstreamId !== undefined) break;
        }
      }
    }
    if (workstreamId === undefined && hit.threadId !== undefined) {
      workstreamId = join.byThread.get(hit.threadId);
    }
    if (workstreamId === undefined) {
      droppedUnattributed += 1;
      continue;
    }
    const agg = perWorkstream.get(workstreamId) ?? { sum: 0, titles: [], count: 0, anyContent: false };
    agg.sum += hit.rrf;
    agg.count += 1;
    agg.anyContent = agg.anyContent || hit.bodyIndexed;
    if (hit.title !== undefined && hit.title.length > 0 && agg.titles.length < WHY_MAX_TITLES) {
      if (!agg.titles.includes(hit.title)) agg.titles.push(hit.title);
    }
    perWorkstream.set(workstreamId, agg);
  }

  if (perWorkstream.size === 0) {
    // Everything matched but nothing was attributed to a workstream. This is
    // NOT "nothing matches" — the lane found neighbors, but the join has no
    // labels to vote with. Say so: the lane's ceiling here is attribution
    // sparsity (label economics), not retrieval, and the fix the reason
    // points at is "file some of these matches", not "index more pages".
    return typedEmpty(
      `${String(droppedUnattributed)} similar ${droppedUnattributed === 1 ? 'page' : 'pages'} found, none filed to a workstream yet`,
    );
  }

  const maxSum = Math.max(...[...perWorkstream.values()].map((a) => a.sum));
  const candidates: GuessLaneCandidate[] = [...perWorkstream.entries()].map(([workstreamId, agg]) => ({
    workstreamId,
    score: maxSum > 0 ? Math.min(1, agg.sum / maxSum) : 0,
    why: renderWhy(agg.count, agg.titles, agg.anyContent),
  }));
  void droppedUnattributed; // counted for diagnostics; not surfaced in `why`

  const top = candidates
    .sort((l, r) =>
      r.score !== l.score
        ? r.score - l.score
        : l.workstreamId < r.workstreamId
          ? -1
          : l.workstreamId > r.workstreamId
            ? 1
            : 0,
    )
    .slice(0, MAX_LANE_CANDIDATES);

  return { lane: 'content', candidates: top };
};

// Compose the FTS query from title + URL tokens. Lexical only — no vector.
// Uses the same non-punctuation URL-token slug the embed sees.
const composeFtsQuery = (title: string | null, canonicalUrl: string): string => {
  const parts: string[] = [];
  if (title !== null && title.length > 0) parts.push(title);
  const toks = urlTokens(canonicalUrl);
  if (toks.length > 0) parts.push(toks);
  return parts.join(' ').trim();
};

// Render the honest `why`: match count + up to 2 doc titles, and title-vector
// provenance when NO content-derived vector backed any of this workstream's
// hits (chat_turn / timeline_visit title-only embeds).
const renderWhy = (
  count: number,
  titles: readonly string[],
  anyContent: boolean,
): string => {
  const provenance = anyContent ? '' : ' · title-vector';
  const named = titles.length === 0 ? '' : ` (${titles.join(', ')})`;
  const plural = count === 1 ? 'match' : 'matches';
  return `${count} ${plural}${named}${provenance}`;
};

// ---- serve-side orchestration -----------------------------------------
//
// The route handler calls appendContentLane AFTER resolveUrlAttributionArmed
// (whether the six-lane result came fresh or from the resolver cache) so lane 7
// is decoupled from the resolver cache — it recomputes at query time against the
// live titleHint. It is a no-op that returns the result unchanged when the lane
// is disabled or the result carried no `lanes` (guess lanes off), keeping the
// array 6 long in those cases. Failures degrade to a typed-empty lane, never
// throwing into the resolve.

// A resolve result carrying the optional lanes array (structural subset of
// UrlResolutionResult — avoids a cyclic import into resolver.ts).
export interface ResultWithLanes {
  readonly lanes?: readonly GuessLaneResult[];
}

export interface AppendContentLaneDeps {
  readonly store: ContentLaneStore | undefined;
  readonly embed?: ContentLaneEmbed | undefined;
  readonly embedderUsable: boolean;
  // Whether the parent SIDETRACK_GUESS_LANES flag is on. When off the result
  // carries no lanes and the content lane is omitted (nothing to append to).
  readonly guessLanesEnabled: boolean;
  // Authoritative neighbor-URL → workstream lookup (URL attribution
  // projection). See BuildContentLaneInput.lookupWorkstreamByUrl.
  readonly lookupWorkstreamByUrl?: (canonicalUrl: string) => string | undefined;
}

// Append the query-time content lane to a resolve result. Pure w.r.t. its
// inputs beyond the store/embed round-trips. `title` is the caller-resolved
// best-effort title (titleHint → snapshot lookup) — same fallback the title
// lane uses.
export const appendContentLane = async <T extends ResultWithLanes>(
  result: T,
  input: {
    readonly canonicalUrl: string;
    readonly snapshot: ConnectionsSnapshot;
    readonly title: string | null;
  },
  deps: AppendContentLaneDeps,
): Promise<T> => {
  // Guess lanes off ⇒ no lanes array ⇒ nothing to append to. Content lane off ⇒
  // leave the six-lane array untouched.
  if (!deps.guessLanesEnabled || !contentLaneEnabled() || result.lanes === undefined) {
    return result;
  }
  let lane: GuessLaneResult;
  try {
    lane = await buildContentLane({
      canonicalUrl: input.canonicalUrl,
      snapshot: input.snapshot,
      title: input.title,
      store: deps.store,
      ...(deps.embed === undefined ? {} : { embed: deps.embed }),
      embedderUsable: deps.embedderUsable,
      ...(deps.lookupWorkstreamByUrl === undefined
        ? {}
        : { lookupWorkstreamByUrl: deps.lookupWorkstreamByUrl }),
    });
  } catch (err) {
    lane = typedEmpty('recall store unavailable');
    void err;
  }
  // Idempotent: replace any prior 'content' entry (e.g. a cached result already
  // carried one) rather than appending a duplicate.
  const withoutContent = result.lanes.filter((existing) => existing.lane !== 'content');
  return { ...result, lanes: [...withoutContent, lane] };
};
