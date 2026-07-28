// Title enrichment — event contract (companion half of PR #288–#291).
//
// The panel synthesizes descriptive titles on-device (Gemini Nano) for
// entities whose RAW title is structurally junk (empty / URL-shaped) and
// POSTs them to /v1/enrichment/titles. Each accepted item appends ONE
// ENTITY_TITLE_ENRICHED event; the served overlay is DERIVED by folding
// these events (see titleEnrichment.ts). This file is the canonical event
// declaration + payload guard, kept in the repo-standard `events.ts` home so
// the sync-contract coverage test (registry.test.ts) discovers the type and
// enforces a registry entry for it.

export const ENTITY_TITLE_ENRICHED = 'entity.title.enriched' as const;

export type EntityTitleEnrichedEventType = typeof ENTITY_TITLE_ENRICHED;

// The two entity kinds the panel enriches: chat threads (keyed by bac_id)
// and URL visits (keyed by canonicalUrl). Closed union so the fold key
// `kind:id` can never collide across kinds.
export const ENTITY_TITLE_ENRICHED_KINDS = ['thread', 'url'] as const;

export type EntityTitleEnrichedKind = (typeof ENTITY_TITLE_ENRICHED_KINDS)[number];

// FROZEN CONTRACT field bounds. Titles cap at 200 chars (the panel
// synthesizes short descriptive titles); the content hash is a hex digest ≤
// 64 chars. Both are DoS bounds (mirrors timeline's TIMELINE_TITLE_MAX_LENGTH
// rationale) AND contract validation.
export const ENRICHED_TITLE_MAX_LENGTH = 200;
export const ENRICHED_SOURCE_HASH_MAX_LENGTH = 64;
export const ENRICHED_ID_MAX_LENGTH = 4096;

export interface EntityTitleEnrichedPayload {
  readonly payloadVersion: 1;
  readonly kind: EntityTitleEnrichedKind;
  // Thread bac_id (kind === 'thread') or canonicalUrl (kind === 'url').
  readonly id: string;
  readonly synthesizedTitle: string;
  // Hex digest of the content the panel synthesized FROM. The dedupe key is
  // (kind,id,sourceContentHash): a fresh synthesis over unchanged content
  // yields the same hash → no-op; a synthesis over changed content yields a
  // new hash → a new fold entry that supersedes the old one.
  readonly sourceContentHash: string;
  readonly model: string;
  readonly generatedAt: string;
}

