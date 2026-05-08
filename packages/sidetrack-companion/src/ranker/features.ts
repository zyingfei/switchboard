import {
  type ConnectionEdge,
  type ConnectionNode,
  type ConnectionsSnapshot,
} from '../connections/types.js';
import {
  ENGAGEMENT_SESSION_AGGREGATED,
  isEngagementSessionAggregatedPayload,
} from '../engagement/events.js';
import {
  USER_ENGAGEMENT_RELABELED,
  USER_ORGANIZED_ITEM,
  isUserEngagementRelabeledPayload,
  isUserOrganizedItemPayload,
} from '../feedback/events.js';
import {
  NAVIGATION_COMMITTED,
  isNavigationCommittedPayload,
} from '../navigation/events.js';
import { SELECTION_COPIED, isSelectionCopiedPayload } from '../snippets/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import {
  BROWSER_TIMELINE_OBSERVED,
  isBrowserTimelineObservedPayload,
} from '../timeline/events.js';
import { detectSearchUrl } from '../timeline/sanitize.js';
import {
  FEATURE_SCHEMA_VERSION,
  type CandidatePairFeatures,
  type ExtractFeatures,
} from './feature-schema.js';
import type { Candidate } from './types.js';

type BinaryFeature = 0 | 1;

interface VisitRecord {
  readonly id: string;
  readonly url: string;
  readonly canonicalUrl: string;
  readonly observedAtMs: number;
  readonly title?: string;
  readonly openerVisitId?: string;
  readonly previousVisitId?: string;
}

interface OrderedValue<T> {
  readonly value: T;
  readonly acceptedAtMs: number;
  readonly replicaId: string;
  readonly seq: number;
}

interface ReturnSession {
  readonly visitId: string;
  readonly sessionId: string;
  readonly returnCount: number;
  readonly acceptedAtMs: number;
  readonly replicaId: string;
  readonly seq: number;
}

interface FeatureModel {
  readonly recordsById: ReadonlyMap<string, VisitRecord>;
  readonly idsByCanonical: ReadonlyMap<string, ReadonlySet<string>>;
  readonly timelineNodesByVisitKey: ReadonlyMap<string, ConnectionNode>;
  readonly workstreamsByVisit: ReadonlyMap<string, ReadonlySet<string>>;
  readonly snippetsByVisit: ReadonlyMap<string, ReadonlySet<string>>;
  readonly userThreadsByVisit: ReadonlyMap<string, ReadonlySet<string>>;
  readonly userWorkstreamsByVisit: ReadonlyMap<string, ReadonlySet<string>>;
  readonly engagementClassByVisit: ReadonlyMap<string, OrderedValue<string>>;
  readonly returnCountByVisit: ReadonlyMap<string, number>;
  readonly openerGraph: ReadonlyMap<string, ReadonlySet<string>>;
  readonly navigationGraph: ReadonlyMap<string, ReadonlySet<string>>;
  readonly snapshot: ConnectionsSnapshot;
  readonly referenceMs: number | null;
}

const TIMELINE_VISIT_PREFIX = 'timeline-visit:';
const THREAD_PREFIX = 'thread:';
const WORKSTREAM_PREFIX = 'workstream:';
const SNIPPET_PREFIX = 'snippet:';
const DAY_MS = 24 * 60 * 60 * 1_000;

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const parseTimestamp = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const visitKeyForUrl = (url: string): string =>
  url.trim().replace(/#.*$/u, '').replace(/\/+$/u, '');

const parsePrefixedId = (value: string, prefix: string): string | null => {
  if (!value.startsWith(prefix)) return null;
  const id = value.slice(prefix.length);
  return id.length > 0 ? id : null;
};

const visitKeyFromNodeOrRaw = (value: string): string =>
  parsePrefixedId(value, TIMELINE_VISIT_PREFIX) ?? value;

const isUrlLike = (value: string): boolean => {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
};

const normalizedUrlCandidate = (value: string): string | null =>
  isUrlLike(value) ? visitKeyForUrl(value) : null;

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
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

const unionSetsForAliases = (
  map: ReadonlyMap<string, ReadonlySet<string>>,
  aliases: ReadonlySet<string>,
): ReadonlySet<string> => {
  const out = new Set<string>();
  for (const alias of aliases) {
    const values = map.get(alias);
    if (values === undefined) continue;
    for (const value of values) out.add(value);
  }
  return out;
};

const countIntersection = (
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): number => {
  let count = 0;
  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];
  for (const value of smaller) {
    if (larger.has(value)) count += 1;
  }
  return count;
};

