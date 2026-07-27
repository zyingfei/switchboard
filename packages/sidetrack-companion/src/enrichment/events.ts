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
