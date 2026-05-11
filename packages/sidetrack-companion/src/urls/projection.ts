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

const upsertObservedVisit = (
  records: Map<string, UrlVisitRecord>,
  input: {
    readonly canonicalUrl: string;
    readonly observedAt: string;
    readonly latestUrl?: string;
    readonly latestTitle?: string;
    readonly provider?: string;
    readonly tabSessionId?: string;
  },
): void => {
  const existing = records.get(input.canonicalUrl);
  const tabSessionIds = existing?.tabSessionIds ?? [];
  const nextTabSessionIds =
    input.tabSessionId === undefined || tabSessionIds.includes(input.tabSessionId)
      ? tabSessionIds
      : [...tabSessionIds, input.tabSessionId].sort(compareString);
  const next: UrlVisitRecord = {
    canonicalUrl: input.canonicalUrl,
    firstSeenAt:
      existing === undefined || input.observedAt < existing.firstSeenAt
        ? input.observedAt
        : existing.firstSeenAt,
    lastSeenAt:
      existing === undefined || input.observedAt > existing.lastSeenAt
        ? input.observedAt
        : existing.lastSeenAt,
    visitCount: (existing?.visitCount ?? 0) + 1,
    tabSessionIds: nextTabSessionIds,
    attributionHistory: existing?.attributionHistory ?? [],
    ...(existing?.currentAttribution === undefined
      ? {}
      : { currentAttribution: existing.currentAttribution }),
    // Latest-wins for title/url/provider/host, derived from the latest
    // observation we've seen by event order.
    ...(input.latestUrl !== undefined
      ? { latestUrl: input.latestUrl }
      : existing?.latestUrl !== undefined
        ? { latestUrl: existing.latestUrl }
        : {}),
    ...(input.latestTitle !== undefined
      ? { latestTitle: input.latestTitle }
      : existing?.latestTitle !== undefined
        ? { latestTitle: existing.latestTitle }
        : {}),
    ...(input.provider !== undefined
      ? { provider: input.provider }
      : existing?.provider !== undefined
        ? { provider: existing.provider }
        : {}),
    ...((): { host?: string } => {
      const derived = hostOf(input.latestUrl ?? existing?.latestUrl ?? input.canonicalUrl);
      return derived === undefined ? {} : { host: derived };
    })(),
  };
  records.set(input.canonicalUrl, next);
};

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

// Stage 5 follow-up — thread→URL attribution propagation.
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

export const projectUrls = (
  events: readonly AcceptedEvent[],
  options: ProjectUrlsOptions = {},
): UrlProjection => {
  if (events.length === 0 && (options.threads === undefined || options.threads.length === 0)) {
    return emptyProjection();
  }
  const records = new Map<string, UrlVisitRecord>();

  for (const event of [...events].sort(compareEventOrder)) {
    if (
      event.type === BROWSER_TIMELINE_OBSERVED &&
      isBrowserTimelineObservedPayload(event.payload)
    ) {
      const payload = event.payload;
      const canonical = payload.canonicalUrl ?? payload.url;
      if (typeof canonical !== 'string' || canonical.length === 0) continue;
      upsertObservedVisit(records, {
        canonicalUrl: canonical,
        observedAt: payload.observedAt,
        ...(payload.url === undefined ? {} : { latestUrl: payload.url }),
        ...(payload.title === undefined ? {} : { latestTitle: payload.title }),
        ...(payload.provider === undefined ? {} : { provider: payload.provider }),
        ...(payload.tabSessionId === undefined ? {} : { tabSessionId: payload.tabSessionId }),
      });
      continue;
    }

    if (event.type === USER_ORGANIZED_ITEM && isUserOrganizedItemPayload(event.payload)) {
      const payload = event.payload;
      if (payload.itemKind !== 'canonical-url' || payload.action !== 'move') continue;
      upsertAttribution(records, {
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
      continue;
    }

    if (
      event.type === URL_ATTRIBUTION_INFERRED &&
      isUrlAttributionInferredPayload(event.payload)
    ) {
      upsertAttribution(records, {
        canonicalUrl: event.payload.canonicalUrl,
        workstreamId: event.payload.workstreamId,
        source: 'inferred',
        observedAt: isoFromAcceptedAt(event.acceptedAtMs),
        clientEventId: event.clientEventId,
        replicaId: event.dot.replicaId,
        seq: event.dot.seq,
      });
    }
  }

  // Stage 5 follow-up — thread→URL attribution propagation. Applied
  // AFTER event-based attributions so an explicit URL attribution
  // event (more recent + same source-tier as 'thread') still wins on
  // tie-break. Only URLs that already appear in the projection (i.e.
  // have been observed at least once) get the derived attribution —
  // we don't fabricate URL records for thread URLs that were never
  // visited as timeline entries.
  if (options.threads !== undefined) {
    for (const thread of options.threads) {
      if (typeof thread.primaryWorkstreamId !== 'string') continue;
      if (thread.primaryWorkstreamId.length === 0) continue;
      const candidate = thread.canonicalUrl ?? thread.threadUrl;
      if (typeof candidate !== 'string' || candidate.length === 0) continue;
      const canonical = stripFragmentAndTrailingSlash(candidate);
      if (!records.has(canonical)) continue;
      upsertAttribution(records, {
        canonicalUrl: canonical,
        workstreamId: thread.primaryWorkstreamId,
        source: 'thread',
        observedAt: thread.lastSeenAt ?? new Date(0).toISOString(),
        clientEventId: `thread:${thread.bac_id}`,
        replicaId: 'derived',
        seq: 0,
      });
    }
  }

  return {
    schemaVersion: URL_PROJECTION_SCHEMA_VERSION,
    byCanonicalUrl: new Map(
      [...records.entries()].sort(([left], [right]) => compareString(left, right)),
    ),
  };
};

export const serializeUrlProjection = (projection: UrlProjection): SerializedUrlProjection => ({
  schemaVersion: projection.schemaVersion,
  byCanonicalUrl: Object.fromEntries(projection.byCanonicalUrl),
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
