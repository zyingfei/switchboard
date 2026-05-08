import type { ConnectionEdge } from '../connections/types.js';
import type { AcceptedEvent } from '../sync/causal.js';
import type { Candidate, CandidateSource } from './types.js';

export type NegativeCandidateSeed = string | number;
export type VisitRef = string | { readonly id: string };

export interface RandomUnrelatedOptions {
  readonly edges?: readonly ConnectionEdge[];
  readonly existingEdges?: readonly ConnectionEdge[];
  readonly generatedAt?: number;
}

export interface RecentlySkippedOptions {
  readonly referenceAtMs?: number;
  readonly generatedAt?: number;
}

const TIMELINE_VISIT_PREFIX = 'timeline-visit:';
const USER_FLOW_REJECTED = 'user.flow.rejected';
const DAY_MS = 24 * 60 * 60 * 1_000;
const UINT32_MAX_PLUS_ONE = 0x1_0000_0000;

const FLOW_RELATION_KINDS = new Set<string>([
  'closest_visit',
  'visit_resembles_visit',
  'visit_continues_visit',
]);

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const normalizeVisitId = (value: string): string =>
  value.startsWith(TIMELINE_VISIT_PREFIX) ? value.slice(TIMELINE_VISIT_PREFIX.length) : value;

const visitIdFromRef = (visit: VisitRef): string => {
  const id = typeof visit === 'string' ? visit : visit.id;
  return normalizeVisitId(id);
};

const maybeTimestamp = (value: number): number | null => (Number.isFinite(value) ? value : null);

const parseTimestamp = (value: string): number | null => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const maxTimestamp = (current: number, candidate: number | null): number =>
  candidate === null || candidate <= current ? current : candidate;

const stableGeneratedAtFromEdges = (edges: readonly ConnectionEdge[]): number => {
  let generatedAt = 0;
  for (const edge of edges) {
    generatedAt = maxTimestamp(generatedAt, parseTimestamp(edge.observedAt));
  }
  return generatedAt;
};

const stableGeneratedAtFromEvents = (events: readonly AcceptedEvent[]): number => {
  let generatedAt = 0;
  for (const event of events) {
    generatedAt = maxTimestamp(generatedAt, maybeTimestamp(event.acceptedAtMs));
  }
  return generatedAt;
};

const normalizeCount = (count: number): number =>
  Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;

const hashSeed = (seed: NegativeCandidateSeed): number => {
  const text = String(seed);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0 || 0x9e3779b9;
};

const seededRandom = (seed: NegativeCandidateSeed): (() => number) => {
  let state = hashSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / UINT32_MAX_PLUS_ONE;
  };
};

const swap = (values: string[], leftIndex: number, rightIndex: number): void => {
  const left = values[leftIndex];
  const right = values[rightIndex];
  if (left === undefined || right === undefined) {
    throw new Error('seeded shuffle index out of range');
  }
  values[leftIndex] = right;
  values[rightIndex] = left;
};

const seededShuffle = (
  values: readonly string[],
  seed: NegativeCandidateSeed,
): readonly string[] => {
  const shuffled = [...values];
  const random = seededRandom(seed);

  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    swap(shuffled, i, j);
  }

  return shuffled;
};

const connectedVisitIds = (
  fromVisitId: string,
  edges: readonly ConnectionEdge[],
): ReadonlySet<string> => {
  const fromKey = normalizeVisitId(fromVisitId);
  const connected = new Set<string>();

  for (const edge of edges) {
    const left = normalizeVisitId(edge.fromNodeId);
    const right = normalizeVisitId(edge.toNodeId);
    if (left === fromKey) connected.add(right);
    if (right === fromKey) connected.add(left);
  }

  return connected;
};

const candidatesFromIds = (
  fromVisitId: string,
  toVisitIds: readonly string[],
  source: CandidateSource,
  generatedAt: number,
): readonly Candidate[] =>
  toVisitIds.map((toVisitId) => ({
    fromVisitId,
    toVisitId,
    sources: [source],
    generatedAt,
  }));