const hasIntersection = (
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean => countIntersection(left, right) > 0;

const toBinary = (value: boolean): BinaryFeature => (value ? 1 : 0);

const compareOrdered = <T>(
  left: OrderedValue<T> | ReturnSession,
  right: OrderedValue<T> | ReturnSession,
): number => {
  if (left.acceptedAtMs !== right.acceptedAtMs) return left.acceptedAtMs - right.acceptedAtMs;
  if (left.replicaId !== right.replicaId) return compareText(left.replicaId, right.replicaId);
  return left.seq - right.seq;
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

const mergeVisitRecord = (left: VisitRecord, right: VisitRecord): VisitRecord => {
  const observedAtMs = Math.max(left.observedAtMs, right.observedAtMs);
  const title = pickRicherTitle(left.title, right.title);
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
    ...(openerVisitId === undefined ? {} : { openerVisitId }),
    ...(previousVisitId === undefined ? {} : { previousVisitId }),
  };
};

const collectVisitRecords = (
  events: readonly AcceptedEvent[],
  snapshot: ConnectionsSnapshot,
): ReadonlyMap<string, VisitRecord> => {
  const byId = new Map<string, VisitRecord>();
  const put = (record: VisitRecord): void => {
    const existing = byId.get(record.id);
    byId.set(record.id, existing === undefined ? record : mergeVisitRecord(existing, record));
  };

  for (const event of events) {
    if (event.type === NAVIGATION_COMMITTED && isNavigationCommittedPayload(event.payload)) {
      const canonicalUrl = visitKeyForUrl(event.payload.canonicalUrl);
      if (event.payload.visitId.length === 0 || canonicalUrl.length === 0) continue;
      put({
        id: event.payload.visitId,
        url: event.payload.url,
        canonicalUrl,
        observedAtMs: event.payload.commitTimestamp,
        ...(event.payload.openerVisitId === null ? {} : { openerVisitId: event.payload.openerVisitId }),
        ...(event.payload.previousVisitId === null
          ? {}
          : { previousVisitId: event.payload.previousVisitId }),
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
      });
    }
  }

  for (const node of snapshot.nodes) {
    if (node.kind !== 'timeline-visit') continue;
    const id = parsePrefixedId(node.id, TIMELINE_VISIT_PREFIX);
    if (id === null) continue;
    const metadataUrl = typeof node.metadata.url === 'string' ? node.metadata.url : undefined;
    const metadataCanonical =
      typeof node.metadata.canonicalUrl === 'string' && node.metadata.canonicalUrl.length > 0
        ? visitKeyForUrl(node.metadata.canonicalUrl)
        : id;
    const title = typeof node.metadata.title === 'string' ? node.metadata.title : undefined;
    put({
      id,
      url: metadataUrl ?? metadataCanonical,
      canonicalUrl: metadataCanonical,
      observedAtMs: parseTimestamp(node.lastSeenAt) ?? parseTimestamp(node.firstSeenAt) ?? 0,
      ...(title === undefined || title.length === 0 ? {} : { title }),
    });
  }

  return byId;
};

const idsByCanonical = (
  recordsById: ReadonlyMap<string, VisitRecord>,
): ReadonlyMap<string, ReadonlySet<string>> => {
  const byCanonical = new Map<string, Set<string>>();
  for (const record of recordsById.values()) {
    addToSetMap(byCanonical, record.canonicalUrl, record.id);
  }
  return byCanonical;
};

const timelineNodesByVisitKey = (
  snapshot: ConnectionsSnapshot,
): ReadonlyMap<string, ConnectionNode> => {
  const byVisit = new Map<string, ConnectionNode>();
  for (const node of snapshot.nodes) {
    if (node.kind !== 'timeline-visit') continue;
    const visitKey = parsePrefixedId(node.id, TIMELINE_VISIT_PREFIX);
    if (visitKey !== null) byVisit.set(visitKey, node);
  }
  return byVisit;
};

const aliasesForVisit = (model: FeatureModel, visitId: string): ReadonlySet<string> => {
  const aliases = new Set<string>();
  const rawKey = visitKeyFromNodeOrRaw(visitId);
  const urlKey = normalizedUrlCandidate(rawKey);
  const key = urlKey ?? rawKey;
  aliases.add(key);
  if (rawKey !== key) aliases.add(rawKey);

  const directRecord = model.recordsById.get(key) ?? model.recordsById.get(rawKey);
  if (directRecord !== undefined) aliases.add(directRecord.canonicalUrl);

  const node = model.timelineNodesByVisitKey.get(key);
  if (node !== undefined && typeof node.metadata.canonicalUrl === 'string') {
    aliases.add(visitKeyForUrl(node.metadata.canonicalUrl));
  }

  const idsForCanonical = isUrlLike(key) ? model.idsByCanonical.get(key) : undefined;
  if (idsForCanonical !== undefined) {
    for (const id of idsForCanonical) aliases.add(id);
  }

  return aliases;
};

const recordForVisit = (model: FeatureModel, visitId: string): VisitRecord | undefined => {
  const aliases = [...aliasesForVisit(model, visitId)].sort(compareText);
  const directKey = visitKeyFromNodeOrRaw(visitId);
  const directRecord = model.recordsById.get(directKey);
  if (directRecord !== undefined) return directRecord;
  for (const alias of aliases) {
    const record = model.recordsById.get(alias);
    if (record !== undefined) return record;
  }
  return undefined;
};

const canonicalUrlForVisit = (model: FeatureModel, visitId: string): string | null => {
  const record = recordForVisit(model, visitId);
  if (record !== undefined) return record.canonicalUrl;
  const key = visitKeyFromNodeOrRaw(visitId);
  const normalized = normalizedUrlCandidate(key);
  return normalized ?? null;
};

const hostForUrl = (value: string): string | null => {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./u, '');
  } catch {
    return null;
  }
};

