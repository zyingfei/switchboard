// Durable cross-drain state for the served-signal floor guard.
//
// Why this exists: in production the CLI sets SIDETRACK_CONNECTIONS_CHILD=1
// (cli.ts), so every connections drain runs buildAndWrite inside a fresh
// single-use fork (connectionsReconcileChild.entry.ts calls process.exit
// after one drain). That means ANY in-memory closure counter inside
// createConnectionsMaterializer is re-instantiated every drain and can
// only ever read {0, 1}. The floor guard needs three pieces of state to
// survive the fork:
//
//   1. A durable suppressed-collapse LATCH + running count so /v1/system/
//      health can reflect whether the graph is CURRENTLY flapping (a
//      recent-window signal) while keeping the lifetime total as a
//      metric (findings on the monotonic health pin + the child-fork
//      counter reset).
//
//   2. A bounded-recovery escape: consecutive suppressions of the SAME
//      built low-count band. A flap alternates high/empty (the count
//      resets each clean drain); a sustained shift (real deletion) keeps
//      rebuilding the same low count. After N consecutive suppressions we
//      accept the new lower revision as the truth so a real deletion is
//      never pinned forever.
//
//   3. A privacy-purge reset EPOCH. A DOMAIN_TOMBSTONE / RECALL_TOMBSTONE
//      arms a reset that must stay active across the LATER drain(s) where
//      the similarity-edge collapse actually lands (the tombstone event is
//      no longer in that drain's window). The epoch is armed when a
//      tombstone is observed and consumed once a legitimate collapse is
//      published (or a full rebuild recomputes past it).
//
// The module is a thin durable store (read/merge/write of one small JSON
// artifact under _BAC/). The pure decisions live in similarityFloorGuard.ts;
// this file is the infrastructure port that persists their inputs/outputs.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SIMILARITY_FLOOR_STATE_SCHEMA_VERSION = 1;

// Consecutive suppressions of the same low-count band after which the
// guard accepts the new lower revision as the truth (bounded recovery).
// A genuine flap self-heals on the next clean drain (resetting the run),
// so only a SUSTAINED low count reaches this threshold. Chosen at 4 —
// long enough that a coin-flip flap essentially never trips it, short
// enough that a real deletion recovers within a handful of drains.
export const SIMILARITY_FLOOR_SUSTAINED_COLLAPSE_DRAINS = 4;

// Consecutive clean drains after which the health surface stops
// reporting the floor section as flapping. Keeps the alarm reflecting
// CURRENT state (a permanently-red light is alarm fatigue) while the
// lifetime count remains a metric. A single clean drain is not enough to
// declare recovery (the flap alternates), so we require a short run.
export const SIMILARITY_FLOOR_HEALTH_RECOVERY_CLEAN_DRAINS = 3;

// Two built low-count bands are "the same" for the sustained-collapse
// counter if they fall in the same bucket. A real deletion re-builds a
// stable low count each drain (e.g. always 0, or always ~40); a flap
// alternates between 0 and the prior high. Bucketing by a coarse log-ish
// band keeps small builder jitter from resetting the run.
export const similarityFloorLowCountBand = (edgeCount: number): number => {
  if (edgeCount <= 0) return 0;
  // 1..10 → 1, 11..100 → 2, 101..1000 → 3, ...
  return Math.floor(Math.log10(edgeCount)) + 1;
};

