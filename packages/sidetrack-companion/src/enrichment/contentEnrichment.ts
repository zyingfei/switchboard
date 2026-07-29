// Content enrichment — the companion half of the WebGPU content-gist arc.
//
// Sibling of titleEnrichment.ts. Where title enrichment overlays a synthesized
// TITLE onto a junk-titled entity, content enrichment attaches a synthesized
// GIST (a paragraph-scale prose summary) so the entity becomes RETRIEVABLE by
// concepts its raw title/URL never carried. The panel synthesizes the gist
// on-device (WebGPU) and POSTs it to /v1/enrichment/content; each accepted item
// appends one ENTITY_CONTENT_ENRICHED event, and the served surface is DERIVED
// by folding those events — never a mutable side table.
//
// SHARED IDEMPOTENCY. The dedupe key is (kind,id,sourceContentHash), computed by
// the SAME enrichmentClientEventId helper the title path uses (single source of
// truth — the two enrichment families can never drift on how the key is
// derived). Re-posting the same triple binds to the existing event ⇒ no-op
// (skipped); a new hash for the same (kind,id) supersedes in the fold.
//
// SHARED FLAG. Governed by the SAME SIDETRACK_TITLE_ENRICHMENT flag as titles —
// that flag now governs ENRICHMENT INGESTION AS A WHOLE (title + content). The
// name is kept (not renamed) so existing runbooks/tests keep working; this
// comment is the documentation that the flag's scope widened.
//
// COST DISCIPLINE. The fold + memo mirror titleEnrichment.ts exactly (typed
// store read via events_type_idx, memo on the event-log content signature).
// Content-enriched events are sparse relative to the engagement log, so a warm
// serve pays only the cheap logSignature() stats.

import type { AcceptedEvent } from '../sync/causal.js';
import type { EventLog } from '../sync/eventLog.js';
import { getCaughtUpSharedEventStore } from '../sync/eventStore.js';

import {
  ENTITY_CONTENT_ENRICHED,
  ENTITY_ENRICHMENT_RETRACTED,
  type EntityContentEnrichedPayload,
  type EntityTitleEnrichedKind,
  isEntityContentEnrichedPayload,
  isEntityEnrichmentRetractedPayload,
} from './events.js';
import {
  enrichmentClientEventId,
  titleEnrichmentEnabled,
  type EnrichmentAppendOutcome,
} from './titleEnrichment.js';

// Re-export the event contract so consumers import the whole content-enrichment
// surface (event + guard + gist lookup) from this one module.
export {
  ENTITY_CONTENT_ENRICHED,
  ENRICHED_GIST_MAX_LENGTH,
  isEntityContentEnrichedPayload,
} from './events.js';
export type {
  EntityContentEnrichedEventType,
  EntityContentEnrichedPayload,
} from './events.js';

// ---- folded gist lookup -----------------------------------------------

export interface GistEntry {
  readonly gist: string;
  readonly sourceContentHash: string;
  /**
   * When the panel synthesized this gist (the payload's own `generatedAt`).
   * Carried through the fold because an UNSCOPED retraction is resolved
   * against it — see foldContentEnrichmentEvents.
   */
  readonly generatedAt: string;
}

// kind:id → {gist, hash}. A pure fold over ENTITY_CONTENT_ENRICHED events: last
// writer per key wins, idempotent per sourceContentHash. Distinct kinds never
// collide (key is kind-prefixed).
export type GistLookup = ReadonlyMap<string, GistEntry>;

const foldKey = (kind: EntityTitleEnrichedKind, id: string): string => `${kind}:${id}`;

// The INVERSE of foldKey, exported so downstream folds (entityIndex.ts) can
// walk a GistLookup back to the (kind,id) it came from without re-deriving
// the key shape — one place owns "how a gist entry is keyed", so the two can
// never drift. Split on the FIRST colon only: a 'url' id is a canonicalUrl
// and carries its own colons ("https://…"). Returns null for a key whose
// prefix is not a known kind, which is a corrupt key rather than a missing
// entry — callers skip it instead of inventing an entity.
export const parseGistLookupKey = (
  key: string,
): { readonly kind: EntityTitleEnrichedKind; readonly id: string } | null => {
  const at = key.indexOf(':');
  if (at <= 0 || at + 1 >= key.length) return null;
  const kind = key.slice(0, at);
  if (kind !== 'url' && kind !== 'thread') return null;
  return { kind, id: key.slice(at + 1) };
};

// Look up the synthesized gist for a (kind,id). Returns undefined when there is
// no enrichment OR the flag is off (the lookup is null then).
export const lookupGist = (
  lookup: GistLookup | null,
  kind: EntityTitleEnrichedKind,
  id: string,
): string | undefined => {
  if (lookup === null) return undefined;
  return lookup.get(foldKey(kind, id))?.gist;
};

