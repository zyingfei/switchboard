import { type ConnectionEdge } from '../connections/types.js';
import { USER_FLOW_CONFIRMED } from '../feedback/events.js';
import { NAVIGATION_COMMITTED, isNavigationCommittedPayload } from '../navigation/events.js';
import { type WeightedItem } from '../page-evidence/idf.js';
import type { PageEvidenceRecord, WeightedEntity } from '../page-evidence/types.js';
import { SELECTION_COPIED, isSelectionCopiedPayload } from '../snippets/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { BROWSER_TIMELINE_OBSERVED, isBrowserTimelineObservedPayload } from '../timeline/events.js';
import { detectSearchUrl } from '../timeline/sanitize.js';
import type { Candidate, CandidateSource, GenerateCandidates } from './types.js';

type CandidateContext = Parameters<GenerateCandidates>[1];

type SourceGenerator = (
  fromVisitId: string,
  context: CandidateContext,
  generatedAt: number,
) => readonly Candidate[];

interface VisitRecord {
  readonly id: string;
  readonly url: string;
  readonly canonicalUrl: string;
  readonly observedAtMs: number;
  readonly title?: string;
  readonly workstreamId?: string;
  readonly openerVisitId?: string;
  readonly previousVisitId?: string;
  readonly replicaId?: string;
}

export const CANDIDATE_SOURCES = [
  'user_confirmed',
  'opener_chain',
  'navigation_chain',
  'same_canonical_url',
  'same_repo_or_domain',
  'same_search_query',
  'same_copied_snippet',
  'same_title_path_tokens',
  'embedding_neighborhood',
  'content_term_overlap',
  'content_embedding_neighborhood',
  'cross_replica_continuation',
  'random_unrelated',
  'recently_skipped',
] as const satisfies readonly CandidateSource[];

const SOURCE_ORDER = new Map<CandidateSource, number>(
  CANDIDATE_SOURCES.map((source, index) => [source, index]),
);

