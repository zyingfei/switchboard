import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  buildEngagementClassRevision,
  ENGAGEMENT_CLASSES,
  ENGAGEMENT_CLASS_PRODUCER_KEY,
  type EngagementClass,
  type EngagementClassifierInput,
  type EngagementClassRevision,
  type EngagementRuleThresholds,
} from '../connections/engagementClassifier.js';
import { createRevision } from '../domain/ids.js';
import {
  ENGAGEMENT_SESSION_AGGREGATED,
  isEngagementSessionAggregatedPayload,
  type EngagementDimensions,
} from '../engagement/events.js';
import {
  NAVIGATION_COMMITTED,
  isNavigationCommittedPayload,
} from '../navigation/events.js';
import type { SelectionPastedPayload } from '../snippets/events.js';
import { projectSnippetLineage } from '../snippets/projection.js';
import type { AcceptedEvent } from '../sync/causal.js';
import type { TimelineDayProjection } from '../timeline/projection.js';

const DOWNSTREAM_PASTE_DESTINATIONS: ReadonlySet<SelectionPastedPayload['destinationKind']> =
  new Set<SelectionPastedPayload['destinationKind']>([
    'thread',
    'dispatch',
    'note',
    'capture',
  ]);

interface LatestSessionAggregate {
  readonly visitId: string;
  readonly sessionId: string;
  readonly engagement: EngagementDimensions;
  readonly acceptedAtMs: number;
  readonly replicaId: string;
  readonly seq: number;
}

interface LineageSummary {
  hasDownstreamPasteLineage: boolean;
  destinationKinds: Set<SelectionPastedPayload['destinationKind']>;
}

const emptyEngagement = (): EngagementDimensions => ({
  activeMs: 0,
  visibleMs: 0,
  focusedWindowMs: 0,
  idleMs: 0,
  foregroundBursts: 0,
  returnCount: 0,
  scrollEvents: 0,
  maxScrollRatio: 0,
  copyCount: 0,
  pasteCount: 0,
});

const clampRatio = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
};

const mergeEngagement = (
  left: EngagementDimensions,
  right: EngagementDimensions,
): EngagementDimensions => ({
  activeMs: left.activeMs + right.activeMs,
  visibleMs: left.visibleMs + right.visibleMs,
  focusedWindowMs: left.focusedWindowMs + right.focusedWindowMs,
  idleMs: left.idleMs + right.idleMs,
  foregroundBursts: left.foregroundBursts + right.foregroundBursts,
  returnCount: left.returnCount + right.returnCount,
  scrollEvents: left.scrollEvents + right.scrollEvents,
  maxScrollRatio: Math.max(clampRatio(left.maxScrollRatio), clampRatio(right.maxScrollRatio)),
  copyCount: left.copyCount + right.copyCount,
  pasteCount: left.pasteCount + right.pasteCount,
});