// Fold a stream of events into the gist lookup. Idempotent per
// (kind,id,sourceContentHash); a new hash supersedes. Non-content / malformed
// events are skipped. Exported for unit tests.
//
// RETRACTIONS are honored here, and deliberately NOT by stream position.
//
// The typed store read returns `ORDER BY replica_id, seq` — replica-major, not
// global log order. So "delete the entry standing at this point in the stream"
// would make a retraction's effect depend on which replica happened to sort
// first: a retraction could silently fail to apply, which is the worst outcome
// available (an operator told the system to forget something and it kept it).
//
// Instead a retraction is resolved against the SEMANTIC timestamps the two
// payloads already carry — `generatedAt` vs `retractedAt` — in a second pass
// over the folded map. That is order-independent and says exactly what a
// retraction means: withdraw the enrichment that existed when I retracted it.
// A gist generated AFTER the retraction survives, so re-running synthesis
// against a fixed model works and a retraction never blacklists an entity.
//
// The hash-scoped form is stronger still and carries no clock dependence at
// all: it withdraws only if the standing entry came from that exact source
// revision. That is the form the purge route uses whenever the caller knows
// the hash, and the reason a retraction racing a fresh re-enrichment cannot
// eat the new, good gist.
//
// Only family 'content' applies here; a title retraction in the same stream is
// inert (titleEnrichment.ts honors those, symmetrically).
interface PendingRetraction {
  readonly sourceContentHash: string | undefined;
  readonly retractedAt: string;
}

export const foldContentEnrichmentEvents = (
  events: Iterable<AcceptedEvent>,
): GistLookup => {
  const map = new Map<string, GistEntry>();
  // key → retractions seen for it. Kept as a list, not a last-wins slot: a
  // hash-scoped and an unscoped retraction for the same entity are different
  // statements and both must get their say.
  const retractions = new Map<string, PendingRetraction[]>();
  for (const event of events) {
    if (event.type === ENTITY_ENRICHMENT_RETRACTED) {
      if (!isEntityEnrichmentRetractedPayload(event.payload)) continue;
      const payload = event.payload;
      if (payload.family !== 'content') continue;
      const key = foldKey(payload.kind, payload.id);
      const list = retractions.get(key);
      const entry: PendingRetraction = {
        sourceContentHash: payload.sourceContentHash,
        retractedAt: payload.retractedAt,
      };
      if (list === undefined) retractions.set(key, [entry]);
      else list.push(entry);
      continue;
    }
    if (event.type !== ENTITY_CONTENT_ENRICHED) continue;
    if (!isEntityContentEnrichedPayload(event.payload)) continue;
    const payload = event.payload;
    const key = foldKey(payload.kind, payload.id);
    const existing = map.get(key);
    if (existing !== undefined && existing.sourceContentHash === payload.sourceContentHash) {
      continue;
    }
    map.set(key, {
      gist: payload.gist,
      sourceContentHash: payload.sourceContentHash,
      generatedAt: payload.generatedAt,
    });
  }
  // Second pass: apply retractions to what actually stands.
  for (const [key, list] of retractions) {
    const standing = map.get(key);
    if (standing === undefined) continue;
    for (const retraction of list) {
      if (retraction.sourceContentHash !== undefined) {
        // Hash-scoped: exact revision or nothing. No clock involved.
        if (retraction.sourceContentHash === standing.sourceContentHash) map.delete(key);
        continue;
      }
      // Unscoped: withdraw unless the standing gist post-dates the retraction.
      // ISO-8601 UTC strings compare lexicographically as instants; a missing
      // or unparseable timestamp is treated as OLD (retract), because failing
      // to honor a retraction is worse than withdrawing one gist too many.
      if (standing.generatedAt > retraction.retractedAt) continue;
      map.delete(key);
    }
  }
  return map;
};

// ---- typed store read (fold source) -----------------------------------

const emptyEvents: readonly AcceptedEvent[] = [];

// BOTH types, always. A read that fetched only ENTITY_CONTENT_ENRICHED would
// fold a retracted gist straight back into serving — the retraction would
// exist in the log and change nothing, which is the worst failure mode
// available (an operator told the system to forget something and it silently
// kept it). The two types are read together and folded in log order.
const CONTENT_FOLD_TYPES = [ENTITY_CONTENT_ENRICHED, ENTITY_ENRICHMENT_RETRACTED] as const;

const isContentFoldType = (type: string): boolean =>
  type === ENTITY_CONTENT_ENRICHED || type === ENTITY_ENRICHMENT_RETRACTED;

