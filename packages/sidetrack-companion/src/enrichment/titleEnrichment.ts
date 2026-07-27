// Title enrichment — companion half of the on-device title-synthesis arc
// (PR #288–#291). The panel synthesizes descriptive titles on-device
// (Gemini Nano) for entities whose RAW title is structurally junk — chat
// threads titled "ChatGPT", visits whose only "title" is the URL itself —
// and POSTs them to /v1/enrichment/titles. This module is the ingestion +
// overlay core.
//
// EVENT-SOURCED DISCIPLINE: each accepted POST item appends one
// ENTITY_TITLE_ENRICHED event (via eventLog.appendServerObserved at the
// route). The served overlay is DERIVED — folded from those events at read
// time — never a mutable side table. Re-posting the same
// (kind,id,sourceContentHash) folds to the same entry, so the fold is
// idempotent and the route can honestly report it as `skipped`.
//
// OVERLAY, NEVER OVERWRITE: a synthesized title applies ONLY where the raw
// title is structurally junk (empty or URL-shaped). Raw non-junk titles
// ALWAYS win. `effectiveTitle(raw, synthesized)` is the single junk rule;
// every consumer seam funnels through it so title logic is not forked
// per-consumer. Junk detection is STRUCTURAL only (empty / URL-shaped) — no
// vocabulary lists.
//
// COST DISCIPLINE (mirrors emit.ts loadAttributionV1State): the folded
// lookup Map is memoized on the event log's cheap content signature
// (logSignature() = shard mtimes+sizes). A warm serve is O(#shard files)
// stats — no full-log read, no re-fold — until a write (any append,
// including our own) flips the signature. Enrichment events are sparse
// relative to the engagement-heavy log, so the fold reads them via the
// typed store path (forEachChunkOfTypes over events_type_idx) exactly like
// readAttributionV1SourceEvents.

import { createHash } from 'node:crypto';

import type { AcceptedEvent } from '../sync/causal.js';
import type { EventLog } from '../sync/eventLog.js';
import { getCaughtUpSharedEventStore } from '../sync/eventStore.js';

import {
  ENTITY_TITLE_ENRICHED,
  type EntityTitleEnrichedKind,
  type EntityTitleEnrichedPayload,
  isEntityTitleEnrichedPayload,
} from './events.js';

// Re-export the event contract so consumers can import the whole title-
// enrichment surface (event + guard + overlay) from this one module.
export {
  ENTITY_TITLE_ENRICHED,
  ENTITY_TITLE_ENRICHED_KINDS,
  ENRICHED_TITLE_MAX_LENGTH,
  ENRICHED_SOURCE_HASH_MAX_LENGTH,
  ENRICHED_ID_MAX_LENGTH,
  isEntityTitleEnrichedPayload,
} from './events.js';
export type {
  EntityTitleEnrichedEventType,
  EntityTitleEnrichedKind,
  EntityTitleEnrichedPayload,
} from './events.js';

// ---- flag -------------------------------------------------------------

export const TITLE_ENRICHMENT_ENV = 'SIDETRACK_TITLE_ENRICHMENT';

// Default ON. Only an explicit '0'/'false' disables — and it disables BOTH
// halves: the route stops appending events (200 {accepted:0} with a disabled
// note) AND every overlay seam falls through to the raw title. Read at each
// call site (never cached) so a runtime flip takes effect on the next serve
// and tests can assert overlay-off === raw-title behavior.
export const titleEnrichmentEnabled = (): boolean => {
  const raw = process.env[TITLE_ENRICHMENT_ENV];
  return raw !== '0' && raw !== 'false';
};

// ---- junk rule (the single overlay decision) --------------------------

// A raw title is STRUCTURALLY junk when it is empty/whitespace or URL-shaped
// (`https://…`). This is the SAME rule titleForCanonicalUrl already applies
// to its label fallback (a URL is not a title: feeding it to the title lane
// degenerates into scheme/TLD-token matching — the live "https, com" false
// friend). No vocabulary list — "ChatGPT" is NOT junk by this rule; it is
// suppressed upstream by the cross-workstream IDF, not here. The panel
// decides which entities to synthesize for; the companion only guards that a
// REAL raw title is never overwritten.
export const isJunkTitle = (raw: string | undefined | null): boolean => {
  if (raw === undefined || raw === null) return true;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return true;
  return /^https?:\/\//iu.test(trimmed);
};