const TIMELINE_VISIT_PREFIX = 'timeline-visit:';
const SNIPPET_PREFIX = 'snippet:';
const EXPLICIT_RANDOM_UNRELATED = 'ranker.random_unrelated';
const USER_FLOW_REJECTED = 'user.flow.rejected';

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const visitKeyForUrl = (url: string): string =>
  url.trim().replace(/#.*$/u, '').replace(/\/+$/u, '');

const maybeTimestamp = (value: number): number | null => (Number.isFinite(value) ? value : null);

const parseTimestamp = (value: string): number | null => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const maxTimestamp = (current: number, candidate: number | null): number =>
  candidate === null || candidate <= current ? current : candidate;

const stableGeneratedAt = (context: CandidateContext): number => {
  let generatedAt = 0;

  for (const event of context.merged) {
    generatedAt = maxTimestamp(generatedAt, maybeTimestamp(event.acceptedAtMs));
    if (event.type === NAVIGATION_COMMITTED && isNavigationCommittedPayload(event.payload)) {
      generatedAt = maxTimestamp(generatedAt, maybeTimestamp(event.payload.commitTimestamp));
    }
    if (
      event.type === BROWSER_TIMELINE_OBSERVED &&
      isBrowserTimelineObservedPayload(event.payload)
    ) {
      generatedAt = maxTimestamp(generatedAt, parseTimestamp(event.payload.observedAt));
    }
  }

  for (const edge of context.existingEdges) {
    generatedAt = maxTimestamp(generatedAt, parseTimestamp(edge.observedAt));
  }

  return generatedAt;
};

const parsePrefixedId = (value: string, prefix: string): string | null => {
  if (!value.startsWith(prefix)) return null;
  const id = value.slice(prefix.length);
  return id.length > 0 ? id : null;
};

const visitIdFromNodeOrRaw = (value: string): string =>
  parsePrefixedId(value, TIMELINE_VISIT_PREFIX) ?? value;

const fromKeyFor = (fromVisitId: string): string => visitIdFromNodeOrRaw(fromVisitId);

const singleSourceCandidate = (
  fromVisitId: string,
  toVisitId: string,
  source: CandidateSource,
  generatedAt: number,
): Candidate | null => {
  if (fromVisitId.length === 0 || toVisitId.length === 0) return null;
  if (fromKeyFor(fromVisitId) === visitIdFromNodeOrRaw(toVisitId)) return null;
  return {
    fromVisitId,
    toVisitId,
    sources: [source],
    generatedAt,
  };
};

const candidatesFromIds = (
  fromVisitId: string,
  toVisitIds: Iterable<string>,
  source: CandidateSource,
  generatedAt: number,
): readonly Candidate[] => {
  const candidates: Candidate[] = [];
  for (const toVisitId of [...new Set(toVisitIds)].sort(compareText)) {
    const candidate = singleSourceCandidate(fromVisitId, toVisitId, source, generatedAt);
    if (candidate !== null) candidates.push(candidate);
  }
  return candidates;
};

const pickLatestText = (
  left: string,
  leftObservedAtMs: number,
  right: string,
  rightObservedAtMs: number,
): string => {
  if (rightObservedAtMs > leftObservedAtMs) return right;
  if (rightObservedAtMs < leftObservedAtMs) return left;
  return compareText(right, left) < 0 ? right : left;
};

const pickOptionalLatestText = (
  left: string | undefined,
  leftObservedAtMs: number,
  right: string | undefined,
  rightObservedAtMs: number,
): string | undefined => {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return pickLatestText(left, leftObservedAtMs, right, rightObservedAtMs);
};

const pickRicherTitle = (
  left: string | undefined,
  right: string | undefined,
): string | undefined => {
  if (left === undefined || left.length === 0) return right;
  if (right === undefined || right.length === 0) return left;
  if (right.length > left.length) return right;
  if (right.length < left.length) return left;
  return compareText(right, left) < 0 ? right : left;
};

const mergeVisitRecord = (left: VisitRecord, right: VisitRecord): VisitRecord => {
  const observedAtMs = Math.max(left.observedAtMs, right.observedAtMs);
  const title = pickRicherTitle(left.title, right.title);
  const workstreamId = pickOptionalLatestText(
    left.workstreamId,
    left.observedAtMs,
    right.workstreamId,
    right.observedAtMs,
  );
  const openerVisitId = pickOptionalLatestText(
    left.openerVisitId,
    left.observedAtMs,
    right.openerVisitId,
    right.observedAtMs,
  );
  const previousVisitId = pickOptionalLatestText(
    left.previousVisitId,
    left.observedAtMs,
    right.previousVisitId,
    right.observedAtMs,
  );
  const replicaId = pickOptionalLatestText(
    left.replicaId,
    left.observedAtMs,
    right.replicaId,
    right.observedAtMs,
  );

  return {
    id: left.id,
    url: pickLatestText(left.url, left.observedAtMs, right.url, right.observedAtMs),
    canonicalUrl: pickLatestText(
      left.canonicalUrl,
      left.observedAtMs,
      right.canonicalUrl,
      right.observedAtMs,
    ),
    observedAtMs,
    ...(title === undefined ? {} : { title }),
    ...(workstreamId === undefined ? {} : { workstreamId }),
    ...(openerVisitId === undefined ? {} : { openerVisitId }),
    ...(previousVisitId === undefined ? {} : { previousVisitId }),
    ...(replicaId === undefined ? {} : { replicaId }),
  };
};

const collectVisitRecords = (events: readonly AcceptedEvent[]): readonly VisitRecord[] => {
  const byId = new Map<string, VisitRecord>();
  const put = (record: VisitRecord): void => {
    const existing = byId.get(record.id);
    byId.set(record.id, existing === undefined ? record : mergeVisitRecord(existing, record));
  };

  for (const event of events) {
    if (event.type === NAVIGATION_COMMITTED && isNavigationCommittedPayload(event.payload)) {
      const canonicalUrl = visitKeyForUrl(event.payload.canonicalUrl);
      if (event.payload.visitId.length === 0 || canonicalUrl.length === 0) continue;
      const observedAtMs = event.payload.commitTimestamp;
      put({
        id: event.payload.visitId,
        url: event.payload.url,
        canonicalUrl,
        observedAtMs,
        ...(event.payload.openerVisitId === null
          ? {}
          : { openerVisitId: event.payload.openerVisitId }),
        ...(event.payload.previousVisitId === null
          ? {}
          : { previousVisitId: event.payload.previousVisitId }),
        ...(event.dot.replicaId.length === 0 ? {} : { replicaId: event.dot.replicaId }),
      });
      continue;
    }

    if (
      event.type === BROWSER_TIMELINE_OBSERVED &&
      isBrowserTimelineObservedPayload(event.payload)
    ) {
      const canonicalUrl = visitKeyForUrl(event.payload.canonicalUrl ?? event.payload.url);
      if (canonicalUrl.length === 0) continue;
      put({
        id: canonicalUrl,
        url: event.payload.url,
        canonicalUrl,
        observedAtMs: parseTimestamp(event.payload.observedAt) ?? event.acceptedAtMs,
        ...(event.payload.title === undefined || event.payload.title.length === 0
          ? {}
          : { title: event.payload.title }),
        ...(event.payload.workstreamId === undefined || event.payload.workstreamId.length === 0
          ? {}
          : { workstreamId: event.payload.workstreamId }),
        ...(event.dot.replicaId.length === 0 ? {} : { replicaId: event.dot.replicaId }),
      });
    }
  }

  return [...byId.values()].sort((left, right) => compareText(left.id, right.id));
};

const recordsById = (records: readonly VisitRecord[]): ReadonlyMap<string, VisitRecord> =>
  new Map(records.map((record) => [record.id, record] as const));

interface GroupedRecordIndex {
  readonly byKey: ReadonlyMap<string, ReadonlySet<string>>;
  readonly keysByRecordId: ReadonlyMap<string, readonly string[]>;
}

interface CandidateContextIndexes {
  readonly generatedAt: number;
  readonly records: readonly VisitRecord[];
  readonly recordsById: ReadonlyMap<string, VisitRecord>;
  readonly groupedRecordIndexes: Map<CandidateSource, GroupedRecordIndex>;
  readonly chainGraphs: Map<CandidateSource, ReadonlyMap<string, ReadonlySet<string>>>;
  snippetGroups?: ReadonlyMap<string, ReadonlySet<string>>;
  embeddingNeighbors?: ReadonlyMap<string, ReadonlySet<string>>;
  contentTermEdgeNeighbors?: ReadonlyMap<string, ReadonlySet<string>>;
  contentVectorEdgeNeighbors?: ReadonlyMap<string, ReadonlySet<string>>;
  contentTermEvidenceNeighbors?: ReadonlyMap<string, readonly string[]>;
}

const indexesByContext = new WeakMap<object, CandidateContextIndexes>();

const indexesFor = (context: CandidateContext): CandidateContextIndexes => {
  const cached = indexesByContext.get(context);
  if (cached !== undefined) return cached;
  const records = collectVisitRecords(context.merged);
  const indexes: CandidateContextIndexes = {
    generatedAt: stableGeneratedAt(context),
    records,
    recordsById: recordsById(records),
    groupedRecordIndexes: new Map(),
    chainGraphs: new Map(),
  };
  indexesByContext.set(context, indexes);
  return indexes;
};

const addToSetMap = (map: Map<string, Set<string>>, key: string, value: string): void => {
  if (key.length === 0 || value.length === 0) return;
  let set = map.get(key);
  if (set === undefined) {
    set = new Set<string>();
    map.set(key, set);
  }
  set.add(value);
};

const toSortedIds = (set: ReadonlySet<string> | undefined): readonly string[] =>
  set === undefined ? [] : [...set].sort(compareText);

const addUndirected = (graph: Map<string, Set<string>>, left: string, right: string): void => {
  if (left.length === 0 || right.length === 0 || left === right) return;
  addToSetMap(graph, left, right);
  addToSetMap(graph, right, left);
};

// Connected components of an undirected graph, computed in ONE pass.
// Every node maps to the sorted member list of its component (the
// array instance is shared across all members of that component).
// Replaces a per-node walkGraph() BFS when many nodes of the same
// graph are queried — O(graph) once instead of O(nodes × component).
const buildComponents = (
  graph: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyMap<string, readonly string[]> => {
  const componentByNode = new Map<string, readonly string[]>();
  for (const start of graph.keys()) {
    if (componentByNode.has(start)) continue;
    const seen = new Set<string>([start]);
    const queue: string[] = [start];
    let index = 0;
    while (index < queue.length) {
      const current = queue[index];
      index += 1;
      if (current === undefined) continue;
      for (const next of graph.get(current) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    const members = [...seen].sort(compareText);
    for (const node of members) componentByNode.set(node, members);
  }
  return componentByNode;
};

const pairSourceGenerator = (
  source: CandidateSource,
  readPairs: (
    context: CandidateContext,
  ) => readonly { readonly from: string; readonly to: string }[],
): SourceGenerator => {
  // Index readPairs(context) into a from→to map ONCE per context. The
  // old code re-ran readPairs (a full scan of context.merged) and
  // re-filtered the whole pair list for every visit — O(visits × events).
  const byFromCache = new WeakMap<object, ReadonlyMap<string, readonly string[]>>();
  return (fromVisitId, context, generatedAt) => {
    let byFrom = byFromCache.get(context);
    if (byFrom === undefined) {
      const built = new Map<string, string[]>();
      for (const pair of readPairs(context)) {
        const list = built.get(pair.from);
        if (list === undefined) built.set(pair.from, [pair.to]);
        else list.push(pair.to);
      }
      byFrom = built;
      byFromCache.set(context, byFrom);
    }
    return candidatesFromIds(
      fromVisitId,
      byFrom.get(fromKeyFor(fromVisitId)) ?? [],
      source,
      generatedAt,
    );
  };
};

const sourceWrapper =
  (source: CandidateSource, generator: SourceGenerator): GenerateCandidates =>
  (fromVisitId, context) =>
    generator(fromVisitId, context, indexesFor(context).generatedAt);

const groupedRecordCandidates = (
  fromVisitId: string,
  context: CandidateContext,
  source: CandidateSource,
  generatedAt: number,
  keyForRecord: (record: VisitRecord) => readonly string[],
): readonly Candidate[] => {
  const indexes = indexesFor(context);
  const fromRecord = indexes.recordsById.get(fromKeyFor(fromVisitId));
  if (fromRecord === undefined) return [];
  let grouped = indexes.groupedRecordIndexes.get(source);
  if (grouped === undefined) {
    const byKey = new Map<string, Set<string>>();
    const keysByRecordId = new Map<string, readonly string[]>();
    for (const record of indexes.records) {
      const keys = keyForRecord(record);
      keysByRecordId.set(record.id, keys);
      for (const key of keys) {
        addToSetMap(byKey, key, record.id);
      }
    }
    grouped = { byKey, keysByRecordId };
    indexes.groupedRecordIndexes.set(source, grouped);
  }

  const toVisitIds = new Set<string>();
  for (const key of grouped.keysByRecordId.get(fromRecord.id) ?? []) {
    for (const toVisitId of toSortedIds(grouped.byKey.get(key))) {
      toVisitIds.add(toVisitId);
    }
  }

  return candidatesFromIds(fromVisitId, toVisitIds, source, generatedAt);
};

const chainGenerator = (
  source: CandidateSource,
  linkForRecord: (record: VisitRecord) => string | undefined,
): SourceGenerator => {
  // Precompute connected components ONCE per context. The old code ran
  // a fresh walkGraph() BFS — with a sort at every node visited — for
  // every visit, i.e. O(visits × component). Components are stable for
  // the graph, so one pass serves all visits.
  const componentsCache = new WeakMap<object, ReadonlyMap<string, readonly string[]>>();
  return (fromVisitId, context, generatedAt) => {
    const indexes = indexesFor(context);
    let graph = indexes.chainGraphs.get(source);
    if (graph === undefined) {
      const nextGraph = new Map<string, Set<string>>();
      for (const record of indexes.records) {
        const linked = linkForRecord(record);
        if (linked !== undefined) addUndirected(nextGraph, record.id, linked);
      }
      graph = nextGraph;
      indexes.chainGraphs.set(source, graph);
    }
    let components = componentsCache.get(context);
    if (components === undefined) {
      components = buildComponents(graph);
      componentsCache.set(context, components);
    }
    const fromKey = fromKeyFor(fromVisitId);
    // walkGraph excluded the start node; match that exactly.
    const reachable = (components.get(fromKey) ?? []).filter((id) => id !== fromKey);
    return candidatesFromIds(fromVisitId, reachable, source, generatedAt);
  };
};

// Registrable domains of large multi-author / multi-topic platforms where two
// pages sharing the domain are NOT topically related. For these, the bare
// `domain:` grouping key AND the shared site-chrome title/path tokens ("hacker",
// "news", "item", "comments", "watch", …) are pure noise: they linked an
// AI-generated-video Hacker News post to unrelated security items and placed it
// in a linux-security workstream at 82% confidence (same_repo_or_domain scores
// 0.65, same_title_path_tokens 0.45). GitHub/GitLab hit the same coarseness and
// are already grouped at repo granularity instead. Matched by registrable
// domain, so every subdomain is covered (news.ycombinator.com, old.reddit.com,
// m.youtube.com, gemini.google.com, …). Kill-switch (absent = on):
// SIDETRACK_AGGREGATOR_GROUPING_GUARD=0 restores the old bare-domain grouping.
const COARSE_MULTI_TOPIC_DOMAINS: ReadonlySet<string> = new Set([
  'ycombinator.com',
  'reddit.com',
  'lobste.rs',
  'twitter.com',
  'x.com',
  't.co',
  'youtube.com',
  'youtu.be',
  'facebook.com',
  'instagram.com',
  'linkedin.com',
  'medium.com',
  'substack.com',
  'quora.com',
  'pinterest.com',
  'tumblr.com',
  'stackoverflow.com',
  'stackexchange.com',
  'google.com',
  'bing.com',
  'duckduckgo.com',
  'chatgpt.com',
  'openai.com',
  'claude.ai',
]);

// Call-time + case-insensitive so it is togglable in tests and consistent with
// the repo's other boolean flags (lexicalFallbackEnabled, embeddingDisabled).
const aggregatorGroupingGuardEnabled = (): boolean => {
  const raw = process.env['SIDETRACK_AGGREGATOR_GROUPING_GUARD']?.toLowerCase();
  return raw !== '0' && raw !== 'false';
};

/**
 * True when `hostname` belongs to a large multi-topic platform — i.e. two pages
 * sharing only this domain (or its site-chrome tokens) are not topically
 * related. Matched by registrable domain, so any subdomain qualifies. Exported
 * for tests. See {@link COARSE_MULTI_TOPIC_DOMAINS}.
 */
export const isCoarseMultiTopicDomain = (hostname: string): boolean => {
  // Strip a trailing dot (FQDN form, e.g. `news.ycombinator.com.`) so it does
  // not defeat the suffix match.
  const host = hostname.toLowerCase().replace(/^www\./u, '').replace(/\.$/u, '');
  if (host.length === 0) return false;
  const labels = host.split('.');
  // Test the full host and each registrable suffix, never the bare TLD.
  for (let index = 0; index < labels.length - 1; index += 1) {
    if (COARSE_MULTI_TOPIC_DOMAINS.has(labels.slice(index).join('.'))) return true;
  }
  return false;
};

const suppressCoarseGrouping = (hostname: string): boolean =>
  aggregatorGroupingGuardEnabled() && isCoarseMultiTopicDomain(hostname);

// On some multi-topic platforms the URL structure encodes a coherent
// sub-community (a subreddit, a Medium author). Grouping by that — the same way
// GitHub groups by `repo:owner/repo` rather than `domain:github.com` — recovers
// the legitimate signal the bare-domain suppression drops, without the
// topic-blind fan-out of the whole platform.
const communityGroupingKey = (
  hostname: string,
  segments: readonly string[],
): string | null => {
  if (hostname === 'reddit.com' || hostname.endsWith('.reddit.com')) {
    return segments[0] === 'r' && segments[1] !== undefined && segments[1].length > 0
      ? `forum:reddit.com/r/${segments[1]}`
      : null;
  }
  if (hostname === 'medium.com' || hostname.endsWith('.medium.com')) {
    const author = segments[0];
    return author !== undefined && author.startsWith('@') && author.length > 1
      ? `author:medium.com/${author}`
      : null;
  }
  return null;
};

const repoOrDomainKeys = (record: VisitRecord): readonly string[] => {
  try {
    const parsed = new URL(record.canonicalUrl);
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./u, '');
    const segments = parsed.pathname
      .split('/')
      .filter((segment) => segment.length > 0)
      .map((segment) => segment.replace(/\.git$/iu, '').toLowerCase());
    const [owner, repo] = segments;
    if (
      (hostname === 'github.com' || hostname === 'gitlab.com') &&
      owner !== undefined &&
      repo !== undefined
    ) {
      return [`repo:${hostname}/${owner}/${repo}`];
    }
    if (hostname.length === 0) return [];
    if (suppressCoarseGrouping(hostname)) {
      // Coarse platform: prefer a community-level key when the URL encodes one;
      // otherwise emit nothing (the bare domain is topic-blind).
      const community = communityGroupingKey(hostname, segments);
      return community === null ? [] : [community];
    }
    return [`domain:${hostname}`];
  } catch {
    return [];
  }
};

const normalizeSearchQuery = (value: string): string =>
  value.replace(/\s+/gu, ' ').trim().toLowerCase();

const searchQueryKeys = (record: VisitRecord): readonly string[] => {
  const search = detectSearchUrl(record.canonicalUrl) ?? detectSearchUrl(record.url);
  if (search === null) return [];
  const query = normalizeSearchQuery(search.query);
  return query.length === 0 ? [] : [`search:${query}`];
};

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const TITLE_PATH_STOP_TOKENS: ReadonlySet<string> = new Set([
  'about',
  'after',
  'and',
  'blog',
  'com',
  'docs',
  'for',
  'from',
  'html',
  'http',
  'https',
  'into',
  'net',
  'org',
  'page',
  'search',
  'the',
  'this',
  'with',
  'www',
]);

const tokenizeTitlePathText = (value: string): readonly string[] =>
  value
    .split(/[^A-Za-z0-9]+/u)
    .map((token) => token.trim().toLowerCase())
    .filter(
      (token) => token.length >= 3 && !/^\d+$/u.test(token) && !TITLE_PATH_STOP_TOKENS.has(token),
    );

const titlePathTokenKeys = (record: VisitRecord): readonly string[] => {
  const pieces: string[] = [];
  if (record.title !== undefined) pieces.push(record.title);
  try {
    const parsed = new URL(record.canonicalUrl);
    // On multi-topic platforms the title is dominated by site chrome ("… |
    // Hacker News") and the path is a generic stub ("item"), so title/path
    // tokens link unrelated items. Rely on content signals for these pages.
    if (suppressCoarseGrouping(parsed.hostname)) return [];
    for (const part of parsed.pathname.split('/')) {
      pieces.push(safeDecode(part));
    }
  } catch {
    pieces.push(record.canonicalUrl);
  }
  return [...new Set(tokenizeTitlePathText(pieces.join(' ')))].map((token) => `token:${token}`);
};

const snippetGroupsFromEvents = (
  events: readonly AcceptedEvent[],
): ReadonlyMap<string, Set<string>> => {
  const groups = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.type !== SELECTION_COPIED || !isSelectionCopiedPayload(event.payload)) continue;
    addToSetMap(groups, event.payload.selectionHash, event.payload.visitId);
  }
  return groups;
};

const snippetGroupsFromEdges = (
  edges: readonly ConnectionEdge[],
): ReadonlyMap<string, Set<string>> => {
  const groups = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.kind !== 'snippet_copied_from_visit') continue;
    const snippetId = parsePrefixedId(edge.fromNodeId, SNIPPET_PREFIX);
    const visitId = parsePrefixedId(edge.toNodeId, TIMELINE_VISIT_PREFIX);
    if (snippetId !== null && visitId !== null) addToSetMap(groups, snippetId, visitId);
  }
  return groups;
};

