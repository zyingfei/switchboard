// Workstream routes: create, projections, projection, markdown, export,
// trust read/write, bump, patch, delete, and linked-notes.
//
// Extracted verbatim from server.ts in stage S2 of the cost-of-change
// refactor; order within this array is dispatch order and is pinned by
// routeTable.characterization.test.ts.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { defaultAllowedTools, readTrust, writeTrust } from '../../auth/workstreamTrust.js';
import { appleFmStatus } from '../../enrichment/appleFmEngine.js';
import { loadGistLookup } from '../../enrichment/contentEnrichment.js';
import { scanVaultForLinkedNotes } from '../../vault/linkback.js';
import { WorkstreamHasChildrenError } from '../../vault/writer.js';
import { WORKSTREAM_DELETED, WORKSTREAM_PROTOTYPE_GENERATED, WORKSTREAM_UPSERTED } from '../../workstreams/events.js';
import { projectWorkstream } from '../../workstreams/projection.js';
import { foldLatestPrototypeGenerations } from '../../workstreams/prototypeGeneration.js';
import { gatherWorkstreamEvidence, workstreamEvidenceLanguage, type WorkstreamEvidenceItem } from '../../workstreams/prototypeEvidence.js';
import { computeWorkstreamPrototypeStatus } from '../../workstreams/prototypeStatus.js';
import {
  createSuggestionCandidateStore,
  NEW_CATEGORY_SCOPE_ID,
  SUGGESTION_CANDIDATE_KINDS,
  type SuggestionCandidateKind,
} from '../../workstreams/suggestionCandidateStore.js';
import { workstreamCreateSchema, workstreamExportSchema, workstreamTrustPutSchema, workstreamUpdateSchema } from '../schemas.js';

import { HttpRouteError, objectRecord, readAggregateEventsServeStale, ROUTE_CACHE_TTL_MS, mutationResponse, readBody, readEventsFromStoreOrLog, readVaultMarkdown, requireVaultRoot, requireWorkstreamTrust, routeCache, routeInFlight } from '../routeSupport.js';
import type { RouteDefinition } from '../routeSupport.js';

const cachedRoute = async (
  key: string,
  ttlMs: number,
  build: () => Promise<readonly [number, unknown]>,
): Promise<readonly [number, unknown]> => {
  const cached = routeCache.get(key);
  if (cached !== undefined && Date.now() - cached.computedAtMs < ttlMs) {
    return cached.result;
  }
  const inFlight = routeInFlight.get(key);
  if (inFlight !== undefined) return inFlight;
  const compute = (async (): Promise<readonly [number, unknown]> => {
    try {
      const result = await build();
      if (result[0] === 200) {
        routeCache.set(key, { result, computedAtMs: Date.now() });
        if (routeCache.size > 256) {
          const now = Date.now();
          for (const [k, v] of routeCache) {
            if (now - v.computedAtMs >= ttlMs) routeCache.delete(k);
          }
        }
      }
      return result;
    } finally {
      routeInFlight.delete(key);
    }
  })();
  routeInFlight.set(key, compute);
  return compute;
};

const WORKSTREAM_PROJECTION_EVENT_TYPES = [WORKSTREAM_UPSERTED, WORKSTREAM_DELETED] as const;