// The single overlay decision, funnelled through by EVERY consumer seam.
//   - raw is a real (non-junk) title  → raw wins, always.
//   - raw is junk and synthesized present → synthesized fills.
//   - raw is junk and no synthesized  → return the raw as-is (undefined stays
//     undefined; a URL-shaped raw stays URL-shaped) so callers that had a
//     value keep their prior honest-emptiness behavior. Consumers that reject
//     URL-shaped labels (titleForCanonicalUrl) still do so downstream.
export const effectiveTitle = (
  raw: string | undefined,
  synthesized: string | undefined,
): string | undefined => {
  if (!isJunkTitle(raw)) return raw;
  if (synthesized !== undefined && synthesized.length > 0) return synthesized;
  return raw;
};

// ---- folded lookup ----------------------------------------------------

export interface EnrichmentEntry {
  readonly title: string;
  readonly sourceContentHash: string;
}

// kind:id → {title, hash}. A pure fold over ENTITY_TITLE_ENRICHED events:
// last writer per key wins (LWW by fold/replay order — the fold is
// order-independent up to the sourceContentHash dedupe below). Distinct kinds
// never collide because the key is prefixed with the kind.
export type EnrichmentLookup = ReadonlyMap<string, EnrichmentEntry>;

const foldKey = (kind: EntityTitleEnrichedKind, id: string): string => `${kind}:${id}`;

// Look up the synthesized title for a (kind,id). Returns undefined when there
// is no enrichment OR the flag is off — so callers can pass the result
// straight into effectiveTitle and get raw-title behavior when disabled.
export const lookupSynthesizedTitle = (
  lookup: EnrichmentLookup | null,
  kind: EntityTitleEnrichedKind,
  id: string,
): string | undefined => {
  if (lookup === null) return undefined;
  return lookup.get(foldKey(kind, id))?.title;
};

// The two consumer-facing overlay helpers — each combines the lookup with the
// junk rule so a seam is a one-liner (`effectiveThreadTitle(lookup, id, raw)`)
// and can never accidentally overwrite a real raw title. Both funnel through
// effectiveTitle, so the junk decision lives in exactly one place.
export const effectiveThreadTitle = (
  lookup: EnrichmentLookup | null,
  bacId: string,
  rawTitle: string | undefined,
): string | undefined =>
  effectiveTitle(rawTitle, lookupSynthesizedTitle(lookup, 'thread', bacId));

export const effectiveUrlTitle = (
  lookup: EnrichmentLookup | null,
  canonicalUrl: string,
  rawTitle: string | undefined,
): string | undefined =>
  effectiveTitle(rawTitle, lookupSynthesizedTitle(lookup, 'url', canonicalUrl));

// Fold a stream of events into the lookup. Idempotent per
// (kind,id,sourceContentHash): re-seeing the same hash for a key does not
// change the entry. A NEW hash for a key supersedes (content changed → newer
// synthesis wins). Non-enrichment / malformed events are skipped. Exported so
// the fold can be unit-tested without touching the event store.
export const foldEnrichmentEvents = (
  events: Iterable<AcceptedEvent>,
): EnrichmentLookup => {
  const map = new Map<string, EnrichmentEntry>();
  for (const event of events) {
    if (event.type !== ENTITY_TITLE_ENRICHED) continue;
    if (!isEntityTitleEnrichedPayload(event.payload)) continue;
    const payload = event.payload;
    const key = foldKey(payload.kind, payload.id);
    const existing = map.get(key);
    // Same hash already folded ⇒ no-op (idempotent). Different hash ⇒
    // supersede (the panel re-synthesized over changed content).
    if (existing !== undefined && existing.sourceContentHash === payload.sourceContentHash) {
      continue;
    }
    map.set(key, {
      title: payload.synthesizedTitle,
      sourceContentHash: payload.sourceContentHash,
    });
  }
  return map;
};

// ---- typed store read (fold source) -----------------------------------

const emptyEvents: readonly AcceptedEvent[] = [];

