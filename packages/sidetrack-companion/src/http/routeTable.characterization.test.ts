// Stage S1 (strict-discipline refactor safety net) — PIN the HTTP route
// table's ORDER and SHAPE before a single route leaves server.ts.
//
// Dispatch is `routes.find((candidate) => candidate.method === method &&
// candidate.pattern.test(pathname))` (see `handleRequest` below in
// server.ts): the FIRST pattern that matches wins. That makes array order
// part of the route's observable behavior, not an implementation detail —
// and this table has REAL overlaps that depend on it. For example,
// `GET ^\/v1\/review-drafts\/changes$` (a literal path) is declared ahead
// of `GET ^\/v1\/review-drafts\/(?<bacId>[A-Za-z0-9_-]+)$` (a bare capture
// group), and the literal string "changes" itself satisfies the capture
// group's own `[A-Za-z0-9_-]+` character class. Swap those two entries and
// a GET to /v1/review-drafts/changes silently stops listing changes and
// starts being served as "fetch the single review draft whose id is
// changes" — no type error, no thrown exception, just the wrong handler
// answering. A route-extraction pass that moves handler bodies between
// files but reassembles the route objects in a different order would
// reproduce exactly that class of bug, silently.
//
// The literal list below is GENERATED, not hand-typed: produced by
// iterating the live `routes` export and printing
// `${route.method} ${route.pattern.source}` for each entry, in order, then
// pasting the output verbatim. When this pin legitimately needs to move (a
// route added, removed, or deliberately reordered), regenerate it the same
// way and diff — never hand-edit individual lines, since a typo here is
// indistinguishable from a real behavior change.
import { describe, expect, it } from 'vitest';

import { routes } from './server.js';

