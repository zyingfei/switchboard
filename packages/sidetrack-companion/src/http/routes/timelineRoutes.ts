// Timeline routes: timeline-event ingestion, edge-event ingestion, and the timeline read.
//
// Extracted verbatim from server.ts in stage S2 of the cost-of-change
// refactor; order within this array is dispatch order and is pinned by
// routeTable.characterization.test.ts.

import { ENGAGEMENT_INTERVAL_OBSERVED, ENGAGEMENT_SESSION_AGGREGATED, isEngagementIntervalObservedPayload, isEngagementSessionAggregatedPayload } from '../../engagement/events.js';
import { NAVIGATION_COMMITTED, isNavigationCommittedPayload } from '../../navigation/events.js';
import { SELECTION_COPIED, SELECTION_PASTED, isSelectionCopiedPayload, isSelectionPastedPayload } from '../../snippets/events.js';
import type { AcceptedEvent } from '../../sync/causal.js';
import { BROWSER_TIMELINE_OBSERVED, isBrowserTimelineObservedPayload } from '../../timeline/events.js';
import { sanitizeTimelinePayload } from '../../timeline/sanitize.js';
import { VISUAL_FINGERPRINT_OBSERVED, isVisualFingerprintObservedPayload } from '../../visual/events.js';

import { HttpRouteError, domainTombstoneSetFor, readBody } from '../routeSupport.js';
import type { RouteDefinition } from '../routeSupport.js';