const repoKeyForUrl = (value: string): string | null => {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./u, '');
    if (hostname !== 'github.com' && hostname !== 'gitlab.com') return null;
    const [owner, repo] = parsed.pathname
      .split('/')
      .filter((part) => part.length > 0)
      .map((part) => part.replace(/\.git$/iu, '').toLowerCase());
    if (owner === undefined || repo === undefined) return null;
    return `${hostname}/${owner}/${repo}`;
  } catch {
    return null;
  }
};

const normalizeSearchQuery = (value: string): string =>
  value.replace(/\s+/gu, ' ').trim().toLowerCase();

const searchQueriesForVisit = (model: FeatureModel, visitId: string): ReadonlySet<string> => {
  const queries = new Set<string>();
  const aliases = aliasesForVisit(model, visitId);
  for (const alias of aliases) {
    const node = model.timelineNodesByVisitKey.get(alias);
    if (node !== undefined && typeof node.metadata['searchQuery'] === 'string') {
      const query = normalizeSearchQuery(node.metadata['searchQuery']);
      if (query.length > 0) queries.add(query);
    }
    const record = model.recordsById.get(alias);
    const search =
      record === undefined
        ? detectSearchUrl(alias)
        : detectSearchUrl(record.canonicalUrl) ?? detectSearchUrl(record.url);
    if (search !== null) {
      const query = normalizeSearchQuery(search.query);
      if (query.length > 0) queries.add(query);
    }
  }
  return queries;
};

const tokenize = (value: string): readonly string[] =>
  value
    .split(/[^A-Za-z0-9]+/u)
    .map((token) => token.trim().toLowerCase())
    .filter(
      (token) =>
        token.length >= 3 &&
        !/^\d+$/u.test(token) &&
        !TITLE_PATH_STOP_TOKENS.has(token),
    );

const titleTokensForVisit = (model: FeatureModel, visitId: string): ReadonlySet<string> => {
  const tokens = new Set<string>();
  for (const alias of aliasesForVisit(model, visitId)) {
    const record = model.recordsById.get(alias);
    if (record?.title !== undefined) {
      for (const token of tokenize(record.title)) tokens.add(token);
    }
    const node = model.timelineNodesByVisitKey.get(alias);
    if (node !== undefined && typeof node.metadata.title === 'string') {
      for (const token of tokenize(node.metadata.title)) tokens.add(token);
    }
  }
  return tokens;
};

const pathTokensForUrl = (url: string): readonly string[] => {
  try {
    const parsed = new URL(url);
    return tokenize(parsed.pathname.split('/').map(safeDecode).join(' '));
  } catch {
    return tokenize(url);
  }
};

const pathTokensForVisit = (model: FeatureModel, visitId: string): ReadonlySet<string> => {
  const tokens = new Set<string>();
  const canonicalUrl = canonicalUrlForVisit(model, visitId);
  if (canonicalUrl === null) return tokens;
  for (const token of pathTokensForUrl(canonicalUrl)) tokens.add(token);
  return tokens;
};