const sameCopiedSnippetGenerator: SourceGenerator = (fromVisitId, context, generatedAt) => {
  const indexes = indexesFor(context);
  if (indexes.snippetGroups === undefined) {
    const groups = new Map<string, Set<string>>();
    for (const [snippetId, visitIds] of snippetGroupsFromEvents(context.merged)) {
      for (const visitId of visitIds) addToSetMap(groups, snippetId, visitId);
    }
    for (const [snippetId, visitIds] of snippetGroupsFromEdges(context.existingEdges)) {
      for (const visitId of visitIds) addToSetMap(groups, snippetId, visitId);
    }
    indexes.snippetGroups = groups;
  }

  const fromKey = fromKeyFor(fromVisitId);
  const toVisitIds = new Set<string>();
  for (const visitIds of indexes.snippetGroups.values()) {
    if (!visitIds.has(fromKey)) continue;
    for (const visitId of visitIds) toVisitIds.add(visitId);
  }
  return candidatesFromIds(fromVisitId, toVisitIds, 'same_copied_snippet', generatedAt);
};

const embeddingNeighborhoodGenerator: SourceGenerator = (fromVisitId, context, generatedAt) => {
  const indexes = indexesFor(context);
  if (indexes.embeddingNeighbors === undefined) {
    const neighbors = new Map<string, Set<string>>();
    for (const edge of context.existingEdges) {
      if (edge.kind !== 'visit_resembles_visit') continue;
      const fromEdgeVisit = visitIdFromNodeOrRaw(edge.fromNodeId);
      const toEdgeVisit = visitIdFromNodeOrRaw(edge.toNodeId);
      addToSetMap(neighbors, fromEdgeVisit, toEdgeVisit);
      addToSetMap(neighbors, toEdgeVisit, fromEdgeVisit);
    }
    indexes.embeddingNeighbors = neighbors;
  }
  const fromKey = fromKeyFor(fromVisitId);
  return candidatesFromIds(
    fromVisitId,
    toSortedIds(indexes.embeddingNeighbors.get(fromKey)),
    'embedding_neighborhood',
    generatedAt,
  );
};

