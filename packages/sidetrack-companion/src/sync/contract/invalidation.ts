// Sync Contract v1 / Stage 5.2 W6 — declarative invalidation table for
// retroactive mutator events. Foundational types only; nothing wires
// this yet. Future incremental-materializer tracks (W2a streaming
// engagement classifier, per-event URL/tab-session projection patches,
// W7 content/recall index lane) consume this table to compute the
// minimal set of slices to recompute when a mutator lands.
//
// Design context: docs/proposals/work-graph-stage5-2-incremental-materializer.md
// "W6 — Declarative invalidation table for retroactive mutators."
//
// The mapping says: when event T arrives, recompute slices S1, S2, …
// Each slice is identified by an InvalidationKey discriminated by
// `kind`. The materializer's hot path looks up the rules for an
// accepted event's type, accumulates the affected keys, and runs
// per-slice recompute (or schedules them for reconciliation).
//
// Today the connections materializer rebuilds the whole snapshot on
// every accepted event (modulo W3/W4 cache hits). With this table
// wired up, the materializer can skip entire passes when no slice
// they own was invalidated.

import {
  USER_ENGAGEMENT_RELABELED,
  USER_FLOW_CONFIRMED,
  USER_FLOW_REJECTED,
  USER_ORGANIZED_ITEM,
  USER_SNIPPET_PROMOTED,
  USER_TOPIC_RENAMED,
} from '../../feedback/events.js';
import {
  ANNOTATION_CREATED,
  ANNOTATION_DELETED,
  ANNOTATION_NOTE_SET,
} from '../../annotations/events.js';
import { DISPATCH_LINKED, DISPATCH_RECORDED } from '../../dispatches/events.js';
import { ENGAGEMENT_SESSION_AGGREGATED } from '../../engagement/events.js';
import { NAVIGATION_COMMITTED } from '../../navigation/events.js';
import { QUEUE_CREATED, QUEUE_STATUS_SET } from '../../queue/events.js';
import { BROWSER_TIMELINE_OBSERVED } from '../../timeline/events.js';
import { CAPTURE_RECORDED, RECALL_TOMBSTONE_TARGET } from '../../recall/events.js';
import { CAPTURE_EXTRACTION_PRODUCED } from '../../recall/extraction/events.js';
import { TAB_SESSION_ATTRIBUTION_INFERRED } from '../../tabsession/events.js';
import {
  THREAD_ARCHIVED,
  THREAD_DELETED,
  THREAD_UNARCHIVED,
  THREAD_UPSERTED,
} from '../../threads/events.js';
import { URL_ATTRIBUTION_INFERRED } from '../../urls/events.js';
import { WORKSTREAM_DELETED, WORKSTREAM_UPSERTED } from '../../workstreams/events.js';
import type { AcceptedEvent } from '../causal.js';

export type InvalidationKey =
  // Per-row slices.
  | { readonly kind: 'url'; readonly canonicalUrl: string }
  | { readonly kind: 'tabSession'; readonly tabSessionId: string }
  | { readonly kind: 'thread'; readonly bacId: string }
  | { readonly kind: 'workstream'; readonly bacId: string }
  // Structural.
  | { readonly kind: 'workstreamTree' }
  | { readonly kind: 'workstreamPathMemo'; readonly bacId: string }
  // Engagement / topic membership.
  | { readonly kind: 'engagementVisit'; readonly visitId: string }
  | { readonly kind: 'topicMember'; readonly visitId: string }
  // Queue (per-item).
  | { readonly kind: 'queue'; readonly itemId: string }
  // Batch-level.
  | { readonly kind: 'rankerLabels' }
  | { readonly kind: 'inboxFilter' }
  // Group B — content / recall index lane (W7).
  | { readonly kind: 'sourceUnit'; readonly sourceUnitId: string }
  | { readonly kind: 'extractionRevision'; readonly extractionRevisionId: string }
  | { readonly kind: 'recallIndex'; readonly sourceUnitId: string }
  | { readonly kind: 'contentSimilarity'; readonly sourceUnitId: string }
  | { readonly kind: 'contentEvidence'; readonly sourceUnitId: string }
  | { readonly kind: 'resolverAnchors'; readonly nodeIds: readonly string[] }
  // Batch-level content keys (model / chunker version flips).
  | { readonly kind: 'embeddingModelRevision' }
  | { readonly kind: 'chunkerVersion' };

type InvalidationRule = (event: AcceptedEvent) => readonly InvalidationKey[];

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const strs = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : undefined;

