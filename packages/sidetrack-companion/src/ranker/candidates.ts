import { type ConnectionEdge } from '../connections/types.js';
import { NAVIGATION_COMMITTED, isNavigationCommittedPayload } from '../navigation/events.js';
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
  'same_workstream',
  'opener_chain',
  'navigation_chain',
  'same_canonical_url',
  'same_repo_or_domain',
  'same_search_query',
  'same_copied_snippet',
  'same_title_path_tokens',
  'embedding_neighborhood',
  'cross_replica_continuation',
  'random_unrelated',
  'recently_skipped',
] as const satisfies readonly CandidateSource[];

const SOURCE_ORDER = new Map<CandidateSource, number>(
  CANDIDATE_SOURCES.map((source, index) => [source, index]),
);

const TIMELINE_VISIT_PREFIX = 'timeline-visit:';
const WORKSTREAM_PREFIX = 'workstream:';
const SNIPPET_PREFIX = 'snippet:';
const EXPLICIT_RANDOM_UNRELATED = 'ranker.random_unrelated';
const USER_FLOW_REJECTED = 'user.flow.rejected';

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const visitKeyForUrl = (url: string): string =>
  url.trim().replace(/#.*$/u, '').replace(/\/+$/u, '');

const maybeTimestamp = (value: number): number | null =>
  Number.isFinite(value) ? value : null;

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

const pickRicherTitle = (left: string | undefined, right: string | undefined): string | undefined => {
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
        ...(event.payload.openerVisitId === null ? {} : { openerVisitId: event.payload.openerVisitId }),
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

const walkGraph = (graph: ReadonlyMap<string, ReadonlySet<string>>, start: string): readonly string[] => {
  const seen = new Set<string>([start]);
  const queue: string[] = [...toSortedIds(graph.get(start))];

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    for (const next of toSortedIds(graph.get(current))) {
      if (!seen.has(next)) queue.push(next);
    }
  }

  seen.delete(start);
  return [...seen].sort(compareText);
};

const pairSourceGenerator = (
  source: CandidateSource,
  readPairs: (context: CandidateContext) => readonly { readonly from: string; readonly to: string }[],
): SourceGenerator => (fromVisitId, context, generatedAt) => {
  const fromKey = fromKeyFor(fromVisitId);
  return candidatesFromIds(
    fromVisitId,
    readPairs(context)
      .filter((pair) => pair.from === fromKey)
      .map((pair) => pair.to),
    source,
    generatedAt,
  );
};

const sourceWrapper = (source: CandidateSource, generator: SourceGenerator): GenerateCandidates => (
  fromVisitId,
  context,
) => generator(fromVisitId, context, stableGeneratedAt(context));

const groupedRecordCandidates = (
  fromVisitId: string,
  context: CandidateContext,
  source: CandidateSource,
  generatedAt: number,
  keyForRecord: (record: VisitRecord) => readonly string[],
): readonly Candidate[] => {
  const records = collectVisitRecords(context.merged);
  const byId = recordsById(records);
  const fromRecord = byId.get(fromKeyFor(fromVisitId));
  if (fromRecord === undefined) return [];

  const byKey = new Map<string, Set<string>>();
  for (const record of records) {
    for (const key of keyForRecord(record)) {
      addToSetMap(byKey, key, record.id);
    }
  }

  const toVisitIds = new Set<string>();
  for (const key of keyForRecord(fromRecord)) {
    for (const toVisitId of toSortedIds(byKey.get(key))) {
      toVisitIds.add(toVisitId);
    }
  }

  return candidatesFromIds(fromVisitId, toVisitIds, source, generatedAt);
};

const workstreamGroupsFromEdges = (edges: readonly ConnectionEdge[]): ReadonlyMap<string, Set<string>> => {
  const groups = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.kind !== 'visit_in_workstream') continue;
    const fromVisit = parsePrefixedId(edge.fromNodeId, TIMELINE_VISIT_PREFIX);
    const toWorkstream = parsePrefixedId(edge.toNodeId, WORKSTREAM_PREFIX);
    if (fromVisit !== null && toWorkstream !== null) {
      addToSetMap(groups, toWorkstream, fromVisit);
      continue;
    }
    const toVisit = parsePrefixedId(edge.toNodeId, TIMELINE_VISIT_PREFIX);
    const fromWorkstream = parsePrefixedId(edge.fromNodeId, WORKSTREAM_PREFIX);
    if (toVisit !== null && fromWorkstream !== null) {
      addToSetMap(groups, fromWorkstream, toVisit);
    }
  }
  return groups;
};

const sameWorkstreamGenerator: SourceGenerator = (fromVisitId, context, generatedAt) => {
  const groups = new Map<string, Set<string>>();
  for (const record of collectVisitRecords(context.merged)) {
    if (record.workstreamId !== undefined) addToSetMap(groups, record.workstreamId, record.id);
  }
  for (const [workstreamId, visitIds] of workstreamGroupsFromEdges(context.existingEdges)) {
    for (const visitId of visitIds) addToSetMap(groups, workstreamId, visitId);
  }

  const fromKey = fromKeyFor(fromVisitId);
  const toVisitIds = new Set<string>();
  for (const visitIds of groups.values()) {
    if (!visitIds.has(fromKey)) continue;
    for (const visitId of visitIds) toVisitIds.add(visitId);
  }

  return candidatesFromIds(fromVisitId, toVisitIds, 'same_workstream', generatedAt);
};

