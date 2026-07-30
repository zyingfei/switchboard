// Review-draft routes: list, the literal "changes" listing (which must stay
// ahead of the bacId capture-group route — see routeTable.characterization.test.ts),
// single-draft read, event append, and delete.
//
// Extracted verbatim from server.ts in stage S2 of the cost-of-change
// refactor; order within this array is dispatch order and is pinned by
// routeTable.characterization.test.ts.

import { isReviewDraftEvent, projectReviewDraft } from '../../review/projection.js';
import type { TargetRef } from '../../sync/causal.js';
import { deleteReviewDraft, listReviewDrafts, readReviewDraft, writeReviewDraft } from '../../vault/reviewDrafts.js';
import { reviewDraftEventBatchSchema, reviewDraftListQuerySchema } from '../schemas.js';

import { HttpRouteError, readBody, requireIdempotencyKey, requireVaultRoot, runIdempotent } from '../routeSupport.js';
import type { RouteDefinition } from '../routeSupport.js';

// Strip undefined keys produced by zod's `optional()` so the caller's
// `exactOptionalPropertyTypes` interfaces accept the value without
// complaining about `T | undefined` mismatches.
const compactTargetRef = (raw: Record<string, unknown> | undefined): TargetRef | undefined => {
  if (raw === undefined) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
};

