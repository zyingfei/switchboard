// Derivation-DAG lineage registry.
//
// This module is DATA, not a framework. It declares — in one typed
// place — every derived store the companion maintains: what raw event
// types feed it, where the code that rebuilds it lives, and whether it
// is on by default. Today nothing in the runtime reads this registry;
// it exists so the health/docs surfaces (and the eventual
// SIDETRACK_EVENT_STORE default-ON decision) have a single source of
// truth for the storage layout, instead of the DAG living only in
// scattered comments across ~9 on-disk formats.
//
// Freeze-safe: this is documentation-of-layout + a small accessor. It
// wires no serving math, changes no thresholds, and imports no runtime
// modules (rebuildEntrypoint is a descriptive `module:function` string,
// NOT a live function pointer) so it stays inert and cheap to import.
//
// KEEP IN SYNC when a store's default flag flips, its rebuild code
// moves, or a new derived store lands. The lineage.test.ts coverage
// gate asserts the registry is internally consistent (unique ids, the
// canonical source declared, valid default states).

import { ENGAGEMENT_INTERVAL_OBSERVED } from '../engagement/events.js';
import { PAGE_EVIDENCE_EXTRACTED } from '../page-evidence/events.js';
import { BROWSER_TIMELINE_OBSERVED } from '../timeline/events.js';

/**
 * Whether a derived store is materialised by default on a stock
 * companion, or is opt-in behind an env flag / non-default engine.
 * `canonical` marks the append-only sources everything else derives
 * from — they are not "derived" but are listed so the DAG has roots.
 */
export type LineageDefaultState = 'canonical' | 'default-on' | 'default-off' | 'always-on';

export interface LineageNode {
  /** Stable id, also used as the DAG edge key. */
  readonly id: string;
  /** Human-facing name. */
  readonly label: string;
  /** On-disk location relative to the vault root. */
  readonly path: string;
  /** The lineage ids this store derives FROM (its inputs). */
  readonly derivesFrom: readonly string[];
  /**
   * The raw event types this store folds. Empty for canonical roots and
   * for stores whose input is another derived store rather than raw
   * events. `'*'` means "all event types" (whole-log consumers).
   */
  readonly sourceEventTypes: readonly string[];
  /**
   * Descriptive reference to the code that rebuilds this store from its
   * source, as `path/to/module.ts:exportName`. A STRING by design — the
   * registry stays a dependency-free data island; callers that want to
   * actually run a rebuild resolve the reference themselves.
   */
  readonly rebuildEntrypoint: string;
  /** Default materialisation state (see LineageDefaultState). */
  readonly defaultState: LineageDefaultState;
  /**
   * The env var that toggles this store, when it has one. Documented
   * here so the single lineage view also answers "how do I flip it?".
   */
  readonly toggleEnv?: string;
}

// Canonical append-only roots. Everything else derives from these.
const CANONICAL_EVENT_LOG = 'event-log';
const PROJECTION_CHANGES = 'projection-changes';