const weightedEntityItems = (entities: readonly WeightedEntity[]): readonly WeightedItem[] =>
  entities.map((entity) => ({ normalized: entity.normalized, weight: entity.weight }));

const contentItemsFor = (evidence: PageEvidenceRecord): readonly WeightedItem[] => [
  ...(evidence.content?.terms ?? []),
  ...(evidence.content?.keyphrases ?? []),
  ...weightedEntityItems(evidence.content?.entities ?? []),
];

const CONTENT_TERM_SOURCE_LIMIT = 80;
const CONTENT_TERM_POSTING_LIMIT = 200;
const CONTENT_TERM_CANDIDATE_LIMIT = 80;

interface ContentPosting {
  readonly canonicalUrl: string;
  readonly weight: number;
}

const sortedContentItems = (evidence: PageEvidenceRecord): readonly WeightedItem[] =>
  [...contentItemsFor(evidence)]
    .filter((item) => item.normalized.length > 0 && item.weight > 0)
    .sort(
      (left, right) => right.weight - left.weight || compareText(left.normalized, right.normalized),
    )
    .slice(0, CONTENT_TERM_SOURCE_LIMIT);

const contentTermOverlapFromEvidence = (
  fromVisitId: string,
  context: CandidateContext,
  generatedAt: number,
): readonly Candidate[] | null => {
  const indexes = indexesFor(context);
  const evidenceByCanonicalUrl = context.pageEvidenceByCanonicalUrl;
  if (evidenceByCanonicalUrl === undefined) return null;
  const fromKey = fromKeyFor(fromVisitId);
  const fromEvidence = evidenceByCanonicalUrl.get(fromKey);
  if (fromEvidence?.content === undefined) return [];
  if (indexes.contentTermEvidenceNeighbors === undefined) {
    const records = [...evidenceByCanonicalUrl.values()].filter((record) => {
      if (record.content === undefined) return false;
      return sortedContentItems(record).length > 0;
    });
    const itemsByUrl = new Map(
      records.map((record) => [record.canonicalUrl, sortedContentItems(record)] as const),
    );
    const postingsByTerm = new Map<string, ContentPosting[]>();
    for (const record of records) {
      for (const item of itemsByUrl.get(record.canonicalUrl) ?? []) {
        const postings = postingsByTerm.get(item.normalized) ?? [];
        postings.push({ canonicalUrl: record.canonicalUrl, weight: item.weight });
        postingsByTerm.set(item.normalized, postings);
      }
    }
    for (const [term, postings] of postingsByTerm) {
      postingsByTerm.set(
        term,
        postings
          .sort(
            (left, right) =>
              right.weight - left.weight || compareText(left.canonicalUrl, right.canonicalUrl),
          )
          .slice(0, CONTENT_TERM_POSTING_LIMIT),
      );
    }
    const neighbors = new Map<string, readonly string[]>();
    for (const record of records) {
      const scores = new Map<string, number>();
      for (const item of itemsByUrl.get(record.canonicalUrl) ?? []) {
        for (const posting of postingsByTerm.get(item.normalized) ?? []) {
          if (posting.canonicalUrl === record.canonicalUrl) continue;
          scores.set(
            posting.canonicalUrl,
            (scores.get(posting.canonicalUrl) ?? 0) + Math.min(item.weight, posting.weight),
          );
        }
      }
      const ranked = [...scores.entries()]
        .map(([canonicalUrl, score]) => ({ canonicalUrl, score }))
        .sort(
          (left, right) =>
            right.score - left.score || compareText(left.canonicalUrl, right.canonicalUrl),
        )
        .slice(0, CONTENT_TERM_CANDIDATE_LIMIT)
        .map((row) => row.canonicalUrl);
      neighbors.set(record.canonicalUrl, ranked);
    }
    indexes.contentTermEvidenceNeighbors = neighbors;
  }
  return candidatesFromIds(
    fromVisitId,
    indexes.contentTermEvidenceNeighbors.get(fromEvidence.canonicalUrl) ?? [],
    'content_term_overlap',
    generatedAt,
  );
};

