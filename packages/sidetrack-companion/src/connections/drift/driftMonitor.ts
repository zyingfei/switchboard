// Connections drift layer — drift monitor.
//
// One observation per signal per materializer drain is fed through a
// pair of change detectors (ADWIN + KSWIN). The monitor reports an
// aggregate status:
//
//   - `drift`   — at least one signal's ADWIN *or* KSWIN confirmed a
//                 distribution change this drain;
//   - `warning` — no confirmed change but at least one signal's KSWIN
//                 is within the warning band, or the temporal
//                 silhouette dropped sharply;
//   - `stable`  — nothing tripped.
//
// Signals consumed (all already produced by the existing pipeline):
//
//   Always available (from `MaterializerDiagnostics`):
//     - similarityEdgeCount   (similarity.edgeCount)
//     - topicCount            (topics.topicCount)
//     - topicMemberCount      (topics.memberCount)
//     - snapshotEdgeCount     (snapshot.edgeCount)
//
//   Available only when the topic shadow candidate is enabled
//   (`shadowVsBaseline` present):
//     - perVisitChurn
//     - noiseShare
//     - edgeCountBeforePruning
//     - edgeCountAfterPruning
//     - maxTopicSizeDelta
//
// The monitor is pure given its inputs + restored detector state. It
// never rebuilds topics or similarity; it only reads the diagnostic
// numbers the materializer already computed. All persistence I/O is
// wrapped so observability can never fail the drain — exactly the
// contract the existing diagnostics artifact follows.

import { Adwin } from './adwin.js';
import { Kswin } from './kswin.js';
import type { DriftPersistedState, DriftStateStore } from './driftStateStore.js';
import { DRIFT_STATE_SCHEMA_VERSION } from './driftStateStore.js';
import {
  TemporalSilhouetteTracker,
  computeRevisionSilhouette,
  type RevisionSilhouette,
  type SilhouetteSimilarityEdge,
  type SilhouetteTopic,
} from './temporalSilhouette.js';

export const DRIFT_MONITOR_SCHEMA_VERSION = 1;

export type DriftStatus = 'stable' | 'warning' | 'drift';

// A sharp silhouette drop (cluster quality decay) is itself a warning
// even if no single counter tripped a detector.
const SILHOUETTE_WARNING_DROP = 0.15;

export interface DriftSignalSample {
  readonly name: string;
  readonly value: number;
}

export interface DriftSignalReport {
  readonly name: string;
  readonly value: number;
  readonly adwinDrift: boolean;
  readonly kswinDrift: boolean;
  readonly kswinWarning: boolean;
  /** Per-signal status folded from the two detectors. */
  readonly status: DriftStatus;
  /** Running mean of ADWIN's adaptive window after this observation. */
  readonly adwinMean: number;
}

export interface DriftSilhouetteReport {
  readonly revisionId: string;
  readonly silhouette: number | null;
  readonly previousSilhouette: number | null;
  readonly delta: number | null;
  readonly meanCohesion: number;
  readonly meanSeparation: number;
  readonly topicCount: number;
}

export interface DriftReport {
  readonly schemaVersion: typeof DRIFT_MONITOR_SCHEMA_VERSION;
  readonly status: DriftStatus;
  /** Signal names that confirmed a drift this drain (sorted). */
  readonly trippedSignals: readonly string[];
  /** Signal names in the warning band this drain (sorted). */
  readonly warningSignals: readonly string[];
  readonly signals: readonly DriftSignalReport[];
  readonly silhouette: DriftSilhouetteReport;
}

// Diagnostic series the monitor knows how to extract — the single
// source of truth for the signal catalogue. A new signal is added by
// extending these arrays (an extension point, not a central switch the
// pipeline branches on). Exported so consumers/tests assert against the
// canonical list rather than re-hardcoding strings.
export const ALWAYS_AVAILABLE_SIGNALS = [
  'similarityEdgeCount',
  'topicCount',
  'topicMemberCount',
  'snapshotEdgeCount',
] as const;

export const SHADOW_SIGNALS = [
  'perVisitChurn',
  'noiseShare',
  'edgeCountBeforePruning',
  'edgeCountAfterPruning',
  'maxTopicSizeDelta',
] as const;