export const LINEAGE_REGISTRY: readonly LineageNode[] = [
  {
    id: CANONICAL_EVENT_LOG,
    label: 'Canonical event log (JSONL)',
    path: '_BAC/log/<replicaId>/<date>.jsonl',
    derivesFrom: [],
    sourceEventTypes: [],
    rebuildEntrypoint: 'sync/eventLog.ts:createEventLog',
    defaultState: 'canonical',
  },
  {
    id: PROJECTION_CHANGES,
    label: 'Projection change feed (monotonic cursor)',
    path: '_BAC/.sync/projection-changes.jsonl',
    derivesFrom: [CANONICAL_EVENT_LOG],
    sourceEventTypes: [],
    rebuildEntrypoint: 'sync/projectionChanges.ts:createProjectionChangeFeed',
    defaultState: 'canonical',
  },
  {
    id: 'event-store',
    label: 'Event store (SQLite mirror of the JSONL log)',
    path: '_BAC/connections/event-store.db',
    derivesFrom: [CANONICAL_EVENT_LOG],
    sourceEventTypes: ['*'],
    rebuildEntrypoint: 'sync/eventStore.ts:rebuildFromJsonl',
    defaultState: 'default-off',
    toggleEnv: 'SIDETRACK_EVENT_STORE',
  },
  {
    id: 'engagement-facts',
    label: 'Engagement classifier facts (SQLite)',
    path: '_BAC/connections/engagement-facts.db',
    derivesFrom: [CANONICAL_EVENT_LOG],
    sourceEventTypes: [ENGAGEMENT_INTERVAL_OBSERVED, 'engagement.session.aggregated'],
    rebuildEntrypoint: 'engagement/engagementFactsStore.ts:createEngagementFactsStore',
    defaultState: 'default-off',
    toggleEnv: 'SIDETRACK_ENGAGEMENT_FACTS_STORE',
  },
  {
    id: 'timeline-facts',
    label: 'Timeline day facts (SQLite)',
    path: '_BAC/connections/timeline-facts.db',
    derivesFrom: [CANONICAL_EVENT_LOG],
    sourceEventTypes: [BROWSER_TIMELINE_OBSERVED],
    rebuildEntrypoint: 'timeline/timelineFactsStore.ts:createTimelineFactsStore',
    defaultState: 'default-off',
    toggleEnv: 'SIDETRACK_TIMELINE_FACTS_STORE',
  },
  {
    id: 'connections-current',
    label: 'Connections graph snapshot (current)',
    path: '_BAC/connections/current.db',
    derivesFrom: [CANONICAL_EVENT_LOG, 'engagement-facts', 'timeline-facts'],
    // The connections materializer folds the full structural event set;
    // the exact handled set lives in the contract registry (materializer
    // 'connections'). Listed as '*' here because it consumes across many
    // owners rather than a fixed short list.
    sourceEventTypes: ['*'],
    rebuildEntrypoint: 'sync/contract/connectionsMaterializer.ts:createConnectionsMaterializer',
    defaultState: 'always-on',
    // The JSON-store engine is the opt-in variant; the default is SQLite.
    toggleEnv: 'SIDETRACK_CONNECTIONS_STORE',
  },
  {
    id: 'connections-daily-snapshots',
    label: 'Connections daily snapshots',
    path: '_BAC/connections/snapshots/<date>.json',
    derivesFrom: ['connections-current'],
    sourceEventTypes: [],
    rebuildEntrypoint: 'connections/snapshot.ts:ConnectionsStore.putDay',
    defaultState: 'always-on',
  },
  {
    id: 'recall-v2-index',
    label: 'Recall v2 hybrid index (FTS5 + sqlite-vec)',
    path: '_BAC/recall/v2/index.sqlite',
    derivesFrom: [CANONICAL_EVENT_LOG],
    sourceEventTypes: [PAGE_EVIDENCE_EXTRACTED, 'capture.recorded'],
    rebuildEntrypoint: 'recall-v2/store/backfill.ts:backfillRecallStore',
    defaultState: 'always-on',
  },
  {
    id: 'recall-index',
    label: 'Recall keyword index',
    path: '_BAC/recall/index.bin',
    derivesFrom: [CANONICAL_EVENT_LOG],
    sourceEventTypes: ['capture.recorded', 'capture.extraction.produced'],
    rebuildEntrypoint: 'recall/rebuild.ts:rebuildFromEventLog',
    defaultState: 'always-on',
  },
  {
    id: 'semantic-pool',
    label: 'Semantic recall pool (vectors + neighbours)',
    path: '_BAC/recall/semantic-pool/vectors.json',
    derivesFrom: ['recall-v2-index'],
    sourceEventTypes: [],
    rebuildEntrypoint: 'recall/semanticRecallPool.ts:getOrBuildSemanticRecallPool',
    defaultState: 'default-on',
    toggleEnv: 'SIDETRACK_ENABLE_SEMANTIC_RECALL_POOL',
  },
];

const REGISTRY_BY_ID: ReadonlyMap<string, LineageNode> = new Map(
  LINEAGE_REGISTRY.map((node) => [node.id, node]),
);

/** Look up a lineage node by id, or `undefined` when unknown. */
export const lineageNode = (id: string): LineageNode | undefined => REGISTRY_BY_ID.get(id);

/** Every derived (non-canonical) store — the stores with a rebuild path. */
export const derivedLineageNodes = (): readonly LineageNode[] =>
  LINEAGE_REGISTRY.filter((node) => node.defaultState !== 'canonical');

/**
 * The direct + transitive inputs of a store, in dependency order (roots
 * first). Cheap: the DAG is tiny and acyclic. Returns `[]` for an
 * unknown id.
 */
export const lineageInputsOf = (id: string): readonly LineageNode[] => {
  const seen = new Set<string>();
  const order: LineageNode[] = [];
  const visit = (nodeId: string): void => {
    const node = REGISTRY_BY_ID.get(nodeId);
    if (node === undefined) return;
    for (const parent of node.derivesFrom) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      visit(parent);
      const parentNode = REGISTRY_BY_ID.get(parent);
      if (parentNode !== undefined) order.push(parentNode);
    }
  };
  visit(id);
  return order;
};
