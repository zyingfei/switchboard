// Queue routes: create and the projection read.
//
// Extracted verbatim from server.ts in stage S2 of the cost-of-change
// refactor; order within this array is dispatch order and is pinned by
// routeTable.characterization.test.ts.

import { QUEUE_CREATED } from '../../queue/events.js';
import { projectQueueItem } from '../../queue/projection.js';
import { queueCreateSchema } from '../schemas.js';

import { HttpRouteError, readAggregateEventsServeStale, mutationResponse, readBody, requireIdempotencyKey, requireWorkstreamTrust, runIdempotent } from '../routeSupport.js';
import type { RouteDefinition } from '../routeSupport.js';

export const queueRoutes: readonly RouteDefinition[] = [
  {
    method: 'POST',
    pattern: /^\/v1\/queue$/,
    authRequired: true,
    handle: async (request, requestId, _match, context) => {
      const idempotencyKey = requireIdempotencyKey(request);
      return await runIdempotent(context, 'createQueueItem', idempotencyKey, async () => {
        const input = queueCreateSchema.parse(await readBody(request));
        // Only a workstream-scoped queue item is trust-gated; a thread /
        // global item has no workstream to check. MCP-key callers are
        // gated on that workstream; the extension surface is exempt.
        if (input.scope === 'workstream') {
          await requireWorkstreamTrust(context, request, input.targetId, 'sidetrack.queue.create');
        }
        const result = await context.vaultWriter.createQueueItem(input, requestId);
        if (context.eventLog !== undefined) {
          await context.eventLog
            .appendServerObserved({
              clientEventId: idempotencyKey,
              aggregateId: result.bac_id,
              type: QUEUE_CREATED,
              payload: {
                bac_id: result.bac_id,
                text: input.text,
                scope: input.scope,
                ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
                ...(input.status === undefined ? {} : { status: input.status }),
              },
            })
            .catch(() => undefined);
        }
        return [201, mutationResponse(result, requestId)];
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/queue\/(?<bacId>[A-Za-z0-9_-]+)\/projection$/,
    authRequired: true,
    handle: async (_request, _requestId, match, context) => {
      if (match.bacId === undefined) {
        throw new Error('Missing bacId path parameter.');
      }
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      const events = await readAggregateEventsServeStale(context, match.bacId);
      return [200, { data: projectQueueItem(match.bacId, events) }];
    },
  },
];
