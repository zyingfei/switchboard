// Per-canonical-URL projection. Mirrors `tabsession/projection.ts`
// structurally but keys by canonical URL instead of tab-session id.
// Each record tracks every visit-instance of the URL across tab
// sessions, plus the URL's attribution (user-asserted via the
// `user.organized.item` event with itemKind: 'canonical-url', or
// inferred via `urls.attribution.inferred`).
//
// The URL is the user-facing attribution unit. Per-tab-session
// attribution stays in the tabsession projection for compatibility,
// but the connections graph + Inbox + resolver all read URL
// attribution first.

import type { AcceptedEvent } from '../sync/causal.js';
import { USER_ORGANIZED_ITEM, isUserOrganizedItemPayload } from '../feedback/events.js';
import { BROWSER_TIMELINE_OBSERVED, isBrowserTimelineObservedPayload } from '../timeline/events.js';
import { URL_ATTRIBUTION_INFERRED, isUrlAttributionInferredPayload } from './events.js';

export const URL_PROJECTION_SCHEMA_VERSION = 1;

export interface UrlAttribution {
  readonly workstreamId: string | null;
  readonly source: 'user_asserted' | 'tab-group-pull-in' | 'tab-group-pull-out' | 'inferred';
  readonly observedAt: string;
  readonly clientEventId: string;
  readonly replicaId: string;
  readonly seq: number;
}

export interface UrlVisitRecord {
  readonly canonicalUrl: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly latestUrl?: string;
  readonly latestTitle?: string;
  readonly provider?: string;
  readonly host?: string;
  readonly visitCount: number;
  readonly tabSessionIds: readonly string[];
  readonly currentAttribution?: UrlAttribution;
  readonly attributionHistory: readonly UrlAttribution[];
}

export interface UrlProjection {
  readonly schemaVersion: typeof URL_PROJECTION_SCHEMA_VERSION;
  readonly byCanonicalUrl: ReadonlyMap<string, UrlVisitRecord>;
}

export interface SerializedUrlProjection {
  readonly schemaVersion: typeof URL_PROJECTION_SCHEMA_VERSION;
  readonly byCanonicalUrl: Record<string, UrlVisitRecord>;
}

const compareString = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareEventOrder = (left: AcceptedEvent, right: AcceptedEvent): number => {
  if (left.acceptedAtMs !== right.acceptedAtMs) return left.acceptedAtMs - right.acceptedAtMs;
  const replica = compareString(left.dot.replicaId, right.dot.replicaId);
  if (replica !== 0) return replica;
  if (left.dot.seq !== right.dot.seq) return left.dot.seq - right.dot.seq;
  return compareString(left.type, right.type);
};

const compareAttribution = (left: UrlAttribution, right: UrlAttribution): number => {
  // user_asserted always beats inferred regardless of order — the user's
  // explicit choice is sticky until the user changes it.
  const precedence = (value: UrlAttribution): number => (value.source === 'inferred' ? 0 : 1);
  const tier = precedence(left) - precedence(right);
  if (tier !== 0) return tier;
  const observed = compareString(left.observedAt, right.observedAt);
  if (observed !== 0) return observed;
  const replica = compareString(left.replicaId, right.replicaId);
  if (replica !== 0) return replica;
  if (left.seq !== right.seq) return left.seq - right.seq;
  return compareString(left.clientEventId, right.clientEventId);
};

const isoFromAcceptedAt = (acceptedAtMs: number): string => new Date(acceptedAtMs).toISOString();

const hostOf = (raw: string | undefined): string | undefined => {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  try {
    const host = new URL(raw).host;
    return host.length > 0 ? host : undefined;
  } catch {
    return undefined;
  }
};

const emptyProjection = (): UrlProjection => ({
  schemaVersion: URL_PROJECTION_SCHEMA_VERSION,
  byCanonicalUrl: new Map<string, UrlVisitRecord>(),
});

export const createEmptyUrlProjection = (): UrlProjection => emptyProjection();

