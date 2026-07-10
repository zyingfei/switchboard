// Step 5 of the incremental-ranker plan — the OnlineLabelLedger.
//
// Goal: a deterministic materialized projection over the merged event
// log, keyed by a causal frontier, that an online learner (Step 6)
// will read to apply per-label pairwise weight updates. The pattern
// mirrors `sync/contract/connectionsMaterializer.ts`: replicas merge
// EVENTS, not derived state. The online weights are a projection
// computed by walking the merged event log ≤ the frontier; replica
// merges just advance the frontier and replay any newly-causally-
// observable events.
//
// Step 5 lands the substrate:
// - `AppliedRankerLabel` — one record per label produced by a feedback
//   event, keyed by `labelKey` (fromId·toId·polarity) so retries +
//   reorderings collapse to the same record.
// - `OnlineRankerState` — versioned by `appliedLabelFrontier` (causal
//   version vector) + `appliedLabelKeysDigest` (sha-tag of the sorted
//   label-keys applied so far; tie-break vs the frontier).
// - `replayLabelLedger(events)` — pure projection: events in, sorted
//   stable list of AppliedRankerLabel records out. Same input →
//   bytewise identical output (replay determinism).
// - `advanceFrontier(state, events)` — append-only state update:
//   processes events newer than the current frontier, records their
//   labels, advances the frontier + digest. Out-of-frontier events
//   are no-ops (exactly-once application).
//
// Step 5 does NOT yet:
// - Compute or update weights — `OnlineRankerState.weights` stays
//   zero. The pairwise RankNet update is Step 6.
// - Capture `featureVectorAtApplication` — needs the FeatureModel +
//   snapshot context. Step 6 wires that in (the per-event snapshot
//   the user observed is available via `event.deps`).
//
// Persistence:
// - Disk path: `_BAC/connections/closest-visit/online-ranker-state.json`
// - Lenient parser drops state and forces a re-replay if version
//   markers diverge from the trainer (featureSchemaVersion or
//   featureStatsVersion mismatch ⇒ re-base from the active LR weights).

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  isUserFlowConfirmedPayload,
  isUserFlowRejectedPayload,
  isUserOrganizedItemPayload,
  isUserSnippetPromotedPayload,
  USER_FLOW_CONFIRMED,
  USER_FLOW_REJECTED,
  USER_ORGANIZED_ITEM,
  USER_SNIPPET_PROMOTED,
} from '../feedback/events.js';
import { type AcceptedEvent, type Dot, maxVector, type VersionVector } from '../sync/causal.js';
import { FEATURE_SCHEMA_VERSION } from './feature-schema.js';
import { LOGISTIC_BATCH_FEATURE_STATS_VERSION } from './train.js';

const ONLINE_RANKER_STATE_RELATIVE_PATH = '_BAC/connections/closest-visit/online-ranker-state.json';
const ONLINE_RANKER_STATE_SCHEMA_VERSION = 1 as const;

export type LabelPolarity = 'positive' | 'negative';

// Per-label record. One per (fromId, toId, polarity) tuple emitted by
// a feedback event. `labelKey` is the dedup key — two events that
// emit the same (fromId, toId, polarity) collapse to the same record
// (the first-causally-observed wins; later ones bump
// `lastObservedDot` but don't re-apply).
export interface AppliedRankerLabel {
  readonly labelKey: string;
  readonly fromVisitId: string;
  readonly toVisitId: string;
  readonly polarity: LabelPolarity;
  readonly firstObservedDot: Dot;
  readonly lastObservedDot: Dot;
  readonly featureSchemaVersion: number;
  // Source event type — kept for diagnostics + cross-checking against
  // the FeedbackProjection batch-path label set.
  readonly eventType: string;
}