export const timelineRoutes: readonly RouteDefinition[] = [
  // Sync Contract v1 — timeline (Class F + Class B) routes.
  //
  // POST /v1/timeline/events — imports plugin-originated edge events
  // (browser.timeline.observed). The plugin allocates the edge dot;
  // the companion does NOT restamp. importEdgeEvent runs the
  // accepted event through the contract runner so the timeline
  // materializer rebuilds the affected day projection.
  //
  // GET /v1/timeline — returns the daily-bucketed projection. Range
  // filtered by `since` / `until` (UTC ISO timestamps); plain
  // substring filter on `q` (matches title or url). Always returns
  // a ScopedResult-shaped envelope with `scope: 'companion-extended'`.
  {
    method: 'POST',
    pattern: /^\/v1\/timeline\/events$/u,
    authRequired: true,
    handle: async (request, requestId, _match, context) => {
      if (context.importEdgeEvent === undefined) {
        throw new HttpRouteError(503, 'TIMELINE_NOT_WIRED', 'Timeline import is not configured.');
      }
      const body = (await readBody(request)) as { events?: unknown };
      if (body === null || typeof body !== 'object' || !Array.isArray(body.events)) {
        throw new HttpRouteError(
          400,
          'INVALID_REQUEST',
          'Body must be { events: AcceptedEvent[] }.',
        );
      }
      const imported: { replicaId: string; seq: number }[] = [];
      const skipped: (
        | { replicaId: string; seq: number; reason: string }
        | { status: 'duplicate-in-batch'; clientEventId: string; droppedAt: number }
      )[] = [];
      const recordImported = (event: import('../../sync/causal.js').AcceptedEvent): void => {
        imported.push({ replicaId: event.dot.replicaId, seq: event.dot.seq });
      };
      const recordSkipped = (
        event: import('../../sync/causal.js').AcceptedEvent,
        reason: string,
      ): void => {
        skipped.push({ replicaId: event.dot.replicaId, seq: event.dot.seq, reason });
      };
      // Validate + sanitize every candidate first, collecting the
      // accepted ones, so the import can run as ONE batched dedupe
      // pass instead of a per-event whole-log scan (the per-event
      // path made multi-event POSTs run 0.4-3.4 s).
      const valid: import('../../sync/causal.js').AcceptedEvent[] = [];
      const seenClientEventIds = new Set<string>();
      for (const [index, candidate] of body.events.entries()) {
        if (
          candidate === null ||
          typeof candidate !== 'object' ||
          typeof (candidate as { type?: unknown }).type !== 'string' ||
          typeof (candidate as { dot?: unknown }).dot !== 'object' ||
          (candidate as { dot?: { replicaId?: unknown } }).dot === null
        ) {
          continue;
        }
        const event = candidate as import('../../sync/causal.js').AcceptedEvent;
        // Reviewer-flagged: this endpoint is timeline-only. Reject
        // any event whose type is not browser.timeline.observed OR
        // whose payload fails the runtime predicate. Engagement /
        // selection / visual-fingerprint events go through the
        // companion's `/v1/edge/events` route (defined below).
        if (event.type !== BROWSER_TIMELINE_OBSERVED) {
          recordSkipped(event, 'invalid-event-type');
          continue;
        }
        if (!isBrowserTimelineObservedPayload(event.payload)) {
          recordSkipped(event, 'invalid-payload');
          continue;
        }
        // Reviewer-flagged defense-in-depth: sanitize URLs BEFORE
        // the event is appended. The plugin observer already
        // sanitizes outgoing URLs, but this route accepts events
        // from any caller with the bridge key (older plugin builds,
        // archive-import path, …). Once the event lands in the
        // immutable log we can't strip auth tokens out — this is
        // the last opportunity. We construct a new event with the
        // sanitized payload (preserving the edge dot + clientEventId
        // so importPeerEvent dedupe still works).
        const sanitizedPayload = sanitizeTimelinePayload(event.payload);
        const sanitized =
          sanitizedPayload === event.payload ? event : { ...event, payload: sanitizedPayload };
        if (seenClientEventIds.has(sanitized.clientEventId)) {
          skipped.push({
            status: 'duplicate-in-batch',
            clientEventId: sanitized.clientEventId,
            droppedAt: index,
          });
          continue;
        }
        seenClientEventIds.add(sanitized.clientEventId);
        valid.push(sanitized);
      }
      // Batched ingest — ONE readMerged dedupe for the whole POST.
      // importTimelineEvents dispatches each accepted event to the
      // contract runner (timeline/projection materializers are
      // event-driven), exactly like the per-event path. Falls back
      // to per-event importEdgeEvent when the batched importer is
      // not wired (tests / programmatic startCompanion callers).
      if (context.importTimelineEvents !== undefined && valid.length > 0) {
        const byClientEventId = new Map(valid.map((event) => [event.clientEventId, event]));
        try {
          const results = await context.importTimelineEvents(valid);
          for (const result of results) {
            const event = byClientEventId.get(result.clientEventId);
            if (event === undefined) continue;
            if (result.imported) recordImported(event);
            else recordSkipped(event, 'already-imported');
          }
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          for (const event of valid) recordSkipped(event, reason);
        }
      } else {
        for (const event of valid) {
          try {
            const result = await context.importEdgeEvent(event);
            if (result.imported) recordImported(event);
            else recordSkipped(event, 'already-imported');
          } catch (err) {
            recordSkipped(event, err instanceof Error ? err.message : String(err));
          }
        }
      }
      void requestId;
      return [200, { data: { imported, skipped } }];
    },
  },
  // POST /v1/edge/events — generic ingest route for plugin-originated
  // edge events that are NOT timeline observations: engagement
  // (interval + session aggregated), selection (copied + pasted),
  // visual fingerprint. The plugin's edge-event buffer drains here on
  // its 1-minute alarm; pre-fix this route returned 404 and engagement
  // events accumulated in the plugin's IndexedDB forever, starving
  // similarity edges, URL inference, and the ranker. Same import +
  // dedupe pipeline as /v1/timeline/events, narrowed to the set of
  // event types this route accepts.
  {
    method: 'POST',
    pattern: /^\/v1\/edge\/events$/u,
    authRequired: true,
    handle: async (request, requestId, _match, context) => {
      if (context.importEdgeEvent === undefined) {
        throw new HttpRouteError(
          503,
          'EDGE_EVENTS_NOT_WIRED',
          'Edge event import is not configured.',
        );
      }
      const body = (await readBody(request)) as { events?: unknown };
      if (body === null || typeof body !== 'object' || !Array.isArray(body.events)) {
        throw new HttpRouteError(
          400,
          'INVALID_REQUEST',
          'Body must be { events: AcceptedEvent[] }.',
        );
      }
      // Single source of truth for what `/v1/edge/events` accepts.
      // Previously a parallel `ACCEPTED_EDGE_EVENT_TYPES` Set plus a
      // `validatePayload` switch could drift (each new event type
      // needed two synchronized edits — that's how navigation.committed
      // shipped without a validator entry). One Map; adding a type
      // means one entry, period.
      const EDGE_EVENT_VALIDATORS = new Map<string, (payload: unknown) => boolean>([
        [ENGAGEMENT_INTERVAL_OBSERVED, isEngagementIntervalObservedPayload],
        [ENGAGEMENT_SESSION_AGGREGATED, isEngagementSessionAggregatedPayload],
        [SELECTION_COPIED, isSelectionCopiedPayload],
        [SELECTION_PASTED, isSelectionPastedPayload],
        [VISUAL_FINGERPRINT_OBSERVED, isVisualFingerprintObservedPayload],
        [NAVIGATION_COMMITTED, isNavigationCommittedPayload],
      ]);
      const isAcceptedEdgeEventType = (type: string): boolean => EDGE_EVENT_VALIDATORS.has(type);
      const validatePayload = (type: string, payload: unknown): boolean =>
        EDGE_EVENT_VALIDATORS.get(type)?.(payload) ?? false;
      const imported: { replicaId: string; seq: number }[] = [];
      const skipped: { replicaId: string; seq: number; reason: string }[] = [];
      const valid: import('../../sync/causal.js').AcceptedEvent[] = [];
      for (const candidate of body.events) {
        if (
          candidate === null ||
          typeof candidate !== 'object' ||
          typeof (candidate as { type?: unknown }).type !== 'string' ||
          typeof (candidate as { dot?: unknown }).dot !== 'object' ||
          (candidate as { dot?: { replicaId?: unknown } }).dot === null
        ) {
          continue;
        }
        const event = candidate as import('../../sync/causal.js').AcceptedEvent;
        if (!isAcceptedEdgeEventType(event.type)) {
          skipped.push({
            replicaId: event.dot.replicaId,
            seq: event.dot.seq,
            reason: 'invalid-event-type',
          });
          continue;
        }
        if (!validatePayload(event.type, event.payload)) {
          skipped.push({
            replicaId: event.dot.replicaId,
            seq: event.dot.seq,
            reason: 'invalid-payload',
          });
          continue;
        }
        valid.push(event);
      }
      void requestId;
      // P2 — batch the whole flush: ONE readMerged + dedupe + shard
      // write, vs ~3 whole-log scans PER event (the 39s-on-backlog
      // quadratic). Fallback to the per-event path when the batch
      // dep isn't wired (tests / programmatic startCompanion users).
      const recordResult = (
        event: import('../../sync/causal.js').AcceptedEvent,
        wasImported: boolean,
      ): void => {
        if (wasImported) {
          imported.push({ replicaId: event.dot.replicaId, seq: event.dot.seq });
        } else {
          skipped.push({
            replicaId: event.dot.replicaId,
            seq: event.dot.seq,
            reason: 'already-imported',
          });
        }
      };
      const recordError = (
        event: import('../../sync/causal.js').AcceptedEvent,
        err: unknown,
      ): void => {
        skipped.push({
          replicaId: event.dot.replicaId,
          seq: event.dot.seq,
          reason: err instanceof Error ? err.message : String(err),
        });
      };
      if (context.importEdgeEvents !== undefined) {
        try {
          const res = await context.importEdgeEvents(valid);
          const importedById = new Map(res.map((r) => [r.clientEventId, r.imported]));
          for (const event of valid) {
            recordResult(event, importedById.get(event.clientEventId) === true);
          }
        } catch (err) {
          for (const event of valid) recordError(event, err);
        }
      } else {
        for (const event of valid) {
          try {
            const result = await context.importEdgeEvent!(event);
            recordResult(event, result.imported);
          } catch (err) {
            recordError(event, err);
          }
        }
      }
      return [200, { data: { imported, skipped } }];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/timeline(?:\?.*)?$/u,
    authRequired: true,
    handle: async (request, requestId, _match, context) => {
      if (context.timelineStore === undefined) {
        throw new HttpRouteError(
          503,
          'TIMELINE_NOT_WIRED',
          'Timeline projection is not configured.',
        );
      }
      const url = new URL(request.url ?? '/v1/timeline', 'http://internal');
      const sinceRaw = url.searchParams.get('since') ?? undefined;
      const untilRaw = url.searchParams.get('until') ?? undefined;
      // Normalize date-only inputs (YYYY-MM-DD) to ISO timestamps:
      // since=date → start-of-day; until=date → end-of-day. Without
      // this, an entry's full ISO timestamp would lex-compare
      // greater than the bare date prefix and get excluded
      // incorrectly. With explicit ISO inputs we leave the value
      // alone — "exact" filtering at the timestamp level.
      const isDateOnly = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s);
      const since =
        sinceRaw === undefined
          ? undefined
          : isDateOnly(sinceRaw)
            ? `${sinceRaw}T00:00:00.000Z`
            : sinceRaw;
      const until =
        untilRaw === undefined
          ? undefined
          : isDateOnly(untilRaw)
            ? `${untilRaw}T23:59:59.999Z`
            : untilRaw;
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
      const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '100', 10);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : 100;

      // Privacy gate — exclude visits whose domain has been tombstoned
      // via a no-capture-rule purge. Read boundary filter only (the raw
      // JSONL log is untouched); serving math is unaffected.
      const tombstones = await domainTombstoneSetFor(context);
      const days = await context.timelineStore.listDays();
      // Day-bucket coarse filter — picks files we need to open.
      const inRange = days.filter((d) => {
        if (since !== undefined && d < since.slice(0, 10)) return false;
        if (until !== undefined && d > until.slice(0, 10)) return false;
        return true;
      });
      const items: {
        readonly date: string;
        readonly id: string;
        readonly firstSeenAt: string;
        readonly lastSeenAt: string;
        readonly url: string;
        readonly canonicalUrl?: string;
        readonly title?: string;
        readonly provider?: string;
        readonly visitCount: number;
      }[] = [];
      // Reviewer F6: also apply EXACT timestamp filtering. The
      // day-bucket filter above is only a coarse pass that picks
      // which files to open. An entry on the boundary day might
      // straddle the requested range — we include it if its
      // [firstSeenAt, lastSeenAt] window overlaps [since, until].
      // Without this, since=2026-05-07T12:00:00Z would still
      // return entries from 09:00 the same day.
      const overlapsRange = (entry: { firstSeenAt: string; lastSeenAt: string }): boolean => {
        if (since !== undefined && entry.lastSeenAt < since) return false;
        if (until !== undefined && entry.firstSeenAt > until) return false;
        return true;
      };
      // Walk newest-day first so we hit the limit on recent
      // entries.
      for (const date of [...inRange].reverse()) {
        const day = await context.timelineStore.readDay(date);
        if (day === null) continue;
        for (const entry of day.entries) {
          if (!overlapsRange(entry)) continue;
          // Domain-tombstone privacy gate — drop purged domains.
          if (
            !tombstones.isEmpty &&
            tombstones.matchesPage({
              url: entry.url,
              ...(entry.title === undefined ? {} : { title: entry.title }),
            })
          ) {
            continue;
          }
          if (q.length > 0) {
            const hay = `${entry.title ?? ''} ${entry.url}`.toLowerCase();
            if (!hay.includes(q)) continue;
          }
          items.push({ date, ...entry });
          if (items.length >= limit) break;
        }
        if (items.length >= limit) break;
      }
      void requestId;
      return [
        200,
        {
          data: {
            scope: 'companion-extended',
            items,
            entryCount: items.length,
          },
        },
      ];
    },
  },
];
