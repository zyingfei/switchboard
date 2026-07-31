// Entity routes: list and single-entity read.
//
// Extracted verbatim from server.ts in stage S2 of the cost-of-change
// refactor; order within this array is dispatch order and is pinned by
// routeTable.characterization.test.ts.

import { SqliteConnectionsStore } from '../../connections/snapshot.js';
import { ENTITY_LIST_MAX, entityIndexEnabled, listEntities, loadEntityIndex, lookupEntity, type EntityIndex } from '../../enrichment/entityIndex.js';
import { deserializeUrlProjection } from '../../urls/projection.js';

import { HttpRouteError } from '../routeSupport.js';
import type { CompanionHttpConfig, RouteDefinition } from '../routeSupport.js';

// Authoritative canonicalUrl → workstream lookup for any read surface that
// needs to know where a URL is FILED.
//
// The resolver's snapshot is SCOPED to a request's own URLs, so a neighbor's
// membership edges are usually absent from it — joining on the snapshot alone
// reported "none filed to a workstream" while live neighbors were user-filed
// (caught by the user, 2026-07-27). The URL attribution projection is the
// filing record of truth.
//
// STRICTLY the metadata-only read (SqliteConnectionsStore.readSnapshotMetadata):
// no read surface may pay a full readCurrent / event-log fold for a join (the
// resolve route's perf contract, asserted in visitsRoutes.test.ts). On any
// other store shape this returns undefined and the caller keeps whatever
// fallback it has.
//
// EXTRACTED (not copied) so the content/AI lanes and the entity index share
// one definition of "where is this URL filed" — two copies of a join is how
// two answers to the same question start disagreeing.
export const urlWorkstreamLookupFromProjection = async (
  context: CompanionHttpConfig,
): Promise<((canonicalUrl: string) => string | undefined) | undefined> => {
  if (!(context.connectionsStore instanceof SqliteConnectionsStore)) return undefined;
  try {
    const metadata = await context.connectionsStore.readSnapshotMetadata();
    if (metadata?.urlProjection === undefined) return undefined;
    const projection = deserializeUrlProjection(metadata.urlProjection);
    return (canonicalUrl: string): string | undefined =>
      projection.byCanonicalUrl.get(canonicalUrl)?.currentAttribution?.workstreamId ?? undefined;
  } catch {
    return undefined;
  }
};

// Entity index for a read request (GET /v1/entities…). Threads the SAME
// projection join the content lane uses, so "which workstream is this page
// filed under" has one answer across the whole companion. Returns null when
// there is nothing to derive from (no vault / no event log / gist fold off) —
// typed absence, which the routes render as typed empty with the reason
// named, never as "no entities exist".
const loadEntityIndexForRequest = async (
  context: CompanionHttpConfig,
): Promise<EntityIndex | null> => {
  if (context.vaultRoot === undefined || context.eventLog === undefined) return null;
  const lookupWorkstreamByUrl = await urlWorkstreamLookupFromProjection(context);
  const { index } = await loadEntityIndex(
    context.vaultRoot,
    context.eventLog,
    lookupWorkstreamByUrl === undefined ? {} : { lookupWorkstreamByUrl },
  );
  return index;
};

// The typed-empty body for GET /v1/entities. Same field set as a populated
// response (zeroed) plus the REASON — a client rendering "no entities yet"
// must be able to tell "the switch is off" from "nothing has a gist yet",
// because those invite completely different responses from the user.
const entityIndexUnavailable = (
  emptyReason: string,
  disabled = false,
): { readonly data: Record<string, unknown> } => ({
  data: {
    entities: [],
    hubs: 0,
    gists: 0,
    scanned: 0,
    dropped: 0,
    ...(disabled ? { disabled: true } : {}),
    emptyReason,
  },
});

