// Feedback routes: feedback event ingestion and the feedback projection read.
//
// Extracted verbatim from server.ts in stage S2 of the cost-of-change
// refactor; order within this array is dispatch order and is pinned by
// routeTable.characterization.test.ts.

import { USER_ENGAGEMENT_RELABELED, USER_FLOW_CONFIRMED, USER_FLOW_REJECTED, USER_ORGANIZED_ITEM, USER_REJECTED_RELATION, USER_SNIPPET_PROMOTED, USER_TOPIC_RENAMED, isUserEngagementRelabeledPayload, isUserFlowConfirmedPayload, isUserFlowRejectedPayload, isUserOrganizedItemPayload, isUserRejectedRelationPayload, isUserSnippetPromotedPayload, isUserTopicRenamedPayload } from '../../feedback/events.js';
import { projectFeedback } from '../../feedback/projection.js';
import { recordLaneOutcome } from '../../tabsession/lanePrequential.js';

import { FEEDBACK_EVENT_TYPE_LIST, HttpRouteError, aggregateIdForFeedbackEvent, baseVectorForAggregate, isFeedbackEventType, objectRecord, readBody, readEventsFromStoreOrLog, requireIdempotencyKey, requireVaultRoot, runIdempotent } from '../routeSupport.js';
import type { RouteDefinition } from '../routeSupport.js';

const isFeedbackPayloadForType = (
  type: string,
  payload: unknown,
): payload is Record<string, unknown> => {
  if (type === USER_ORGANIZED_ITEM) return isUserOrganizedItemPayload(payload);
  if (type === USER_ENGAGEMENT_RELABELED) return isUserEngagementRelabeledPayload(payload);
  if (type === USER_FLOW_CONFIRMED) return isUserFlowConfirmedPayload(payload);
  if (type === USER_FLOW_REJECTED) return isUserFlowRejectedPayload(payload);
  if (type === USER_TOPIC_RENAMED) return isUserTopicRenamedPayload(payload);
  if (type === USER_SNIPPET_PROMOTED) return isUserSnippetPromotedPayload(payload);
  if (type === USER_REJECTED_RELATION) return isUserRejectedRelationPayload(payload);
  return false;
};

export const feedbackRoutes: readonly RouteDefinition[] = [
  {
    method: 'POST',
    pattern: /^\/v1\/feedback\/events$/,
    authRequired: true,
    handle: async (request, requestId, _match, context) => {
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      const eventLog = context.eventLog;
      const idempotencyKey = requireIdempotencyKey(request);
      return await runIdempotent(context, 'feedbackEvent', idempotencyKey, async () => {
        const body = objectRecord(await readBody(request));
        const type = body?.['type'];
        const payload = body?.['payload'];
        if (!isFeedbackEventType(type) || !isFeedbackPayloadForType(type, payload)) {
          throw new HttpRouteError(
            400,
            'VALIDATION_ERROR',
            'Validation failed.',
            'Body must be a valid feedback event envelope.',
          );
        }
        const aggregateId = aggregateIdForFeedbackEvent(type, payload);
        const accepted = await eventLog.appendClient({
          clientEventId: idempotencyKey,
          aggregateId,
          type,
          payload,
          baseVector: await baseVectorForAggregate(eventLog, aggregateId),
        });
        if (
          type === USER_ORGANIZED_ITEM &&
          isUserOrganizedItemPayload(payload) &&
          payload.itemKind === 'canonical-url' &&
          payload.action === 'move' &&
          payload.details?.servedOpportunityId !== undefined
        ) {
          await recordLaneOutcome(requireVaultRoot(context), {
            opportunityId: payload.details.servedOpportunityId,
            canonicalUrl: payload.itemId,
            workstreamId: payload.toContainer ?? null,
            atMs: accepted.acceptedAtMs,
          }).catch((error: unknown) => {
            console.warn('[lane-prequential]', {
              requestId,
              operation: 'lane-prequential.outcome-record',
              outcome: 'error',
              errorCategory: error instanceof Error ? error.name : 'unknown',
            });
          });
        }
        return [201, { data: { accepted } }];
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/feedback\/projection$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => {
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      return [
        200,
        {
          data: projectFeedback(
            await readEventsFromStoreOrLog(
              context,
              context.eventLog,
              (event) => isFeedbackEventType(event.type),
              FEEDBACK_EVENT_TYPE_LIST,
            ),
          ),
        },
      ];
    },
  },
];
