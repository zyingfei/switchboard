import type { AcceptedEvent } from '../sync/causal.js';
import { USER_ORGANIZED_ITEM, isUserOrganizedItemPayload } from '../feedback/events.js';
import { BROWSER_TIMELINE_OBSERVED, isBrowserTimelineObservedPayload } from '../timeline/events.js';
import {
  TAB_SESSION_ATTRIBUTION_INFERRED,
  isTabSessionAttributionInferredPayload,
} from './events.js';

export const TAB_SESSION_PROJECTION_SCHEMA_VERSION = 1;

export interface TabSessionAttribution {
  readonly workstreamId: string | null;
  readonly source: 'user_asserted' | 'tab-group-pull-in' | 'tab-group-pull-out' | 'inferred';
  readonly observedAt: string;
  readonly clientEventId: string;
  readonly replicaId: string;
  readonly seq: number;
}

export interface TabSessionRecord {
  readonly tabSessionId: string;
  readonly openedAt: string;
  readonly lastActivityAt: string;
  readonly closedAt?: string;
  readonly tabIdHash?: string;
  readonly openerTabSessionId?: string;
  readonly latestUrl?: string;
  readonly latestTitle?: string;
  readonly provider?: string;
  readonly currentAttribution?: TabSessionAttribution;
  readonly attributionHistory: readonly TabSessionAttribution[];
}

export interface TabSessionProjection {
  readonly schemaVersion: typeof TAB_SESSION_PROJECTION_SCHEMA_VERSION;
  readonly bySessionId: ReadonlyMap<string, TabSessionRecord>;
  readonly openSessionsByTabId: ReadonlyMap<string, string>;
}

