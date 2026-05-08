// Sync Contract v1 — registry. Class is per-surface, not per-event.
//
// One ContractEntry per event type the system emits. Each entry's
// `surfaces[]` lists every derived surface the event touches, with
// the surface's class (A/B/C/D/E/F), materializer (if applicable),
// freshness bound, and recovery mechanism.
//
// Examples:
//   capture.recorded touches THREE surfaces:
//     - extraction-revisions  (class E, materializer 'extraction')
//     - recall-index          (class B, materializer 'recall')
//     - capture-audit-jsonl   (class C, local-only by design)
//
// The coverage test (registry.test.ts) asserts:
//   - every event type in */events.ts has exactly one entry
//   - every materializer field references a known materializer
//   - class-A surfaces route to the projection materializer
//   - class-E surfaces route to the extraction materializer
//   - class-B surfaces have a valid recovery mode
//   - no entry has an empty surfaces[]
//
// Adding a new event type requires adding a registry entry + a
// matching materializer + a contract test. See plan
// (kind-prancing-river.md) Lane 1 / 2 / 3 sections.

import {
  ANNOTATION_CREATED,
  ANNOTATION_DELETED,
  ANNOTATION_NOTE_SET,
} from '../../annotations/events.js';
import { DISPATCH_LINKED, DISPATCH_RECORDED } from '../../dispatches/events.js';
import {
  ENGAGEMENT_INTERVAL_OBSERVED,
  ENGAGEMENT_SESSION_AGGREGATED,
} from '../../engagement/events.js';
import {
  PRIVACY_GATE_FLIPPED,
  PRIVACY_PERMISSION_GRANTED,
  PRIVACY_PERMISSION_REVOKED,
} from '../../privacy/events.js';
import { NAVIGATION_COMMITTED } from '../../navigation/events.js';
import { QUEUE_CREATED, QUEUE_STATUS_SET } from '../../queue/events.js';
import { CAPTURE_RECORDED, RECALL_TOMBSTONE_TARGET } from '../../recall/events.js';
import { CAPTURE_EXTRACTION_PRODUCED } from '../../recall/extraction/events.js';
import { REVIEW_DRAFT_EVENT_TYPES } from '../../review/projection.js';
import { SELECTION_COPIED, SELECTION_PASTED } from '../../snippets/events.js';
import {
  THREAD_ARCHIVED,
  THREAD_DELETED,
  THREAD_UNARCHIVED,
  THREAD_UPSERTED,
} from '../../threads/events.js';
import { BROWSER_TIMELINE_OBSERVED } from '../../timeline/events.js';
import { WORKSTREAM_DELETED, WORKSTREAM_UPSERTED } from '../../workstreams/events.js';

export type StateClass =
  | 'aggregate-projection' // A
  | 'derived-cache' // B
  | 'local-only' // C
  | 'identity-auth' // D
  | 'extraction-revision' // E
  | 'plugin-tier-bounded'; // F (companion side declares the partner surface; the actual storage is plugin-tier)

export type RecoveryMode =
  | 'replay-event-log'
  | 'source-scoped-reextract'
  | 'on-demand-rebuild'
  | 'spool-drain'
  | 'none';

export interface SurfaceContract {
  readonly surface: string;
  readonly class: StateClass;
  // Required for non-local-only surfaces.
  readonly materializer?: string;
  // Cross-replica freshness bound under normal operation.
  readonly peerFreshnessMs?: number;
  readonly recovery?: RecoveryMode;
  // Required for class === 'local-only' (the audit explanation).
  readonly localOnlyReason?: string;
}

export interface ContractEntry {
  readonly eventType: string;
  readonly currentPayloadVersion?: number;
  readonly allowedDimensions?: readonly string[];
  readonly surfaces: readonly SurfaceContract[];
}

// Materializers wired in Lane 1 (S2). Lane 2 adds 'extraction'.
// Future surfaces (context-pack, obsidian, mcp, summary, browser-timeline)
// register additional materializer names here as they land.
//
// Note on annotation-overlay: the in-page overlay refresh is owned by
// the extension's SSE subscriber (F13 path) — that's plugin-tier,
// not a companion-side materializer. The annotation-projection
// surface (companion-side, Class A) IS owned by the projection
// materializer here.
// Note on consumer-only materializers: `recall`, `extraction`, and
// (from the Connections feature) `connections` consume across many
// event-type owners and don't appear as `surfaces[].materializer`
// on every event they care about. The registry-coverage gate
// (registry.test.ts) checks that every `surface.materializer`
// value IS in this set — but does NOT require the inverse. So
// adding a name here is sufficient to register a consumer-only
// materializer.
export const KNOWN_MATERIALIZERS: ReadonlySet<string> = new Set<string>([
  'projection',
  'recall',
  'extraction',
  'timeline',
  'connections',
]);

const projectionEntry = (eventType: string, surface: string): ContractEntry => ({
  eventType,
  currentPayloadVersion: 1,
  surfaces: [
    {
      surface,
      class: 'aggregate-projection',
      materializer: 'projection',
      peerFreshnessMs: 5_000,
      recovery: 'replay-event-log',
    },
  ],
});

