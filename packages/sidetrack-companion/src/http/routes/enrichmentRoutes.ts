// Enrichment routes: on-device title/content enrichment and retraction.
//
// Extracted verbatim from server.ts in stage S2 of the cost-of-change
// refactor; order within this array is dispatch order and is pinned by
// routeTable.characterization.test.ts.

import { appendContentEnrichmentEvent, type EntityContentEnrichedPayload } from '../../enrichment/contentEnrichment.js';
import { appendEnrichmentRetractionEvent } from '../../enrichment/enrichmentRetraction.js';
import type { EnrichmentFamily, EntityEnrichmentRetractedPayload } from '../../enrichment/events.js';
import { appendEnrichmentEvent, titleEnrichmentEnabled, type EntityTitleEnrichedKind, type EntityTitleEnrichedPayload } from '../../enrichment/titleEnrichment.js';

import { HttpRouteError, readBody } from '../routeSupport.js';
import type { RouteDefinition } from '../routeSupport.js';

export const enrichmentRoutes: readonly RouteDefinition[] = [
  {
    // Title enrichment — POST /v1/enrichment/titles. The panel synthesizes
    // descriptive titles ON-DEVICE (Gemini Nano) for junk-titled entities
    // (chat threads titled "ChatGPT", visits whose only "title" is the URL)
    // and POSTs a batch here. Each ACCEPTED item appends one
    // ENTITY_TITLE_ENRICHED event; the served overlay is DERIVED by folding
    // those events at the title seams (titleForCanonicalUrl, url/thread
    // projections, recall FTS) — never a mutable side table.
    //
    // FROZEN CONTRACT: { items: [{ kind, id, synthesizedTitle,
    // sourceContentHash, model, generatedAt }] } → 200 { accepted, skipped }.
    // ≤50 items/request; item-level problems are SKIPPED (counted), never a
    // 400 (only a non-object body / non-array items is a 400). Idempotent per
    // (kind,id,sourceContentHash): the clientEventId is a deterministic hash
    // of that triple, so re-posting the same hash returns the existing event
    // and is counted as `skipped`; a new hash for the same (kind,id)
    // supersedes.
    //
    // KILL SWITCH SIDETRACK_TITLE_ENRICHMENT (default ON): '0'/'false'
    // disables ingestion — the route 200s with { accepted: 0, skipped: n,
    // disabled: true } and appends nothing (the overlay is disabled in the
    // same flag).
    method: 'POST',
    pattern: /^\/v1\/enrichment\/titles$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const eventLog = context.eventLog;
      if (eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'event log not configured for this companion',
        );
      }
      const body = await readBody(request);
      const items =
        typeof body === 'object' && body !== null && Array.isArray((body as { items?: unknown }).items)
          ? (body as { items: readonly unknown[] }).items
          : null;
      if (items === null) {
        throw new HttpRouteError(
          400,
          'VALIDATION_ERROR',
          'Validation failed.',
          'Body must be an object with an `items` array.',
        );
      }
      // ≤50 items/request. Over-cap requests are truncated (the excess is
      // counted as skipped) rather than 400'd — tolerant + additive, same
      // posture as the titleHints cap.
      const MAX_ENRICHMENT_ITEMS = 50;
      const overCap = Math.max(0, items.length - MAX_ENRICHMENT_ITEMS);
      const considered = items.slice(0, MAX_ENRICHMENT_ITEMS);

      // Flag off: accept the request, persist nothing. Everything (incl. the
      // over-cap remainder) counts as skipped so the panel sees its POST was
      // received but no-op'd.
      if (!titleEnrichmentEnabled()) {
        return [
          200,
          { data: { accepted: 0, skipped: items.length, disabled: true } },
        ];
      }

      let accepted = 0;
      let skipped = overCap;
      for (const raw of considered) {
        // Build a candidate payload and validate it with the SAME guard the
        // fold uses (single source of truth for "what is a valid enrichment").
        if (typeof raw !== 'object' || raw === null) {
          skipped += 1;
          continue;
        }
        const item = raw as Record<string, unknown>;
        const candidate: EntityTitleEnrichedPayload = {
          payloadVersion: 1,
          kind: item['kind'] as EntityTitleEnrichedKind,
          id: item['id'] as string,
          synthesizedTitle: item['synthesizedTitle'] as string,
          sourceContentHash: item['sourceContentHash'] as string,
          model: item['model'] as string,
          generatedAt: item['generatedAt'] as string,
        };
        // Hand the candidate to the shared idempotent append helper — the
        // SAME path the companion-side title sweep uses, so the two producers
        // never drift on the payload guard, the (kind,id,sourceContentHash)
        // idempotency key, or the aggregate grouping. A guard failure /
        // duplicate hash / durable-write failure all count as skipped; the
        // batch never fails on one bad item.
        const outcome = await appendEnrichmentEvent(eventLog, candidate);
        if (outcome === 'accepted') accepted += 1;
        else skipped += 1;
      }
      return [200, { data: { accepted, skipped } }];
    },
  },
  {
    // Content enrichment — POST /v1/enrichment/content. Sibling of the titles
    // route. The panel synthesizes a paragraph-scale GIST on-device (WebGPU)
    // for an entity and POSTs a batch here. Each ACCEPTED item appends one
    // ENTITY_CONTENT_ENRICHED event; the served surface is DERIVED by folding
    // those events (contentEnrichment.ts) and injecting the gist into the
    // recall lexical (FTS) index + the content lane's embed text — never a
    // mutable side table.
    //
    // FROZEN CONTRACT: { items: [{ kind, id, gist, sourceContentHash, model,
    // generatedAt }] } → 200 { accepted, skipped }. Same discipline as titles:
    // ≤50 items/request; item-level problems are SKIPPED (counted), never a
    // 400 (only a non-object body / non-array items is a 400). Idempotent per
    // (kind,id,sourceContentHash) via the SHARED enrichmentClientEventId helper
    // (family='content', so its keys never collide with a title event's keys).
    //
    // KILL SWITCH SIDETRACK_TITLE_ENRICHMENT (default ON): the SAME flag that
    // governs title enrichment now governs enrichment ingestion AS A WHOLE
    // (title + content). '0'/'false' disables — the route 200s with
    // { accepted: 0, skipped: n, disabled: true } and appends nothing.
    method: 'POST',
    pattern: /^\/v1\/enrichment\/content$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const eventLog = context.eventLog;
      if (eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'event log not configured for this companion',
        );
      }
      const body = await readBody(request);
      const items =
        typeof body === 'object' && body !== null && Array.isArray((body as { items?: unknown }).items)
          ? (body as { items: readonly unknown[] }).items
          : null;
      if (items === null) {
        throw new HttpRouteError(
          400,
          'VALIDATION_ERROR',
          'Validation failed.',
          'Body must be an object with an `items` array.',
        );
      }
      const MAX_ENRICHMENT_ITEMS = 50;
      const overCap = Math.max(0, items.length - MAX_ENRICHMENT_ITEMS);
      const considered = items.slice(0, MAX_ENRICHMENT_ITEMS);

      // Flag off: accept the request, persist nothing. Everything (incl. the
      // over-cap remainder) counts as skipped.
      if (!titleEnrichmentEnabled()) {
        return [200, { data: { accepted: 0, skipped: items.length, disabled: true } }];
      }

      let accepted = 0;
      let skipped = overCap;
      for (const raw of considered) {
        if (typeof raw !== 'object' || raw === null) {
          skipped += 1;
          continue;
        }
        const item = raw as Record<string, unknown>;
        const candidate: EntityContentEnrichedPayload = {
          payloadVersion: 1,
          kind: item['kind'] as EntityTitleEnrichedKind,
          id: item['id'] as string,
          gist: item['gist'] as string,
          sourceContentHash: item['sourceContentHash'] as string,
          model: item['model'] as string,
          generatedAt: item['generatedAt'] as string,
        };
        // The shared idempotent append (family='content'). Guard failure /
        // duplicate hash / durable-write failure all count as skipped; the
        // batch never fails on one bad item.
        const outcome = await appendContentEnrichmentEvent(eventLog, candidate);
        if (outcome === 'accepted') accepted += 1;
        else skipped += 1;
      }
      return [200, { data: { accepted, skipped } }];
    },
  },
  {
    // Enrichment retraction — POST /v1/enrichment/retract. WITHDRAW a
    // synthesized title or gist that should never have been served.
    //
    // WHY IT EXISTS (live, 2026-07-27). Five gists produced before the
    // generation path was fixed are in the vault feeding retrieval: three
    // repetition loops, one paraphrased prompt-echo, one led by nav
    // boilerplate. A gist is injected into the recall lexical index and the
    // content lane's embed text, so a degenerate one is WORSE than no gist —
    // it actively pollutes retrieval for its entity. There was no way to take
    // one back; this is that way.
    //
    // The event log is append-only, so this appends a RETRACTION and lets the
    // folds honor it (TOMBSTONE + HIDE, as the privacy domain tombstone does).
    // The original event survives for forensics; what changes is what serves.
    //
    // FROZEN CONTRACT: { items: [{ family, kind, id, sourceContentHash?,
    // reason }] } → 200 { accepted, skipped }. Same discipline as the two
    // enrichment routes: ≤50 items/request, item-level problems SKIPPED and
    // counted rather than failing the batch, idempotent per
    // (family,kind,id,hash-or-'*') so re-running a purge is safe.
    //
    // `sourceContentHash` OPTIONAL and meaningful: present ⇒ withdraw only
    // that exact revision (no clock involved, cannot eat a fresh re-synthesis);
    // omitted ⇒ withdraw whatever stands, unless it was generated after the
    // retraction. `reason` is REQUIRED — an unexplained deletion in an audit
    // log is the thing this design is trying not to be.
    //
    // DELIBERATELY NOT flag-gated. SIDETRACK_TITLE_ENRICHMENT switching
    // ingestion off must not block cleaning up what ingestion already wrote;
    // an operator turning the feature off is MORE likely to want the purge,
    // not less.
    method: 'POST',
    pattern: /^\/v1\/enrichment\/retract$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const eventLog = context.eventLog;
      if (eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'event log not configured for this companion',
        );
      }
      const body = await readBody(request);
      const items =
        typeof body === 'object' && body !== null && Array.isArray((body as { items?: unknown }).items)
          ? (body as { items: readonly unknown[] }).items
          : null;
      if (items === null) {
        throw new HttpRouteError(
          400,
          'VALIDATION_ERROR',
          'Validation failed.',
          'Body must be an object with an `items` array.',
        );
      }
      const MAX_RETRACTION_ITEMS = 50;
      const overCap = Math.max(0, items.length - MAX_RETRACTION_ITEMS);
      const considered = items.slice(0, MAX_RETRACTION_ITEMS);
      const retractedAt = new Date().toISOString();

      let accepted = 0;
      let skipped = overCap;
      for (const raw of considered) {
        if (typeof raw !== 'object' || raw === null) {
          skipped += 1;
          continue;
        }
        const item = raw as Record<string, unknown>;
        const hash = item['sourceContentHash'];
        const candidate: EntityEnrichmentRetractedPayload = {
          payloadVersion: 1,
          family: item['family'] as EnrichmentFamily,
          kind: item['kind'] as EntityTitleEnrichedKind,
          id: item['id'] as string,
          // Only set the key when the caller scoped it — an explicit
          // `undefined` and an absent field must mean the same thing.
          ...(typeof hash === 'string' && hash.length > 0
            ? { sourceContentHash: hash }
            : {}),
          reason: item['reason'] as string,
          // Server-stamped, NOT caller-supplied: the retraction timestamp is
          // load-bearing for unscoped retractions, so it comes from the
          // process doing the durable write rather than from a client whose
          // clock we cannot check.
          retractedAt,
        };
        const outcome = await appendEnrichmentRetractionEvent(eventLog, candidate);
        if (outcome === 'accepted') accepted += 1;
        else skipped += 1;
      }
      return [200, { data: { accepted, skipped } }];
    },
  },
];