const upsertAttribution = (
  records: Map<string, UrlVisitRecord>,
  attribution: UrlAttribution & { readonly canonicalUrl: string },
): void => {
  const existing = records.get(attribution.canonicalUrl);
  const history = [
    ...(existing?.attributionHistory ?? []),
    {
      workstreamId: attribution.workstreamId,
      source: attribution.source,
      observedAt: attribution.observedAt,
      clientEventId: attribution.clientEventId,
      replicaId: attribution.replicaId,
      seq: attribution.seq,
    },
  ].sort(compareAttribution);
  const currentAttribution = history[history.length - 1];
  const fallbackObservedAt = attribution.observedAt;
  records.set(attribution.canonicalUrl, {
    canonicalUrl: attribution.canonicalUrl,
    firstSeenAt: existing?.firstSeenAt ?? fallbackObservedAt,
    lastSeenAt: existing?.lastSeenAt ?? fallbackObservedAt,
    visitCount: existing?.visitCount ?? 0,
    tabSessionIds: existing?.tabSessionIds ?? [],
    ...(existing?.latestUrl === undefined ? {} : { latestUrl: existing.latestUrl }),
    ...(existing?.latestTitle === undefined ? {} : { latestTitle: existing.latestTitle }),
    ...(existing?.provider === undefined ? {} : { provider: existing.provider }),
    ...(existing?.host === undefined ? {} : { host: existing.host }),
    ...(currentAttribution === undefined ? {} : { currentAttribution }),
    attributionHistory: history,
  });
};

// -- Stage 5.2 W2b — URL projection accumulator -----------------------
// The legacy projectUrls() sorts events first then folds. That works
// but makes every drain re-walk the entire log. The accumulator
// exposes seed + fold + derive so callers (the connections
// materializer, eventually) can hold the per-canonical-URL state
// across drains and update only the records touched by newly accepted
// events. Byte-equal output for any event-order permutation is the
// load-bearing property — verified by the parity tests.

interface UrlObservationCursor {
  readonly acceptedAtMs: number;
  readonly replicaId: string;
  readonly seq: number;
}

export interface UrlProjectionAccumulator {
  /** Live per-canonical-URL records. Mirrored to UrlProjection at derive time. */
  readonly records: Map<string, UrlVisitRecord>;
  /**
   * Per-canonical-URL cursor for the most recent observation event seen
   * by the accumulator. Used to make latest-* field updates
   * (`latestUrl`, `latestTitle`, `provider`) order-independent: a later
   * fold of an older event can still backfill an undefined field but
   * never overwrite a value contributed by a newer event.
   */
  readonly observationCursors: Map<string, UrlObservationCursor>;
}

export const createEmptyUrlProjectionAccumulator = (): UrlProjectionAccumulator => ({
  records: new Map<string, UrlVisitRecord>(),
  observationCursors: new Map<string, UrlObservationCursor>(),
});

const cursorIsNewerThan = (
  candidate: UrlObservationCursor,
  baseline: UrlObservationCursor | undefined,
): boolean => {
  if (baseline === undefined) return true;
  if (candidate.acceptedAtMs !== baseline.acceptedAtMs) {
    return candidate.acceptedAtMs > baseline.acceptedAtMs;
  }
  const replica = compareString(candidate.replicaId, baseline.replicaId);
  if (replica !== 0) return replica > 0;
  return candidate.seq > baseline.seq;
};

const pickLatestField = <T>(
  existingValue: T | undefined,
  candidateValue: T | undefined,
  candidateIsNewer: boolean,
): T | undefined => {
  // Newer event with a value: it wins.
  // Older event with a value, existing undefined: backfill.
  // Otherwise: keep existing (older event with a value but existing
  // already has one from a newer event = no-op).
  if (candidateValue !== undefined && candidateIsNewer) return candidateValue;
  if (candidateValue !== undefined && existingValue === undefined) return candidateValue;
  return existingValue;
};