const reviewDraftEntries: readonly ContractEntry[] = REVIEW_DRAFT_EVENT_TYPES.map(
  (eventType) => projectionEntry(eventType, 'review-draft-projection'),
);

export const CONTRACT_REGISTRY: readonly ContractEntry[] = [
  // Class A — aggregate projections.
  projectionEntry(THREAD_UPSERTED, 'thread-projection'),
  projectionEntry(THREAD_ARCHIVED, 'thread-projection'),
  projectionEntry(THREAD_UNARCHIVED, 'thread-projection'),
  projectionEntry(THREAD_DELETED, 'thread-projection'),
  projectionEntry(WORKSTREAM_UPSERTED, 'workstream-projection'),
  projectionEntry(WORKSTREAM_DELETED, 'workstream-projection'),
  projectionEntry(QUEUE_CREATED, 'queue-projection'),
  projectionEntry(QUEUE_STATUS_SET, 'queue-projection'),
  projectionEntry(DISPATCH_RECORDED, 'dispatch-projection'),
  projectionEntry(DISPATCH_LINKED, 'dispatch-projection'),
  projectionEntry(PRIVACY_GATE_FLIPPED, 'privacy-projection'),
  projectionEntry(PRIVACY_PERMISSION_GRANTED, 'privacy-projection'),
  projectionEntry(PRIVACY_PERMISSION_REVOKED, 'privacy-projection'),
  // Annotation events fan out to TWO surfaces: the projection (Class A,
  // SSE-mirrored) AND the in-page overlay refresh (Class A, dispatched
  // via runtime message to tabs viewing the annotated URL).
  {
    eventType: ANNOTATION_CREATED,
    currentPayloadVersion: 1,
    surfaces: [
      {
        surface: 'annotation-projection',
        class: 'aggregate-projection',
        materializer: 'projection',
        peerFreshnessMs: 5_000,
        recovery: 'replay-event-log',
      },
      {
        // The in-page overlay refresh is owned by the extension's
        // SSE subscriber on the annotation-projection prefix; no
        // companion-side materializer is registered. Marking the
        // surface as plugin-tier-bounded keeps the registry honest
        // about ownership.
        surface: 'annotation-overlay',
        class: 'plugin-tier-bounded',
        peerFreshnessMs: 5_000,
        recovery: 'on-demand-rebuild',
      },
    ],
  },
  {
    eventType: ANNOTATION_NOTE_SET,
    currentPayloadVersion: 1,
    surfaces: [
      {
        surface: 'annotation-projection',
        class: 'aggregate-projection',
        materializer: 'projection',
        peerFreshnessMs: 5_000,
        recovery: 'replay-event-log',
      },
      {
        // The in-page overlay refresh is owned by the extension's
        // SSE subscriber on the annotation-projection prefix; no
        // companion-side materializer is registered. Marking the
        // surface as plugin-tier-bounded keeps the registry honest
        // about ownership.
        surface: 'annotation-overlay',
        class: 'plugin-tier-bounded',
        peerFreshnessMs: 5_000,
        recovery: 'on-demand-rebuild',
      },
    ],
  },
  {
    eventType: ANNOTATION_DELETED,
    currentPayloadVersion: 1,
    surfaces: [
      {
        surface: 'annotation-projection',
        class: 'aggregate-projection',
        materializer: 'projection',
        peerFreshnessMs: 5_000,
        recovery: 'replay-event-log',
      },
      {
        // The in-page overlay refresh is owned by the extension's
        // SSE subscriber on the annotation-projection prefix; no
        // companion-side materializer is registered. Marking the
        // surface as plugin-tier-bounded keeps the registry honest
        // about ownership.
        surface: 'annotation-overlay',
        class: 'plugin-tier-bounded',
        peerFreshnessMs: 5_000,
        recovery: 'on-demand-rebuild',
      },
    ],
  },
  // Review-draft events are all Class A projection.
  ...reviewDraftEntries,

  // Class B / E — capture + recall events.
  // capture.recorded fans out to extraction-revisions (Class E),
  // recall-index (Class B), capture-audit-jsonl (Class C).
  // Lane 1 only registers the recall-index entry against the recall
  // materializer; the extraction-revisions surface is reserved for
  // Lane 2 (will add a materializer: 'extraction' row + uncomment in
  // KNOWN_MATERIALIZERS).
  {
    eventType: CAPTURE_RECORDED,
    currentPayloadVersion: 1,
    surfaces: [
      {
        surface: 'recall-index',
        class: 'derived-cache',
        materializer: 'recall',
        peerFreshnessMs: 30_000,
        recovery: 'replay-event-log', // Lane 1; Lane 2 changes to 'source-scoped-reextract'
      },
      {
        surface: 'capture-audit-jsonl',
        class: 'local-only',
        localOnlyReason: 'audit trail is per-replica by design',
      },
    ],
  },
  {
    eventType: RECALL_TOMBSTONE_TARGET,
    currentPayloadVersion: 1,
    surfaces: [
      {
        surface: 'recall-index',
        class: 'derived-cache',
        materializer: 'recall',
        peerFreshnessMs: 30_000,
        recovery: 'replay-event-log',
      },
    ],
  },
  // Lane 2 / L2.S6 — capture.extraction.produced. A replica
  // announces a fresher extraction revision for an existing
  // sourceUnitId. Class E surface owned by 'extraction'
  // materializer (writes the revision + flips source state).
  // Class B surface owned by 'recall' materializer (consumes
  // active extraction revisions; source-scoped replace via
  // replaceEntriesForSourceUnit). Note: 'extraction' is not yet
  // in KNOWN_MATERIALIZERS — Lane 2 stage 6 wires the
  // extractionMaterializer; this entry is registered now so the
  // coverage test enforces that gap.
  {
    eventType: CAPTURE_EXTRACTION_PRODUCED,
    currentPayloadVersion: 1,
    surfaces: [
      {
        surface: 'extraction-revisions',
        class: 'extraction-revision',
        materializer: 'extraction',
        peerFreshnessMs: 30_000,
        recovery: 'replay-event-log',
      },
      {
        surface: 'recall-index',
        class: 'derived-cache',
        materializer: 'recall',
        peerFreshnessMs: 30_000,
        recovery: 'source-scoped-reextract',
      },
    ],
  },
  // First future surface — proves the contract is open. Two
  // surfaces per browser.timeline.observed event:
  //   1. plugin-timeline-active-window — Class F (plugin-tier
  //      bounded). Recovery is spool-drain when companion comes
  //      back online.
  //   2. timeline-projection — Class B (derived-cache; daily
  //      reduction over events, not a per-aggregate LWW). Owned by
  //      the dedicated 'timeline' materializer.
  {
    eventType: NAVIGATION_COMMITTED,
    currentPayloadVersion: 1,
    allowedDimensions: ['provenance'],
    surfaces: [
      {
        surface: 'plugin-navigation-committed',
        class: 'plugin-tier-bounded',
        peerFreshnessMs: 1_000,
        recovery: 'spool-drain',
      },
      {
        surface: 'connections-causal-spine',
        class: 'derived-cache',
        materializer: 'connections',
        peerFreshnessMs: 30_000,
        recovery: 'replay-event-log',
      },
    ],
  },
  {
    eventType: ENGAGEMENT_INTERVAL_OBSERVED,
    currentPayloadVersion: 1,
    allowedDimensions: ['engagement'],
    surfaces: [
      {
        surface: 'plugin-engagement-intervals',
        class: 'plugin-tier-bounded',
        peerFreshnessMs: 1_000,
        recovery: 'spool-drain',
      },
      {
        surface: 'engagement-session-projection',
        class: 'derived-cache',
        materializer: 'connections',
        peerFreshnessMs: 30_000,
        recovery: 'replay-event-log',
      },
    ],
  },
  {
    eventType: ENGAGEMENT_SESSION_AGGREGATED,
    currentPayloadVersion: 1,
    allowedDimensions: ['engagement'],
    surfaces: [
      {
        surface: 'engagement-session-projection',
        class: 'derived-cache',
        materializer: 'connections',
        peerFreshnessMs: 30_000,
        recovery: 'replay-event-log',
      },
    ],
  },
  {
    eventType: SELECTION_COPIED,
    currentPayloadVersion: 1,
    allowedDimensions: [],
    surfaces: [
      {
        surface: 'snippet-lineage',
        class: 'derived-cache',
        materializer: 'connections',
        peerFreshnessMs: 30_000,
        recovery: 'replay-event-log',
      },
    ],
  },
  {
    eventType: SELECTION_PASTED,
    currentPayloadVersion: 1,
    allowedDimensions: [],
    surfaces: [
      {
        surface: 'snippet-lineage',
        class: 'derived-cache',
        materializer: 'connections',
        peerFreshnessMs: 30_000,
        recovery: 'replay-event-log',
      },
    ],
  },
  {
    eventType: BROWSER_TIMELINE_OBSERVED,
    currentPayloadVersion: 1,
    surfaces: [
      {
        surface: 'plugin-timeline-active-window',
        class: 'plugin-tier-bounded',
        peerFreshnessMs: 1_000,
        recovery: 'spool-drain',
      },
      {
        surface: 'timeline-projection',
        class: 'derived-cache',
        materializer: 'timeline',
        peerFreshnessMs: 30_000,
        recovery: 'replay-event-log',
      },
    ],
  },
];

// Set of every event type that has a registry entry. Used by tests
// that need to enumerate (without iterating CONTRACT_REGISTRY itself).
export const REGISTERED_EVENT_TYPES: ReadonlySet<string> = new Set(
  CONTRACT_REGISTRY.map((entry) => entry.eventType),
);

// All registry entries that route to the given materializer.
export const entriesForMaterializer = (
  name: string,
): readonly ContractEntry[] =>
  CONTRACT_REGISTRY.filter((entry) =>
    entry.surfaces.some((surface) => surface.materializer === name),
  );

// All event types that the given materializer should react to.
export const eventTypesForMaterializer = (name: string): ReadonlySet<string> =>
  new Set(entriesForMaterializer(name).map((entry) => entry.eventType));
