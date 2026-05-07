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
import { QUEUE_CREATED, QUEUE_STATUS_SET } from '../../queue/events.js';
import { CAPTURE_RECORDED, RECALL_TOMBSTONE_TARGET } from '../../recall/events.js';
import { REVIEW_DRAFT_EVENT_TYPES } from '../../review/projection.js';
import {
  THREAD_ARCHIVED,
  THREAD_DELETED,
  THREAD_UNARCHIVED,
  THREAD_UPSERTED,
} from '../../threads/events.js';
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
export const KNOWN_MATERIALIZERS: ReadonlySet<string> = new Set<string>([
  'projection',
  'recall',
  // 'extraction',         // Lane 2 — uncomment when extractionMaterializer ships
]);

const projectionEntry = (eventType: string, surface: string): ContractEntry => ({
  eventType,
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
  // Annotation events fan out to TWO surfaces: the projection (Class A,
  // SSE-mirrored) AND the in-page overlay refresh (Class A, dispatched
  // via runtime message to tabs viewing the annotated URL).
  {
    eventType: ANNOTATION_CREATED,
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