export interface OnlineRankerState {
  readonly schemaVersion: typeof ONLINE_RANKER_STATE_SCHEMA_VERSION;
  // The LightGBM revision the online state was last re-based from.
  // Step 6 uses this to determine when to re-start from the persisted
  // batch LR weights vs continue applying deltas.
  readonly baseRevisionId: string | null;
  readonly featureSchemaVersion: typeof FEATURE_SCHEMA_VERSION;
  readonly featureStatsVersion: typeof LOGISTIC_BATCH_FEATURE_STATS_VERSION;
  // Per-feature weights. Step 5 keeps these at zero (Float64Array
  // length = featureCount + 1 for bias). Step 6 mutates them via
  // pairwise SGD. Persisted as a plain number[] for portability.
  readonly weights: readonly number[];
  // Sorted unique labelKey list applied so far. Sorted so the digest
  // is independent of arrival order (causal merge commutativity).
  readonly appliedLabelKeys: readonly string[];
  readonly appliedLabelKeysDigest: string;
  // Causal frontier — events at or below this vector have been folded
  // into the state. Step 6's online pass reads `events.filter(e =>
  // !vectorCovers(frontier, e.dot))` to find work to do.
  readonly appliedLabelFrontier: VersionVector;
  readonly updateCount: number;
  readonly updatedAtMs: number;
  // When a pairwise weight update last APPLIED. `updatedAtMs` refreshes on
  // every frontier-advance write (each drain observes new events), so it
  // cannot answer "when did feedback last move the weights" — this can.
  // Optional: absent on states persisted before the field existed.
  readonly lastNudgeAtMs?: number;
}

export const EMPTY_ONLINE_RANKER_STATE = (featureCount: number): OnlineRankerState => ({
  schemaVersion: ONLINE_RANKER_STATE_SCHEMA_VERSION,
  baseRevisionId: null,
  featureSchemaVersion: FEATURE_SCHEMA_VERSION,
  featureStatsVersion: LOGISTIC_BATCH_FEATURE_STATS_VERSION,
  weights: new Array(featureCount + 1).fill(0) as number[],
  appliedLabelKeys: [],
  appliedLabelKeysDigest: digestLabelKeys([]),
  appliedLabelFrontier: {},
  updateCount: 0,
  updatedAtMs: 0,
});

// Deterministic dedup key. Field-separator NUL keeps "a\0b" from
// colliding with "ab\0" — same convention the feedback projection
// uses for `itemId` keying in user.flow.confirmed (`fromId\0toId`).
export const labelKeyFor = (fromId: string, toId: string, polarity: LabelPolarity): string =>
  `${fromId}\u0000${toId}\u0000${polarity}`;

const digestLabelKeys = (sortedKeys: readonly string[]): string =>
  createHash('sha256').update(sortedKeys.join('\n')).digest('hex');

interface RawLabel {
  readonly fromVisitId: string;
  readonly toVisitId: string;
  readonly polarity: LabelPolarity;
  readonly eventType: string;
}

// Pure event → labels extractor. Mirrors `feedback/projection.ts`
// label-emission logic without ever expanding container membership;
// the online path stays event-scoped end-to-end.
const labelsFromEvent = (event: AcceptedEvent): readonly RawLabel[] => {
  const out: RawLabel[] = [];
  if (event.type === USER_FLOW_CONFIRMED && isUserFlowConfirmedPayload(event.payload)) {
    out.push({
      fromVisitId: event.payload.fromId,
      toVisitId: event.payload.toId,
      polarity: 'positive',
      eventType: event.type,
    });
    return out;
  }
  if (event.type === USER_FLOW_REJECTED && isUserFlowRejectedPayload(event.payload)) {
    out.push({
      fromVisitId: event.payload.fromId,
      toVisitId: event.payload.toId,
      polarity: 'negative',
      eventType: event.type,
    });
    return out;
  }
  if (event.type === USER_ORGANIZED_ITEM && isUserOrganizedItemPayload(event.payload)) {
    if (
      event.payload.action === 'move' ||
      event.payload.action === 'merge' ||
      event.payload.action === 'promote'
    ) {
      const toContainer = event.payload.toContainer;
      if (typeof toContainer === 'string' && toContainer.length > 0) {
        out.push({
          fromVisitId: event.payload.itemId,
          toVisitId: toContainer,
          polarity: 'positive',
          eventType: event.type,
        });
      }
    }
    // `ignore` / `split` container negatives stay event-scoped here;
    // snapshot membership must not rewrite them into pairwise labels.
    return out;
  }
  if (event.type === USER_SNIPPET_PROMOTED && isUserSnippetPromotedPayload(event.payload)) {
    const source = event.payload.sourceVisitId ?? event.payload.snippetId;
    out.push({
      fromVisitId: source,
      toVisitId: event.payload.targetId,
      polarity: 'positive',
      eventType: event.type,
    });
    return out;
  }
  return out;
};