export interface SerializedTabSessionProjection {
  readonly schemaVersion: typeof TAB_SESSION_PROJECTION_SCHEMA_VERSION;
  readonly bySessionId: Record<string, TabSessionRecord>;
  readonly openSessionsByTabId: Record<string, string>;
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

const compareAttribution = (left: TabSessionAttribution, right: TabSessionAttribution): number => {
  const precedence = (value: TabSessionAttribution): number =>
    value.source === 'inferred' ? 0 : 1;
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

const emptyProjection = (): TabSessionProjection => ({
  schemaVersion: TAB_SESSION_PROJECTION_SCHEMA_VERSION,
  bySessionId: new Map<string, TabSessionRecord>(),
  openSessionsByTabId: new Map<string, string>(),
});

export const createEmptyTabSessionProjection = (): TabSessionProjection => emptyProjection();

const upsertObservedSession = (
  records: Map<string, TabSessionRecord>,
  openSessionsByTabId: Map<string, string>,
  input: {
    readonly tabSessionId: string;
    readonly observedAt: string;
    readonly transition: string;
    readonly tabIdHash?: string;
    readonly openerTabSessionId?: string;
    readonly url?: string;
    readonly title?: string;
    readonly provider?: string;
  },
): void => {
  const existing = records.get(input.tabSessionId);
  if (existing !== undefined && existing.closedAt !== undefined && input.transition !== 'closed') {
    return;
  }

  const next: TabSessionRecord =
    existing === undefined
      ? {
          tabSessionId: input.tabSessionId,
          openedAt: input.observedAt,
          lastActivityAt: input.observedAt,
          ...(input.transition === 'closed' ? { closedAt: input.observedAt } : {}),
          ...(input.tabIdHash === undefined ? {} : { tabIdHash: input.tabIdHash }),
          ...(input.openerTabSessionId === undefined
            ? {}
            : { openerTabSessionId: input.openerTabSessionId }),
          ...(input.url === undefined ? {} : { latestUrl: input.url }),
          ...(input.title === undefined ? {} : { latestTitle: input.title }),
          ...(input.provider === undefined ? {} : { provider: input.provider }),
          attributionHistory: [],
        }
      : {
          ...existing,
          openedAt: input.observedAt < existing.openedAt ? input.observedAt : existing.openedAt,
          lastActivityAt:
            input.observedAt > existing.lastActivityAt ? input.observedAt : existing.lastActivityAt,
          ...(input.transition === 'closed'
            ? {
                closedAt:
                  existing.closedAt === undefined || input.observedAt > existing.closedAt
                    ? input.observedAt
                    : existing.closedAt,
              }
            : {}),
          ...(input.tabIdHash === undefined ? {} : { tabIdHash: input.tabIdHash }),
          ...(input.openerTabSessionId === undefined
            ? {}
            : { openerTabSessionId: input.openerTabSessionId }),
          ...(input.url === undefined ? {} : { latestUrl: input.url }),
          ...(input.title === undefined ? {} : { latestTitle: input.title }),
          ...(input.provider === undefined ? {} : { provider: input.provider }),
        };
  records.set(input.tabSessionId, next);

  if (input.tabIdHash === undefined) return;
  if (input.transition === 'closed') {
    if (openSessionsByTabId.get(input.tabIdHash) === input.tabSessionId) {
      openSessionsByTabId.delete(input.tabIdHash);
    }
    return;
  }
  if (next.closedAt === undefined) {
    openSessionsByTabId.set(input.tabIdHash, input.tabSessionId);
  }
};

const upsertAttribution = (
  records: Map<string, TabSessionRecord>,
  attribution: TabSessionAttribution & { readonly tabSessionId: string },
): void => {
  const existing = records.get(attribution.tabSessionId);
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
  records.set(attribution.tabSessionId, {
    tabSessionId: attribution.tabSessionId,
    openedAt: existing?.openedAt ?? fallbackObservedAt,
    lastActivityAt: existing?.lastActivityAt ?? fallbackObservedAt,
    ...(existing?.closedAt === undefined ? {} : { closedAt: existing.closedAt }),
    ...(existing?.tabIdHash === undefined ? {} : { tabIdHash: existing.tabIdHash }),
    ...(existing?.openerTabSessionId === undefined
      ? {}
      : { openerTabSessionId: existing.openerTabSessionId }),
    ...(existing?.latestUrl === undefined ? {} : { latestUrl: existing.latestUrl }),
    ...(existing?.latestTitle === undefined ? {} : { latestTitle: existing.latestTitle }),
    ...(existing?.provider === undefined ? {} : { provider: existing.provider }),
    ...(currentAttribution === undefined ? {} : { currentAttribution }),
    attributionHistory: history,
  });
};

export const projectTabSessions = (events: readonly AcceptedEvent[]): TabSessionProjection => {
  if (events.length === 0) return emptyProjection();
  const records = new Map<string, TabSessionRecord>();
  const openSessionsByTabId = new Map<string, string>();

  for (const event of [...events].sort(compareEventOrder)) {
    if (
      event.type === BROWSER_TIMELINE_OBSERVED &&
      isBrowserTimelineObservedPayload(event.payload)
    ) {
      const payload = event.payload;
      if (payload.tabSessionId === undefined || payload.tabSessionId.length === 0) continue;
      upsertObservedSession(records, openSessionsByTabId, {
        tabSessionId: payload.tabSessionId,
        observedAt: payload.observedAt,
        transition: payload.transition,
        ...(payload.tabIdHash === undefined ? {} : { tabIdHash: payload.tabIdHash }),
        ...(payload.openerTabSessionId === undefined
          ? {}
          : { openerTabSessionId: payload.openerTabSessionId }),
        url: payload.canonicalUrl ?? payload.url,
        ...(payload.title === undefined ? {} : { title: payload.title }),
        ...(payload.provider === undefined ? {} : { provider: payload.provider }),
      });
      continue;
    }

    if (event.type === USER_ORGANIZED_ITEM && isUserOrganizedItemPayload(event.payload)) {
      const payload = event.payload;
      if (payload.itemKind !== 'tab-session' || payload.action !== 'move') continue;
      upsertAttribution(records, {
        tabSessionId: payload.itemId,
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
      event.type === TAB_SESSION_ATTRIBUTION_INFERRED &&
      isTabSessionAttributionInferredPayload(event.payload)
    ) {
      upsertAttribution(records, {
        tabSessionId: event.payload.tabSessionId,
        workstreamId: event.payload.workstreamId,
        source: 'inferred',
        observedAt: isoFromAcceptedAt(event.acceptedAtMs),
        clientEventId: event.clientEventId,
        replicaId: event.dot.replicaId,
        seq: event.dot.seq,
      });
    }
  }

  return {
    schemaVersion: TAB_SESSION_PROJECTION_SCHEMA_VERSION,
    bySessionId: new Map(
      [...records.entries()].sort(([left], [right]) => compareString(left, right)),
    ),
    openSessionsByTabId: new Map(
      [...openSessionsByTabId.entries()].sort(([left], [right]) => compareString(left, right)),
    ),
  };
};

export const serializeTabSessionProjection = (
  projection: TabSessionProjection,
): SerializedTabSessionProjection => ({
  schemaVersion: projection.schemaVersion,
  bySessionId: Object.fromEntries(projection.bySessionId),
  openSessionsByTabId: Object.fromEntries(projection.openSessionsByTabId),
});

export const tabSessionInbox = (
  projection: TabSessionProjection,
  input: { readonly limit: number; readonly offset: number },
): readonly TabSessionRecord[] =>
  [...projection.bySessionId.values()]
    .filter((record) => record.closedAt === undefined && record.currentAttribution === undefined)
    .sort((left, right) => {
      if (left.lastActivityAt !== right.lastActivityAt) {
        return left.lastActivityAt < right.lastActivityAt ? 1 : -1;
      }
      return compareString(left.tabSessionId, right.tabSessionId);
    })
    .slice(input.offset, input.offset + input.limit);