const visitAndContainerFromEdge = (
  edge: ConnectionEdge,
  containerPrefix: string,
): { readonly visitKey: string; readonly containerId: string } | null => {
  const fromVisit = parsePrefixedId(edge.fromNodeId, TIMELINE_VISIT_PREFIX);
  const toContainer = parsePrefixedId(edge.toNodeId, containerPrefix);
  if (fromVisit !== null && toContainer !== null) {
    return { visitKey: fromVisit, containerId: toContainer };
  }

  const toVisit = parsePrefixedId(edge.toNodeId, TIMELINE_VISIT_PREFIX);
  const fromContainer = parsePrefixedId(edge.fromNodeId, containerPrefix);
  if (toVisit !== null && fromContainer !== null) {
    return { visitKey: toVisit, containerId: fromContainer };
  }

  return null;
};

const buildWorkstreamMap = (
  snapshot: ConnectionsSnapshot,
): ReadonlyMap<string, ReadonlySet<string>> => {
  const workstreams = new Map<string, Set<string>>();
  for (const node of snapshot.nodes) {
    if (node.kind !== 'timeline-visit') continue;
    const visitKey = parsePrefixedId(node.id, TIMELINE_VISIT_PREFIX);
    const workstreamId =
      typeof node.metadata.workstreamId === 'string' ? node.metadata.workstreamId : undefined;
    if (visitKey !== null && workstreamId !== undefined) {
      addToSetMap(workstreams, visitKey, workstreamId);
    }
  }

  for (const edge of snapshot.edges) {
    if (edge.kind !== 'visit_in_workstream') continue;
    const pair = visitAndContainerFromEdge(edge, WORKSTREAM_PREFIX);
    if (pair !== null) addToSetMap(workstreams, pair.visitKey, pair.containerId);
  }

  return workstreams;
};

const snippetEdgePair = (
  edge: ConnectionEdge,
): { readonly snippetId: string; readonly visitKey: string } | null => {
  const fromSnippet = parsePrefixedId(edge.fromNodeId, SNIPPET_PREFIX);
  const toVisit = parsePrefixedId(edge.toNodeId, TIMELINE_VISIT_PREFIX);
  if (fromSnippet !== null && toVisit !== null) return { snippetId: fromSnippet, visitKey: toVisit };

  const toSnippet = parsePrefixedId(edge.toNodeId, SNIPPET_PREFIX);
  const fromVisit = parsePrefixedId(edge.fromNodeId, TIMELINE_VISIT_PREFIX);
  if (toSnippet !== null && fromVisit !== null) return { snippetId: toSnippet, visitKey: fromVisit };

  return null;
};

const buildSnippetMap = (
  events: readonly AcceptedEvent[],
  snapshot: ConnectionsSnapshot,
): ReadonlyMap<string, ReadonlySet<string>> => {
  const snippets = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.type !== SELECTION_COPIED || !isSelectionCopiedPayload(event.payload)) continue;
    addToSetMap(snippets, event.payload.visitId, event.payload.selectionHash);
  }
  for (const edge of snapshot.edges) {
    if (edge.kind !== 'snippet_copied_from_visit') continue;
    const pair = snippetEdgePair(edge);
    if (pair !== null) addToSetMap(snippets, pair.visitKey, pair.snippetId);
  }
  return snippets;
};

const containerKindForOrganizedTarget = (
  rawTarget: string,
  snapshot: ConnectionsSnapshot,
): { readonly kind: 'thread' | 'workstream'; readonly id: string } | null => {
  const thread = parsePrefixedId(rawTarget, THREAD_PREFIX);
  if (thread !== null) return { kind: 'thread', id: thread };
  const workstream = parsePrefixedId(rawTarget, WORKSTREAM_PREFIX);
  if (workstream !== null) return { kind: 'workstream', id: workstream };

  const nodeIds = new Set(snapshot.nodes.map((node) => node.id));
  if (nodeIds.has(`${THREAD_PREFIX}${rawTarget}`)) return { kind: 'thread', id: rawTarget };
  if (nodeIds.has(`${WORKSTREAM_PREFIX}${rawTarget}`)) return { kind: 'workstream', id: rawTarget };
  return null;
};

const organizedVisitIds = (payload: {
  readonly itemId: string;
  readonly details?: { readonly mergeMembers?: readonly string[] };
}): readonly string[] => [
  payload.itemId,
  ...(payload.details?.mergeMembers ?? []),
];