// Typed read of exactly ENTITY_TITLE_ENRICHED via events_type_idx when the
// shared store is available, else a single readMerged filtered by type.
// Mirrors readAttributionV1SourceEvents — enrichment events are sparse, so
// this stays cheap. The readMerged fallback exists because the shared event
// store is opt-in (SIDETRACK_EVENT_STORE): with it OFF (the default) the log
// is the only source. That readMerged is not a per-resolve scan in practice —
// this whole load is memoized on the log signature (loadEnrichmentLookup*),
// AND eventLog.readMerged is itself memoized on the same signature, so the
// fallback hits the warm merged memo rather than re-scanning disk. Callers on
// the hot batch path that already hold the merged log should prefer
// foldEnrichmentEvents over the passed array (see server batch-resolve) to
// avoid even the extra readMerged INVOCATION.
const readEnrichmentEvents = async (
  vaultRoot: string,
  eventLog: EventLog,
): Promise<readonly AcceptedEvent[]> => {
  const store = await getCaughtUpSharedEventStore(vaultRoot);
  if (store === null) {
    return (await eventLog.readMerged()).filter((event) => event.type === ENTITY_TITLE_ENRICHED);
  }
  const events: AcceptedEvent[] = [];
  await store.forEachChunkOfTypes(
    [ENTITY_TITLE_ENRICHED],
    (chunk) => {
      for (const event of chunk) events.push(event);
    },
    2000,
  );
  return events;
};

// ---- memoized loader --------------------------------------------------

interface MemoizedLookup {
  readonly vaultRoot: string;
  readonly signature: string;
  readonly lookup: EnrichmentLookup;
}

let memoized: MemoizedLookup | null = null;

// Resolve the current enrichment lookup for a vault, memoized on the event
// log's content signature. Returns null when the flag is off (so every seam
// falls through to the raw title) or when the event log is unavailable. On a
// warm memo this pays only the cheap logSignature() stats; the fold (typed
// read + Map build) runs once per write. In-process single-lane: the drain /
// serve paths are single-threaded per request so a plain module-level memo is
// sufficient (same shape as loadAttributionV1State's memoizedState).
export const loadEnrichmentLookup = async (
  vaultRoot: string,
  eventLog: EventLog | undefined,
): Promise<EnrichmentLookup | null> =>
  (await loadEnrichmentLookupWithSignature(vaultRoot, eventLog)).lookup;

export interface LoadedEnrichmentLookup {
  readonly lookup: EnrichmentLookup | null;
  // Cache-busting token for consumers that memoize a DERIVED artifact keyed
  // on the enrichment state (the recall lexical FTS index cache). 'off' when
  // the flag is disabled (so the cache never carries an overlay), 'none' when
  // no event log, else the event log's content signature. Distinct from
  // 'off'/'none' so a flag flip busts the derived cache too.
  readonly signature: string;
}

// Same as loadEnrichmentLookup but also returns a cheap cache-busting token so
// callers that build a DERIVED index over the overlaid titles (recall's
// lexical MiniSearch) can key their cache on it. A new enrichment event flips
// the event-log signature, which flips this token, which busts the derived
// cache — the same discipline the AttributionV1 resolver cache uses against
// currentAttributionV1StateRevision.
export const loadEnrichmentLookupWithSignature = async (
  vaultRoot: string,
  eventLog: EventLog | undefined,
): Promise<LoadedEnrichmentLookup> => {
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
  const events = await readEnrichmentEvents(vaultRoot, eventLog).catch(() => emptyEvents);
  const lookup = foldEnrichmentEvents(events);
  memoized = { vaultRoot, signature, lookup };
  return { lookup, signature };
};

// Hot-path variant for callers that ALREADY hold the merged log (the
// batch-resolve convoy reads it once for the resolver). Folds enrichment
// straight from the provided events — NO extra readMerged invocation — and
// memoizes on the caller-supplied signature (the same log signature the
// caller used to key its own reads). Returns null when the flag is off. The
// caller MUST pass an events array that includes ENTITY_TITLE_ENRICHED events
// (add the type to its readEventsFromStoreOrLog filter); a filtered array
// missing them would silently fold to empty. When the memo is already warm on
// this signature it is returned without re-folding.
export const enrichmentLookupFromMerged = (
  vaultRoot: string,
  signature: string,
  events: readonly AcceptedEvent[],
): EnrichmentLookup | null => {
  if (!titleEnrichmentEnabled()) return null;
  if (
    memoized !== null &&
    memoized.vaultRoot === vaultRoot &&
    memoized.signature === signature
  ) {
    return memoized.lookup;
  }
  const lookup = foldEnrichmentEvents(events);
  memoized = { vaultRoot, signature, lookup };
  return lookup;
};

// ---- idempotent event append (single source of truth) ----------------

