// Annotation routes: create, list, patch, delete, and the two projection reads.
//
// Extracted verbatim from server.ts in stage S2 of the cost-of-change
// refactor; order within this array is dispatch order and is pinned by
// routeTable.characterization.test.ts.

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { buildAnchorFromTerm } from '../../annotation/anchorBuilder.js';
import { ANNOTATION_CREATED, ANNOTATION_DELETED, ANNOTATION_NOTE_SET } from '../../annotations/events.js';
import { projectAnnotations } from '../../annotations/projection.js';
import { listAnnotations, softDeleteAnnotation, updateAnnotation, writeAnnotation } from '../../vault/annotationStore.js';
import { currentAuditContext as currentAuditContextMut } from '../../vault/auditContext.js';
import { annotationCreateSchema, annotationListQuerySchema, annotationUpdateSchema, auditEventSchema } from '../schemas.js';

import { HttpRouteError, readAggregateEventsServeStale, readBody, readEventsFromStoreOrLog, readThreadMetadata, requireIdempotencyKey, requireVaultRoot, runIdempotent } from '../routeSupport.js';
import type { RouteDefinition } from '../routeSupport.js';

// Write an audit row for an HTTP write that does NOT flow through the
// vault writer's own audit() closure (annotation edits/deletes go straight
// to annotationStore, so they never recorded a provenance line). Mirrors
// the writer's audit format + on-disk layout (_BAC/audit/<YYYY-MM-DD>.jsonl,
// one JSON object per line) and merges the ambient request-scoped
// AuditContext (agent / tool / argsSummary / scope / trustModeActive) so
// the caller identity is on the line. Best-effort: an audit-write failure
// must never fail the mutation it records.
const appendHttpAuditLine = async (
  vaultRoot: string,
  event: { readonly requestId: string; readonly route: string; readonly bac_id?: string },
): Promise<void> => {
  const timestamp = new Date().toISOString();
  const provenance = currentAuditContextMut();
  const base = {
    requestId: event.requestId,
    route: event.route,
    outcome: 'success' as const,
    ...(event.bac_id === undefined ? {} : { bac_id: event.bac_id }),
    timestamp,
  };
  const enriched =
    provenance === undefined
      ? base
      : {
          ...base,
          agent: provenance.agent,
          tool: provenance.tool,
          ...(provenance.argsSummary === undefined ? {} : { argsSummary: provenance.argsSummary }),
          scope: provenance.scope,
          trustModeActive: provenance.trustModeActive,
        };
  // Validate against the shared schema so an invalid line can never reach
  // disk (the audit reader parses with the same schema).
  const parsed = auditEventSchema.safeParse(enriched);
  if (!parsed.success) return;
  const auditPath = join(vaultRoot, '_BAC', 'audit', `${timestamp.slice(0, 10)}.jsonl`);
  await mkdir(join(vaultRoot, '_BAC', 'audit'), { recursive: true }).catch(() => undefined);
  await appendFile(auditPath, `${JSON.stringify(parsed.data)}\n`, 'utf8').catch(() => undefined);
};

const ANNOTATION_PROJECTION_EVENT_TYPES = [
  ANNOTATION_CREATED,
  ANNOTATION_NOTE_SET,
  ANNOTATION_DELETED,
] as const;