const buildUserAssertedMaps = (
  events: readonly AcceptedEvent[],
  snapshot: ConnectionsSnapshot,
): {
  readonly threadsByVisit: ReadonlyMap<string, ReadonlySet<string>>;
  readonly workstreamsByVisit: ReadonlyMap<string, ReadonlySet<string>>;
} => {
  const threadsByVisit = new Map<string, Set<string>>();
  const workstreamsByVisit = new Map<string, Set<string>>();

  for (const edge of snapshot.edges) {
    if (edge.confidence !== 'asserted') continue;
    const threadPair = visitAndContainerFromEdge(edge, THREAD_PREFIX);
    if (threadPair !== null) addToSetMap(threadsByVisit, threadPair.visitKey, threadPair.containerId);
    const workstreamPair = visitAndContainerFromEdge(edge, WORKSTREAM_PREFIX);
    if (workstreamPair !== null) {
      addToSetMap(workstreamsByVisit, workstreamPair.visitKey, workstreamPair.containerId);
    }
  }

  for (const event of events) {
    if (event.type !== USER_ORGANIZED_ITEM || !isUserOrganizedItemPayload(event.payload)) continue;
    if (event.payload.itemKind !== 'visit' || event.payload.toContainer === undefined) continue;
    const container = containerKindForOrganizedTarget(event.payload.toContainer, snapshot);
    if (container === null) continue;
    for (const visitId of organizedVisitIds(event.payload)) {
      if (container.kind === 'thread') addToSetMap(threadsByVisit, visitId, container.id);
      if (container.kind === 'workstream') addToSetMap(workstreamsByVisit, visitId, container.id);
    }
  }

  return { threadsByVisit, workstreamsByVisit };
};

const readEngagementClass = (node: ConnectionNode): string | null => {
  const engagement = node.metadata['engagement'];
  if (!isRecord(engagement)) return null;
  const classValue = engagement['class'];
  return typeof classValue === 'string' && classValue.length > 0 ? classValue : null;
};

const buildEngagementClassMap = (
  events: readonly AcceptedEvent[],
  snapshot: ConnectionsSnapshot,
): ReadonlyMap<string, OrderedValue<string>> => {
  const classes = new Map<string, OrderedValue<string>>();
  const put = (visitId: string, value: OrderedValue<string>): void => {
    const existing = classes.get(visitId);
    if (existing === undefined || compareOrdered(existing, value) <= 0) {
      classes.set(visitId, value);
    }
  };

  for (const node of snapshot.nodes) {
    if (node.kind !== 'timeline-visit') continue;
    const visitKey = parsePrefixedId(node.id, TIMELINE_VISIT_PREFIX);
    const classValue = readEngagementClass(node);
    if (visitKey === null || classValue === null) continue;
    put(visitKey, {
      value: classValue,
      acceptedAtMs: -1,
      replicaId: '',
      seq: 0,
    });
  }

  for (const event of events) {
    if (
      event.type !== USER_ENGAGEMENT_RELABELED ||
      !isUserEngagementRelabeledPayload(event.payload)
    ) {
      continue;
    }
    put(event.payload.visitId, {
      value: event.payload.toClass,
      acceptedAtMs: event.acceptedAtMs,
      replicaId: event.dot.replicaId,
      seq: event.dot.seq,
    });
  }

  return classes;
};

const buildReturnCountMap = (
  events: readonly AcceptedEvent[],
): ReadonlyMap<string, number> => {
  const latestByVisitSession = new Map<string, ReturnSession>();
  for (const event of events) {
    if (
      event.type !== ENGAGEMENT_SESSION_AGGREGATED ||
      !isEngagementSessionAggregatedPayload(event.payload)
    ) {
      continue;
    }
    const next: ReturnSession = {
      visitId: event.payload.visitId,
      sessionId: event.payload.sessionId,
      returnCount: event.payload.dimensions.engagement.returnCount,
      acceptedAtMs: event.acceptedAtMs,
      replicaId: event.dot.replicaId,
      seq: event.dot.seq,
    };
    const key = `${next.visitId}\u0000${next.sessionId}`;
    const existing = latestByVisitSession.get(key);
    if (existing === undefined || compareOrdered(existing, next) < 0) {
      latestByVisitSession.set(key, next);
    }
  }

  const byVisit = new Map<string, number>();
  for (const session of latestByVisitSession.values()) {
    byVisit.set(session.visitId, (byVisit.get(session.visitId) ?? 0) + session.returnCount);
  }
  return byVisit;
};

const buildChainGraph = (
  recordsById: ReadonlyMap<string, VisitRecord>,
  linkForRecord: (record: VisitRecord) => string | undefined,
): ReadonlyMap<string, ReadonlySet<string>> => {
  const graph = new Map<string, Set<string>>();
  for (const record of recordsById.values()) {
    const linked = linkForRecord(record);
    if (linked === undefined || linked.length === 0 || linked === record.id) continue;
    addToSetMap(graph, record.id, linked);
    addToSetMap(graph, linked, record.id);
  }
  return graph;
};

