// Workstream suggestion routes — accept/decline for NEW-TOPIC ("new-
// category") suggestion candidates (docs/plans/2026-08-16-category-
// flexibility-hyde.md §4, item 7 of the 2026-08-16 keyword-layer directive:
// "the missing half of 'suggest new categories AND splits'").
//
// WHY A SEPARATE ROUTE FILE, NOT AN EXTENSION OF visitsRoutes.ts's existing
// /memberships route. That route assumes the target workstreamId ALREADY
// EXISTS; a new-topic candidate has no workstream at all until accepted —
// "Accept = create workstream + workstream.membership.set events for
// members" (design §4: "not a new mechanism," POST /v1/workstreams create
// then a batch of the existing memberships mechanic). This file is exactly
// that orchestration, applied to every member of a STABLE, EMITTED
// SuggestionCandidateRecord at once rather than one visit at a time.
//
// DECLINE = population-scoped, not event-sourced. See
// suggestionCandidateStore.ts's declineCandidate/declinedConceptSets and
// splitSuggestionEngine.ts's isSuppressedByDecline: a decline here persists
// the candidate's concept-id fingerprint directly in the (derived-stats,
// not event-sourced — see that store's own header) suggestion-candidate
// store. There is no workstreamId to hang a SUGGESTION_DECLINED event off
// of, since nothing was ever created.
//
// SCOPE. Only kind='new-category' at NEW_CATEGORY_SCOPE_ID is served here.
// Split-suggestion accept/decline already has a home (visitsRoutes.ts's
// existing /memberships + /suggestions/decline routes) — a split
// candidate's members already belong to a real, existing workstream, so
// they never needed a create step.
//
// READ ROUTES ARE OUT OF SCOPE HERE ON PURPOSE. A concurrent sibling branch
// owns "small READ routes around suggestionCandidateStore and prototype
// status" for the panel UI — this file is WRITE-only (accept/decline),
// avoiding any overlap.

import { USER_ORGANIZED_ITEM } from '../../feedback/events.js';
import { createKeywordConceptStore, type KeywordConceptStore } from '../../enrichment/keywordConceptStore.js';
import { createKeywordIndexStore, type KeywordIndexStore } from '../../search-index/keywordIndexStore.js';
import { WORKSTREAM_UPSERTED } from '../../workstreams/events.js';
import { membershipAggregateId, WORKSTREAM_MEMBERSHIP_SET } from '../../workstreams/membershipEvents.js';
import { SUGGESTION_ACCEPTED, suggestionAggregateId } from '../../workstreams/suggestionEvents.js';
import {
  NEW_CATEGORY_SCOPE_ID,
  createSuggestionCandidateStore,
  type SuggestionCandidateStore,
} from '../../workstreams/suggestionCandidateStore.js';
import { workstreamCreateSchema } from '../schemas.js';

import {
  HttpRouteError,
  aggregateIdForFeedbackEvent,
  baseVectorForAggregate,
  objectRecord,
  readBody,
  requireIdempotencyKey,
  requireVaultRoot,
  runIdempotent,
} from '../routeSupport.js';
import type { RouteDefinition } from '../routeSupport.js';

// ---- lazy per-vault singleton handles (mirrors enrichment/keywordIngest.ts's idiom) --

interface Handles {
  readonly candidates: SuggestionCandidateStore;
  readonly keywordIndex: KeywordIndexStore;
  readonly concepts: KeywordConceptStore;
}
const handlesByVault = new Map<string, Promise<Handles>>();

const ensureHandles = async (vaultRoot: string): Promise<Handles> => {
  let pending = handlesByVault.get(vaultRoot);
  if (pending === undefined) {
    pending = (async (): Promise<Handles> => {
      const [candidates, keywordIndex, concepts] = await Promise.all([
        createSuggestionCandidateStore(vaultRoot),
        createKeywordIndexStore(vaultRoot),
        createKeywordConceptStore(vaultRoot),
      ]);
      return { candidates, keywordIndex, concepts };
    })();
    handlesByVault.set(vaultRoot, pending);
  }
  try {
    return await pending;
  } catch (error) {
    handlesByVault.delete(vaultRoot);
    throw error;
  }
};

export const resetWorkstreamSuggestionHandlesForTest = (): void => {
  handlesByVault.clear();
};

/** Re-derive a declined candidate's concept-id set at decline time from the
 *  keyword layer (rather than requiring the caller to know it) — every
 *  member's indexed keywords, mapped to concept ids, unioned. */
const conceptIdsForMembers = (
  memberIds: readonly string[],
  keywordIndex: KeywordIndexStore,
  concepts: KeywordConceptStore,
): readonly string[] => {
  const ids = new Set<string>();
  for (const memberId of memberIds) {
    const keywords = keywordIndex.keywordsForPage(`url:${memberId}`) ?? [];
    for (const conceptId of concepts.conceptIdsForKeywords(keywords)) ids.add(conceptId);
  }
  return [...ids];
};

const findCandidate = (
  store: SuggestionCandidateStore,
  fingerprint: string,
): ReturnType<SuggestionCandidateStore['candidatesFor']>[number] | undefined =>
  store.candidatesFor(NEW_CATEGORY_SCOPE_ID, 'new-category').find((c) => c.fingerprint === fingerprint);