const contentTermOverlapGenerator: SourceGenerator = (fromVisitId, context, generatedAt) => {
  const evidenceCandidates = contentTermOverlapFromEvidence(fromVisitId, context, generatedAt);
  if (evidenceCandidates !== null) return evidenceCandidates;
  const indexes = indexesFor(context);
  if (indexes.contentTermEdgeNeighbors === undefined) {
    const neighbors = new Map<string, Set<string>>();
    for (const edge of context.existingEdges) {
      if (edge.kind !== 'visit_resembles_visit') continue;
      const matchedTerms = edge.metadata?.['matchedTerms'];
      const matchedKeyphrases = edge.metadata?.['matchedKeyphrases'];
      const matchedEntities = edge.metadata?.['matchedEntities'];
      const hasContentTerms =
        (Array.isArray(matchedTerms) && matchedTerms.length > 0) ||
        (Array.isArray(matchedKeyphrases) && matchedKeyphrases.length > 0) ||
        (Array.isArray(matchedEntities) && matchedEntities.length > 0);
      if (!hasContentTerms) continue;
      const fromEdgeVisit = visitIdFromNodeOrRaw(edge.fromNodeId);
      const toEdgeVisit = visitIdFromNodeOrRaw(edge.toNodeId);
      addToSetMap(neighbors, fromEdgeVisit, toEdgeVisit);
      addToSetMap(neighbors, toEdgeVisit, fromEdgeVisit);
    }
    indexes.contentTermEdgeNeighbors = neighbors;
  }
  const fromKey = fromKeyFor(fromVisitId);
  return candidatesFromIds(
    fromVisitId,
    toSortedIds(indexes.contentTermEdgeNeighbors.get(fromKey)),
    'content_term_overlap',
    generatedAt,
  );
};