export interface SimilarityFloorState {
  readonly schemaVersion: typeof SIMILARITY_FLOOR_STATE_SCHEMA_VERSION;
  // Lifetime running count of suppressed collapses (metric only — NOT a
  // health status driver).
  readonly suppressedCollapseCount: number;
  // Epoch ms of the most recent suppressed collapse, or null if never.
  readonly lastSuppressedAtMs: number | null;
  // Consecutive clean (non-suppressed) drains since the last suppression.
  // Drives the health recovery decay.
  readonly consecutiveCleanDrains: number;
  // The low-count band of the built revision that was suppressed on the
  // last suppression run, or null. Used to detect a SUSTAINED collapse.
  readonly lastSuppressedBuiltBand: number | null;
  // Consecutive suppressions landing in `lastSuppressedBuiltBand`.
  readonly consecutiveSuppressionsInBand: number;
  // Monotonic purge epoch. Incremented when a tombstone is observed.
  readonly purgeResetArmedEpoch: number;
  // The purge epoch that has been consumed by a published collapse / full
  // rebuild. `purgeResetArmedEpoch > purgeResetConsumedEpoch` ⇒ a purge
  // reset is pending and the floor guard must allow the collapse through.
  readonly purgeResetConsumedEpoch: number;
  // The embedding model revision that produced the currently served
  // similarity edges. When the live RECALL_MODEL revision differs, the
  // old edges live in a different vector space and a collapse is a
  // legitimate model-change reset (NOT only a dimension mismatch). null
  // until the first published revision records it.
  readonly servedModelRevision: string | null;
}