const versionVectorEqual = (a: VersionVector, b: VersionVector): boolean => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if ((a[key] ?? 0) !== (b[key] ?? 0)) return false;
  }
  return true;
};

const dotCompare = (left: Dot, right: Dot): number => {
  if (left.replicaId !== right.replicaId) {
    return left.replicaId < right.replicaId ? -1 : 1;
  }
  return left.seq - right.seq;
};

const dotIsEarlier = (left: Dot, right: Dot): boolean => dotCompare(left, right) < 0;

// Replay the merged event log into a sorted, deduped list of applied
// labels. Pure; called from the batch path + from tests to verify
// replay determinism.
//
// Sort order: by `labelKey` (deterministic, independent of event
// arrival order). The `firstObservedDot` for each key is the
// causally-earliest event that produced it; ties broken on
// (replicaId, seq).
export const replayLabelLedger = (
  events: readonly AcceptedEvent[],
): readonly AppliedRankerLabel[] => {
  const byKey = new Map<string, AppliedRankerLabel>();
  for (const event of events) {
    for (const raw of labelsFromEvent(event)) {
      const key = labelKeyFor(raw.fromVisitId, raw.toVisitId, raw.polarity);
      const existing = byKey.get(key);
      if (existing === undefined) {
        byKey.set(key, {
          labelKey: key,
          fromVisitId: raw.fromVisitId,
          toVisitId: raw.toVisitId,
          polarity: raw.polarity,
          firstObservedDot: event.dot,
          lastObservedDot: event.dot,
          featureSchemaVersion: FEATURE_SCHEMA_VERSION,
          eventType: raw.eventType,
        });
        continue;
      }
      // Replay determinism: the "first" is the causally earliest dot,
      // not the array-iteration first. The "last" is the latest.
      const firstObservedDot = dotIsEarlier(event.dot, existing.firstObservedDot)
        ? event.dot
        : existing.firstObservedDot;
      const lastObservedDot = dotIsEarlier(existing.lastObservedDot, event.dot)
        ? event.dot
        : existing.lastObservedDot;
      byKey.set(key, {
        ...existing,
        firstObservedDot,
        lastObservedDot,
      });
    }
  }
  return [...byKey.values()].sort((left, right) =>
    left.labelKey < right.labelKey ? -1 : left.labelKey > right.labelKey ? 1 : 0,
  );
};

export interface AdvanceFrontierResult {
  readonly state: OnlineRankerState;
  // Labels NEWLY observed by this advance — i.e. label keys that were
  // not yet in `state.appliedLabelKeys` but are now. Step 6 consumes
  // this list to drive pairwise SGD updates.
  readonly newLabels: readonly AppliedRankerLabel[];
}

// Advance the state's frontier by folding in any events whose
// labels aren't yet applied. Idempotent: replaying the same events
// twice yields the same state. Causal-commutative: applying events
// in any order produces the same labelKey set (the underlying
// replay sorts + dedupes deterministically).
//
// Codex review of PR #231 caught a subtle bug in the earlier
// implementation: it filtered events upfront via `vectorCovers`, and
// the frontier advanced by `maxVector` (not contiguous-prefix), so
// late-arriving lower-seq peer events after a higher seq had advanced
// the vector clock got dropped. Fix: stop using the frontier to
// filter events. The `appliedLabelKeys` set is the sole source of
// truth for "have we already seen this label" — labelKey de-dup
// handles correctness even when events arrive in arbitrary order
// from a replica. The frontier becomes purely informational
// (per-replica max-seen seq) and is computed over ALL events.
export const advanceFrontier = (
  state: OnlineRankerState,
  events: readonly AcceptedEvent[],
  nowMs: number,
): AdvanceFrontierResult => {
  // Re-replay the full event set. The projection is small (one
  // record per unique labelKey, bounded by user actions), the sort
  // is O(n log n) over ~hundreds of labels.
  const allLabels = replayLabelLedger(events);
  const previouslyApplied = new Set(state.appliedLabelKeys);
  const newLabels = allLabels.filter((label) => !previouslyApplied.has(label.labelKey));

  // Frontier (informational) = max(current, max-dot-per-replica
  // observed across ALL events). Used for diagnostics + reasoning
  // about coverage, never for correctness (labelKey set is the
  // authoritative de-dup).
  let frontier = state.appliedLabelFrontier;
  for (const event of events) {
    frontier = maxVector(frontier, { [event.dot.replicaId]: event.dot.seq });
  }
  const frontierChanged = !versionVectorEqual(frontier, state.appliedLabelFrontier);

  if (newLabels.length === 0) {
    // No new labels — but the frontier may still advance if we
    // observed events whose labels were already applied. Surface
    // that without claiming new label work.
    if (!frontierChanged) {
      return { state, newLabels: [] };
    }
    return {
      state: { ...state, appliedLabelFrontier: frontier, updatedAtMs: nowMs },
      newLabels: [],
    };
  }

  const appliedLabelKeys = [
    ...state.appliedLabelKeys,
    ...newLabels.map((label) => label.labelKey),
  ].sort();
  const appliedLabelKeysDigest = digestLabelKeys(appliedLabelKeys);

  return {
    state: {
      ...state,
      appliedLabelKeys,
      appliedLabelKeysDigest,
      appliedLabelFrontier: frontier,
      updateCount: state.updateCount + newLabels.length,
      updatedAtMs: nowMs,
    },
    newLabels,
  };
};