const contentEmbeddingNeighborhoodGenerator: SourceGenerator = (
  fromVisitId,
  context,
  generatedAt,
) => {
  const indexes = indexesFor(context);
  if (indexes.contentVectorEdgeNeighbors === undefined) {
    const neighbors = new Map<string, Set<string>>();
    for (const edge of context.existingEdges) {
      if (edge.kind !== 'visit_resembles_visit') continue;
      const channels = edge.metadata?.['channels'];
      const contentVector =
        isRecord(channels) && typeof channels['contentVector'] === 'number'
          ? channels['contentVector']
          : undefined;
      if (contentVector === undefined || contentVector <= 0) continue;
      const fromEdgeVisit = visitIdFromNodeOrRaw(edge.fromNodeId);
      const toEdgeVisit = visitIdFromNodeOrRaw(edge.toNodeId);
      addToSetMap(neighbors, fromEdgeVisit, toEdgeVisit);
      addToSetMap(neighbors, toEdgeVisit, fromEdgeVisit);
    }
    indexes.contentVectorEdgeNeighbors = neighbors;
  }
  const fromKey = fromKeyFor(fromVisitId);
  return candidatesFromIds(
    fromVisitId,
    toSortedIds(indexes.contentVectorEdgeNeighbors.get(fromKey)),
    'content_embedding_neighborhood',
    generatedAt,
  );
};