/** Every signal name the monitor can emit, in catalogue order. */
export const DRIFT_SIGNAL_NAMES: readonly string[] = [
  ...ALWAYS_AVAILABLE_SIGNALS,
  ...SHADOW_SIGNALS,
];

export type DriftSignalName =
  | (typeof ALWAYS_AVAILABLE_SIGNALS)[number]
  | (typeof SHADOW_SIGNALS)[number];

export interface DriftMonitorObservation {
  /** Diagnostic series sampled this drain. Order is irrelevant. */
  readonly samples: readonly DriftSignalSample[];
  /** Topic revision id this drain (drives the temporal silhouette). */
  readonly revisionId: string;
  readonly topics: readonly SilhouetteTopic[];
  readonly similarityEdges: readonly SilhouetteSimilarityEdge[];
}

const foldSignalStatus = (
  adwinDrift: boolean,
  kswinDrift: boolean,
  kswinWarning: boolean,
): DriftStatus => {
  if (adwinDrift || kswinDrift) return 'drift';
  if (kswinWarning) return 'warning';
  return 'stable';
};

const escalate = (current: DriftStatus, next: DriftStatus): DriftStatus => {
  if (current === 'drift' || next === 'drift') return 'drift';
  if (current === 'warning' || next === 'warning') return 'warning';
  return 'stable';
};

interface SignalDetectors {
  readonly adwin: Adwin;
  readonly kswin: Kswin;
}

/**
 * Stateful per-vault monitor. Construct once via {@link loadDriftMonitor}
 * (restores persisted detector state), call {@link observe} per drain,
 * then {@link persist} the returned state. Detectors are created lazily
 * the first time a signal is seen, so enabling the shadow candidate
 * mid-stream simply starts those series fresh.
 */
export class DriftMonitor {
  private readonly detectors = new Map<string, SignalDetectors>();
  private readonly silhouette: TemporalSilhouetteTracker;

  constructor(
    restored: DriftPersistedState | null,
    private readonly adwinDelta?: number,
  ) {
    if (restored !== null) {
      for (const [name, pair] of Object.entries(restored.signals)) {
        this.detectors.set(name, {
          adwin: Adwin.fromState(pair.adwin),
          kswin: Kswin.fromState(pair.kswin),
        });
      }
      this.silhouette = TemporalSilhouetteTracker.fromState(restored.silhouette);
    } else {
      this.silhouette = new TemporalSilhouetteTracker();
    }
  }

  private detectorsFor(name: string): SignalDetectors {
    let pair = this.detectors.get(name);
    if (pair === undefined) {
      pair = {
        adwin: new Adwin(this.adwinDelta === undefined ? {} : { delta: this.adwinDelta }),
        kswin: new Kswin(),
      };
      this.detectors.set(name, pair);
    }
    return pair;
  }

  /** Feed one drain's worth of samples and produce the status report. */
  observe(observation: DriftMonitorObservation): DriftReport {
    const signals: DriftSignalReport[] = [];
    const tripped: string[] = [];
    const warnings: string[] = [];
    let status: DriftStatus = 'stable';

    // Deterministic processing order regardless of caller sample order.
    const ordered = [...observation.samples].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const sample of ordered) {
      const { adwin, kswin } = this.detectorsFor(sample.name);
      const a = adwin.update(sample.value);
      const k = kswin.update(sample.value);
      const signalStatus = foldSignalStatus(a.drift, k.drift, k.warning);
      if (a.drift || k.drift) tripped.push(sample.name);
      else if (k.warning) warnings.push(sample.name);
      status = escalate(status, signalStatus);
      signals.push({
        name: sample.name,
        value: sample.value,
        adwinDrift: a.drift,
        kswinDrift: k.drift,
        kswinWarning: k.warning,
        status: signalStatus,
        adwinMean: Number(adwin.mean.toFixed(6)),
      });
    }

    const revisionSilhouette: RevisionSilhouette = computeRevisionSilhouette(
      observation.revisionId,
      observation.topics,
      observation.similarityEdges,
    );
    const silObs = this.silhouette.record(revisionSilhouette);
    if (silObs.delta !== null && silObs.delta <= -SILHOUETTE_WARNING_DROP) {
      status = escalate(status, 'warning');
    }