describe('HTTP route table characterization (stage S1 pin)', () => {
  it('pins the exact ordered "METHOD pattern.source" list — order is dispatch behavior', () => {
    const actual = routes.map((route) => `${route.method} ${route.pattern.source}`);
    expect(actual).toEqual([
      'GET ^\\/v1\\/health$',
      'GET ^\\/v1\\/version$',
      'GET ^\\/v1\\/status$',
      'GET ^\\/v1\\/vault\\/changes$',
      'GET ^\\/v1\\/privacy\\/projection$',
      'POST ^\\/v1\\/privacy\\/events$',
      'POST ^\\/v1\\/privacy\\/domain-tombstone$',
      'POST ^\\/v1\\/feedback\\/events$',
      'GET ^\\/v1\\/feedback\\/projection$',
      'GET ^\\/v1\\/tabsessions\\/projection$',
      'GET ^\\/v1\\/tabsessions\\/inbox$',
      'GET ^\\/v1\\/tabsessions\\/(?<tabSessionId>[^/]+)\\/resolve$',
      'POST ^\\/v1\\/tabsessions\\/(?<tabSessionId>[^/]+)\\/resolve$',
      'POST ^\\/v1\\/tabsessions\\/(?<tabSessionId>[^/]+)\\/attribute$',
      'GET ^\\/v1\\/visits\\/projection$',
      'GET ^\\/v1\\/visits\\/inbox$',
      'GET ^\\/v1\\/visits\\/(?<canonicalUrl>[^/]+)\\/resolve$',
      'POST ^\\/v1\\/visits\\/batch-resolve$',
      'POST ^\\/v1\\/visits\\/(?<canonicalUrl>[^/]+)\\/resolve$',
      'POST ^\\/v1\\/visits\\/(?<canonicalUrl>[^/]+)\\/attribute$',
      'POST ^\\/v1\\/visits\\/(?<canonicalUrl>[^/]+)\\/ignore$',
      'GET ^\\/v1\\/system\\/service-status$',
      'POST ^\\/v1\\/system\\/install-service$',
      'POST ^\\/v1\\/system\\/uninstall-service$',
      'GET ^\\/v1\\/system\\/update-check$',
      'POST ^\\/v1\\/system\\/auto-update$',
      'GET ^\\/v1\\/system\\/health$',
      'GET ^\\/v1\\/system\\/hygiene-status$',
      'GET ^\\/v1\\/system\\/vault-ledger$',
      'GET ^\\/v1\\/system\\/focus-health$',
      'GET ^\\/v1\\/system\\/section15$',
      'GET ^\\/v1\\/system\\/reliability$',
      'POST ^\\/v1\\/system\\/tab-recovery$',
      'POST ^\\/v1\\/auth\\/rotate-bridge-key$',
      'GET ^\\/v1\\/buckets$',
      'GET ^\\/v1\\/collectors$',
      'POST ^\\/v1\\/collectors\\/(?<collectorId>[a-z0-9.-]+)\\/replay$',
      'PUT ^\\/v1\\/buckets$',
      'GET ^\\/v1\\/settings$',
      'GET ^\\/v1\\/settings\\/export$',
      'POST ^\\/v1\\/settings\\/import$',
      'PATCH ^\\/v1\\/settings$',
      'POST ^\\/v1\\/dispatches$',
      'GET ^\\/v1\\/dispatches$',
      'POST ^\\/v1\\/dispatches\\/(?<bacId>[A-Za-z0-9_-]+)\\/link$',
      'GET ^\\/v1\\/dispatches\\/projection$',
      'GET ^\\/v1\\/dispatches\\/(?<bacId>[A-Za-z0-9_-]+)\\/link$',
      'GET ^\\/v1\\/dispatches\\/(?<bacId>[A-Za-z0-9_-]+)\\/await-capture$',
      'GET ^\\/v1\\/audit$',
      'GET ^\\/v1\\/turns$',
      'POST ^\\/v1\\/reviews$',
      'GET ^\\/v1\\/reviews$',
      'GET ^\\/v1\\/review-drafts$',
      'GET ^\\/v1\\/review-drafts\\/changes$',
      'GET ^\\/v1\\/review-drafts\\/(?<bacId>[A-Za-z0-9_-]+)$',
      'POST ^\\/v1\\/review-drafts\\/(?<bacId>[A-Za-z0-9_-]+)\\/events$',
      'DELETE ^\\/v1\\/review-drafts\\/(?<bacId>[A-Za-z0-9_-]+)$',
      'POST ^\\/v1\\/annotations$',
      'GET ^\\/v1\\/annotations$',
      'PATCH ^\\/v1\\/annotations\\/(?<annotationId>[A-Za-z0-9_-]+)$',
      'DELETE ^\\/v1\\/annotations\\/(?<annotationId>[A-Za-z0-9_-]+)$',
      'GET ^\\/v1\\/annotations\\/projection$',
      'GET ^\\/v1\\/annotations\\/(?<bacId>[A-Za-z0-9_-]+)\\/projection$',
      'GET ^\\/v1\\/dispatches\\/(?<bacId>[A-Za-z0-9_-]+)\\/projection$',
      'POST ^\\/v1\\/recall\\/index$',
      'GET ^\\/v1\\/recall\\/query$',
      'POST ^\\/v1\\/page-content\\/extracted$',
      'GET ^\\/v1\\/page-evidence\\/summary(?:\\?.*)?$',
      'GET ^\\/v1\\/page-content\\/text(?:\\?.*)?$',
      'POST ^\\/v1\\/page-evidence\\/extracted$',
      'POST ^\\/v1\\/page-content\\/tombstone$',
      'POST ^\\/v1\\/page-content\\/recanonicalize$',
      'GET ^\\/v1\\/page-content\\/coverage(?:\\?.*)?$',
      'POST ^\\/v2\\/recall$',
      'POST ^\\/v1\\/models\\/(?<modelOrg>[^/]+)\\/(?<modelRepo>[^/]+)\\/fetch$',
      'GET ^\\/v1\\/models\\/(?<modelOrg>[^/]+)\\/(?<modelRepo>[^/]+)\\/fetch$',
      'POST ^\\/v1\\/enrichment\\/titles$',
      'POST ^\\/v1\\/enrichment\\/content$',
      'POST ^\\/v1\\/enrichment\\/retract$',
      'GET ^\\/v1\\/entities$',
      'GET ^\\/v1\\/entities\\/(?<entityName>[^/]+)$',
      'POST ^\\/v1\\/recall\\/action$',
      'POST ^\\/v1\\/recall\\/rebuild$',
      'POST ^\\/v1\\/recall\\/gc$',
      'GET ^\\/v1\\/suggestions\\/thread\\/(?<threadId>[A-Za-z0-9_-]+)$',
      'POST ^\\/v1\\/events$',
      'POST ^\\/v1\\/threads$',
      'GET ^\\/v1\\/threads$',
      'GET ^\\/v1\\/threads\\/(?<bacId>[A-Za-z0-9_-]+)\\/projection$',
      'GET ^\\/v1\\/threads\\/(?<bacId>[A-Za-z0-9_-]+)\\/markdown$',
      'POST ^\\/v1\\/threads\\/(?<bacId>[A-Za-z0-9_-]+)\\/export$',
      'POST ^\\/v1\\/threads\\/(?<bacId>[A-Za-z0-9_-]+)\\/archive$',
      'POST ^\\/v1\\/threads\\/(?<bacId>[A-Za-z0-9_-]+)\\/unarchive$',
      'POST ^\\/v1\\/workstreams$',
      'GET ^\\/v1\\/workstreams\\/projections$',
      'GET ^\\/v1\\/workstreams\\/(?<bacId>[A-Za-z0-9_-]+)\\/projection$',
      'GET ^\\/v1\\/workstreams\\/(?<bacId>[A-Za-z0-9_-]+)\\/markdown$',
      'POST ^\\/v1\\/workstreams\\/(?<bacId>[A-Za-z0-9_-]+)\\/export$',
      'GET ^\\/v1\\/workstreams\\/(?<workstreamId>[A-Za-z0-9_-]+)\\/trust$',
      'PUT ^\\/v1\\/workstreams\\/(?<workstreamId>[A-Za-z0-9_-]+)\\/trust$',
      'POST ^\\/v1\\/workstreams\\/(?<bacId>[A-Za-z0-9_-]+)\\/bump$',
      'PATCH ^\\/v1\\/workstreams\\/(?<workstreamId>[A-Za-z0-9_-]+)$',
      'DELETE ^\\/v1\\/workstreams\\/(?<workstreamId>[A-Za-z0-9_-]+)$',
      'GET ^\\/v1\\/workstreams\\/(?<workstreamId>[A-Za-z0-9_-]+)\\/linked-notes$',
      'POST ^\\/v1\\/queue$',
      'GET ^\\/v1\\/queue\\/(?<bacId>[A-Za-z0-9_-]+)\\/projection$',
      'POST ^\\/v1\\/reminders$',
      'PATCH ^\\/v1\\/reminders\\/(?<reminderId>[A-Za-z0-9_-]+)$',
      'POST ^\\/v1\\/coding-sessions\\/attach-tokens$',
      'POST ^\\/v1\\/coding-sessions$',
      'GET ^\\/v1\\/coding-sessions$',
      'DELETE ^\\/v1\\/coding-sessions\\/(?<codingSessionId>[A-Za-z0-9_-]+)$',
      'POST ^\\/v1\\/timeline\\/events$',
      'POST ^\\/v1\\/edge\\/events$',
      'GET ^\\/v1\\/timeline(?:\\?.*)?$',
      'POST ^\\/v1\\/connections\\/ranker\\/retrain$',
      'POST ^\\/v1\\/ranker\\/impression-bootstrap$',
      'GET ^\\/v1\\/connections(?:\\?.*)?$',
      'GET ^\\/v1\\/connections\\/nodes\\/(?<connectionsNodeId>[^/?]+)\\/neighbors(?:\\?.*)?$',
      'GET ^\\/v1\\/connections\\/edges\\/(?<connectionsEdgeId>[^/?]+)(?:\\?.*)?$',
      'GET ^\\/v1\\/connections\\/path(?:\\?.*)?$',
      'POST ^\\/v1\\/debug\\/dump$',
    ]);
  });

  it('pins that every route declares authRequired — the audit-trail contract', () => {
    // RouteDefinition.authRequired is documented, on the interface itself,
    // as "intent only" — the actual pre-route-match gate is the
    // PUBLIC_UNAUTHENTICATED_PATHS allowlist, not this field — but it's
    // kept anyway to "stay a reliable audit reference". `routes` being
    // typed `readonly RouteDefinition[]` already makes a MISSING field a
    // compile error today, so this assertion is not catching a live bug;
    // it's a trip-wire for the NEXT stages, which extract route modules
    // and reassemble them — exactly the kind of mechanical reshuffling
    // that can widen a type, drop a spread key, or paper over a gap with
    // an `as` cast without any single line looking wrong in review. Pin
    // the runtime fact now so a regression during extraction fails a test
    // instead of quietly rotting the audit trail this field promises.
    for (const route of routes) {
      expect(
        typeof route.authRequired,
        `${route.method} ${route.pattern.source} is missing authRequired`,
      ).toBe('boolean');
    }
  });
});