const readContentEnrichmentEvents = async (
  vaultRoot: string,
  eventLog: EventLog,
): Promise<readonly AcceptedEvent[]> => {
  const store = await getCaughtUpSharedEventStore(vaultRoot);
  if (store === null) {
    return (await eventLog.readMerged()).filter((event) => isContentFoldType(event.type));
  }
  const events: AcceptedEvent[] = [];
  await store.forEachChunkOfTypes(
    [...CONTENT_FOLD_TYPES],
    (chunk) => {
      for (const event of chunk) events.push(event);
    },
    2000,
  );
  return events;
};

// ---- memoized loader --------------------------------------------------

interface MemoizedGist {
  readonly vaultRoot: string;
  readonly signature: string;
  readonly lookup: GistLookup;
}

let memoized: MemoizedGist | null = null;

export interface LoadedGistLookup {
  readonly lookup: GistLookup | null;
  // Cache-busting token (mirrors loadEnrichmentLookupWithSignature): 'off' when
  // the flag is disabled, 'none' when no event log, else the log signature.
  readonly signature: string;
}

// Resolve the current gist lookup for a vault, memoized on the event-log content
// signature. Returns null when the flag is off (so every seam falls through to
// no-gist behavior) or when the event log is unavailable. Warm memo pays only
// the cheap logSignature() stats.
export const loadGistLookupWithSignature = async (
  vaultRoot: string,
  eventLog: EventLog | undefined,
): Promise<LoadedGistLookup> => {
  if (!titleEnrichmentEnabled()) return { lookup: null, signature: 'off' };
  if (eventLog === undefined) return { lookup: null, signature: 'none' };
  const signature = await eventLog.logSignature();
  if (
    memoized !== null &&
    memoized.vaultRoot === vaultRoot &&
    memoized.signature === signature
  ) {
    return { lookup: memoized.lookup, signature };
  }
  const events = await readContentEnrichmentEvents(vaultRoot, eventLog).catch(() => emptyEvents);
  const lookup = foldContentEnrichmentEvents(events);
  memoized = { vaultRoot, signature, lookup };
  return { lookup, signature };
};

export const loadGistLookup = async (
  vaultRoot: string,
  eventLog: EventLog | undefined,
): Promise<GistLookup | null> => (await loadGistLookupWithSignature(vaultRoot, eventLog)).lookup;

// Hot-path variant for callers that ALREADY hold the merged log (the batch-
// resolve convoy). Folds straight from the provided events — NO extra
// readMerged — and memoizes on the caller-supplied signature. The caller MUST
// pass an events array that includes ENTITY_CONTENT_ENRICHED events (add the
// type to its readEventsFromStoreOrLog filter); a filtered array missing them
// silently folds to empty. Returns null when the flag is off.
export const gistLookupFromMerged = (
  vaultRoot: string,
  signature: string,
  events: readonly AcceptedEvent[],
): GistLookup | null => {
  if (!titleEnrichmentEnabled()) return null;
  if (
    memoized !== null &&
    memoized.vaultRoot === vaultRoot &&
    memoized.signature === signature
  ) {
    return memoized.lookup;
  }
  const lookup = foldContentEnrichmentEvents(events);
  memoized = { vaultRoot, signature, lookup };
  return lookup;
};

// ---- idempotent event append ------------------------------------------

// Idempotently append ONE ENTITY_CONTENT_ENRICHED event. Same outcome semantics
// as appendEnrichmentEvent (title): 'invalid' (guard failed), 'skipped'
// (duplicate triple / write failure), 'accepted' (fresh durable append). Reuses
// the SHARED enrichmentClientEventId helper so the (kind,id,sourceContentHash)
// dedupe key is derived identically to the title path. Callers gate on
// titleEnrichmentEnabled() themselves (the append is flag-agnostic so tests can
// exercise it directly).
export const appendContentEnrichmentEvent = async (
  eventLog: EventLog,
  candidate: EntityContentEnrichedPayload,
): Promise<EnrichmentAppendOutcome> => {
  if (!isEntityContentEnrichedPayload(candidate)) return 'invalid';
  // 'content' family so this key never collides with a title event's key for
  // the same (kind,id,sourceContentHash).
  const clientEventId = enrichmentClientEventId(
    candidate.kind,
    candidate.id,
    candidate.sourceContentHash,
    'content',
  );
  const existing = await eventLog.findByClientEventId(clientEventId).catch(() => null);
  if (existing !== null) return 'skipped';
  try {
    await eventLog.appendServerObserved({
      clientEventId,
      // Aggregate under the entity it enriches so the per-aggregate frontier
      // groups an entity's enrichment history (same convention as titles).
      aggregateId: `enrichment:${candidate.kind}:${candidate.id}`,
      type: ENTITY_CONTENT_ENRICHED,
      payload: { ...candidate },
    });
    return 'accepted';
  } catch {
    return 'skipped';
  }
};

export const resetGistLookupMemoForTest = (): void => {
  memoized = null;
};