export const workstreamsRoutes: readonly RouteDefinition[] = [
  {
    method: 'POST',
    pattern: /^\/v1\/workstreams$/,
    authRequired: true,
    handle: async (request, requestId, _match, context) => {
      const input = workstreamCreateSchema.parse(await readBody(request));
      // F32 — creating a CHILD workstream is trust-gated on the parent
      // for MCP-key callers; a top-level create (no parentId) has no
      // scope to check and passes. Extension surface is exempt.
      await requireWorkstreamTrust(
        context,
        request,
        input.parentId,
        'sidetrack.workstreams.create',
      );
      const result = await context.vaultWriter.createWorkstream(input, requestId);
      if (context.eventLog !== undefined) {
        await context.eventLog
          .appendServerObserved({
            clientEventId: requestId,
            aggregateId: result.bac_id,
            type: WORKSTREAM_UPSERTED,
            payload: {
              bac_id: result.bac_id,
              title: input.title,
              ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
              // Match the writer's default (createWorkstream stamps
              // `privacy: input.privacy ?? 'private'`) so the event log
              // never disagrees with the persisted record.
              privacy: input.privacy ?? 'private',
              ...(input.screenShareSensitive === undefined
                ? {}
                : { screenShareSensitive: input.screenShareSensitive }),
              ...(input.tags === undefined ? {} : { tags: input.tags }),
              ...(input.children === undefined ? {} : { children: input.children }),
              ...(input.checklist === undefined ? {} : { checklist: input.checklist }),
              ...(input.description === undefined ? {} : { description: input.description }),
            },
          })
          .catch(() => undefined);
      }
      return [201, mutationResponse(result, requestId)];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/workstreams\/projections$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => {
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      // Bulk endpoint used by extension's refreshCachedWorkstreams: enumerate
      // every aggregate id touched by a WORKSTREAM_UPSERTED or
      // WORKSTREAM_DELETED event and project each one. This is the bridge
      // from the companion's relay-replicated event log to the extension's
      // chrome.storage cache, so workstreams created on Browser A reach
      // Browser B's side panel via the standard sync path.
      return cachedRoute(
        'wsproj',
        ROUTE_CACHE_TTL_MS,
        async (): Promise<readonly [number, unknown]> => {
          const events = await readEventsFromStoreOrLog(
            context,
            context.eventLog!,
            (event) => event.type === WORKSTREAM_UPSERTED || event.type === WORKSTREAM_DELETED,
            WORKSTREAM_PROJECTION_EVENT_TYPES,
          );
          // Bucket per-bacId once so each projectWorkstream call sees
          // only its own events. Without bucketing this is
          // O(aggregates × events) and stalls the route on large
          // vaults — same fix as buildConnectionsSnapshot.
          const eventsByBacId = new Map<string, typeof events[number][]>();
          for (const event of events) {
            const existing = eventsByBacId.get(event.aggregateId);
            if (existing === undefined) eventsByBacId.set(event.aggregateId, [event]);
            else existing.push(event);
          }
          const projections = [...eventsByBacId.keys()]
            .sort()
            .map((bacId) => projectWorkstream(bacId, eventsByBacId.get(bacId) ?? []));
          return [200, { data: projections }];
        },
      );
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/workstreams\/(?<bacId>[A-Za-z0-9_-]+)\/projection$/,
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
      const projection = projectWorkstream(match.bacId, events);
      return [200, { data: projection }];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/workstreams\/(?<bacId>[A-Za-z0-9_-]+)\/markdown$/,
    authRequired: true,
    handle: async (_request, _requestId, match, context) => {
      if (match.bacId === undefined) {
        throw new Error('Missing bacId path parameter.');
      }
      return [200, await readVaultMarkdown(requireVaultRoot(context), 'workstreams', match.bacId)];
    },
  },
  {
    // §13 step 13 — user-facing Markdown export of a workstream (and,
    // when includeThreads is set, its threads). Writes tree-path report
    // files OUTSIDE _BAC/ via the writer's atomic primitive, returning
    // vault-root-relative paths. Normal bridge-key route.
    method: 'POST',
    pattern: /^\/v1\/workstreams\/(?<bacId>[A-Za-z0-9_-]+)\/export$/,
    authRequired: true,
    handle: async (request, _requestId, match, context) => {
      if (match.bacId === undefined) {
        throw new Error('Missing bacId path parameter.');
      }
      requireVaultRoot(context);
      // readBody returns {} for an empty POST, so includeThreads defaults off.
      const input = workstreamExportSchema.parse(await readBody(request));
      const result = await context.vaultWriter.exportWorkstream(match.bacId, {
        ...(input.includeThreads === undefined ? {} : { includeThreads: input.includeThreads }),
      });
      return [200, { data: { files: [...result.files] } }];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/workstreams\/(?<workstreamId>[A-Za-z0-9_-]+)\/trust$/,
    authRequired: true,
    handle: async (_request, _requestId, match, context) => {
      if (match.workstreamId === undefined) {
        throw new Error('Missing workstreamId path parameter.');
      }
      const record = (await readTrust(requireVaultRoot(context))).find(
        (item) => item.workstreamId === match.workstreamId,
      );
      return [
        200,
        {
          data: {
            workstreamId: match.workstreamId,
            // Fresh workstreams (no explicit record on disk) default
            // to NO allowed write tools — matches isAllowed's
            // deny-by-default semantic (PRD §6.1.14, re-recorded
            // 2026-07-11): MCP write trust is opt-in per workstream.
            allowedTools:
              record === undefined ? [...defaultAllowedTools()] : [...record.allowedTools],
          },
        },
      ];
    },
  },
  {
    method: 'PUT',
    pattern: /^\/v1\/workstreams\/(?<workstreamId>[A-Za-z0-9_-]+)\/trust$/,
    authRequired: true,
    handle: async (request, _requestId, match, context) => {
      if (match.workstreamId === undefined) {
        throw new Error('Missing workstreamId path parameter.');
      }
      const input = workstreamTrustPutSchema.parse(await readBody(request));
      const vaultRoot = requireVaultRoot(context);
      const current = await readTrust(vaultRoot);
      await writeTrust(vaultRoot, [
        ...current.filter((record) => record.workstreamId !== match.workstreamId),
        { workstreamId: match.workstreamId, allowedTools: new Set(input.allowedTools) },
      ]);
      return [
        200,
        { data: { workstreamId: match.workstreamId, allowedTools: input.allowedTools } },
      ];
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/workstreams\/(?<bacId>[A-Za-z0-9_-]+)\/bump$/,
    authRequired: true,
    handle: async (_request, requestId, match, context) => {
      if (match.bacId === undefined) {
        throw new Error('Missing bacId path parameter.');
      }
      await requireWorkstreamTrust(context, _request, match.bacId, 'sidetrack.workstreams.bump');
      return [
        200,
        mutationResponse(
          await context.vaultWriter.bumpWorkstream(match.bacId, requestId),
          requestId,
        ),
      ];
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/v1\/workstreams\/(?<workstreamId>[A-Za-z0-9_-]+)$/,
    authRequired: true,
    handle: async (request, requestId, match, context) => {
      if (match.workstreamId === undefined) {
        throw new Error('Missing workstreamId path parameter.');
      }
      const input = workstreamUpdateSchema.parse(await readBody(request));
      const result = await context.vaultWriter.updateWorkstream(
        match.workstreamId,
        input,
        requestId,
      );
      // PATCH semantics: the input is a delta. Re-read the full
      // record after the vault write so the emitted event carries a
      // complete snapshot. Per-field registers (a finer CRDT) are
      // documented as future work; for now a full-snapshot register
      // matches the existing vault semantics.
      if (context.eventLog !== undefined) {
        const vaultRoot = requireVaultRoot(context);
        try {
          const raw = await readFile(
            join(vaultRoot, '_BAC', 'workstreams', `${match.workstreamId}.json`),
            'utf8',
          );
          const record = JSON.parse(raw) as Record<string, unknown>;
          if (typeof record['bac_id'] === 'string' && typeof record['title'] === 'string') {
            await context.eventLog.appendServerObserved({
              clientEventId: requestId,
              aggregateId: match.workstreamId,
              type: WORKSTREAM_UPSERTED,
              payload: {
                bac_id: record['bac_id'],
                title: record['title'],
                ...(typeof record['parentId'] === 'string' ? { parentId: record['parentId'] } : {}),
                ...(typeof record['privacy'] === 'string' ? { privacy: record['privacy'] } : {}),
                ...(Array.isArray(record['tags']) ? { tags: record['tags'] } : {}),
                ...(typeof record['description'] === 'string'
                  ? { description: record['description'] }
                  : {}),
              },
            });
          }
        } catch {
          // Best effort — the vault write succeeded regardless.
        }
      }
      return [200, mutationResponse(result, requestId)];
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/v1\/workstreams\/(?<workstreamId>[A-Za-z0-9_-]+)$/,
    authRequired: true,
    handle: async (_request, requestId, match, context) => {
      if (match.workstreamId === undefined) {
        throw new Error('Missing workstreamId path parameter.');
      }
      try {
        const result = await context.vaultWriter.deleteWorkstream(match.workstreamId, requestId);
        // F12 — emit workstream.deleted so peers learn of the
        // deletion. Without this, the local file is removed but the
        // event log is silent; the peer's mirror keeps the row
        // forever and any thread the user moved to this workstream
        // (which DID emit a thread.upserted with the new ws-id)
        // points at a dangling reference on the peer.
        if (context.eventLog !== undefined) {
          await context.eventLog
            .appendServerObserved({
              clientEventId: requestId,
              aggregateId: result.bac_id,
              type: WORKSTREAM_DELETED,
              payload: { bac_id: result.bac_id },
            })
            .catch(() => undefined);
        }
        return [
          200,
          {
            data: {
              bac_id: result.bac_id,
              detachedThreadIds: result.detachedThreadIds,
            },
            requestId,
          },
        ];
      } catch (error) {
        if (error instanceof WorkstreamHasChildrenError) {
          throw new HttpRouteError(
            409,
            'WORKSTREAM_HAS_CHILDREN',
            `Cannot delete — ${String(error.childCount)} child workstream(s) remain. Detach or delete children first.`,
          );
        }
        throw error;
      }
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/workstreams\/(?<workstreamId>[A-Za-z0-9_-]+)\/linked-notes$/,
    authRequired: true,
    handle: async (_request, _requestId, match, context) => {
      if (match.workstreamId === undefined) {
        throw new Error('Missing workstreamId path parameter.');
      }
      if (context.vaultRoot === undefined) {
        throw new Error('Vault root is unavailable.');
      }
      const notes = await scanVaultForLinkedNotes(context.vaultRoot);
      return [200, { items: notes.filter((note) => note.workstreamId === match.workstreamId) }];
    },
  },
  // UI-visibility phase (docs/plans/2026-08-16-category-flexibility-hyde.md,
  // "very little visibility about how hyDE works") — per-workstream
  // prototype-lane status, read-only. NO new computation: folds the SAME
  // WORKSTREAM_PROTOTYPE_GENERATED events prototypeGeneration.ts's own
  // background tick already writes, joined against the SAME evidence
  // gatherer + Apple FM probe that tick already calls. Every workstream
  // that either has current evidence or has ever generated is included, so
  // a workstream that fell below the floor after prototypes were deleted
  // (impossible today, but future-proof) still reports honestly.
  {
    method: 'GET',
    pattern: /^\/v1\/workstreams\/prototypes\/status$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => {
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      const eventLog = context.eventLog;
      const evidenceByWorkstream =
        context.connectionsStore === undefined
          ? new Map<string, readonly WorkstreamEvidenceItem[]>()
          : await gatherWorkstreamEvidence(
              context.connectionsStore,
              await loadGistLookup(requireVaultRoot(context), eventLog).catch(() => null),
            ).catch(() => new Map<string, readonly WorkstreamEvidenceItem[]>());
      const generationEvents = await readEventsFromStoreOrLog(
        context,
        eventLog,
        (event) => event.type === WORKSTREAM_PROTOTYPE_GENERATED,
        [WORKSTREAM_PROTOTYPE_GENERATED],
      );
      const lastByWorkstream = foldLatestPrototypeGenerations(generationEvents);
      const appleFm = await appleFmStatus().catch(() => undefined);
      const workstreamIds = new Set([...evidenceByWorkstream.keys(), ...lastByWorkstream.keys()]);
      const statuses = [...workstreamIds]
        .sort()
        .map((workstreamId) => {
          const items = evidenceByWorkstream.get(workstreamId) ?? [];
          return computeWorkstreamPrototypeStatus(
            workstreamId,
            items.length,
            workstreamEvidenceLanguage(items) === 'en',
            lastByWorkstream.get(workstreamId),
            appleFm,
          );
        });
      return [200, { data: { statuses } }];
    },
  },
  // Split / new-category suggestion read surface (design doc §4) — ONE
  // route for BOTH kinds the store already discriminates
  // (`suggestionCandidateStore.ts`'s `kind: 'split' | 'new-category'`, PR
  // #376), so a caller doesn't need to know the internal `__unfiled__`
  // scope sentinel: `kind=split` requires `workstreamId` (the scope IS
  // that workstream's own evidence); `kind=new-category` ignores
  // `workstreamId` and always reads the fixed unfiled-pool scope. Only
  // candidates that are BOTH `emitted` (stability-gated) AND not
  // `dismissed` (declined) are ever returned — never a still-forming or
  // declined one. The engine (splitSuggestionEngine.ts) is wired and
  // tested but not yet fed live evidence in production — see PR #376's
  // landing note §8 — so this route HONESTLY returns an empty array until
  // a future recompute pass populates the store; it is a real read
  // surface, not a placeholder, and starts working the moment that
  // recompute is wired in.
  {
    method: 'GET',
    pattern: /^\/v1\/workstreams\/suggestions$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const url = new URL(request.url ?? '/v1/workstreams/suggestions', 'http://internal');
      const rawKind = url.searchParams.get('kind');
      if (!(SUGGESTION_CANDIDATE_KINDS as readonly string[]).includes(rawKind ?? '')) {
        throw new HttpRouteError(
          400,
          'VALIDATION_ERROR',
          'Validation failed.',
          `kind query param must be one of ${SUGGESTION_CANDIDATE_KINDS.join(', ')}.`,
        );
      }
      const kind = rawKind as SuggestionCandidateKind;
      const workstreamId = url.searchParams.get('workstreamId') ?? undefined;
      if (kind === 'split' && (workstreamId === undefined || workstreamId.length === 0)) {
        throw new HttpRouteError(
          400,
          'VALIDATION_ERROR',
          'Validation failed.',
          'workstreamId query param is required when kind=split.',
        );
      }
      const scopeId = kind === 'new-category' ? NEW_CATEGORY_SCOPE_ID : (workstreamId as string);
      const store = await createSuggestionCandidateStore(requireVaultRoot(context));
      try {
        const candidates = store
          .candidatesFor(scopeId, kind)
          .filter((candidate) => candidate.emitted && !candidate.dismissed)
          .slice()
          .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
          .map((candidate) => ({
            kind,
            scopeId: candidate.scopeId,
            fingerprint: candidate.fingerprint,
            memberIds: candidate.memberIds,
            memberCount: candidate.memberIds.length,
            suggestedName: candidate.structuralName,
            updatedAt: candidate.updatedAtMs,
          }));
        return [200, { data: { candidates } }];
      } finally {
        store.close();
      }
    },
  },
  // Decline a split/new-category suggestion candidate — the whole-cluster
  // counterpart to the per-URL `POST /v1/visits/:url/suggestions/decline`
  // (PR #376): that route declines "this URL into this EXISTING
  // workstream"; this one declines "this proposed NEW grouping, which has
  // no workstream yet." Sticky (`dismissCandidate`) — the same fingerprint
  // never resurfaces even across future recomputes, matching the "per-
  // scope decline memory means it never recurs" requirement for the other
  // suggestion surfaces in this feature.
  {
    method: 'POST',
    pattern: /^\/v1\/workstreams\/suggestions\/decline$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const body = objectRecord(await readBody(request));
      const rawKind = body?.['kind'];
      if (!(SUGGESTION_CANDIDATE_KINDS as readonly string[]).includes(rawKind as string)) {
        throw new HttpRouteError(
          400,
          'VALIDATION_ERROR',
          'Validation failed.',
          `Body must contain kind as one of ${SUGGESTION_CANDIDATE_KINDS.join(', ')}.`,
        );
      }
      const kind = rawKind as SuggestionCandidateKind;
      const fingerprint = body?.['fingerprint'];
      if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
        throw new HttpRouteError(
          400,
          'VALIDATION_ERROR',
          'Validation failed.',
          'Body must contain fingerprint as a non-empty string.',
        );
      }
      const workstreamId = body?.['workstreamId'];
      if (kind === 'split' && (typeof workstreamId !== 'string' || workstreamId.length === 0)) {
        throw new HttpRouteError(
          400,
          'VALIDATION_ERROR',
          'Validation failed.',
          'Body must contain workstreamId as a non-empty string when kind is "split".',
        );
      }
      const scopeId = kind === 'new-category' ? NEW_CATEGORY_SCOPE_ID : (workstreamId as string);
      const store = await createSuggestionCandidateStore(requireVaultRoot(context));
      try {
        const dismissed = store.dismissCandidate(scopeId, kind, fingerprint, Date.now());
        return [201, { data: { dismissed } }];
      } finally {
        store.close();
      }
    },
  },
];