const foldObservedVisitIntoAccumulator = (
  acc: UrlProjectionAccumulator,
  event: AcceptedEvent,
): void => {
  if (event.type !== BROWSER_TIMELINE_OBSERVED) return;
  if (!isBrowserTimelineObservedPayload(event.payload)) return;
  const payload = event.payload;
  const canonical = payload.canonicalUrl ?? payload.url;
  if (typeof canonical !== 'string' || canonical.length === 0) return;
  const cursor: UrlObservationCursor = {
    acceptedAtMs: event.acceptedAtMs,
    replicaId: event.dot.replicaId,
    seq: event.dot.seq,
  };
  const existing = acc.records.get(canonical);
  const existingCursor = acc.observationCursors.get(canonical);
  const candidateIsNewer = cursorIsNewerThan(cursor, existingCursor);
  const tabSessionIds = existing?.tabSessionIds ?? [];
  const nextTabSessionIds =
    payload.tabSessionId === undefined || tabSessionIds.includes(payload.tabSessionId)
      ? tabSessionIds
      : [...tabSessionIds, payload.tabSessionId].sort(compareString);
  const latestUrl = pickLatestField(existing?.latestUrl, payload.url, candidateIsNewer);
  const latestTitle = pickLatestField(existing?.latestTitle, payload.title, candidateIsNewer);
  const provider = pickLatestField(existing?.provider, payload.provider, candidateIsNewer);
  const derivedHost = hostOf(latestUrl ?? canonical);
  const next: UrlVisitRecord = {
    canonicalUrl: canonical,
    firstSeenAt:
      existing === undefined || payload.observedAt < existing.firstSeenAt
        ? payload.observedAt
        : existing.firstSeenAt,
    lastSeenAt:
      existing === undefined || payload.observedAt > existing.lastSeenAt
        ? payload.observedAt
        : existing.lastSeenAt,
    visitCount: (existing?.visitCount ?? 0) + 1,
    tabSessionIds: nextTabSessionIds,
    attributionHistory: existing?.attributionHistory ?? [],
    ...(existing?.currentAttribution === undefined
      ? {}
      : { currentAttribution: existing.currentAttribution }),
    ...(latestUrl === undefined ? {} : { latestUrl }),
    ...(latestTitle === undefined ? {} : { latestTitle }),
    ...(provider === undefined ? {} : { provider }),
    ...(derivedHost === undefined ? {} : { host: derivedHost }),
  };
  acc.records.set(canonical, next);
  if (candidateIsNewer) acc.observationCursors.set(canonical, cursor);
};

const foldUserOrganizedIntoAccumulator = (
  acc: UrlProjectionAccumulator,
  event: AcceptedEvent,
): void => {
  if (event.type !== USER_ORGANIZED_ITEM) return;
  if (!isUserOrganizedItemPayload(event.payload)) return;
  const payload = event.payload;
  if (payload.itemKind !== 'canonical-url' || payload.action !== 'move') return;
  // upsertAttribution is already order-independent (it sorts the
  // attributionHistory by precedence + observedAt + replicaId + seq
  // on every insert), so the fold is just the existing helper.
  upsertAttribution(acc.records, {
    canonicalUrl: payload.itemId,
    workstreamId: payload.toContainer ?? null,
    source:
      payload.details?.attributionSource === 'tab-group-pull-in' ||
      payload.details?.attributionSource === 'tab-group-pull-out'
        ? payload.details.attributionSource
        : 'user_asserted',
    observedAt: isoFromAcceptedAt(event.acceptedAtMs),
    clientEventId: event.clientEventId,
    replicaId: event.dot.replicaId,
    seq: event.dot.seq,
  });
};

