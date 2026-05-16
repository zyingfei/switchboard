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
import {
  URL_ATTRIBUTION_INFERRED,
  URL_IGNORED,
  isUrlAttributionInferredPayload,
  isUrlIgnoredPayload,
} from './events.js';

export const URL_PROJECTION_SCHEMA_VERSION = 1;

export interface UrlAttribution {
  readonly workstreamId: string | null;
  // Stage 5 follow-up — `'thread'` is a derived source: the user
  // attributed a chat THREAD to a workstream, and the projection
  // propagates that to the matching canonical URL. Without this
  // bridge, attributing an AI chat via the "All threads" tab leaves
  // its URL in the Inbox asking for re-attribution.
  readonly source:
    | 'user_asserted'
    | 'tab-group-pull-in'
    | 'tab-group-pull-out'
    | 'inferred'
    | 'thread';
  readonly observedAt: string;
  readonly clientEventId: string;
  readonly replicaId: string;
  readonly seq: number;
}

export interface UrlIgnoredState {
  // Stage 5 polish — explicit user dismissal of a URL as "noise."
  // Stronger than workstreamId:null + 'user_asserted' (which says
  // "meaningful but no workstream"). Ignored URLs are hidden from
  // Inbox, the workstream view, the connections graph, and topic
  // clusters. Reversible: re-organizing the URL into a workstream
  // supersedes the ignore.
  readonly reason: 'noise' | 'duplicate' | 'private';
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
  readonly currentIgnored?: UrlIgnoredState;
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
  // user_asserted / thread always beat inferred regardless of order —
  // the user's explicit choice (direct on the URL, or transitive
  // through the thread) is sticky until the user changes it.
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
  // Re-organize supersedes ignore: when the user explicitly attributes
  // an ignored URL to a workstream (workstreamId !== null + source =
  // user_asserted / tab-group-*), the prior `currentIgnored` is
  // cleared. Inferred attributions never clear ignored (auto-apply
  // should already be filtering ignored URLs upstream).
  const userAssertedReorganize =
    attribution.workstreamId !== null &&
    (attribution.source === 'user_asserted' ||
      attribution.source === 'tab-group-pull-in' ||
      attribution.source === 'tab-group-pull-out');
  const preserveIgnored = existing?.currentIgnored !== undefined && !userAssertedReorganize;
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
    ...(preserveIgnored && existing.currentIgnored !== undefined
      ? { currentIgnored: existing.currentIgnored }
      : {}),
    attributionHistory: history,
  });
};

const upsertIgnored = (
  records: Map<string, UrlVisitRecord>,
  input: UrlIgnoredState & { readonly canonicalUrl: string },
): void => {
  const existing = records.get(input.canonicalUrl);
  // Last-write-wins by event order. Compare against existing ignore
  // (if any) via the same order semantics used for attributions.
  const incomingCursor = {
    observedAt: input.observedAt,
    replicaId: input.replicaId,
    seq: input.seq,
    clientEventId: input.clientEventId,
  };
  const existingCursor = existing?.currentIgnored;
  const keepExisting =
    existingCursor !== undefined &&
    (existingCursor.observedAt > incomingCursor.observedAt ||
      (existingCursor.observedAt === incomingCursor.observedAt &&
        existingCursor.seq > incomingCursor.seq));
  const nextIgnored: UrlIgnoredState =
    keepExisting && existingCursor !== undefined
      ? existingCursor
      : {
          reason: input.reason,
          observedAt: input.observedAt,
          clientEventId: input.clientEventId,
          replicaId: input.replicaId,
          seq: input.seq,
        };
  const fallbackObservedAt = input.observedAt;
  records.set(input.canonicalUrl, {
    canonicalUrl: input.canonicalUrl,
    firstSeenAt: existing?.firstSeenAt ?? fallbackObservedAt,
    lastSeenAt: existing?.lastSeenAt ?? fallbackObservedAt,
    visitCount: existing?.visitCount ?? 0,
    tabSessionIds: existing?.tabSessionIds ?? [],
    ...(existing?.latestUrl === undefined ? {} : { latestUrl: existing.latestUrl }),
    ...(existing?.latestTitle === undefined ? {} : { latestTitle: existing.latestTitle }),
    ...(existing?.provider === undefined ? {} : { provider: existing.provider }),
    ...(existing?.host === undefined ? {} : { host: existing.host }),
    ...(existing?.currentAttribution === undefined
      ? {}
      : { currentAttribution: existing.currentAttribution }),
    currentIgnored: nextIgnored,
    attributionHistory: existing?.attributionHistory ?? [],
  });
};