const referenceMsFor = (
  events: readonly AcceptedEvent[],
  snapshot: ConnectionsSnapshot,
): number | null => {
  let maxMs = parseTimestamp(snapshot.updatedAt);
  for (const event of events) {
    if (Number.isFinite(event.acceptedAtMs)) {
      maxMs = maxMs === null ? event.acceptedAtMs : Math.max(maxMs, event.acceptedAtMs);
    }
  }
  for (const edge of snapshot.edges) {
    const edgeMs = parseTimestamp(edge.observedAt);
    if (edgeMs !== null) maxMs = maxMs === null ? edgeMs : Math.max(maxMs, edgeMs);
  }
  return maxMs;
};

const buildFeatureModel = (
  events: readonly AcceptedEvent[],
  snapshot: ConnectionsSnapshot,
): FeatureModel => {
  const recordsById = collectVisitRecords(events, snapshot);
  const userAsserted = buildUserAssertedMaps(events, snapshot);
  const workstreams = new Map<string, Set<string>>();
  for (const [visitKey, values] of buildWorkstreamMap(snapshot)) {
    for (const value of values) addToSetMap(workstreams, visitKey, value);
  }
  for (const [visitKey, values] of userAsserted.workstreamsByVisit) {
    for (const value of values) addToSetMap(workstreams, visitKey, value);
  }

  return {
    recordsById,
    idsByCanonical: idsByCanonical(recordsById),
    timelineNodesByVisitKey: timelineNodesByVisitKey(snapshot),
    workstreamsByVisit: workstreams,
    snippetsByVisit: buildSnippetMap(events, snapshot),
    userThreadsByVisit: userAsserted.threadsByVisit,
    userWorkstreamsByVisit: userAsserted.workstreamsByVisit,
    engagementClassByVisit: buildEngagementClassMap(events, snapshot),
    returnCountByVisit: buildReturnCountMap(events),
    openerGraph: buildChainGraph(recordsById, (record) => record.openerVisitId),
    navigationGraph: buildChainGraph(recordsById, (record) => record.previousVisitId),
    snapshot,
    referenceMs: referenceMsFor(events, snapshot),
  };
};

const sameWorkstreamFeature = (
  candidate: Candidate,
  model: FeatureModel,
): BinaryFeature => {
  const left = unionSetsForAliases(model.workstreamsByVisit, aliasesForVisit(model, candidate.fromVisitId));
  const right = unionSetsForAliases(model.workstreamsByVisit, aliasesForVisit(model, candidate.toVisitId));
  return toBinary(hasIntersection(left, right));
};

const chainDepth = (
  graph: ReadonlyMap<string, ReadonlySet<string>>,
  starts: ReadonlySet<string>,
  targets: ReadonlySet<string>,
): number => {
  const seen = new Set<string>();
  const queue: { readonly key: string; readonly depth: number }[] = [];
  for (const start of [...starts].sort(compareText)) {
    seen.add(start);
    queue.push({ key: start, depth: 0 });
  }

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (current === undefined) continue;
    if (current.depth > 0 && targets.has(current.key)) return current.depth;
    const neighbors = graph.get(current.key);
    if (neighbors === undefined) continue;
    for (const next of [...neighbors].sort(compareText)) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push({ key: next, depth: current.depth + 1 });
    }
  }
  return 0;
};

const openerChainDepthFeature = (
  candidate: Candidate,
  model: FeatureModel,
): number =>
  chainDepth(
    model.openerGraph,
    aliasesForVisit(model, candidate.fromVisitId),
    aliasesForVisit(model, candidate.toVisitId),
  );

const inNavigationChainFeature = (
  candidate: Candidate,
  model: FeatureModel,
): BinaryFeature =>
  toBinary(
    chainDepth(
      model.navigationGraph,
      aliasesForVisit(model, candidate.fromVisitId),
      aliasesForVisit(model, candidate.toVisitId),
    ) > 0,
  );

const sameCanonicalUrlFeature = (
  candidate: Candidate,
  model: FeatureModel,
): BinaryFeature => {
  const fromCanonical = canonicalUrlForVisit(model, candidate.fromVisitId);
  const toCanonical = canonicalUrlForVisit(model, candidate.toVisitId);
  return toBinary(
    fromCanonical !== null && toCanonical !== null && fromCanonical === toCanonical,
  );
};