const foldUrlAttributionInferredIntoAccumulator = (
  acc: UrlProjectionAccumulator,
  event: AcceptedEvent,
): void => {
  if (event.type !== URL_ATTRIBUTION_INFERRED) return;
  if (!isUrlAttributionInferredPayload(event.payload)) return;
  upsertAttribution(acc.records, {
    canonicalUrl: event.payload.canonicalUrl,
    workstreamId: event.payload.workstreamId,
    source: 'inferred',
    observedAt: isoFromAcceptedAt(event.acceptedAtMs),
    clientEventId: event.clientEventId,
    replicaId: event.dot.replicaId,
    seq: event.dot.seq,
  });
};

/**
 * Stage 5.2 W2b — per-event fold. Updates the accumulator for one
 * accepted event. Idempotent + order-independent: folding the same
 * stream in any permutation yields the same `byCanonicalUrl` map.
 */
export const foldEventIntoUrlProjectionAccumulator = (
  acc: UrlProjectionAccumulator,
  event: AcceptedEvent,
): void => {
  foldObservedVisitIntoAccumulator(acc, event);
  foldUserOrganizedIntoAccumulator(acc, event);
  foldUrlAttributionInferredIntoAccumulator(acc, event);
};

/**
 * Stage 5.2 W2b — full-pass seed. Walks every event once to populate
 * the accumulator. Equivalent to running fold over every event;
 * future incremental callers seed at companion boot, then fold each
 * newly accepted event into the same state.
 */
export const seedUrlProjectionAccumulator = (
  events: readonly AcceptedEvent[],
): UrlProjectionAccumulator => {
  const acc = createEmptyUrlProjectionAccumulator();
  for (const event of events) foldEventIntoUrlProjectionAccumulator(acc, event);
  return acc;
};

/**
 * Stage 5.2 W2b — derive a UrlProjection from accumulator state.
 * Sorts byCanonicalUrl deterministically.
 */
export const urlProjectionFromAccumulator = (
  acc: UrlProjectionAccumulator,
): UrlProjection => ({
  schemaVersion: URL_PROJECTION_SCHEMA_VERSION,
  byCanonicalUrl: new Map(
    [...acc.records.entries()].sort(([left], [right]) => compareString(left, right)),
  ),
});

export const projectUrls = (events: readonly AcceptedEvent[]): UrlProjection => {
  if (events.length === 0) return emptyProjection();
  // Sorted-fold preserves byte-equality with the pre-W2b
  // implementation: prior callers relied on event-order'd
  // visitCount accumulation + latest-wins for latestUrl/Title/provider.
  // The accumulator fold is independently order-independent, but the
  // legacy projectUrls contract is "sorted-fold output."
  return urlProjectionFromAccumulator(
    seedUrlProjectionAccumulator([...events].sort(compareEventOrder)),
  );
};

export const serializeUrlProjection = (projection: UrlProjection): SerializedUrlProjection => ({
  schemaVersion: projection.schemaVersion,
  byCanonicalUrl: Object.fromEntries(projection.byCanonicalUrl),
});

export const deserializeUrlProjection = (
  serialized: SerializedUrlProjection,
): UrlProjection => ({
  schemaVersion: serialized.schemaVersion,
  byCanonicalUrl: new Map(
    Object.entries(serialized.byCanonicalUrl).sort(([left], [right]) =>
      compareString(left, right),
    ),
  ),
});

export const urlInbox = (
  projection: UrlProjection,
  input: { readonly limit: number; readonly offset: number },
): readonly UrlVisitRecord[] =>
  [...projection.byCanonicalUrl.values()]
    .filter((record) => record.currentAttribution === undefined)
    // Sort by FIRST seen (descending — newest URL on top), not last
    // seen. Sorting by lastSeenAt makes existing items jump around the
    // list every time the user revisits the page, which the user
    // perceives as the Inbox "constantly refreshing". firstSeenAt is
    // stable per URL, so cards stay in place once they enter the list.
    .sort((left, right) => {
      if (left.firstSeenAt !== right.firstSeenAt) {
        return left.firstSeenAt < right.firstSeenAt ? 1 : -1;
      }
      return compareString(left.canonicalUrl, right.canonicalUrl);
    })
    .slice(input.offset, input.offset + input.limit);