export const INVALIDATION_RULES: Readonly<Record<string, InvalidationRule>> = {
  [USER_ORGANIZED_ITEM]: (event) => {
    const p = asRecord(event.payload);
    const itemKind = p['itemKind'];
    const itemId = str(p['itemId']);
    if (itemId === undefined) return [];
    if (itemKind === 'canonical-url') return [{ kind: 'url', canonicalUrl: itemId }];
    if (itemKind === 'tab-session') return [{ kind: 'tabSession', tabSessionId: itemId }];
    if (itemKind === 'thread') return [{ kind: 'thread', bacId: itemId }];
    return [];
  },
  [USER_ENGAGEMENT_RELABELED]: (event) => {
    const visitId = str(asRecord(event.payload)['visitId']);
    if (visitId === undefined) return [{ kind: 'rankerLabels' }];
    return [{ kind: 'engagementVisit', visitId }, { kind: 'rankerLabels' }];
  },
  [USER_FLOW_CONFIRMED]: (event) => {
    const ids = strs(asRecord(event.payload)['visitIds']) ?? [];
    return ids.map((visitId) => ({ kind: 'topicMember' as const, visitId }));
  },
  [USER_FLOW_REJECTED]: (event) => {
    const ids = strs(asRecord(event.payload)['visitIds']) ?? [];
    return ids.map((visitId) => ({ kind: 'topicMember' as const, visitId }));
  },
  [USER_TOPIC_RENAMED]: () => [],
  [USER_SNIPPET_PROMOTED]: () => [],
  [WORKSTREAM_UPSERTED]: (event) => {
    const bacId = str(asRecord(event.payload)['bac_id']);
    if (bacId === undefined) return [{ kind: 'workstreamTree' }];
    return [
      { kind: 'workstream', bacId },
      { kind: 'workstreamTree' },
      { kind: 'workstreamPathMemo', bacId },
    ];
  },
  [WORKSTREAM_DELETED]: (event) => {
    const bacId = str(asRecord(event.payload)['bac_id']);
    if (bacId === undefined) return [{ kind: 'workstreamTree' }];
    return [
      { kind: 'workstream', bacId },
      { kind: 'workstreamTree' },
      { kind: 'workstreamPathMemo', bacId },
    ];
  },
  [THREAD_UPSERTED]: (event) => {
    const p = asRecord(event.payload);
    const bacId = str(p['bac_id']);
    const canonicalUrl = str(p['threadUrl']);
    const keys: InvalidationKey[] = [];
    if (bacId !== undefined) keys.push({ kind: 'thread', bacId });
    if (canonicalUrl !== undefined) keys.push({ kind: 'url', canonicalUrl });
    return keys;
  },
  [THREAD_ARCHIVED]: (event) => {
    const bacId = str(asRecord(event.payload)['bac_id']);
    return bacId === undefined
      ? [{ kind: 'inboxFilter' }]
      : [{ kind: 'thread', bacId }, { kind: 'inboxFilter' }];
  },
  [THREAD_UNARCHIVED]: (event) => {
    const bacId = str(asRecord(event.payload)['bac_id']);
    return bacId === undefined
      ? [{ kind: 'inboxFilter' }]
      : [{ kind: 'thread', bacId }, { kind: 'inboxFilter' }];
  },
  [THREAD_DELETED]: (event) => {
    const bacId = str(asRecord(event.payload)['bac_id']);
    return bacId === undefined
      ? [{ kind: 'inboxFilter' }]
      : [{ kind: 'thread', bacId }, { kind: 'inboxFilter' }];
  },
  [URL_ATTRIBUTION_INFERRED]: (event) => {
    const canonicalUrl = str(asRecord(event.payload)['canonicalUrl']);
    return canonicalUrl === undefined ? [] : [{ kind: 'url', canonicalUrl }];
  },
  [TAB_SESSION_ATTRIBUTION_INFERRED]: (event) => {
    const tabSessionId = str(asRecord(event.payload)['tabSessionId']);
    return tabSessionId === undefined ? [] : [{ kind: 'tabSession', tabSessionId }];
  },
  // privacy.gate.flipped is intentionally absent — see "Privacy gate
  // semantics" in the design doc. Option F (future-only) returns [].
  [QUEUE_CREATED]: (event) => {
    const itemId = str(asRecord(event.payload)['itemId']);
    return itemId === undefined ? [] : [{ kind: 'queue', itemId }];
  },
  [QUEUE_STATUS_SET]: (event) => {
    const itemId = str(asRecord(event.payload)['itemId']);
    return itemId === undefined ? [] : [{ kind: 'queue', itemId }];
  },
  // Annotation / dispatch events are graph-additive; they don't
  // invalidate slices, they just add new nodes/edges on the next
  // structural drain. Keep them out of this table for now; emit
  // empty so callers can still look them up if they switch on type.
  [ANNOTATION_CREATED]: () => [],
  [ANNOTATION_NOTE_SET]: () => [],
  [ANNOTATION_DELETED]: () => [],
  [DISPATCH_RECORDED]: () => [],
  [DISPATCH_LINKED]: () => [],
  // Class A leaf observations — append-only at the event log, but
  // each contributes a new visit / engagement signal the materializer
  // must classify. Engagement classifier + similarity + topics all
  // need to re-process when these arrive.
  [BROWSER_TIMELINE_OBSERVED]: (event) => {
    const p = asRecord(event.payload);
    const canonicalUrl = str(p['canonicalUrl']) ?? str(p['url']);
    const visitId = str(p['eventId']);
    const keys: InvalidationKey[] = [];
    if (canonicalUrl !== undefined) keys.push({ kind: 'url', canonicalUrl });
    if (visitId !== undefined) {
      keys.push({ kind: 'engagementVisit', visitId });
      keys.push({ kind: 'topicMember', visitId });
    }
    return keys;
  },
  [NAVIGATION_COMMITTED]: (event) => {
    const p = asRecord(event.payload);
    const canonicalUrl = str(p['canonicalUrl']);
    const visitId = str(p['visitId']);
    const keys: InvalidationKey[] = [];
    if (canonicalUrl !== undefined) keys.push({ kind: 'url', canonicalUrl });
    if (visitId !== undefined) {
      keys.push({ kind: 'engagementVisit', visitId });
      keys.push({ kind: 'topicMember', visitId });
    }
    return keys;
  },
  [ENGAGEMENT_SESSION_AGGREGATED]: (event) => {
    const visitId = str(asRecord(event.payload)['visitId']);
    if (visitId === undefined) return [{ kind: 'rankerLabels' }];
    return [{ kind: 'engagementVisit', visitId }, { kind: 'rankerLabels' }];
  },
  // Group B (W7 content / recall index lane).
  [CAPTURE_RECORDED]: (event) => {
    const sourceUnitId = str(asRecord(event.payload)['sourceUnitId']);
    if (sourceUnitId === undefined) return [];
    return [
      { kind: 'sourceUnit', sourceUnitId },
      { kind: 'recallIndex', sourceUnitId },
      { kind: 'contentSimilarity', sourceUnitId },
    ];
  },
  [CAPTURE_EXTRACTION_PRODUCED]: (event) => {
    const p = asRecord(event.payload);
    const sourceUnitId = str(p['sourceUnitId']);
    const extractionRevisionId = str(p['extractionRevisionId']);
    const keys: InvalidationKey[] = [];
    if (sourceUnitId !== undefined) {
      keys.push(
        { kind: 'sourceUnit', sourceUnitId },
        { kind: 'recallIndex', sourceUnitId },
        { kind: 'contentSimilarity', sourceUnitId },
      );
    }
    if (extractionRevisionId !== undefined) {
      keys.push({ kind: 'extractionRevision', extractionRevisionId });
    }
    return keys;
  },
  [RECALL_TOMBSTONE_TARGET]: (event) => {
    const p = asRecord(event.payload);
    const sourceUnitId = str(p['sourceUnitId']);
    const affectedNodeIds = strs(p['affectedNodeIds']) ?? [];
    const keys: InvalidationKey[] = [];
    if (sourceUnitId !== undefined) {
      keys.push(
        { kind: 'sourceUnit', sourceUnitId },
        { kind: 'recallIndex', sourceUnitId },
        { kind: 'contentSimilarity', sourceUnitId },
      );
    }
    if (affectedNodeIds.length > 0) {
      keys.push({ kind: 'resolverAnchors', nodeIds: affectedNodeIds });
    }
    return keys;
  },
};

/**
 * Compute the set of slices an accepted event invalidates. Returns an
 * empty array when the event type isn't in the rules table — caller
 * decides whether unknown types trigger a full rebuild or are silently
 * ignored.
 */
export const invalidationsForEvent = (event: AcceptedEvent): readonly InvalidationKey[] => {
  const rule = INVALIDATION_RULES[event.type];
  return rule === undefined ? [] : rule(event);
};

/**
 * Deduplicate an array of invalidation keys. Keeps the first
 * occurrence; uses a stable JSON serialization for the dedupe key.
 */
export const dedupeInvalidationKeys = (
  keys: readonly InvalidationKey[],
): readonly InvalidationKey[] => {
  const seen = new Set<string>();
  const out: InvalidationKey[] = [];
  for (const key of keys) {
    const sig = JSON.stringify(key);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(key);
  }
  return out;
};