// Stage 5 follow-up (PR #141) — thread→URL attribution propagation.
//
// The user reported "disconnect" between the workstream / All-threads
// tabs (where AI chats appear as attributed) and the Inbox (where the
// same chat URL keeps showing up unattributed, asking to be picked
// again). Root cause: attributing a thread via the workboard sets
// thread.primaryWorkstreamId in the vault, but emits NO event that
// the URL projection knows about. So
// `urlProjection[canonicalUrl].currentAttribution` stays undefined.
//
// This option lets the materializer pass the threads-vault snapshot
// in. For every thread with `primaryWorkstreamId` set we synthesize
// a derived `source: 'thread'` attribution on the matching canonical
// URL. Downstream this propagates to the Inbox filter (hides
// attributed URLs), the snapshot's `visit_instance_in_workstream`
// edge (URL attribution path), and the ranker's
// `deriveVisitPairLabelsFromSnapshot` (same workstream → visit-pair
// label).
export interface ProjectUrlsOptions {
  readonly threads?: readonly {
    readonly bac_id: string;
    readonly canonicalUrl?: string;
    readonly threadUrl?: string;
    readonly primaryWorkstreamId?: string;
    readonly lastSeenAt?: string;
  }[];
}

const stripFragmentAndTrailingSlash = (url: string): string =>
  url.replace(/#.*$/u, '').replace(/\/+$/u, '');

// -- Stage 5.2 W2b — URL projection accumulator -----------------------
// The legacy projectUrls() sorts events first then folds. That works
// but makes every drain re-walk the entire log. The accumulator
// exposes seed + fold + derive so callers (the connections
// materializer) can hold the per-canonical-URL state across drains
// and update only the records touched by newly accepted events.
// Byte-equal output for any event-order permutation is the
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
  // Auto-apply MUST skip ignored URLs — but server-side autoApplyUrl
  // already filters them. Defensive check here too: if a stale
  // inferred event arrives for an ignored URL, don't override the
  // ignore signal.
  const existing = acc.records.get(event.payload.canonicalUrl);
  if (existing?.currentIgnored !== undefined) return;
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

const foldUrlIgnoredIntoAccumulator = (
  acc: UrlProjectionAccumulator,
  event: AcceptedEvent,
): void => {
  if (event.type !== URL_IGNORED) return;
  if (!isUrlIgnoredPayload(event.payload)) return;
  upsertIgnored(acc.records, {
    canonicalUrl: event.payload.canonicalUrl,
    reason: event.payload.reason ?? 'noise',
    observedAt: isoFromAcceptedAt(event.acceptedAtMs),
    clientEventId: event.clientEventId,
    replicaId: event.dot.replicaId,
    seq: event.dot.seq,
  });
};

export const foldEventIntoUrlProjectionAccumulator = (
  acc: UrlProjectionAccumulator,
  event: AcceptedEvent,
): void => {
  foldObservedVisitIntoAccumulator(acc, event);
  foldUserOrganizedIntoAccumulator(acc, event);
  foldUrlAttributionInferredIntoAccumulator(acc, event);
  foldUrlIgnoredIntoAccumulator(acc, event);
};

export const seedUrlProjectionAccumulator = (
  events: readonly AcceptedEvent[],
): UrlProjectionAccumulator => {
  const acc = createEmptyUrlProjectionAccumulator();
  for (const event of events) foldEventIntoUrlProjectionAccumulator(acc, event);
  return acc;
};

// Async variant that yields to the event loop every `yieldEvery`
// events. Used by the materializer's cold-start path so /status (and
// any other HTTP request) gets a turn while a 10k+ event vault is
// being re-projected. Byte-identical to the sync variant; the only
// difference is the cooperative yield.
export const seedUrlProjectionAccumulatorAsync = async (
  events: readonly AcceptedEvent[],
  yieldEvery = 500,
): Promise<UrlProjectionAccumulator> => {
  const acc = createEmptyUrlProjectionAccumulator();
  for (let i = 0; i < events.length; i += 1) {
    foldEventIntoUrlProjectionAccumulator(acc, events[i]!);
    if ((i + 1) % yieldEvery === 0) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
  }
  return acc;
};

export const urlProjectionFromAccumulator = (acc: UrlProjectionAccumulator): UrlProjection => ({
  schemaVersion: URL_PROJECTION_SCHEMA_VERSION,
  byCanonicalUrl: new Map(
    [...acc.records.entries()].sort(([left], [right]) => compareString(left, right)),
  ),
});

// Apply PR #141's thread→URL attribution propagation to the
// accumulator's records map. Only URLs that already appear in the
// projection (i.e. have been observed at least once) get the derived
// attribution — we don't fabricate URL records for thread URLs that
// were never visited as timeline entries. Pure mutation on the
// records Map; caller derives the projection afterward.
//
// Exported so the materializer can apply thread attribution to its
// long-lived accumulator (W2 wiring) without dropping back to a full
// re-projection.
export const applyThreadAttributionsToAccumulator = (
  acc: UrlProjectionAccumulator,
  threads: ProjectUrlsOptions['threads'],
): void => {
  if (threads === undefined) return;
  for (const thread of threads) {
    if (typeof thread.primaryWorkstreamId !== 'string') continue;
    if (thread.primaryWorkstreamId.length === 0) continue;
    const candidate = thread.canonicalUrl ?? thread.threadUrl;
    if (typeof candidate !== 'string' || candidate.length === 0) continue;
    const canonical = stripFragmentAndTrailingSlash(candidate);
    if (!acc.records.has(canonical)) continue;
    upsertAttribution(acc.records, {
      canonicalUrl: canonical,
      workstreamId: thread.primaryWorkstreamId,
      source: 'thread',
      observedAt: thread.lastSeenAt ?? new Date(0).toISOString(),
      clientEventId: `thread:${thread.bac_id}`,
      replicaId: 'derived',
      seq: 0,
    });
  }
};

export const projectUrls = (
  events: readonly AcceptedEvent[],
  options: ProjectUrlsOptions = {},
): UrlProjection => {
  if (events.length === 0 && (options.threads === undefined || options.threads.length === 0)) {
    return emptyProjection();
  }
  // Sorted-fold preserves byte-equality with the pre-W2b
  // implementation. Thread→URL attribution from PR #141 is applied
  // AFTER all events fold but BEFORE the projection derives, so an
  // explicit URL attribution event still wins on tie-break.
  const acc = seedUrlProjectionAccumulator([...events].sort(compareEventOrder));
  applyThreadAttributionsToAccumulator(acc, options.threads);
  return urlProjectionFromAccumulator(acc);
};

export const serializeUrlProjection = (projection: UrlProjection): SerializedUrlProjection => ({
  schemaVersion: projection.schemaVersion,
  byCanonicalUrl: Object.fromEntries(projection.byCanonicalUrl),
});

export const deserializeUrlProjection = (serialized: SerializedUrlProjection): UrlProjection => ({
  schemaVersion: serialized.schemaVersion,
  byCanonicalUrl: new Map(
    Object.entries(serialized.byCanonicalUrl).sort(([left], [right]) => compareString(left, right)),
  ),
});

export const urlInbox = (
  projection: UrlProjection,
  input: { readonly limit: number; readonly offset: number },
): readonly UrlVisitRecord[] =>
  [...projection.byCanonicalUrl.values()]
    // Hide attributed URLs (they live in their workstream view) AND
    // hide ignored URLs (user explicitly said "noise, don't bother").
    .filter(
      (record) => record.currentAttribution === undefined && record.currentIgnored === undefined,
    )
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