export const entitiesRoutes: readonly RouteDefinition[] = [
  {
    // Entity layer v1 — GET /v1/entities. The conceptual index the gists have
    // been producing all along (review §G4/§E3): every `Key Entities:` line
    // the on-device model wrote, parsed, deduped, and joined to the
    // workstreams its pages are filed under.
    //
    // DERIVED, NOT STORED. No new event type: the index is a pure fold over
    // the SAME ENTITY_CONTENT_ENRICHED events the gist lookup already folds
    // (entityIndex.ts). So it covers every gist already in the vault, and a
    // retracted gist's entities disappear with it for free.
    //
    // FROZEN CONTRACT: 200 { data: { entities: [{ name, kinds, refCount,
    // workstreams, hub }], … } }, sorted by refCount desc (ties by name), cap
    // ENTITY_LIST_MAX. HUBS ARE EXCLUDED — an entity in >25% of gists or with
    // >30 refs is the vault's subject matter, not a link between two pages,
    // and listing it buries everything that discriminates. It stays reachable
    // by exact name (the route below), which is why `hub` is in the item
    // shape at all. The sibling counters (hubs/gists/scanned/dropped) are
    // REPORT-NOT-SILENT: how many entities were damped, how much of the
    // corpus carried entities, and how many candidates the parser rejected.
    //
    // KILL SWITCH SIDETRACK_ENTITY_INDEX (default ON — read-only derivation
    // over data that already exists). '0'/'false' ⇒ typed empty with the
    // reason named, and the fold is never built.
    method: 'GET',
    pattern: /^\/v1\/entities$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => {
      if (!entityIndexEnabled()) {
        return [
          200,
          entityIndexUnavailable('entity index disabled (SIDETRACK_ENTITY_INDEX=0)', true),
        ];
      }
      const index = await loadEntityIndexForRequest(context);
      if (index === null) {
        return [200, entityIndexUnavailable('no enrichment event log on this companion')];
      }
      return [
        200,
        {
          data: {
            entities: listEntities(index, ENTITY_LIST_MAX),
            hubs: index.hubCount,
            gists: index.gistCount,
            scanned: index.scannedCount,
            dropped: index.droppedCandidates,
          },
        },
      ];
    },
  },
  {
    // Entity dossier — GET /v1/entities/{name}. The full entry INCLUDING its
    // refs: which pages/threads named this entity and where each is filed.
    // This is the "show me everything touching Kimi Delta Attention" surface
    // the review calls out; the listing route is the index into it.
    //
    // The name is URL-ENCODED and matched CASE-INSENSITIVELY — model prose
    // capitalizes inconsistently ("OpenAI" / "openai"), and a lookup that
    // demanded the exact spelling would 404 on the user's own reading of the
    // page. Case folding happens in entityKeyFor, the single place the fold
    // and this route share, so the two can never disagree on identity.
    //
    // HUBS ARE RETURNED HERE. A caller who names an entity explicitly gets
    // the honest answer including `hub: true`; damping suppresses the
    // LISTING, it never hides a fact from someone who asked for it.
    //
    // 404 is a TYPED problem (ENTITY_NOT_FOUND) and means exactly "no gist in
    // this vault names that" — the disabled flag returns typed empty instead,
    // because "the feature is off" and "nothing named it" are different facts
    // and answering the first with the second is a lie.
    method: 'GET',
    pattern: /^\/v1\/entities\/(?<entityName>[^/]+)$/u,
    authRequired: true,
    handle: async (_request, _requestId, match, context) => {
      if (!entityIndexEnabled()) {
        return [
          200,
          {
            data: {
              entity: null,
              disabled: true,
              emptyReason: 'entity index disabled (SIDETRACK_ENTITY_INDEX=0)',
            },
          },
        ];
      }
      let name: string;
      try {
        name = decodeURIComponent(match.entityName ?? '');
      } catch {
        // A malformed percent-escape is a caller bug, not a missing entity.
        throw new HttpRouteError(
          400,
          'VALIDATION_ERROR',
          'Validation failed.',
          'Entity name must be URL-encoded.',
        );
      }
      const index = await loadEntityIndexForRequest(context);
      if (index === null) {
        return [
          200,
          {
            data: {
              entity: null,
              emptyReason: 'no enrichment event log on this companion',
            },
          },
        ];
      }
      const entry = lookupEntity(index, name);
      if (entry === undefined) {
        throw new HttpRouteError(
          404,
          'ENTITY_NOT_FOUND',
          'Entity not found.',
          'No gist in this vault names that entity.',
        );
      }
      return [
        200,
        {
          data: {
            entity: {
              name: entry.display,
              kinds: entry.kinds,
              refCount: entry.refs.length,
              workstreams: entry.workstreams,
              hub: entry.hub,
              refs: entry.refs,
            },
          },
        },
      ];
    },
  },
];