// =============== persistence ===============

export const onlineRankerStatePath = (vaultRoot: string): string =>
  join(vaultRoot, ONLINE_RANKER_STATE_RELATIVE_PATH);

const writeAtomic = async (path: string, body: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${String(process.pid)}.tmp`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, path);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

const isVersionVector = (value: unknown): value is VersionVector => {
  if (!isRecord(value)) return false;
  for (const seq of Object.values(value)) {
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return false;
  }
  return true;
};

// Lenient parser. A divergent schemaVersion / featureSchemaVersion /
// featureStatsVersion ⇒ return null so the caller treats the state
// as absent and re-bases from the batch LR weights. This is the
// refuse-to-score invariant for the online path.
export const readOnlineRankerState = async (
  vaultRoot: string,
): Promise<OnlineRankerState | null> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(onlineRankerStatePath(vaultRoot), 'utf8'));
    if (!isRecord(parsed)) return null;
    if (parsed['schemaVersion'] !== ONLINE_RANKER_STATE_SCHEMA_VERSION) return null;
    if (parsed['featureSchemaVersion'] !== FEATURE_SCHEMA_VERSION) return null;
    if (parsed['featureStatsVersion'] !== LOGISTIC_BATCH_FEATURE_STATS_VERSION) return null;
    const weightsRaw = parsed['weights'];
    if (!Array.isArray(weightsRaw)) return null;
    if (!weightsRaw.every(isFiniteNumber)) return null;
    if (!isStringArray(parsed['appliedLabelKeys'])) return null;
    if (typeof parsed['appliedLabelKeysDigest'] !== 'string') return null;
    if (!isVersionVector(parsed['appliedLabelFrontier'])) return null;
    if (!isFiniteNumber(parsed['updateCount'])) return null;
    if (!isFiniteNumber(parsed['updatedAtMs'])) return null;
    const baseRevisionId = parsed['baseRevisionId'];
    if (baseRevisionId !== null && typeof baseRevisionId !== 'string') return null;
    // Optional (pre-existing states omit it); malformed ⇒ treat as absent
    // rather than dropping the whole state.
    const lastNudgeAtMs = parsed['lastNudgeAtMs'];
    return {
      schemaVersion: ONLINE_RANKER_STATE_SCHEMA_VERSION,
      baseRevisionId,
      featureSchemaVersion: FEATURE_SCHEMA_VERSION,
      featureStatsVersion: LOGISTIC_BATCH_FEATURE_STATS_VERSION,
      weights: weightsRaw,
      appliedLabelKeys: parsed['appliedLabelKeys'],
      appliedLabelKeysDigest: parsed['appliedLabelKeysDigest'],
      appliedLabelFrontier: parsed['appliedLabelFrontier'],
      updateCount: parsed['updateCount'],
      updatedAtMs: parsed['updatedAtMs'],
      ...(isFiniteNumber(lastNudgeAtMs) ? { lastNudgeAtMs } : {}),
    };
  } catch {
    return null;
  }
};

export const writeOnlineRankerState = async (
  vaultRoot: string,
  state: OnlineRankerState,
): Promise<void> => {
  await writeAtomic(onlineRankerStatePath(vaultRoot), `${JSON.stringify(state, null, 2)}\n`);
};