const isConnectionEdgeArray = (
  options: readonly ConnectionEdge[] | RandomUnrelatedOptions,
): options is readonly ConnectionEdge[] => Array.isArray(options);

const edgesFromRandomOptions = (
  options: readonly ConnectionEdge[] | RandomUnrelatedOptions,
): readonly ConnectionEdge[] => {
  if (isConnectionEdgeArray(options)) return options;
  return options.edges ?? options.existingEdges ?? [];
};

const generatedAtFromRandomOptions = (
  options: readonly ConnectionEdge[] | RandomUnrelatedOptions,
  edges: readonly ConnectionEdge[],
): number => {
  if (isConnectionEdgeArray(options)) return stableGeneratedAtFromEdges(edges);
  return options.generatedAt ?? stableGeneratedAtFromEdges(edges);
};

export const randomUnrelated = (
  fromVisitId: string,
  allVisits: readonly VisitRef[],
  count: number,
  seed: NegativeCandidateSeed,
  options: readonly ConnectionEdge[] | RandomUnrelatedOptions = {},
): readonly Candidate[] => {
  if (fromVisitId.length === 0) return [];

  const edges = edgesFromRandomOptions(options);
  const sampleCount = normalizeCount(count);
  if (sampleCount === 0) return [];

  const fromKey = normalizeVisitId(fromVisitId);
  const connected = connectedVisitIds(fromVisitId, edges);
  const eligible = [...new Set(allVisits.map(visitIdFromRef))]
    .filter((visitId) => visitId.length > 0 && visitId !== fromKey && !connected.has(visitId))
    .sort(compareText);

  const selected = seededShuffle(eligible, seed).slice(0, sampleCount);
  return candidatesFromIds(
    fromVisitId,
    selected,
    'random_unrelated',
    generatedAtFromRandomOptions(options, edges),
  );
};

const isUserFlowRejectedPayload = (
  value: unknown,
): value is { readonly fromId: string; readonly toId: string } =>
  isRecord(value) &&
  value['payloadVersion'] === 1 &&
  isNonEmptyString(value['relationKind']) &&
  FLOW_RELATION_KINDS.has(value['relationKind']) &&
  isNonEmptyString(value['fromId']) &&
  isNonEmptyString(value['toId']);

const windowDaysToMs = (windowDays: number): number | null =>
  Number.isFinite(windowDays) && windowDays > 0 ? windowDays * DAY_MS : null;

export const recentlySkipped = (
  fromVisitId: string,
  userActions: readonly AcceptedEvent[],
  windowDays: number,
  options: RecentlySkippedOptions = {},
): readonly Candidate[] => {
  if (fromVisitId.length === 0) return [];

  const windowMs = windowDaysToMs(windowDays);
  if (windowMs === null) return [];

  const fromKey = normalizeVisitId(fromVisitId);
  const referenceAtMs = options.referenceAtMs ?? stableGeneratedAtFromEvents(userActions);
  const thresholdAtMs = referenceAtMs - windowMs;
  const toVisitIds = new Set<string>();

  for (const event of userActions) {
    if (event.type !== USER_FLOW_REJECTED) continue;
    if (!isUserFlowRejectedPayload(event.payload)) continue;

    const acceptedAtMs = maybeTimestamp(event.acceptedAtMs);
    if (acceptedAtMs === null || acceptedAtMs < thresholdAtMs || acceptedAtMs > referenceAtMs) {
      continue;
    }

    if (normalizeVisitId(event.payload.fromId) !== fromKey) continue;
    const toVisitId = normalizeVisitId(event.payload.toId);
    if (toVisitId.length === 0 || toVisitId === fromKey) continue;
    toVisitIds.add(toVisitId);
  }

  return candidatesFromIds(
    fromVisitId,
    [...toVisitIds].sort(compareText),
    'recently_skipped',
    options.generatedAt ?? referenceAtMs,
  );
};