export const workstreamSuggestionsRoutes: readonly RouteDefinition[] = [
  {
    // Accept a stable new-topic candidate: create a workstream, then file
    // every member into it via the SAME 3-event shape (suggestion.accepted
    // + membership.set + USER_ORGANIZED_ITEM) visitsRoutes.ts's existing
    // /memberships route uses for a single visit — applied here to the
    // whole candidate's member list in one request.
    method: 'POST',
    pattern: /^\/v1\/workstreams\/suggestions\/new-topic\/(?<fingerprint>[^/]+)\/accept$/u,
    authRequired: true,
    handle: async (request, requestId, match, context) => {
      const vaultRoot = requireVaultRoot(context);
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      const eventLog = context.eventLog;
      const fingerprint = decodeURIComponent(match.fingerprint ?? '');
      const idempotencyKey = requireIdempotencyKey(request);
      return await runIdempotent(
        context,
        'workstreamSuggestionNewTopicAccept',
        idempotencyKey,
        async () => {
          const handles = await ensureHandles(vaultRoot);
          const record = findCandidate(handles.candidates, fingerprint);
          if (record === undefined) {
            throw new HttpRouteError(404, 'NOT_FOUND', 'No such new-topic suggestion candidate.');
          }
          if (!record.emitted) {
            throw new HttpRouteError(
              409,
              'CONFLICT',
              'This candidate has not stabilized yet — nothing to accept.',
            );
          }
          const body = objectRecord(await readBody(request)) ?? {};
          const rawTitle = body['title'];
          const title =
            typeof rawTitle === 'string' && rawTitle.trim().length > 0
              ? rawTitle.trim()
              : (record.structuralName ?? 'New workstream');

          const createInput = workstreamCreateSchema.parse({ title });
          const created = await context.vaultWriter.createWorkstream(createInput, requestId);
          await eventLog
            .appendServerObserved({
              clientEventId: `${idempotencyKey}:create`,
              aggregateId: created.bac_id,
              type: WORKSTREAM_UPSERTED,
              payload: { bac_id: created.bac_id, title, privacy: 'private' },
            })
            .catch(() => undefined);

          let membersAdded = 0;
          for (const memberId of record.memberIds) {
            const acceptedPayload = {
              payloadVersion: 1 as const,
              suggestionSource: 'workstream-new-category' as const,
              subjectKind: 'canonical-url' as const,
              subjectId: memberId,
              workstreamId: created.bac_id,
            };
            const acceptedAggregateId = suggestionAggregateId(
              'workstream-new-category',
              'canonical-url',
              memberId,
              created.bac_id,
            );
            await eventLog.appendClient({
              clientEventId: `${idempotencyKey}:accepted:${memberId}`,
              aggregateId: acceptedAggregateId,
              type: SUGGESTION_ACCEPTED,
              payload: acceptedPayload,
              baseVector: await baseVectorForAggregate(eventLog, acceptedAggregateId),
            });

            const setPayload = {
              payloadVersion: 1 as const,
              subjectKind: 'canonical-url' as const,
              subjectId: memberId,
              workstreamId: created.bac_id,
              role: 'secondary' as const,
              provenance: 'ai-suggested-accepted' as const,
            };
            const setAggregateId = membershipAggregateId('canonical-url', memberId, created.bac_id);
            await eventLog.appendClient({
              clientEventId: `${idempotencyKey}:membership:${memberId}`,
              aggregateId: setAggregateId,
              type: WORKSTREAM_MEMBERSHIP_SET,
              payload: setPayload,
              baseVector: await baseVectorForAggregate(eventLog, setAggregateId),
            });

            const organizedPayload = {
              payloadVersion: 1 as const,
              itemKind: 'canonical-url' as const,
              itemId: memberId,
              action: 'add-container' as const,
              toContainer: created.bac_id,
            };
            const organizedAggregateId = aggregateIdForFeedbackEvent(USER_ORGANIZED_ITEM, organizedPayload);
            await eventLog.appendClient({
              clientEventId: `${idempotencyKey}:organized:${memberId}`,
              aggregateId: organizedAggregateId,
              type: USER_ORGANIZED_ITEM,
              payload: organizedPayload,
              baseVector: await baseVectorForAggregate(eventLog, organizedAggregateId),
            });
            membersAdded += 1;
          }

          return [201, { data: { workstreamId: created.bac_id, membersAdded } }];
        },
      );
    },
  },
  {
    // Decline a new-topic candidate — population-scoped, no workstream ever
    // created. Persists the candidate's concept-id fingerprint so
    // splitSuggestionEngine.ts's isSuppressedByDecline withholds it (and any
    // future cluster whose concept makeup substantially overlaps) from
    // future emission at this scope+kind.
    method: 'POST',
    pattern: /^\/v1\/workstreams\/suggestions\/new-topic\/(?<fingerprint>[^/]+)\/decline$/u,
    authRequired: true,
    handle: async (request, _requestId, match, context) => {
      const vaultRoot = requireVaultRoot(context);
      const fingerprint = decodeURIComponent(match.fingerprint ?? '');
      const idempotencyKey = requireIdempotencyKey(request);
      return await runIdempotent(
        context,
        'workstreamSuggestionNewTopicDecline',
        idempotencyKey,
        async () => {
          const handles = await ensureHandles(vaultRoot);
          const record = findCandidate(handles.candidates, fingerprint);
          if (record === undefined) {
            throw new HttpRouteError(404, 'NOT_FOUND', 'No such new-topic suggestion candidate.');
          }
          const conceptIds = conceptIdsForMembers(
            record.memberIds,
            handles.keywordIndex,
            handles.concepts,
          );
          handles.candidates.declineCandidate(
            NEW_CATEGORY_SCOPE_ID,
            'new-category',
            fingerprint,
            conceptIds,
            Date.now(),
          );
          return [200, { data: { declined: true, conceptIds } }];
        },
      );
    },
  },
];