export const annotationsRoutes: readonly RouteDefinition[] = [
  {
    method: 'POST',
    pattern: /^\/v1\/annotations$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      if (context.vaultRoot === undefined) {
        throw new Error('Vault root is unavailable.');
      }
      const vaultRoot = context.vaultRoot;
      const idempotencyKey = requireIdempotencyKey(request);
      return await runIdempotent(context, 'createAnnotation', idempotencyKey, async () => {
        const input = annotationCreateSchema.parse(await readBody(request));
        // Term-form (Phase 4): companion fetches the thread's assistant
        // turns and builds the anchor server-side. Anchor-form (DOM-
        // driven): caller already serialised the anchor; pass through
        // unchanged.
        if ('term' in input) {
          // Resolve threadUrl + pageTitle from the thread record when
          // the caller passed `threadId`. This is the path
          // sidetrack.dispatch.await_capture flows into — agents pass
          // threadId, the companion looks up everything else.
          let threadUrl: string | undefined = input.url;
          let pageTitle: string | undefined = input.pageTitle;
          if (input.threadId !== undefined) {
            const meta = await readThreadMetadata(vaultRoot, input.threadId);
            if (meta === null) {
              return [
                200,
                {
                  data: {
                    status: 'anchor_failed' as const,
                    reason: 'thread_not_found' as const,
                    message: `Thread ${input.threadId} not found in the vault.`,
                    occurrenceCount: 0,
                  },
                },
              ];
            }
            threadUrl = meta.threadUrl ?? threadUrl;
            pageTitle = pageTitle ?? meta.title;
          }
          if (threadUrl === undefined) {
            return [
              200,
              {
                data: {
                  status: 'validation_failed' as const,
                  reason: 'thread_url_unresolved' as const,
                  message: 'No threadUrl could be resolved from threadId / url.',
                  occurrenceCount: 0,
                },
              },
            ];
          }
          pageTitle ??= threadUrl;
          const allTurns = await context.vaultWriter.readRecentTurns({
            threadUrl,
            limit: 50,
            role: 'assistant',
          });
          if (allTurns.length === 0) {
            return [
              200,
              {
                data: {
                  status: 'anchor_failed' as const,
                  reason: 'no_assistant_turns' as const,
                  message: `No assistant turns found for ${threadUrl}; capture the thread first.`,
                  occurrenceCount: 0,
                },
              },
            ];
          }
          // sourceTurn selects which captured turn the anchor is
          // built against. Defaults to the latest assistant turn —
          // matches the post-dispatch flow where the agent annotates
          // a fresh answer.
          const sortedAsc = allTurns.slice().sort((left, right) => left.ordinal - right.ordinal);
          const sourceTurn = input.sourceTurn ?? 'assistant_latest';
          let turnText: string;
          if (sourceTurn === 'assistant_all') {
            turnText = sortedAsc.map((turn) => turn.text).join('\n\n');
          } else if (sourceTurn === 'assistant_latest') {
            const last = sortedAsc[sortedAsc.length - 1];
            turnText = last?.text ?? '';
          } else {
            const picked = sortedAsc.find((turn) => turn.ordinal === sourceTurn.ordinal);
            if (picked === undefined) {
              return [
                200,
                {
                  data: {
                    status: 'validation_failed' as const,
                    reason: 'invalid_ordinal' as const,
                    message: `Thread has no assistant turn at ordinal ${String(sourceTurn.ordinal)}.`,
                    occurrenceCount: 0,
                  },
                },
              ];
            }
            turnText = picked.text;
          }
          // anchorPolicy fields can each be undefined under
          // exactOptionalPropertyTypes; strip undefined before
          // passing down. Defaults live in buildAnchorFromTerm.
          const policy = input.anchorPolicy;
          const cleanedPolicy =
            policy === undefined
              ? undefined
              : {
                  ...(policy.repeatedTerm === undefined
                    ? {}
                    : { repeatedTerm: policy.repeatedTerm }),
                  ...(policy.shortTermMinLength === undefined
                    ? {}
                    : { shortTermMinLength: policy.shortTermMinLength }),
                };
          const result = buildAnchorFromTerm({
            turnText,
            term: input.term,
            ...(input.selectionHint === undefined ? {} : { selectionHint: input.selectionHint }),
            ...(cleanedPolicy === undefined ? {} : { policy: cleanedPolicy }),
          });
          if (!result.ok) {
            // Structured failure — surfaced as 200 + a `data` block
            // the MCP create_batch tool maps to a per-item retry-able
            // status. Throwing 400 forces the agent to handle a
            // protocol-level error; structured returns let the model
            // self-correct against the same envelope shape as a
            // success.
            return [
              200,
              {
                data: {
                  status: 'anchor_failed' as const,
                  reason: result.reason,
                  message: result.message,
                  occurrenceCount: result.occurrenceCount,
                  ...(result.suggestedSelectionHints === undefined
                    ? {}
                    : { suggestedSelectionHints: [...result.suggestedSelectionHints] }),
                },
              },
            ];
          }
          const annotationUrl = input.url ?? threadUrl;
          const created = await writeAnnotation(vaultRoot, {
            url: annotationUrl,
            pageTitle,
            anchor: result.anchor,
            note: input.note,
          });
          if (context.eventLog !== undefined) {
            await context.eventLog
              .appendServerObserved({
                clientEventId: `${idempotencyKey}.term`,
                aggregateId: created.bac_id,
                type: ANNOTATION_CREATED,
                payload: {
                  bac_id: created.bac_id,
                  url: annotationUrl,
                  anchor: result.anchor,
                  note: input.note,
                  pageTitle,
                },
              })
              .catch(() => undefined);
          }
          // totalForThread/totalForUrl: total non-deleted
          // annotations now associated with this URL. Lets the
          // model report a final count without summing per-batch
          // createdCount across multiple calls (the only fully
          // accurate way to know "how many annotations exist").
          const totalForUrl = (await listAnnotations(vaultRoot, { url: annotationUrl })).length;
          return [
            201,
            {
              data: {
                status: 'created' as const,
                annotationId: created.bac_id,
                occurrenceCount: result.occurrenceCount,
                annotation: created,
                totalForUrl,
              },
            },
          ];
        }
        const result = await writeAnnotation(vaultRoot, input);
        if (context.eventLog !== undefined) {
          await context.eventLog
            .appendServerObserved({
              clientEventId: idempotencyKey,
              aggregateId: result.bac_id,
              type: ANNOTATION_CREATED,
              payload: {
                bac_id: result.bac_id,
                url: input.url,
                anchor: input.anchor,
                note: input.note,
                pageTitle: input.pageTitle,
              },
            })
            .catch(() => undefined);
        }
        return [201, { data: result }];
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/annotations$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      if (context.vaultRoot === undefined) {
        throw new Error('Vault root is unavailable.');
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const query = annotationListQuerySchema.parse({
        url: url.searchParams.get('url') ?? undefined,
        includeDeleted: url.searchParams.get('includeDeleted') ?? undefined,
        limit: url.searchParams.get('limit') ?? undefined,
      });
      const annotations = await listAnnotations(context.vaultRoot, {
        ...(query.url === undefined ? {} : { url: query.url }),
        includeDeleted: query.includeDeleted,
      });
      return [200, { data: annotations.slice(0, query.limit) }];
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/v1\/annotations\/(?<annotationId>[A-Za-z0-9_-]+)$/,
    authRequired: true,
    handle: async (request, requestId, match, context) => {
      if (match.annotationId === undefined) {
        throw new Error('Missing annotationId path parameter.');
      }
      const vaultRoot = requireVaultRoot(context);
      const input = annotationUpdateSchema.parse(await readBody(request));
      const updated = await updateAnnotation(vaultRoot, match.annotationId, input);
      // Annotation edits go straight to annotationStore, bypassing the vault
      // writer's audit() closure — record a provenance line here so an mcp
      // (or extension) caller's edit is attributable in the audit log.
      await appendHttpAuditLine(vaultRoot, {
        requestId,
        route: 'updateAnnotation',
        bac_id: match.annotationId,
      });
      if (context.eventLog !== undefined && typeof input.note === 'string') {
        await context.eventLog
          .appendServerObserved({
            clientEventId: requestId,
            aggregateId: match.annotationId,
            type: ANNOTATION_NOTE_SET,
            payload: { bac_id: match.annotationId, note: input.note },
          })
          .catch(() => undefined);
      }
      return [200, { data: updated }];
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/v1\/annotations\/(?<annotationId>[A-Za-z0-9_-]+)$/,
    authRequired: true,
    handle: async (_request, requestId, match, context) => {
      if (match.annotationId === undefined) {
        throw new Error('Missing annotationId path parameter.');
      }
      const vaultRoot = requireVaultRoot(context);
      const result = await softDeleteAnnotation(vaultRoot, match.annotationId);
      // Annotation deletes bypass the vault writer's audit() closure —
      // record a provenance line here so a delete is attributable.
      await appendHttpAuditLine(vaultRoot, {
        requestId,
        route: 'deleteAnnotation',
        bac_id: match.annotationId,
      });
      // Emit ANNOTATION_DELETED whenever an event log is configured. The
      // clientEventId falls back to a stable 'local' replica placeholder
      // when no replica is bound — previously the whole event was SKIPPED
      // if replica was undefined, so a delete could vanish from the log
      // (and from peers) on any companion without a replica context.
      // requestId already makes the key unique per call.
      if (context.eventLog !== undefined) {
        const replicaId = context.replica?.replicaId ?? 'local';
        await context.eventLog
          .appendServerObserved({
            clientEventId: `annotation-delete:${replicaId}:${match.annotationId}:${requestId}`,
            aggregateId: match.annotationId,
            type: ANNOTATION_DELETED,
            payload: { bac_id: match.annotationId },
          })
          .catch(() => undefined);
      }
      return [200, { data: result }];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/annotations\/projection$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => {
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      const annotationEvents = await readEventsFromStoreOrLog(
        context,
        context.eventLog,
        (event) =>
          event.type === ANNOTATION_CREATED ||
          event.type === ANNOTATION_NOTE_SET ||
          event.type === ANNOTATION_DELETED,
        ANNOTATION_PROJECTION_EVENT_TYPES,
      );
      return [200, { data: projectAnnotations(annotationEvents) }];
    },
  },
  {
    // Per-annotation projection. F13 — extension's SSE subscriber
    // hits this when `_BAC/annotations/<bac_id>.json` changes.
    method: 'GET',
    pattern: /^\/v1\/annotations\/(?<bacId>[A-Za-z0-9_-]+)\/projection$/,
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
      const merged = await readAggregateEventsServeStale(context, match.bacId);
      const projection = projectAnnotations(merged);
      const entry = projection.entries.find((row) => row.bac_id === match.bacId);
      return [
        200,
        {
          data: {
            ...(entry === undefined ? {} : { entry }),
            vector: projection.vector,
            updatedAtMs: projection.updatedAtMs,
          },
        },
      ];
    },
  },
];