const stripFragmentAndTrailingSlash = (url: string): string =>
  url.replace(/#.*$/u, '').replace(/\/+$/u, '');

const compareEventOrder = (
  left: Pick<LatestSessionAggregate, 'acceptedAtMs' | 'replicaId' | 'seq'>,
  right: Pick<LatestSessionAggregate, 'acceptedAtMs' | 'replicaId' | 'seq'>,
): number => {
  if (left.acceptedAtMs !== right.acceptedAtMs) return left.acceptedAtMs - right.acceptedAtMs;
  if (left.replicaId !== right.replicaId) return left.replicaId < right.replicaId ? -1 : 1;
  return left.seq - right.seq;
};

const canonicalVisitAliases = (canonicalUrl: string): readonly string[] => [
  canonicalUrl,
  `visit:${canonicalUrl}`,
];

const canonicalUrlForVisitId = (
  visitId: string,
  canonicalUrlByVisitId: ReadonlyMap<string, string>,
): string => {
  const mapped = canonicalUrlByVisitId.get(visitId);
  if (mapped !== undefined) return mapped;
  if (visitId.startsWith('visit:')) {
    return stripFragmentAndTrailingSlash(visitId.slice('visit:'.length));
  }
  return stripFragmentAndTrailingSlash(visitId);
};

const addLineageSummary = (
  summaries: Map<string, LineageSummary>,
  key: string,
  destinationKind: SelectionPastedPayload['destinationKind'],
): void => {
  if (key.length === 0) return;
  const summary =
    summaries.get(key) ??
    ({
      hasDownstreamPasteLineage: false,
      destinationKinds: new Set<SelectionPastedPayload['destinationKind']>(),
    } satisfies LineageSummary);
  if (DOWNSTREAM_PASTE_DESTINATIONS.has(destinationKind)) {
    summary.hasDownstreamPasteLineage = true;
  }
  summary.destinationKinds.add(destinationKind);
  summaries.set(key, summary);
};

const selectSummary = (
  visitId: string,
  canonicalUrl: string,
  summaries: ReadonlyMap<string, LineageSummary>,
): LineageSummary | undefined =>
  summaries.get(visitId) ?? summaries.get(canonicalUrl) ?? summaries.get(`visit:${canonicalUrl}`);

// Stage 5.2 W2a — accumulator-pattern state for the engagement
// classifier. Foundational refactor: exposes seed + fold + derive so
// future incremental tracks can update state per-event instead of
// re-walking the entire event log on every drain. Today the
// materializer still calls the one-shot `buildEngagementClassifierInputs`
// for byte-equivalence; the streaming path is opt-in for callers that
// want O(new-events) instead of O(total-events) per drain.

// Internal mutable accumulator. Returned from seed; mutated by fold.
// derive (engagementClassifierInputsFromAccumulator) produces the
// readonly EngagementClassifierInput[] consumed by
// buildEngagementClassRevision.
export interface EngagementAccumulator {
  readonly latestByVisitSession: Map<string, LatestSessionAggregate>;
  readonly canonicalUrlByVisitId: Map<string, string>;
  readonly lineageSummaries: Map<string, LineageSummary>;
}

export const createEmptyEngagementAccumulator = (): EngagementAccumulator => ({
  latestByVisitSession: new Map(),
  canonicalUrlByVisitId: new Map(),
  lineageSummaries: new Map(),
});

const recordCanonical = (
  byVisitId: Map<string, string>,
  visitId: string | undefined,
  canonicalUrl: string | undefined,
): void => {
  if (visitId === undefined || visitId.length === 0) return;
  if (canonicalUrl === undefined || canonicalUrl.length === 0) return;
  const canonical = stripFragmentAndTrailingSlash(canonicalUrl);
  byVisitId.set(visitId, canonical);
  for (const alias of canonicalVisitAliases(canonical)) byVisitId.set(alias, canonical);
};

const recordTimelineDay = (
  byVisitId: Map<string, string>,
  day: TimelineDayProjection,
): void => {
  for (const entry of day.entries) {
    const canonical = stripFragmentAndTrailingSlash(entry.canonicalUrl ?? entry.url);
    recordCanonical(byVisitId, entry.id, canonical);
    recordCanonical(byVisitId, entry.url, canonical);
    recordCanonical(byVisitId, entry.canonicalUrl, canonical);
    for (const alias of canonicalVisitAliases(stripFragmentAndTrailingSlash(entry.id))) {
      recordCanonical(byVisitId, alias, canonical);
    }
  }
};

const foldEngagementAggregateIntoAccumulator = (
  acc: EngagementAccumulator,
  event: AcceptedEvent,
): void => {
  if (event.type !== ENGAGEMENT_SESSION_AGGREGATED) return;
  if (!isEngagementSessionAggregatedPayload(event.payload)) return;
  const payload = event.payload;
  const next: LatestSessionAggregate = {
    visitId: payload.visitId,
    sessionId: payload.sessionId,
    engagement: payload.dimensions.engagement,
    acceptedAtMs: event.acceptedAtMs,
    replicaId: event.dot.replicaId,
    seq: event.dot.seq,
  };
  const key = `${payload.visitId}\u0000${payload.sessionId}`;
  const existing = acc.latestByVisitSession.get(key);
  if (existing === undefined || compareEventOrder(existing, next) < 0) {
    acc.latestByVisitSession.set(key, next);
  }
};

const foldNavigationIntoAccumulator = (
  acc: EngagementAccumulator,
  event: AcceptedEvent,
): void => {
  if (event.type !== NAVIGATION_COMMITTED) return;
  if (!isNavigationCommittedPayload(event.payload)) return;
  recordCanonical(acc.canonicalUrlByVisitId, event.payload.visitId, event.payload.canonicalUrl);
};

/**
 * Stage 5.2 W2a — full-pass seed. Walks events + timeline days once
 * to populate the accumulator. Equivalent to running fold over every
 * event; future incremental callers seed at companion boot, then fold
 * each newly accepted event into the same state.
 */
export const seedEngagementAccumulator = (
  events: readonly AcceptedEvent[],
  timelineDays: readonly TimelineDayProjection[],
): EngagementAccumulator => {
  const acc = createEmptyEngagementAccumulator();
  // Navigation events first establish canonical-URL mappings the
  // lineage-summary computation may rely on (selection events resolve
  // copiedVisitId → canonical via this map).
  for (const event of events) {
    foldNavigationIntoAccumulator(acc, event);
  }
  for (const day of timelineDays) {
    recordTimelineDay(acc.canonicalUrlByVisitId, day);
  }
  for (const event of events) {
    foldEngagementAggregateIntoAccumulator(acc, event);
  }
  // Snippet lineage runs in one pass over selection events; the
  // upstream `projectSnippetLineage` is not yet incremental. A future
  // PR can refactor it the same way (state + per-event fold). Until
  // then, callers needing fresh lineage after new selection events
  // must re-seed.
  for (const lineage of projectSnippetLineage(events).lineages) {
    const canonical = canonicalUrlForVisitId(lineage.copiedVisitId, acc.canonicalUrlByVisitId);
    addLineageSummary(acc.lineageSummaries, lineage.copiedVisitId, lineage.destinationKind);
    for (const alias of canonicalVisitAliases(canonical)) {
      addLineageSummary(acc.lineageSummaries, alias, lineage.destinationKind);
    }
  }
  return acc;
};

/**
 * Stage 5.2 W2a — per-event fold. Updates the accumulator for one
 * accepted event. Handles ENGAGEMENT_SESSION_AGGREGATED (canonical
 * use case) and NAVIGATION_COMMITTED (so canonical-URL mappings stay
 * fresh for visits seen after seed).
 *
 * Does NOT update lineageSummaries — snippet lineage is still
 * batch-projected via projectSnippetLineage. A SELECTION_COPIED /
 * SELECTION_PASTED fold belongs with the snippet lineage refactor.
 */
export const foldEventIntoEngagementAccumulator = (
  acc: EngagementAccumulator,
  event: AcceptedEvent,
): void => {
  foldNavigationIntoAccumulator(acc, event);
  foldEngagementAggregateIntoAccumulator(acc, event);
};

/**
 * Stage 5.2 W2a — derive classifier inputs from the current
 * accumulator state. Byte-equivalent to running the one-shot
 * `buildEngagementClassifierInputs(events, days)` over the events
 * that populated the accumulator.
 */
export const engagementClassifierInputsFromAccumulator = (
  acc: EngagementAccumulator,
): readonly EngagementClassifierInput[] => {
  const totalsByVisit = new Map<string, EngagementDimensions>();
  for (const aggregate of acc.latestByVisitSession.values()) {
    const existing = totalsByVisit.get(aggregate.visitId) ?? emptyEngagement();
    totalsByVisit.set(aggregate.visitId, mergeEngagement(existing, aggregate.engagement));
  }
  const inputs: EngagementClassifierInput[] = [];
  for (const [visitId, engagement] of [...totalsByVisit.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const canonicalUrl = canonicalUrlForVisitId(visitId, acc.canonicalUrlByVisitId);
    const summary = selectSummary(visitId, canonicalUrl, acc.lineageSummaries);
    inputs.push({
      visitId,
      canonicalUrl,
      engagement,
      hasDownstreamPasteLineage: summary?.hasDownstreamPasteLineage ?? false,
      distinctPasteDestinationKinds: summary?.destinationKinds.size ?? 0,
    });
  }
  return inputs;
};

export const buildEngagementClassifierInputs = (
  events: readonly AcceptedEvent[],
  timelineDays: readonly TimelineDayProjection[],
): readonly EngagementClassifierInput[] =>
  engagementClassifierInputsFromAccumulator(seedEngagementAccumulator(events, timelineDays));


export const buildEngagementClassRevisionFromEvents = (
  events: readonly AcceptedEvent[],
  timelineDays: readonly TimelineDayProjection[],
  options: {
    readonly thresholds?: EngagementRuleThresholds;
    readonly producedAt?: number;
  } = {},
): EngagementClassRevision => {
  const inputs = buildEngagementClassifierInputs(events, timelineDays);
  const maxAcceptedAtMs = events.reduce(
    (max, event) => Math.max(max, event.acceptedAtMs),
    0,
  );
  return buildEngagementClassRevision(inputs, {
    ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
    producedAt: options.producedAt ?? maxAcceptedAtMs,
  });
};

export interface EngagementClassRevisionStore {
  readonly putRevision: (revision: EngagementClassRevision) => Promise<void>;
  readonly readRevision: (revisionId: string) => Promise<EngagementClassRevision | null>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isEngagementClass = (value: unknown): value is EngagementClass =>
  typeof value === 'string' &&
  ENGAGEMENT_CLASSES.some((candidate) => candidate === value);

const isClassification = (
  value: unknown,
): value is EngagementClassRevision['classifications'][number] =>
  isRecord(value) &&
  typeof value['visitId'] === 'string' &&
  value['visitId'].length > 0 &&
  typeof value['canonicalUrl'] === 'string' &&
  value['canonicalUrl'].length > 0 &&
  isEngagementClass(value['class']);

export const isEngagementClassRevision = (
  value: unknown,
): value is EngagementClassRevision =>
  isRecord(value) &&
  typeof value['revisionId'] === 'string' &&
  value['revisionId'].length > 0 &&
  value['producerKey'] === ENGAGEMENT_CLASS_PRODUCER_KEY &&
  typeof value['ruleTableHash'] === 'string' &&
  value['ruleTableHash'].length > 0 &&
  Array.isArray(value['classifications']) &&
  value['classifications'].every(isClassification) &&
  typeof value['producedAt'] === 'number' &&
  Number.isFinite(value['producedAt']);

export const createEngagementClassRevisionStore = (
  vaultRoot: string,
): EngagementClassRevisionStore => {
  const root = join(vaultRoot, '_BAC', 'connections', 'engagement-class');

  const revisionPath = (revisionId: string): string => join(root, `${revisionId}.json`);

  const writeAtomic = async (path: string, body: string): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    const tmp = join(dirname(path), `.${createRevision()}.tmp`);
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, path);
  };

  const putRevision = async (revision: EngagementClassRevision): Promise<void> => {
    await writeAtomic(
      revisionPath(revision.revisionId),
      JSON.stringify(revision, null, 2),
    );
  };

  const readRevision = async (
    revisionId: string,
  ): Promise<EngagementClassRevision | null> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(revisionPath(revisionId), 'utf8'));
      return isEngagementClassRevision(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };

  return { putRevision, readRevision };
};