const ENTITY_TITLE_ENRICHED_KIND_VALUES: ReadonlySet<string> = new Set<string>(
  ENTITY_TITLE_ENRICHED_KINDS,
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isBoundedNonEmptyString = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

// ---- content enrichment (entity.content.enriched) ---------------------
//
// The SECOND enrichment event, mirroring entity.title.enriched exactly. The
// panel synthesizes a short prose "gist" of an entity's content on-device (via
// WebGPU) and POSTs it to /v1/enrichment/content. The gist is a longer, richer
// summary than a title — it makes an entity RETRIEVABLE by concepts the raw
// title/URL never carried (a page titled only by its URL, a thread whose only
// visible label is "ChatGPT"). The served surface folds these events (see
// contentEnrichment.ts) and injects the gist into the recall lexical index +
// the content lane's embed text. Same (kind,id) key space as titles; the
// dedupe key is (kind,id,sourceContentHash) via the shared clientEventId helper.

export const ENTITY_CONTENT_ENRICHED = 'entity.content.enriched' as const;

export type EntityContentEnrichedEventType = typeof ENTITY_CONTENT_ENRICHED;

// The gist is a paragraph-scale summary, so it gets a larger bound than a title
// (≤200) — the FROZEN CONTRACT caps it at 2000 chars. Still a DoS bound: a
// runaway synthesis can't append an unbounded blob to the event log.
export const ENRICHED_GIST_MAX_LENGTH = 2000;

export interface EntityContentEnrichedPayload {
  readonly payloadVersion: 1;
  // SAME entity kinds + id conventions as the title event: 'thread' → bac_id,
  // 'url' → canonicalUrl. Reused (not forked) so a single fold key space and a
  // single clientEventId helper serve both enrichment event families.
  readonly kind: EntityTitleEnrichedKind;
  readonly id: string;
  readonly gist: string;
  readonly sourceContentHash: string;
  readonly model: string;
  readonly generatedAt: string;
}

// Payload guard — same structure as isEntityTitleEnrichedPayload, with `gist`
// (≤2000) in place of `synthesizedTitle` (≤200). Pin payloadVersion, reject
// `dimensions`, bound every string.
export const isEntityContentEnrichedPayload = (
  value: unknown,
): value is EntityContentEnrichedPayload => {
  if (!isRecord(value)) return false;
  if (value['payloadVersion'] !== 1) return false;
  if (value['dimensions'] !== undefined) return false;
  if (typeof value['kind'] !== 'string' || !ENTITY_TITLE_ENRICHED_KIND_VALUES.has(value['kind'])) {
    return false;
  }
  if (!isBoundedNonEmptyString(value['id'], ENRICHED_ID_MAX_LENGTH)) return false;
  if (!isBoundedNonEmptyString(value['gist'], ENRICHED_GIST_MAX_LENGTH)) return false;
  if (!isBoundedNonEmptyString(value['sourceContentHash'], ENRICHED_SOURCE_HASH_MAX_LENGTH)) {
    return false;
  }
  if (!isBoundedNonEmptyString(value['model'], 64)) return false;
  if (!isBoundedNonEmptyString(value['generatedAt'], 64)) return false;
  return true;
};

// Payload guard — structural validation of a persisted ENTITY_TITLE_ENRICHED
// event's payload. Mirrors isUserOrganizedItemPayload: pin payloadVersion,
// reject `dimensions`, bound every string. `model`/`generatedAt` are recorded
// verbatim (provenance) but only loosely bounded — they never gate the
// overlay, so a malformed clock or model string cannot poison serving; it is
// simply audit metadata.
export const isEntityTitleEnrichedPayload = (
  value: unknown,
): value is EntityTitleEnrichedPayload => {
  if (!isRecord(value)) return false;
  if (value['payloadVersion'] !== 1) return false;
  if (value['dimensions'] !== undefined) return false;
  if (typeof value['kind'] !== 'string' || !ENTITY_TITLE_ENRICHED_KIND_VALUES.has(value['kind'])) {
    return false;
  }
  if (!isBoundedNonEmptyString(value['id'], ENRICHED_ID_MAX_LENGTH)) return false;
  if (!isBoundedNonEmptyString(value['synthesizedTitle'], ENRICHED_TITLE_MAX_LENGTH)) return false;
  if (!isBoundedNonEmptyString(value['sourceContentHash'], ENRICHED_SOURCE_HASH_MAX_LENGTH)) {
    return false;
  }
  if (!isBoundedNonEmptyString(value['model'], 64)) return false;
  if (!isBoundedNonEmptyString(value['generatedAt'], 64)) return false;
  return true;
};

// ---- enrichment retraction (entity.enrichment.retracted) --------------
//
// WHY THIS EXISTS (live, 2026-07-27). Five gists synthesized before the
// generation path was fixed are sitting in the vault and feeding retrieval:
// three repetition loops ("It's a long story." x N; "The content is not a
// question." x N; "2 224 6 224 6 ..."), one paraphrased prompt-echo, and one
// led by nav boilerplate. They are worse than no gist — a gist is injected
// into the recall lexical index and the content lane's embed text, so a
// degenerate one actively pollutes retrieval for its entity.
//
// The event log is APPEND-ONLY, so "delete the bad gist" cannot mean editing
// the log. It means appending the fact that the enrichment is withdrawn and
// letting the FOLD honor it — the same TOMBSTONE + HIDE shape the privacy
// domain tombstone uses. This is the only correct delete in an event-sourced
// store, and it is auditable: the retraction says who withdrew what and why,
// and the original event survives for forensics.
//
// ONE event covers BOTH enrichment families (title and content) because they
// share a key space, a kind/id convention, and a clientEventId helper;
// forking a second event type would guarantee they drift.
//
// ORDERING IS THE SEMANTICS. The folds process events in log order, so a
// retraction removes an entry present at that point and a LATER re-enrichment
// re-adds it. That falls out of the fold for free and is exactly right: a
// retraction withdraws what exists today, it does not blacklist the entity
// forever. Re-running synthesis with a fixed model is meant to work.
//
// HASH SCOPING. `sourceContentHash` is optional. Omitted, the retraction
// withdraws whatever is currently folded for (family,kind,id) — the operator
// intent "this gist is bad, remove it". Present, it withdraws ONLY if the
// folded entry came from that exact source, so a retraction racing a fresh
// re-enrichment cannot silently eat the new, good one.

export const ENTITY_ENRICHMENT_RETRACTED = 'entity.enrichment.retracted' as const;

export type EntityEnrichmentRetractedEventType = typeof ENTITY_ENRICHMENT_RETRACTED;

// Which enrichment family the retraction withdraws. Closed union: a
// retraction always names its target family, so the title fold and the
// content fold each honor only their own and can never cross-delete.
export const ENRICHMENT_FAMILIES = ['title', 'content'] as const;

export type EnrichmentFamily = (typeof ENRICHMENT_FAMILIES)[number];

// Bound on the free-text reason. Audit metadata, never served, but it is
// still operator-supplied text going into an append-only log — so it is
// bounded like every other string in this contract.
export const RETRACTION_REASON_MAX_LENGTH = 500;

export interface EntityEnrichmentRetractedPayload {
  readonly payloadVersion: 1;
  readonly family: EnrichmentFamily;
  readonly kind: EntityTitleEnrichedKind;
  readonly id: string;
  // Scope the retraction to one source revision. Omitted = withdraw whatever
  // is currently folded for this entity.
  readonly sourceContentHash?: string;
  // Why it was withdrawn. Required: a retraction with no stated reason is an
  // unexplained deletion in an audit log, which is the thing this design is
  // trying not to be.
  readonly reason: string;
  readonly retractedAt: string;
}

const ENRICHMENT_FAMILY_VALUES: ReadonlySet<string> = new Set<string>(ENRICHMENT_FAMILIES);

// Payload guard — same discipline as the two enrichment guards: pin
// payloadVersion, reject `dimensions`, bound every string. The only optional
// field is sourceContentHash, which must be a bounded non-empty string WHEN
// PRESENT (an explicit empty hash is a caller bug, not "unscoped").
export const isEntityEnrichmentRetractedPayload = (
  value: unknown,
): value is EntityEnrichmentRetractedPayload => {
  if (!isRecord(value)) return false;
  if (value['payloadVersion'] !== 1) return false;
  if (value['dimensions'] !== undefined) return false;
  if (typeof value['family'] !== 'string' || !ENRICHMENT_FAMILY_VALUES.has(value['family'])) {
    return false;
  }
  if (typeof value['kind'] !== 'string' || !ENTITY_TITLE_ENRICHED_KIND_VALUES.has(value['kind'])) {
    return false;
  }
  if (!isBoundedNonEmptyString(value['id'], ENRICHED_ID_MAX_LENGTH)) return false;
  const hash = value['sourceContentHash'];
  if (hash !== undefined && !isBoundedNonEmptyString(hash, ENRICHED_SOURCE_HASH_MAX_LENGTH)) {
    return false;
  }
  if (!isBoundedNonEmptyString(value['reason'], RETRACTION_REASON_MAX_LENGTH)) return false;
  if (!isBoundedNonEmptyString(value['retractedAt'], 64)) return false;
  return true;
};