const sameHostFeature = (
  candidate: Candidate,
  model: FeatureModel,
): BinaryFeature => {
  const fromCanonical = canonicalUrlForVisit(model, candidate.fromVisitId);
  const toCanonical = canonicalUrlForVisit(model, candidate.toVisitId);
  if (fromCanonical === null || toCanonical === null) return 0;
  const fromHost = hostForUrl(fromCanonical);
  const toHost = hostForUrl(toCanonical);
  return toBinary(fromHost !== null && toHost !== null && fromHost === toHost);
};

const sameRepoFeature = (
  candidate: Candidate,
  model: FeatureModel,
): BinaryFeature => {
  const fromCanonical = canonicalUrlForVisit(model, candidate.fromVisitId);
  const toCanonical = canonicalUrlForVisit(model, candidate.toVisitId);
  if (fromCanonical === null || toCanonical === null) return 0;
  const fromRepo = repoKeyForUrl(fromCanonical);
  const toRepo = repoKeyForUrl(toCanonical);
  return toBinary(fromRepo !== null && toRepo !== null && fromRepo === toRepo);
};

const sameSearchQueryFeature = (
  candidate: Candidate,
  model: FeatureModel,
): BinaryFeature =>
  toBinary(
    hasIntersection(
      searchQueriesForVisit(model, candidate.fromVisitId),
      searchQueriesForVisit(model, candidate.toVisitId),
    ),
  );

const sameCopiedSnippetCountFeature = (
  candidate: Candidate,
  model: FeatureModel,
): number =>
  countIntersection(
    unionSetsForAliases(model.snippetsByVisit, aliasesForVisit(model, candidate.fromVisitId)),
    unionSetsForAliases(model.snippetsByVisit, aliasesForVisit(model, candidate.toVisitId)),
  );

const sharedTitleTokensFeature = (
  candidate: Candidate,
  model: FeatureModel,
): number =>
  countIntersection(
    titleTokensForVisit(model, candidate.fromVisitId),
    titleTokensForVisit(model, candidate.toVisitId),
  );

const sharedPathTokensFeature = (
  candidate: Candidate,
  model: FeatureModel,
): number =>
  countIntersection(
    pathTokensForVisit(model, candidate.fromVisitId),
    pathTokensForVisit(model, candidate.toVisitId),
  );

const edgeConnectsCandidate = (
  edge: ConnectionEdge,
  fromAliases: ReadonlySet<string>,
  toAliases: ReadonlySet<string>,
): boolean => {
  const edgeFrom = visitKeyFromNodeOrRaw(edge.fromNodeId);
  const edgeTo = visitKeyFromNodeOrRaw(edge.toNodeId);
  return (
    (fromAliases.has(edgeFrom) && toAliases.has(edgeTo)) ||
    (fromAliases.has(edgeTo) && toAliases.has(edgeFrom))
  );
};

const clampedUnit = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
};

const cosineSimilarityFeature = (
  candidate: Candidate,
  model: FeatureModel,
): number => {
  const fromAliases = aliasesForVisit(model, candidate.fromVisitId);
  const toAliases = aliasesForVisit(model, candidate.toVisitId);
  let best = 0;
  for (const edge of model.snapshot.edges) {
    if (edge.kind !== 'visit_resembles_visit') continue;
    if (!edgeConnectsCandidate(edge, fromAliases, toAliases)) continue;
    const raw =
      edge.metadata?.['cosine'] ??
      edge.metadata?.['cosine_similarity'] ??
      edge.metadata?.['similarity'];
    if (typeof raw === 'number') best = Math.max(best, clampedUnit(raw));
  }
  return best;
};

const latestObservedAtForVisit = (
  candidateVisitId: string,
  model: FeatureModel,
): number | null => {
  let latest: number | null = null;
  for (const alias of aliasesForVisit(model, candidateVisitId)) {
    const record = model.recordsById.get(alias);
    if (record !== undefined && Number.isFinite(record.observedAtMs) && record.observedAtMs > 0) {
      latest = latest === null ? record.observedAtMs : Math.max(latest, record.observedAtMs);
    }
    const node = model.timelineNodesByVisitKey.get(alias);
    const nodeMs = parseTimestamp(node?.lastSeenAt) ?? parseTimestamp(node?.firstSeenAt);
    if (nodeMs !== null) latest = latest === null ? nodeMs : Math.max(latest, nodeMs);
  }
  return latest;
};

