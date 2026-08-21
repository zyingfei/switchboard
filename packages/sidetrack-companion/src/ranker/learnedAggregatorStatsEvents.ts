// Adapter: AcceptedEvent stream -> AggregatorVisitObservation, the input
// shape learnedAggregatorStats.ts's accumulator consumes. Keeps that module
// free of event-log/visitId bookkeeping (its own header comment says why) —
// this is the one place that resolves NAVIGATION_COMMITTED's opener/
// previous visitId chain to a canonical URL.
//
// Requires events in roughly chronological order within one call (an
// opener's NAVIGATION_COMMITTED must precede its child's for the opener
// chain to resolve) — the same ordering assumption
// ranker/candidates.ts's collectVisitRecords already relies on for opener-
// chain candidates.

import { NAVIGATION_COMMITTED, isNavigationCommittedPayload } from '../navigation/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { BROWSER_TIMELINE_OBSERVED, isBrowserTimelineObservedPayload } from '../timeline/events.js';
import type { AggregatorVisitObservation } from './learnedAggregatorStats.js';

const normalizeCanonicalUrl = (url: string): string =>
  url.trim().replace(/#.*$/u, '').replace(/\/+$/u, '');

const parseTimestamp = (value: string): number | null => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

// Converts a batch of accepted events into observations, resolving each
// NAVIGATION_COMMITTED's opener/previous visitId against a visitId ->
// canonicalUrl map built from THIS SAME batch (no cross-call state — a
// batch that doesn't include the opener's own commit event simply yields an
// edge-less observation for the child, which is a safe under-count, never a
// false hub signal).
export const aggregatorObservationsFromEvents = (
  events: readonly AcceptedEvent[],
): readonly AggregatorVisitObservation[] => {
  const observations: AggregatorVisitObservation[] = [];
  const visitIdToCanonicalUrl = new Map<string, string>();

  for (const event of events) {
    if (event.type === NAVIGATION_COMMITTED && isNavigationCommittedPayload(event.payload)) {
      const canonicalUrl = normalizeCanonicalUrl(event.payload.canonicalUrl);
      if (canonicalUrl.length === 0 || event.payload.visitId.length === 0) continue;
      visitIdToCanonicalUrl.set(event.payload.visitId, canonicalUrl);
      const openerCanonicalUrl =
        event.payload.openerVisitId === null
          ? undefined
          : visitIdToCanonicalUrl.get(event.payload.openerVisitId);
      const previousCanonicalUrl =
        event.payload.previousVisitId === null
          ? undefined
          : visitIdToCanonicalUrl.get(event.payload.previousVisitId);
      // See learnedAggregatorStats.ts's "reachedFromHub edge-quality gating"
      // module-header note (FIX 1) — Chrome's own transitionType='link' is
      // the generic signal that this navigation was a genuine hyperlink
      // click on the source page, as opposed to typed/generated/form_submit/
      // keyword/reload/auto_bookmark/etc (a same-domain navigation with no
      // relationship to a link the source page displayed). Only meaningful
      // when an opener/previous edge is actually present above.
      const reachedViaLinkClick = event.payload.transitionType === 'link';
      observations.push({
        canonicalUrl,
        observedAtMs: event.payload.commitTimestamp,
        ...(openerCanonicalUrl === undefined ? {} : { openerCanonicalUrl }),
        ...(previousCanonicalUrl === undefined ? {} : { previousCanonicalUrl }),
        ...(openerCanonicalUrl === undefined && previousCanonicalUrl === undefined
          ? {}
          : { reachedViaLinkClick }),
      });
      continue;
    }

    if (event.type === BROWSER_TIMELINE_OBSERVED && isBrowserTimelineObservedPayload(event.payload)) {
      const rawUrl = event.payload.canonicalUrl ?? event.payload.url;
      const canonicalUrl = normalizeCanonicalUrl(rawUrl);
      if (canonicalUrl.length === 0) continue;
      observations.push({
        canonicalUrl,
        observedAtMs: parseTimestamp(event.payload.observedAt) ?? event.acceptedAtMs,
        ...(event.payload.title === undefined || event.payload.title.length === 0
          ? {}
          : { title: event.payload.title }),
      });
    }
  }

  return observations;
};