const chainGenerator = (
  source: CandidateSource,
  linkForRecord: (record: VisitRecord) => string | undefined,
): SourceGenerator => (fromVisitId, context, generatedAt) => {
  const graph = new Map<string, Set<string>>();
  for (const record of collectVisitRecords(context.merged)) {
    const linked = linkForRecord(record);
    if (linked !== undefined) addUndirected(graph, record.id, linked);
  }
  return candidatesFromIds(fromVisitId, walkGraph(graph, fromKeyFor(fromVisitId)), source, generatedAt);
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
    return hostname.length === 0 ? [] : [`domain:${hostname}`];
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
      (token) =>
        token.length >= 3 &&
        !/^\d+$/u.test(token) &&
        !TITLE_PATH_STOP_TOKENS.has(token),
    );

const titlePathTokenKeys = (record: VisitRecord): readonly string[] => {
  const pieces: string[] = [];
  if (record.title !== undefined) pieces.push(record.title);
  try {
    const parsed = new URL(record.canonicalUrl);
    for (const part of parsed.pathname.split('/')) {
      pieces.push(safeDecode(part));
    }
  } catch {
    pieces.push(record.canonicalUrl);
  }
  return [...new Set(tokenizeTitlePathText(pieces.join(' ')))].map((token) => `token:${token}`);
};

const snippetGroupsFromEvents = (events: readonly AcceptedEvent[]): ReadonlyMap<string, Set<string>> => {
  const groups = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.type !== SELECTION_COPIED || !isSelectionCopiedPayload(event.payload)) continue;
    addToSetMap(groups, event.payload.selectionHash, event.payload.visitId);
  }
  return groups;
};

const snippetGroupsFromEdges = (edges: readonly ConnectionEdge[]): ReadonlyMap<string, Set<string>> => {
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
  const groups = new Map<string, Set<string>>();
  for (const [snippetId, visitIds] of snippetGroupsFromEvents(context.merged)) {
    for (const visitId of visitIds) addToSetMap(groups, snippetId, visitId);
  }
  for (const [snippetId, visitIds] of snippetGroupsFromEdges(context.existingEdges)) {
    for (const visitId of visitIds) addToSetMap(groups, snippetId, visitId);
  }

  const fromKey = fromKeyFor(fromVisitId);
  const toVisitIds = new Set<string>();
  for (const visitIds of groups.values()) {
    if (!visitIds.has(fromKey)) continue;
    for (const visitId of visitIds) toVisitIds.add(visitId);
  }
  return candidatesFromIds(fromVisitId, toVisitIds, 'same_copied_snippet', generatedAt);
};

const embeddingNeighborhoodGenerator: SourceGenerator = (fromVisitId, context, generatedAt) => {
  const fromKey = fromKeyFor(fromVisitId);
  const toVisitIds = new Set<string>();
  for (const edge of context.existingEdges) {
    if (edge.kind !== 'visit_resembles_visit') continue;
    const fromEdgeVisit = visitIdFromNodeOrRaw(edge.fromNodeId);
    const toEdgeVisit = visitIdFromNodeOrRaw(edge.toNodeId);
    if (fromEdgeVisit === fromKey) toVisitIds.add(toEdgeVisit);
    if (toEdgeVisit === fromKey) toVisitIds.add(fromEdgeVisit);
  }
  return candidatesFromIds(fromVisitId, toVisitIds, 'embedding_neighborhood', generatedAt);
};

const crossReplicaContinuationGenerator: SourceGenerator = (fromVisitId, context, generatedAt) => {
  const records = collectVisitRecords(context.merged);
  const byId = recordsById(records);
  const fromRecord = byId.get(fromKeyFor(fromVisitId));
  if (fromRecord === undefined || fromRecord.replicaId === undefined) return [];

  const toVisitIds = records
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

const pairFromPayload = (payload: unknown): { readonly from: string; readonly to: string } | null => {
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
  groupedRecordCandidates(
    fromVisitId,
    context,
    'same_canonical_url',
    generatedAt,
    (record) => [`canonical:${record.canonicalUrl}`],
  );

const sameRepoOrDomainGenerator: SourceGenerator = (fromVisitId, context, generatedAt) =>
  groupedRecordCandidates(
    fromVisitId,
    context,
    'same_repo_or_domain',
    generatedAt,
    repoOrDomainKeys,
  );

const sameSearchQueryGenerator: SourceGenerator = (fromVisitId, context, generatedAt) =>
  groupedRecordCandidates(
    fromVisitId,
    context,
    'same_search_query',
    generatedAt,
    searchQueryKeys,
  );

const sameTitlePathTokensGenerator: SourceGenerator = (fromVisitId, context, generatedAt) =>
  groupedRecordCandidates(
    fromVisitId,
    context,
    'same_title_path_tokens',
    generatedAt,
    titlePathTokenKeys,
  );

export const generateSameWorkstreamCandidates: GenerateCandidates = sourceWrapper(
  'same_workstream',
  sameWorkstreamGenerator,
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
  same_workstream: generateSameWorkstreamCandidates,
  opener_chain: generateOpenerChainCandidates,
  navigation_chain: generateNavigationChainCandidates,
  same_canonical_url: generateSameCanonicalUrlCandidates,
  same_repo_or_domain: generateSameRepoOrDomainCandidates,
  same_search_query: generateSameSearchQueryCandidates,
  same_copied_snippet: generateSameCopiedSnippetCandidates,
  same_title_path_tokens: generateSameTitlePathTokensCandidates,
  embedding_neighborhood: generateEmbeddingNeighborhoodCandidates,
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