    return {
      schemaVersion: DRIFT_MONITOR_SCHEMA_VERSION,
      status,
      trippedSignals: [...tripped].sort(),
      warningSignals: [...warnings].sort(),
      signals,
      silhouette: {
        revisionId: revisionSilhouette.revisionId,
        silhouette: revisionSilhouette.silhouette,
        previousSilhouette: silObs.previousSilhouette,
        delta: silObs.delta,
        meanCohesion: revisionSilhouette.meanCohesion,
        meanSeparation: revisionSilhouette.meanSeparation,
        topicCount: revisionSilhouette.topicCount,
      },
    };
  }

  /** Snapshot all detector + silhouette state for persistence. */
  toState(updatedAt: string): DriftPersistedState {
    const signals: Record<
      string,
      { adwin: ReturnType<Adwin['toState']>; kswin: ReturnType<Kswin['toState']> }
    > = {};
    for (const [name, pair] of this.detectors) {
      signals[name] = { adwin: pair.adwin.toState(), kswin: pair.kswin.toState() };
    }
    return {
      schemaVersion: DRIFT_STATE_SCHEMA_VERSION,
      updatedAt,
      signals,
      silhouette: this.silhouette.toState(),
    };
  }
}

/**
 * Restore a monitor from the state store. IO failure (missing/corrupt
 * blob) yields a fresh monitor — never throws into the drain.
 */
export const loadDriftMonitor = async (
  store: DriftStateStore,
  options: { readonly adwinDelta?: number } = {},
): Promise<DriftMonitor> => {
  let restored: DriftPersistedState | null = null;
  try {
    restored = await store.read();
  } catch {
    restored = null;
  }
  return new DriftMonitor(restored, options.adwinDelta);
};

/**
 * Persist monitor state. Swallows IO errors (rebuildable cache, same
 * contract as the diagnostics artifact) and reports success so callers
 * can log without branching on the failure.
 */
export const persistDriftMonitor = async (
  store: DriftStateStore,
  monitor: DriftMonitor,
  updatedAt: string,
): Promise<{ readonly persisted: boolean; readonly error: string | null }> => {
  try {
    await store.write(monitor.toState(updatedAt));
    return { persisted: true, error: null };
  } catch (err) {
    return { persisted: false, error: err instanceof Error ? err.message : String(err) };
  }
};

/**
 * Pure helper: turn the diagnostic numbers the materializer already
 * computed into the monitor's sample list. Kept here (not in the
 * materializer) so the signal catalogue lives with the monitor and the
 * materializer edit stays minimal. `shadow` is the optional
 * `shadowVsBaseline` block.
 */
export const extractDriftSamples = (input: {
  readonly similarityEdgeCount: number;
  readonly topicCount: number;
  readonly topicMemberCount: number;
  readonly snapshotEdgeCount: number;
  readonly shadow?: {
    readonly perVisitChurn: number;
    readonly noiseShare: number;
    readonly edgeCountBeforePruning: number;
    readonly edgeCountAfterPruning: number;
    readonly maxTopicSizeDelta: number;
  };
}): DriftSignalSample[] => {
  const samples: DriftSignalSample[] = [
    { name: 'similarityEdgeCount', value: input.similarityEdgeCount },
    { name: 'topicCount', value: input.topicCount },
    { name: 'topicMemberCount', value: input.topicMemberCount },
    { name: 'snapshotEdgeCount', value: input.snapshotEdgeCount },
  ];
  if (input.shadow !== undefined) {
    samples.push(
      { name: 'perVisitChurn', value: input.shadow.perVisitChurn },
      { name: 'noiseShare', value: input.shadow.noiseShare },
      { name: 'edgeCountBeforePruning', value: input.shadow.edgeCountBeforePruning },
      { name: 'edgeCountAfterPruning', value: input.shadow.edgeCountAfterPruning },
      { name: 'maxTopicSizeDelta', value: input.shadow.maxTopicSizeDelta },
    );
  }
  return samples;
};