const crossReplicaContinuationGenerator: SourceGenerator = (fromVisitId, context, generatedAt) => {
  const indexes = indexesFor(context);
  const fromRecord = indexes.recordsById.get(fromKeyFor(fromVisitId));
  if (fromRecord?.replicaId === undefined) return [];

  const toVisitIds = indexes.records
    .filter(
      (record) =>
        record.canonicalUrl === fromRecord.canonicalUrl &&
        record.replicaId !== undefined &&
        record.replicaId !== fromRecord.replicaId,
    )
    .map((record) => record.id);
  return candidatesFromIds(fromVisitId, toVisitIds, 'cross_replica_continuation', generatedAt);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const pairFromPayload = (
  payload: unknown,
): { readonly from: string; readonly to: string } | null => {
  if (!isRecord(payload)) return null;
  const from =
    typeof payload['fromVisitId'] === 'string'
      ? payload['fromVisitId']
      : typeof payload['fromId'] === 'string'
        ? payload['fromId']
        : undefined;
  const to =
    typeof payload['toVisitId'] === 'string'
      ? payload['toVisitId']
      : typeof payload['toId'] === 'string'
        ? payload['toId']
        : typeof payload['candidateVisitId'] === 'string'
          ? payload['candidateVisitId']
          : undefined;
  if (from === undefined || to === undefined || from.length === 0 || to.length === 0) return null;
  return { from, to };
};

const explicitPairGenerator = (eventType: string, source: CandidateSource): SourceGenerator =>
  pairSourceGenerator(source, (context) =>
    context.merged.flatMap((event): readonly { readonly from: string; readonly to: string }[] => {
      if (event.type !== eventType) return [];
      const pair = pairFromPayload(event.payload);
      return pair === null ? [] : [pair];
    }),
  );

const sameCanonicalUrlGenerator: SourceGenerator = (fromVisitId, context, generatedAt) =>
  groupedRecordCandidates(fromVisitId, context, 'same_canonical_url', generatedAt, (record) => [
    `canonical:${record.canonicalUrl}`,
  ]);

const sameRepoOrDomainGenerator: SourceGenerator = (fromVisitId, context, generatedAt) =>
  groupedRecordCandidates(
    fromVisitId,
    context,
    'same_repo_or_domain',
    generatedAt,
    repoOrDomainKeys,
  );

const sameSearchQueryGenerator: SourceGenerator = (fromVisitId, context, generatedAt) =>
  groupedRecordCandidates(fromVisitId, context, 'same_search_query', generatedAt, searchQueryKeys);

const sameTitlePathTokensGenerator: SourceGenerator = (fromVisitId, context, generatedAt) =>
  groupedRecordCandidates(
    fromVisitId,
    context,
    'same_title_path_tokens',
    generatedAt,
    titlePathTokenKeys,
  );

export const generateUserConfirmedCandidates: GenerateCandidates = sourceWrapper(
  'user_confirmed',
  explicitPairGenerator(USER_FLOW_CONFIRMED, 'user_confirmed'),
);

export const generateOpenerChainCandidates: GenerateCandidates = sourceWrapper(
  'opener_chain',
  chainGenerator('opener_chain', (record) => record.openerVisitId),
);

export const generateNavigationChainCandidates: GenerateCandidates = sourceWrapper(
  'navigation_chain',
  chainGenerator('navigation_chain', (record) => record.previousVisitId),
);

export const generateSameCanonicalUrlCandidates: GenerateCandidates = sourceWrapper(
  'same_canonical_url',
  sameCanonicalUrlGenerator,
);

export const generateSameRepoOrDomainCandidates: GenerateCandidates = sourceWrapper(
  'same_repo_or_domain',
  sameRepoOrDomainGenerator,
);

export const generateSameSearchQueryCandidates: GenerateCandidates = sourceWrapper(
  'same_search_query',
  sameSearchQueryGenerator,
);

export const generateSameCopiedSnippetCandidates: GenerateCandidates = sourceWrapper(
  'same_copied_snippet',
  sameCopiedSnippetGenerator,
);

export const generateSameTitlePathTokensCandidates: GenerateCandidates = sourceWrapper(
  'same_title_path_tokens',
  sameTitlePathTokensGenerator,
);

export const generateEmbeddingNeighborhoodCandidates: GenerateCandidates = sourceWrapper(
  'embedding_neighborhood',
  embeddingNeighborhoodGenerator,
);

export const generateContentTermOverlapCandidates: GenerateCandidates = sourceWrapper(
  'content_term_overlap',
  contentTermOverlapGenerator,
);

export const generateContentEmbeddingNeighborhoodCandidates: GenerateCandidates = sourceWrapper(
  'content_embedding_neighborhood',
  contentEmbeddingNeighborhoodGenerator,
);

export const generateCrossReplicaContinuationCandidates: GenerateCandidates = sourceWrapper(
  'cross_replica_continuation',
  crossReplicaContinuationGenerator,
);

export const generateRandomUnrelatedCandidates: GenerateCandidates = sourceWrapper(
  'random_unrelated',
  explicitPairGenerator(EXPLICIT_RANDOM_UNRELATED, 'random_unrelated'),
);

export const generateRecentlySkippedCandidates: GenerateCandidates = sourceWrapper(
  'recently_skipped',
  explicitPairGenerator(USER_FLOW_REJECTED, 'recently_skipped'),
);

export const CANDIDATE_GENERATORS: Readonly<Record<CandidateSource, GenerateCandidates>> = {
  user_confirmed: generateUserConfirmedCandidates,
  opener_chain: generateOpenerChainCandidates,
  navigation_chain: generateNavigationChainCandidates,
  same_canonical_url: generateSameCanonicalUrlCandidates,
  same_repo_or_domain: generateSameRepoOrDomainCandidates,
  same_search_query: generateSameSearchQueryCandidates,
  same_copied_snippet: generateSameCopiedSnippetCandidates,
  same_title_path_tokens: generateSameTitlePathTokensCandidates,
  embedding_neighborhood: generateEmbeddingNeighborhoodCandidates,
  content_term_overlap: generateContentTermOverlapCandidates,
  content_embedding_neighborhood: generateContentEmbeddingNeighborhoodCandidates,
  cross_replica_continuation: generateCrossReplicaContinuationCandidates,
  random_unrelated: generateRandomUnrelatedCandidates,
  recently_skipped: generateRecentlySkippedCandidates,
};

const mergeSources = (
  left: readonly CandidateSource[],
  right: readonly CandidateSource[],
): readonly CandidateSource[] =>
  [...new Set<CandidateSource>([...left, ...right])].sort(
    (a, b) => (SOURCE_ORDER.get(a) ?? 0) - (SOURCE_ORDER.get(b) ?? 0),
  );

const dedupeCandidates = (candidates: readonly Candidate[]): readonly Candidate[] => {
  const byPair = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const key = `${candidate.fromVisitId}\u0000${candidate.toVisitId}`;
    const existing = byPair.get(key);
    if (existing === undefined) {
      byPair.set(key, {
        ...candidate,
        sources: mergeSources([], candidate.sources),
      });
      continue;
    }
    byPair.set(key, {
      ...existing,
      sources: mergeSources(existing.sources, candidate.sources),
      generatedAt: Math.max(existing.generatedAt, candidate.generatedAt),
    });
  }

  return [...byPair.values()].sort(
    (left, right) =>
      compareText(left.fromVisitId, right.fromVisitId) ||
      compareText(left.toVisitId, right.toVisitId),
  );
};

export const generateCandidates: GenerateCandidates = (fromVisitId, context) => {
  if (fromVisitId.length === 0) return [];
  const candidates = CANDIDATE_SOURCES.flatMap((source) =>
    CANDIDATE_GENERATORS[source](fromVisitId, context),
  );
  return dedupeCandidates(candidates);
};