export const reviewDraftsRoutes: readonly RouteDefinition[] = [
  {
    // Review-draft summary listing. Returns items newer than ?since
    // (ms epoch). Browsers use this for cold-start reconciliation
    // when the SSE stream isn't connected.
    method: 'GET',
    pattern: /^\/v1\/review-drafts$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const query = reviewDraftListQuerySchema.parse({
        since: url.searchParams.get('since') ?? undefined,
      });
      const items = await listReviewDrafts(vaultRoot, query.since ?? null);
      return [200, { items }];
    },
  },
  {
    // Cursor-shaped change feed. Browsers poll with ?since=<cursor>
    // and pass back the returned `cursor` on the next call. The
    // cursor is the stringified value of a per-companion monotonic
    // counter — never a wall-clock timestamp — so a peer with a
    // skewed clock can't push the cursor "into the future" and hide
    // subsequent normal-time edits.
    method: 'GET',
    pattern: /^\/v1\/review-drafts\/changes$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const sinceParam = url.searchParams.get('since') ?? undefined;
      const sinceSeq = sinceParam === undefined ? 0 : Number.parseInt(sinceParam, 10);
      const safeSince = Number.isFinite(sinceSeq) && sinceSeq >= 0 ? sinceSeq : 0;
      // Preferred path: read from the local monotonic change feed.
      if (context.projectionChanges !== undefined) {
        const result = await context.projectionChanges.readSince(safeSince);
        const filtered = result.changed.filter((change) => change.aggregate === 'review-draft');
        return [
          200,
          {
            cursor: String(result.cursor),
            // GAP HONESTY (changelog rotation, 2026-07-29). The feed now rotates
            // at a byte cap keeping one prior generation; a client whose `since`
            // predates what is still retained lost changes it will never be
            // handed. `resyncRequired` tells it to fall back to the full
            // /v1/review-drafts listing instead of trusting `changed` to be
            // complete. `retainedFromSeq` 0 means nothing was ever rotated away.
            retainedFromSeq: String(result.retainedFromSeq),
            resyncRequired: result.retainedFromSeq > 0 && safeSince < result.retainedFromSeq,
            changed: filtered.map((change) => ({
              threadId: change.aggregateId,
              vector: change.vector,
              kind: change.kind,
              localWrittenAtMs: change.localWrittenAtMs,
            })),
          },
        ];
      }
      // Legacy fallback for tests that don't wire a feed: scan the
      // projection directory. Cursor here is best-effort and may not
      // be monotonic across hosts; documented as such.
      const items = await listReviewDrafts(vaultRoot, null);
      return [
        200,
        {
          cursor: '0',
          changed: items.map((item) => ({
            threadId: item.threadId,
            vector: item.vector,
            updatedAtMs: item.updatedAtMs,
          })),
        },
      ];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/review-drafts\/(?<bacId>[A-Za-z0-9_-]+)$/,
    authRequired: true,
    handle: async (_request, _requestId, match, context) => {
      if (match.bacId === undefined) {
        throw new Error('Missing threadId path parameter.');
      }
      const vaultRoot = requireVaultRoot(context);
      const projection = await readReviewDraft(vaultRoot, match.bacId);
      if (projection === null) {
        throw new HttpRouteError(404, 'NOT_FOUND', 'Review draft not found.');
      }
      return [200, { data: projection }];
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/review-drafts\/(?<bacId>[A-Za-z0-9_-]+)\/events$/,
    authRequired: true,
    handle: async (request, _requestId, match, context) => {
      const threadId = match.bacId;
      if (threadId === undefined) {
        throw new Error('Missing threadId path parameter.');
      }
      const vaultRoot = requireVaultRoot(context);
      const eventLog = context.eventLog;
      if (eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      const idempotencyKey = requireIdempotencyKey(request);
      return await runIdempotent(context, 'reviewDraftEvent', idempotencyKey, async () => {
        const body = await readBody(request);
        const input = reviewDraftEventBatchSchema.parse(body);
        // Stamp each event with the URL threadId as the aggregateId so
        // the projection layer can fetch by aggregate. Clients don't
        // repeat threadId in every payload; they pass it once via the
        // path parameter.
        const accepted = [];
        for (const incoming of input.events) {
          const target = compactTargetRef(incoming.target);
          // Browser-driven: the editor's `baseVector` is what they
          // observed. Empty `{}` is legal — means the editor saw
          // no prior events. Companion does NOT replace it.
          const event = await eventLog.appendClientObserved({
            clientEventId: incoming.clientEventId,
            aggregateId: threadId,
            type: incoming.type,
            payload: incoming.payload ?? {},
            baseVector: incoming.baseVector ?? {},
            ...(incoming.clientDeps === undefined ? {} : { clientDeps: incoming.clientDeps }),
            ...(target === undefined ? {} : { target }),
          });
          accepted.push(event);
        }
        // Recompute the projection from the merged log so concurrent
        // peer events are reflected too. Phase D may hoist this onto
        // a background projector; for M2 the recompute cost is tiny
        // (one thread's events).
        const reviewEvents = await eventLog.readByAggregate(threadId);
        const threadUrl =
          input.threadUrl ?? (await readReviewDraft(vaultRoot, threadId))?.threadUrl ?? '';
        const projection = projectReviewDraft(threadId, threadUrl, reviewEvents);
        if (projection.discarded) {
          await deleteReviewDraft(vaultRoot, threadId);
        } else {
          await writeReviewDraft(vaultRoot, threadId, projection);
        }
        await context.projectionChanges
          ?.appendChange({
            aggregate: 'review-draft',
            aggregateId: threadId,
            relPath: `_BAC/review-drafts/${threadId}.json`,
            vector: projection.vector,
            kind: projection.discarded ? 'delete' : 'upsert',
          })
          .catch(() => undefined);
        return [200, { data: { accepted, projection } }];
      });
    },
  },
  {
    // Event-sourced delete. Direct unlink is unsafe in a CRDT
    // system: prior events still live in the log, so a rebuild (or
    // a peer that only saw the unaccompanied delete) would
    // resurrect the draft. Instead the route appends a
    // `review-draft.discarded` event whose `baseVector` covers
    // every prior event we've observed; the projection collapses to
    // the discarded state, and the file delete becomes a side
    // effect.
    method: 'DELETE',
    pattern: /^\/v1\/review-drafts\/(?<bacId>[A-Za-z0-9_-]+)$/,
    authRequired: true,
    handle: async (request, requestId, match, context) => {
      const threadId = match.bacId;
      if (threadId === undefined) {
        throw new Error('Missing threadId path parameter.');
      }
      const vaultRoot = requireVaultRoot(context);
      const eventLog = context.eventLog;
      if (eventLog === undefined) {
        // Legacy callers without an eventLog wired (tests) fall back
        // to the direct unlink so we keep their behaviour.
        await deleteReviewDraft(vaultRoot, threadId);
        return [204, undefined];
      }
      // Invariant C: omit baseVector. The eventLog auto-resolves
      // deps from the aggregate's prior events, which equals the
      // current review-draft projection's vector — so the discard
      // event still causally dominates every prior review-draft
      // event for this thread.
      await eventLog.appendServerObserved({
        clientEventId: requestId,
        aggregateId: threadId,
        type: 'review-draft.discarded',
        payload: { reason: 'deleted-via-http' },
      });
      // Recompute and persist the new projection (collapsed to
      // discarded). If the projection function returns null we
      // delete the file; otherwise we write the tombstoned
      // projection so peers still see the vector advance.
      const merged = await eventLog.readByAggregate(threadId);
      const reviewEvents = merged.filter((event) => isReviewDraftEvent(event));
      const projection = projectReviewDraft(threadId, '', reviewEvents);
      if (projection.discarded) {
        await deleteReviewDraft(vaultRoot, threadId);
      } else {
        await writeReviewDraft(vaultRoot, threadId, projection);
      }
      await context.projectionChanges
        ?.appendChange({
          aggregate: 'review-draft',
          aggregateId: threadId,
          relPath: `_BAC/review-drafts/${threadId}.json`,
          vector: projection.vector,
          kind: projection.discarded ? 'delete' : 'upsert',
        })
        .catch(() => undefined);
      return [204, undefined];
    },
  },
];
