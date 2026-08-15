// Dispatch routes: create, list, link, the two link/await-capture reads, and
// (dispatchesRoutesB) the bacId projection read that sits after the
// annotations block in dispatch order.
//
// Extracted verbatim from server.ts in stage S2 of the cost-of-change
// refactor; order within this array is dispatch order and is pinned by
// routeTable.characterization.test.ts.

import { DISPATCH_LINKED, DISPATCH_RECORDED } from '../../dispatches/events.js';
import { projectDispatches } from '../../dispatches/projection.js';
import { createDispatchId } from '../../domain/ids.js';
import { redact } from '../../safety/redaction.js';
import { estimateTokens, tokenThresholdForProvider } from '../../safety/tokenBudget.js';
import { dispatchEventSchema, dispatchLinkRequestSchema, dispatchListQuerySchema } from '../schemas.js';

import { HttpRouteError, readAggregateEventsServeStale, readBody, readEventsFromStoreOrLog, readThreadMetadata, requireIdempotencyKey, runIdempotent, writerForBucket } from '../routeSupport.js';
import type { RouteDefinition } from '../routeSupport.js';

const DISPATCH_PROJECTION_EVENT_TYPES = [DISPATCH_RECORDED, DISPATCH_LINKED] as const;

export const dispatchesRoutesA: readonly RouteDefinition[] = [
  {
    method: 'POST',
    pattern: /^\/v1\/dispatches$/,
    authRequired: true,
    handle: async (request, requestId, _match, context) => {
      const idempotencyKey = requireIdempotencyKey(request);
      return await runIdempotent(
        context,
        'recordDispatch',
        idempotencyKey,
        async () => {
          const input = dispatchEventSchema.parse(await readBody(request));
          const writer = await writerForBucket(context, {
            provider: input.target.provider,
            ...(input.workstreamId === undefined ? {} : { workstreamId: input.workstreamId }),
          });
          const redaction = redact(input.body);
          const tokenEstimate = estimateTokens(redaction.output);
          // Provider-aware warning threshold. The chat surface for each
          // provider caps context well below the raw API window; see
          // safety/tokenBudget.ts for the (approximate) per-provider map.
          const tokenThreshold = tokenThresholdForProvider(input.target.provider);
          const tokenBudgetExceeded = tokenEstimate > tokenThreshold;
          const dispatchEvent = {
            ...input,
            bac_id: input.bac_id ?? createDispatchId(),
            body: redaction.output,
            createdAt: input.createdAt ?? new Date().toISOString(),
            redactionSummary: {
              matched: redaction.matched,
              categories: [...redaction.categories],
            },
            tokenEstimate,
          };
          const result = await writer.writeDispatchEvent(dispatchEvent, requestId);
          if (context.eventLog !== undefined) {
            await context.eventLog
              .appendServerObserved({
                clientEventId: idempotencyKey,
                aggregateId: dispatchEvent.bac_id,
                type: DISPATCH_RECORDED,
                payload: {
                  bac_id: dispatchEvent.bac_id,
                  target: { provider: dispatchEvent.target.provider },
                  ...(dispatchEvent.workstreamId === undefined
                    ? {}
                    : { workstreamId: dispatchEvent.workstreamId }),
                  createdAt: dispatchEvent.createdAt,
                  body: dispatchEvent.body,
                  // Phase 4 cross-replica fix: include the
                  // structural attribution so peer companions can
                  // emit dispatch_from_thread /
                  // dispatch_in_workstream /
                  // dispatch_requested_coding_session from the
                  // event log alone — the dispatch JSONL is per-
                  // replica and doesn't sync.
                  ...(dispatchEvent.sourceThreadId === undefined
                    ? {}
                    : { sourceThreadId: dispatchEvent.sourceThreadId }),
                  ...(dispatchEvent.mcpRequest === undefined
                    ? {}
                    : {
                        mcpRequest: {
                          codingSessionId: dispatchEvent.mcpRequest.codingSessionId,
                        },
                      }),
                  ...(dispatchEvent.title === undefined ? {} : { title: dispatchEvent.title }),
                },
              })
              .catch(() => undefined);
          }
          return [
            201,
            {
              data: {
                ...result,
                // F01: return the SAFE text the companion stored so the
                // extension can render/copy exactly that instead of the
                // caller's pre-redaction original. `body` is redacted;
                // `redaction.rules` are the applied rule ids.
                body: dispatchEvent.body,
                redactionSummary: dispatchEvent.redactionSummary,
                redaction: {
                  applied: redaction.matched > 0,
                  rules: [...redaction.categories],
                },
                tokenEstimate,
                tokenWarning: {
                  provider: input.target.provider,
                  threshold: tokenThreshold,
                  exceeded: tokenBudgetExceeded,
                },
              },
              ...(tokenBudgetExceeded ? { warnings: ['token-budget-exceeded'] } : {}),
            },
          ];
        },
        async (cached) => {
          // Self-heal dead idempotent references: the 24h cache TTL
          // outlives the underlying JSONL record when an operator
          // purges, prunes, or retention-rotates it. If the cached
          // dispatch's bac_id is no longer in the vault, the agent
          // should get a fresh dispatch (and the cache overwrite
          // updates the entry to the new id).
          const cachedRecord = cached as { readonly data?: { readonly bac_id?: unknown } };
          const bacId = cachedRecord.data?.bac_id;
          if (typeof bacId !== 'string' || bacId.length === 0) {
            return false;
          }
          // readDispatchEvents reads the most-recent 100 days of
          // dispatch JSONL files, which is more than the 24h cache
          // TTL covers. If the dispatch is anywhere in that window,
          // the cached response is still valid.
          const events = await context.vaultWriter.readDispatchEvents({ limit: 1000 });
          return events.some((event) => event.bac_id === bacId);
        },
      );
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/dispatches$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const query = dispatchListQuerySchema.parse({
        limit: url.searchParams.get('limit') ?? undefined,
        since: url.searchParams.get('since') ?? undefined,
      });
      return [200, { data: await context.vaultWriter.readDispatchEvents(query) }];
    },
  },
  {
    // Dispatch ↔ thread link table (Phase 3 of the spec-aligned
    // refactor). Replaces the extension-only chrome.storage map.
    // Idempotent on (dispatchId, threadId) pair: re-linking to the
    // same thread is a no-op; re-linking to a different thread
    // appends a new row and the latest one wins on read.
    method: 'POST',
    pattern: /^\/v1\/dispatches\/(?<bacId>[A-Za-z0-9_-]+)\/link$/,
    authRequired: true,
    handle: async (request, requestId, match, context) => {
      if (match.bacId === undefined) {
        throw new Error('Missing dispatch bacId path parameter.');
      }
      const body = dispatchLinkRequestSchema.parse(await readBody(request));
      const record = await context.vaultWriter.linkDispatchToThread(
        { dispatchId: match.bacId, threadId: body.threadId },
        requestId,
      );
      if (context.eventLog !== undefined) {
        await context.eventLog
          .appendServerObserved({
            clientEventId: requestId,
            aggregateId: match.bacId,
            type: DISPATCH_LINKED,
            payload: { dispatchId: match.bacId, threadId: body.threadId },
          })
          .catch(() => undefined);
      }
      return [200, { data: record }];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/dispatches\/projection$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => {
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      const dispatchEvents = await readEventsFromStoreOrLog(
        context,
        context.eventLog,
        (event) => event.type === DISPATCH_RECORDED || event.type === DISPATCH_LINKED,
        DISPATCH_PROJECTION_EVENT_TYPES,
      );
      return [200, { data: projectDispatches(dispatchEvents) }];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/dispatches\/(?<bacId>[A-Za-z0-9_-]+)\/link$/,
    authRequired: true,
    handle: async (_request, _requestId, match, context) => {
      if (match.bacId === undefined) {
        throw new Error('Missing dispatch bacId path parameter.');
      }
      const link = await context.vaultWriter.readLinkForDispatch(match.bacId);
      return [
        200,
        {
          data: link ?? { dispatchId: match.bacId, threadId: null, linkedAt: null },
        },
      ];
    },
  },
  {
    // Long-poll for dispatch capture. Resolves when the link table
    // has a record for this dispatchId, or after timeoutMs (default
    // 60s, capped at 120s). Subscribes to vaultChanges if available
    // so the wait is event-driven; falls back to a 1s polling loop
    // when no watcher is wired.
    method: 'GET',
    pattern: /^\/v1\/dispatches\/(?<bacId>[A-Za-z0-9_-]+)\/await-capture$/,
    authRequired: true,
    handle: async (request, _requestId, match, context) => {
      if (match.bacId === undefined) {
        throw new Error('Missing dispatch bacId path parameter.');
      }
      const dispatchId = match.bacId;
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const rawTimeout = url.searchParams.get('timeoutMs');
      const requested = rawTimeout === null ? 60_000 : Number.parseInt(rawTimeout, 10);
      const timeoutMs =
        Number.isFinite(requested) && requested > 0 ? Math.min(requested, 120_000) : 60_000;
      const vaultRoot = context.vaultRoot;

      const includeTurn = url.searchParams.get('includeLatestAssistantTurn') !== 'false';

      const buildResponse = async (
        link: Awaited<ReturnType<typeof context.vaultWriter.readLinkForDispatch>>,
      ) => {
        if (link === null) {
          return {
            dispatchId,
            matched: false,
            reason: 'timeout' as const,
          };
        }
        const meta =
          vaultRoot === undefined ? null : await readThreadMetadata(vaultRoot, link.threadId);
        // Phase-5-review: always surface `thread.threadId` plus a
        // `resources` URI map so the model can navigate without
        // remembering URI templates from prompt boilerplate.
        // threadUrl/title/provider attach when the thread record is
        // present in the vault; missing ones drop quietly so a thread
        // captured-but-not-yet-flushed still produces a useful payload.
        // Sanitize provider: the captured-thread schema accepts a
        // wider enum (`unknown`, `codex`, …) than the dispatch
        // target enum (chatgpt | claude | gemini). The MCP
        // await_capture outputSchema only declares the dispatch
        // target enum, so anything outside that set drops out
        // rather than surfacing as a schema-violating value.
        const dispatchTargetProviders = ['chatgpt', 'claude', 'gemini'] as const;
        const sanitizedProvider = dispatchTargetProviders.find(
          (candidate) => candidate === meta?.provider,
        );
        const thread = {
          threadId: link.threadId,
          ...(meta?.threadUrl === undefined ? {} : { threadUrl: meta.threadUrl }),
          ...(meta?.title === undefined ? {} : { title: meta.title }),
          ...(sanitizedProvider === undefined ? {} : { provider: sanitizedProvider }),
        };
        const resources = {
          dispatch: `sidetrack://dispatch/${dispatchId}`,
          thread: `sidetrack://thread/${link.threadId}`,
          turns: `sidetrack://thread/${link.threadId}/turns`,
          markdown: `sidetrack://thread/${link.threadId}/markdown`,
          annotations: `sidetrack://thread/${link.threadId}/annotations`,
        };
        // Latest assistant turn — read once now so the model doesn't
        // have to make a follow-up call. Best-effort: a missing
        // threadUrl or empty turn list both reduce to "no latestAssistantTurn".
        let latestAssistantTurn: { ordinal: number; text: string; capturedAt: string } | undefined;
        if (includeTurn && meta?.threadUrl !== undefined) {
          try {
            const turns = await context.vaultWriter.readRecentTurns({
              threadUrl: meta.threadUrl,
              limit: 5,
              role: 'assistant',
            });
            const latest = turns.slice().sort((left, right) => right.ordinal - left.ordinal)[0];
            if (latest !== undefined) {
              latestAssistantTurn = {
                ordinal: latest.ordinal,
                text: latest.text,
                capturedAt: latest.capturedAt,
              };
            }
          } catch {
            // best-effort
          }
        }
        return {
          dispatchId,
          matched: true,
          linkedAt: link.linkedAt,
          thread,
          resources,
          ...(latestAssistantTurn === undefined ? {} : { latestAssistantTurn }),
          reason: 'matched' as const,
        };
      };

      const initial = await context.vaultWriter.readLinkForDispatch(dispatchId);
      if (initial !== null) {
        return [200, { data: await buildResponse(initial) }];
      }

      const result = await new Promise<
        Awaited<ReturnType<typeof context.vaultWriter.readLinkForDispatch>>
      >((resolve) => {
        const timer = setTimeout(() => {
          unsubscribe();
          clearInterval(poll);
          resolve(null);
        }, timeoutMs);
        const poll = setInterval(() => {
          void context.vaultWriter.readLinkForDispatch(dispatchId).then((link) => {
            if (link !== null) {
              clearTimeout(timer);
              clearInterval(poll);
              unsubscribe();
              resolve(link);
            }
          });
        }, 1000);
        const unsubscribe =
          context.vaultChanges?.subscribe((event) => {
            if (event.relPath.startsWith('_BAC/dispatch-links/')) {
              void context.vaultWriter.readLinkForDispatch(dispatchId).then((link) => {
                if (link !== null) {
                  clearTimeout(timer);
                  clearInterval(poll);
                  unsubscribe();
                  resolve(link);
                }
              });
            }
          }) ?? (() => undefined);
      });

      return [200, { data: await buildResponse(result) }];
    },
  },
];

export const dispatchesRoutesB: readonly RouteDefinition[] = [
  {
    // Per-dispatch projection. F15 — extension's SSE subscriber
    // hits this when `_BAC/dispatches/<bac_id>.json` changes.
    method: 'GET',
    pattern: /^\/v1\/dispatches\/(?<bacId>[A-Za-z0-9_-]+)\/projection$/,
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
      const projection = projectDispatches(merged);
      const entry = projection.entries.find((row) => row.bac_id === match.bacId);
      const link = projection.links.find((row) => row.dispatchId === match.bacId);
      return [
        200,
        {
          data: {
            ...(entry === undefined ? {} : { entry }),
            ...(link === undefined ? {} : { link }),
            vector: projection.vector,
            updatedAtMs: projection.updatedAtMs,
          },
        },
      ];
    },
  },
];