export const EMPTY_SIMILARITY_FLOOR_STATE: SimilarityFloorState = {
  schemaVersion: SIMILARITY_FLOOR_STATE_SCHEMA_VERSION,
  suppressedCollapseCount: 0,
  lastSuppressedAtMs: null,
  consecutiveCleanDrains: 0,
  lastSuppressedBuiltBand: null,
  consecutiveSuppressionsInBand: 0,
  purgeResetArmedEpoch: 0,
  purgeResetConsumedEpoch: 0,
  servedModelRevision: null,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const numberOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

// Parse an unknown JSON blob into a state struct, tolerating legacy /
// partial shapes (boundary validation: never trust the file). Any field
// that fails validation falls back to the empty default for that field.
export const parseSimilarityFloorState = (value: unknown): SimilarityFloorState => {
  if (!isRecord(value)) return EMPTY_SIMILARITY_FLOOR_STATE;
  return {
    schemaVersion: SIMILARITY_FLOOR_STATE_SCHEMA_VERSION,
    suppressedCollapseCount: Math.max(0, numberOr(value['suppressedCollapseCount'], 0)),
    lastSuppressedAtMs: numberOrNull(value['lastSuppressedAtMs']),
    consecutiveCleanDrains: Math.max(0, numberOr(value['consecutiveCleanDrains'], 0)),
    lastSuppressedBuiltBand: numberOrNull(value['lastSuppressedBuiltBand']),
    consecutiveSuppressionsInBand: Math.max(
      0,
      numberOr(value['consecutiveSuppressionsInBand'], 0),
    ),
    purgeResetArmedEpoch: Math.max(0, numberOr(value['purgeResetArmedEpoch'], 0)),
    purgeResetConsumedEpoch: Math.max(0, numberOr(value['purgeResetConsumedEpoch'], 0)),
    servedModelRevision: stringOrNull(value['servedModelRevision']),
  };
};

// True when a privacy-purge reset is armed and not yet consumed.
export const purgeResetPending = (state: SimilarityFloorState): boolean =>
  state.purgeResetArmedEpoch > state.purgeResetConsumedEpoch;

// The health surface should report the floor as CURRENTLY flapping only
// when a suppression happened recently AND the graph has not shown a
// short run of clean drains since. This turns a permanent red light into
// a signal that reflects current state.
export const similarityFloorHealthFlapping = (state: SimilarityFloorState): boolean =>
  state.lastSuppressedAtMs !== null &&
  state.consecutiveCleanDrains < SIMILARITY_FLOOR_HEALTH_RECOVERY_CLEAN_DRAINS;

// Fold this drain's outcome into the durable state. Pure — the store
// wraps it around read/write.
export const foldSimilarityFloorDrain = (
  state: SimilarityFloorState,
  drain: {
    readonly suppressed: boolean;
    readonly builtEdgeCount: number;
    readonly nowMs: number;
    // A tombstone/purge was observed in THIS drain's event window.
    readonly purgeObservedThisDrain: boolean;
    // A legitimate collapse (reset reason fired) was published this drain,
    // OR a full rebuild recomputed the corpus — either consumes a pending
    // purge reset.
    readonly resetConsumedThisDrain: boolean;
    // The sustained-collapse escape accepted the new low revision this
    // drain (so the run counter resets even though a collapse occurred).
    readonly sustainedCollapseAccepted: boolean;
    // The embedding model revision the drain PUBLISHED with. On a
    // carry-forward the served edges stay in the OLD model space, so the
    // materializer passes the carried revision's modelRevision here (not
    // the live one) to keep the recorded provenance honest.
    readonly servedModelRevision: string | null;
  },
): SimilarityFloorState => {
  let next: SimilarityFloorState =
    drain.servedModelRevision === null
      ? state
      : { ...state, servedModelRevision: drain.servedModelRevision };
  // Arm the purge reset epoch when a tombstone was observed.
  if (drain.purgeObservedThisDrain) {
    next = { ...next, purgeResetArmedEpoch: next.purgeResetArmedEpoch + 1 };
  }
  // Consume a pending purge reset once a legitimate collapse / full
  // rebuild has recomputed past it.
  if (drain.resetConsumedThisDrain && purgeResetPending(next)) {
    next = { ...next, purgeResetConsumedEpoch: next.purgeResetArmedEpoch };
  }
  if (drain.suppressed && !drain.sustainedCollapseAccepted) {
    const band = similarityFloorLowCountBand(drain.builtEdgeCount);
    const sameBand = next.lastSuppressedBuiltBand === band;
    return {
      ...next,
      suppressedCollapseCount: next.suppressedCollapseCount + 1,
      lastSuppressedAtMs: drain.nowMs,
      consecutiveCleanDrains: 0,
      lastSuppressedBuiltBand: band,
      consecutiveSuppressionsInBand: sameBand ? next.consecutiveSuppressionsInBand + 1 : 1,
    };
  }
  // Clean drain (or a sustained-collapse acceptance, which resets the
  // run because the low count is now the truth).
  return {
    ...next,
    consecutiveCleanDrains: next.consecutiveCleanDrains + 1,
    lastSuppressedBuiltBand: null,
    consecutiveSuppressionsInBand: 0,
  };
};

// True when the current suppression run has reached the sustained-collapse
// threshold for the just-built band — i.e. a real deletion, not a flap.
// `pendingBuiltEdgeCount` is the count the drain is about to (again)
// suppress; the run is counted INCLUSIVE of this drain.
export const similarityFloorSustainedCollapseReached = (
  state: SimilarityFloorState,
  pendingBuiltEdgeCount: number,
): boolean => {
  const band = similarityFloorLowCountBand(pendingBuiltEdgeCount);
  if (state.lastSuppressedBuiltBand !== band) return false;
  // +1 for the drain currently being decided.
  return state.consecutiveSuppressionsInBand + 1 >= SIMILARITY_FLOOR_SUSTAINED_COLLAPSE_DRAINS;
};

export interface SimilarityFloorStateStore {
  readonly read: () => Promise<SimilarityFloorState>;
  readonly write: (state: SimilarityFloorState) => Promise<void>;
}

const STATE_RELATIVE_PATH = ['_BAC', 'connections', 'similarity-floor-state.json'] as const;

// Filesystem-backed store. Best-effort like the diagnostics store: a read
// failure degrades to the empty state (fail open — a missing durable
// signal must not wedge a drain), and a write failure is swallowed by the
// caller. Atomic write via tmp+rename.
export const createSimilarityFloorStateStore = (
  vaultRoot: string,
): SimilarityFloorStateStore => {
  const path = join(vaultRoot, ...STATE_RELATIVE_PATH);
  return {
    read: async (): Promise<SimilarityFloorState> => {
      try {
        const raw = await readFile(path, 'utf8');
        return parseSimilarityFloorState(JSON.parse(raw));
      } catch {
        return EMPTY_SIMILARITY_FLOOR_STATE;
      }
    },
    write: async (state: SimilarityFloorState): Promise<void> => {
      await mkdir(join(vaultRoot, STATE_RELATIVE_PATH[0], STATE_RELATIVE_PATH[1]), {
        recursive: true,
      });
      const body = `${JSON.stringify(state, null, 2)}\n`;
      const tmpPath = `${path}.${String(process.pid)}.tmp`;
      await writeFile(tmpPath, body, 'utf8');
      await rename(tmpPath, path);
    },
  };
};
