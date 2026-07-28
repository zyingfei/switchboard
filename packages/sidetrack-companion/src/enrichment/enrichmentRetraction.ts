// Enrichment retraction — the append half of the withdraw path.
//
// The fold half lives in titleEnrichment.ts / contentEnrichment.ts (both honor
// ENTITY_ENRICHMENT_RETRACTED for their own family). This module owns the one
// way a retraction gets INTO the log, so the two families can never drift on
// how the idempotency key is derived or what a duplicate means.
//
// WHY A RETRACTION AND NOT A DELETE. The event log is append-only. Withdrawing
// a bad enrichment therefore means appending the fact that it was withdrawn and
// letting the folds honor it — TOMBSTONE + HIDE, the same shape the privacy
// domain tombstone uses. The original event survives for forensics; what
// changes is what SERVES.
//
// IDEMPOTENCY. Keyed on (family,kind,id,hash-or-'*') through the same sha256
// helper the enrichment appends use, with a distinct 'retract-' prefix so a
// retraction's key can never collide with the enrichment it withdraws. Posting
// the same retraction twice is a no-op ('skipped'), which makes the purge
// script safe to re-run — a property worth having the first time an operator
// is not sure whether the earlier run landed.

import { createHash } from 'node:crypto';

import type { EventLog } from '../sync/eventLog.js';

import {
  ENTITY_ENRICHMENT_RETRACTED,
  type EnrichmentFamily,
  type EntityEnrichmentRetractedPayload,
  type EntityTitleEnrichedKind,
  isEntityEnrichmentRetractedPayload,
} from './events.js';
import type { EnrichmentAppendOutcome } from './titleEnrichment.js';

// Same NUL separator discipline as enrichmentClientEventId: a byte that cannot
// appear in a URL or a bac_id, so ('a','bc') and ('ab','c') never collide.
const NUL_SEP = String.fromCharCode(0);

/**
 * Idempotency key for a retraction. `'*'` stands in for an unscoped
 * retraction so the two forms — "withdraw revision abc123" and "withdraw
 * whatever stands" — are DIFFERENT statements with different keys. They are;
 * collapsing them would let an unscoped retraction be silently swallowed as a
 * duplicate of an earlier hash-scoped one.
 */
export const retractionClientEventId = (
  family: EnrichmentFamily,
  kind: EntityTitleEnrichedKind,
  id: string,
  sourceContentHash: string | undefined,
): string => {
  const parts = [family, kind, id, sourceContentHash ?? '*'];
  return `retract-${createHash('sha256').update(parts.join(NUL_SEP)).digest('hex').slice(0, 32)}`;
};

/**
 * Idempotently append ONE ENTITY_ENRICHMENT_RETRACTED event.
 *
 * Outcome semantics match the enrichment appends exactly: 'invalid' (guard
 * failed), 'skipped' (duplicate / write failure), 'accepted' (fresh durable
 * append). Callers gate on the enrichment flag themselves — the append is
 * flag-agnostic so tests exercise it directly, and so a retraction can still
 * be recorded when ingestion is switched off. That last part is deliberate:
 * turning enrichment OFF should not block cleaning up what it already wrote.
 */
export const appendEnrichmentRetractionEvent = async (
  eventLog: EventLog,
  candidate: EntityEnrichmentRetractedPayload,
): Promise<EnrichmentAppendOutcome> => {
  if (!isEntityEnrichmentRetractedPayload(candidate)) return 'invalid';
  const clientEventId = retractionClientEventId(
    candidate.family,
    candidate.kind,
    candidate.id,
    candidate.sourceContentHash,
  );
  const existing = await eventLog.findByClientEventId(clientEventId).catch(() => null);
  if (existing !== null) return 'skipped';
  try {
    await eventLog.appendServerObserved({
      clientEventId,
      // SAME aggregate as the enrichment it withdraws, so an entity's
      // enrichment history — synthesized, superseded, retracted — reads as one
      // ordered story on the per-aggregate frontier.
      aggregateId: `enrichment:${candidate.kind}:${candidate.id}`,
      type: ENTITY_ENRICHMENT_RETRACTED,
      payload: { ...candidate },
    });
    return 'accepted';
  } catch {
    return 'skipped';
  }
};