const recencyScore = (candidateVisitId: string, model: FeatureModel): number => {
  if (model.referenceMs === null) return 0;
  const observedAtMs = latestObservedAtForVisit(candidateVisitId, model);
  if (observedAtMs === null) return 0;
  const ageDays = Math.max(0, (model.referenceMs - observedAtMs) / DAY_MS);
  return Math.exp(-ageDays / 30);
};

const recencyScoreFromFeature = (
  candidate: Candidate,
  model: FeatureModel,
): number => recencyScore(candidate.fromVisitId, model);

const recencyScoreToFeature = (
  candidate: Candidate,
  model: FeatureModel,
): number => recencyScore(candidate.toVisitId, model);

const engagementClassForVisit = (
  candidateVisitId: string,
  model: FeatureModel,
): string | null => {
  let selected: OrderedValue<string> | null = null;
  for (const alias of aliasesForVisit(model, candidateVisitId)) {
    const value = model.engagementClassByVisit.get(alias);
    if (value === undefined) continue;
    if (selected === null || compareOrdered(selected, value) <= 0) selected = value;
  }
  return selected?.value ?? null;
};

const engagementClassMatchFeature = (
  candidate: Candidate,
  model: FeatureModel,
): BinaryFeature => {
  const fromClass = engagementClassForVisit(candidate.fromVisitId, model);
  const toClass = engagementClassForVisit(candidate.toVisitId, model);
  return toBinary(fromClass !== null && toClass !== null && fromClass === toClass);
};

const returnCountForVisit = (
  candidateVisitId: string,
  model: FeatureModel,
): number => {
  let count = 0;
  const countedAliases = new Set<string>();
  for (const alias of aliasesForVisit(model, candidateVisitId)) {
    if (countedAliases.has(alias)) continue;
    countedAliases.add(alias);
    count += model.returnCountByVisit.get(alias) ?? 0;
  }
  return count;
};

const returnCountFromFeature = (
  candidate: Candidate,
  model: FeatureModel,
): number => returnCountForVisit(candidate.fromVisitId, model);

const returnCountToFeature = (
  candidate: Candidate,
  model: FeatureModel,
): number => returnCountForVisit(candidate.toVisitId, model);

const userAssertedInThreadFeature = (
  candidate: Candidate,
  model: FeatureModel,
): BinaryFeature =>
  toBinary(
    hasIntersection(
      unionSetsForAliases(model.userThreadsByVisit, aliasesForVisit(model, candidate.fromVisitId)),
      unionSetsForAliases(model.userThreadsByVisit, aliasesForVisit(model, candidate.toVisitId)),
    ),
  );

const userAssertedInWorkstreamFeature = (
  candidate: Candidate,
  model: FeatureModel,
): BinaryFeature =>
  toBinary(
    hasIntersection(
      unionSetsForAliases(
        model.userWorkstreamsByVisit,
        aliasesForVisit(model, candidate.fromVisitId),
      ),
      unionSetsForAliases(
        model.userWorkstreamsByVisit,
        aliasesForVisit(model, candidate.toVisitId),
      ),
    ),
  );

export const extractFeatures: ExtractFeatures = (candidate, context): CandidatePairFeatures => {
  const model = buildFeatureModel(context.merged, context.snapshot);

  return {
    schemaVersion: FEATURE_SCHEMA_VERSION,
    same_workstream: sameWorkstreamFeature(candidate, model),
    opener_chain_depth: openerChainDepthFeature(candidate, model),
    in_navigation_chain: inNavigationChainFeature(candidate, model),
    same_canonical_url: sameCanonicalUrlFeature(candidate, model),
    same_host: sameHostFeature(candidate, model),
    same_repo: sameRepoFeature(candidate, model),
    same_search_query: sameSearchQueryFeature(candidate, model),
    same_copied_snippet_count: sameCopiedSnippetCountFeature(candidate, model),
    shared_title_tokens: sharedTitleTokensFeature(candidate, model),
    shared_path_tokens: sharedPathTokensFeature(candidate, model),
    cosine_similarity: cosineSimilarityFeature(candidate, model),
    recency_score_from: recencyScoreFromFeature(candidate, model),
    recency_score_to: recencyScoreToFeature(candidate, model),
    engagement_class_match: engagementClassMatchFeature(candidate, model),
    return_count_from: returnCountFromFeature(candidate, model),
    return_count_to: returnCountToFeature(candidate, model),
    user_asserted_in_thread: userAssertedInThreadFeature(candidate, model),
    user_asserted_in_workstream: userAssertedInWorkstreamFeature(candidate, model),
  };
};