// Field separator for the idempotency-key hash. A control char (U+0000) so it
// can never appear inside a kind/id/hash and collide two distinct triples.
// Built via String.fromCharCode(0) DELIBERATELY: the equivalent U+0000
// string-escape, when written into this source file by tooling, has repeatedly
// landed
// as a LITERAL NUL byte (a standing review check bans raw NULs in source —
// they make files grep-hostile). This constant produces the identical runtime
// char without any NUL byte living in the file, and stays byte-identical with
// the delimiter the POST /v1/enrichment/titles route used inline so events
// already persisted by the panel-POST path dedupe correctly here.
const NUL_SEP = String.fromCharCode(0);

// The enrichment event FAMILY — 'title' (entity.title.enriched) or 'content'
// (entity.content.enriched). The two families share the (kind,id) key space and
// this ONE clientEventId helper, so the family MUST be part of the idempotency
// key: a title event and a content event for the same (kind,id,hash) would
// otherwise collide on the SAME clientEventId and the second POST would be
// wrongly deduped as a replay of the first.
export type EnrichmentFamily = 'title' | 'content';

// The idempotency key for an enrichment event = a deterministic hash of the
// (family,kind,id,sourceContentHash) tuple. Re-posting the same tuple binds to
// the existing event ⇒ the append is a no-op; a NEW hash for the same
// (family,kind,id) is a distinct clientEventId ⇒ a new event that supersedes in
// the fold. This is the SINGLE definition of the dedupe key — the title POST
// route AND the content POST route both append through this helper so no two
// producers drift on how the key is derived.
//
// BACK-COMPAT: `family` defaults to 'title', and the title hash input is
// UNCHANGED from before this parameter existed (the family segment is appended
// ONLY for non-title families). So every title event already persisted by the
// pre-content POST path keeps its exact clientEventId and still dedupes here.
export const enrichmentClientEventId = (
  kind: EntityTitleEnrichedKind,
  id: string,
  sourceContentHash: string,
  family: EnrichmentFamily = 'title',
): string => {
  // Title: hash [kind,id,hash] verbatim (byte-identical with pre-content
  // events). Content: append the family segment so its keys never collide with
  // a title event's keys.
  const parts =
    family === 'title'
      ? [kind, id, sourceContentHash]
      : [kind, id, sourceContentHash, family];
  return `enrich-${createHash('sha256').update(parts.join(NUL_SEP)).digest('hex').slice(0, 32)}`;
};

export type EnrichmentAppendOutcome = 'accepted' | 'skipped' | 'invalid';

// Idempotently append ONE ENTITY_TITLE_ENRICHED event. Returns:
//   - 'invalid'  — the candidate failed the payload guard (caller counts as
//                  skipped; never appends).
//   - 'skipped'  — an event already exists for this (kind,id,sourceContentHash)
//                  triple (idempotent no-op) OR the durable write failed (one
//                  item's write failure must not fail the batch).
//   - 'accepted' — a fresh event was durably appended.
// This is the EXACT append logic the POST /v1/enrichment/titles route used to
// inline; extracted here so the companion-side title sweep reuses it verbatim
// (same guard, same idempotency key, same aggregate grouping). Callers still
// gate on titleEnrichmentEnabled() themselves — the append itself is
// flag-agnostic so a test can exercise it directly.
export const appendEnrichmentEvent = async (
  eventLog: EventLog,
  candidate: EntityTitleEnrichedPayload,
): Promise<EnrichmentAppendOutcome> => {
  if (!isEntityTitleEnrichedPayload(candidate)) return 'invalid';
  const clientEventId = enrichmentClientEventId(
    candidate.kind,
    candidate.id,
    candidate.sourceContentHash,
  );
  const existing = await eventLog.findByClientEventId(clientEventId).catch(() => null);
  if (existing !== null) return 'skipped';
  try {
    await eventLog.appendServerObserved({
      clientEventId,
      // Aggregate the event under the entity it enriches so the per-aggregate
      // frontier groups an entity's enrichment history.
      aggregateId: `enrichment:${candidate.kind}:${candidate.id}`,
      type: ENTITY_TITLE_ENRICHED,
      payload: { ...candidate },
    });
    return 'accepted';
  } catch {
    // A durable-write failure for one item must not fail the batch.
    return 'skipped';
  }
};

export const resetEnrichmentLookupMemoForTest = (): void => {
  memoized = null;
};
