// Per-surface reliability collector (north-star §5 S1, patterns P9/P12).
//
// Reads the joined impression → action stream (recall.served × recall.action,
// joined by servedContextId), turns each served candidate into a calibration
// sample (raw serving score + observed engagement label + inverse-propensity
// weight), groups the samples per SURFACE, fits per-surface Platt +
// temperature calibrators, and computes a reliability diagram (binned
// predicted-vs-observed + ECE) for each. The report is the input to the
// drain-time reliability artifact and GET /v1/system/reliability.
//
// COST DISCIPLINE — mirrors section15Collector.ts: the typed event read
// (forEachChunkOfTypes / events_type_idx, never a full-log scan) when the
// shared event store is available, else a single readMerged filtered by
// type. Only recall.served + recall.action are read.
//
// FREEZE-SAFE (ADR-0011): measurement only. No serving consumer reads any
// of this — the calibrators are FIT and REPORTED, never applied to a
// serving decision at this stage (S2+ flips that behind a flag).

import type { AcceptedEvent } from '../sync/causal.js';
import type { EventLog } from '../sync/eventLog.js';
import { getCaughtUpSharedEventStore } from '../sync/eventStore.js';
import {
  RECALL_ACTION,
  RECALL_SERVED,
  type RecallActionKind,
  type RecallActionPayload,
  type RecallServedPayload,
  isRecallActionPayload,
  isRecallServedPayload,
  propensityOf,
  surfaceOf,
} from '../recall/events.js';
import {
  fitSurfaceCalibration,
  type CalibrationSample,
  type ReliabilityDiagram,
  type SurfaceCalibrationFit,
} from './calibration.js';

// Engagement is a POSITIVE label for calibration: the user clicked, opened,
// promoted, moved, confirmed, or snippet-promoted the served candidate.
// Everything else the impression showed (no action, or an explicit
// reject/ignore) is a NEGATIVE. This is a coarser, calibration-oriented
// label than the ranker's graded trainingLabelForAction — for a reliability
// diagram we only need "did the served probability match the observed
// engagement rate", so a binary engagement label is the honest target.
const POSITIVE_ACTIONS: ReadonlySet<RecallActionKind> = new Set<RecallActionKind>([
  'click',
  'open_new_tab',
  'snippet_promote',
  'flow_confirm',
  'move',
  'promote',
]);

/** The raw serving score a calibrator scales. Prefer the cross-encoder
 *  rerank score (the last serving decision on the candidate) when present;
 *  otherwise fall back to the fused RRF score. Both are treated as a raw
 *  score / logit — the calibrator learns the mapping to a probability. */
const rawScoreForCandidate = (candidate: {
  readonly rerankScore?: number;
  readonly fusedScore: number;
}): number => candidate.rerankScore ?? candidate.fusedScore;

const emptyEvents: readonly AcceptedEvent[] = [];

const RELIABILITY_EVENT_TYPES: readonly string[] = [RECALL_SERVED, RECALL_ACTION];

// Typed read of exactly recall.served + recall.action. Mirrors
// section15Collector.readSection15Events.
const readReliabilityEvents = async (
  vaultRoot: string,
  eventLog: EventLog | undefined,
): Promise<readonly AcceptedEvent[]> => {
  if (eventLog === undefined) return emptyEvents;
  const types = [...RELIABILITY_EVENT_TYPES];
  const typeSet = new Set<string>(types);
  const store = await getCaughtUpSharedEventStore(vaultRoot);
  if (store === null) {
    return (await eventLog.readMerged()).filter((event) => typeSet.has(event.type));
  }
  const events: AcceptedEvent[] = [];
  await store.forEachChunkOfTypes(
    types,
    (chunk) => {
      for (const event of chunk) events.push(event);
    },
    2000,
  );
  return events;
};

// Latest action per (servedContextId, entityId). A user can act on the
// same candidate more than once; the newest action wins (mirrors the
// trainer's latestActionByEntity).
const latestActionsByImpression = (
  events: readonly AcceptedEvent[],
): ReadonlyMap<string, ReadonlyMap<string, RecallActionPayload>> => {
  const byImpression = new Map<
    string,
    Map<string, { payload: RecallActionPayload; acceptedAtMs: number }>
  >();
  for (const event of events) {
    if (event.type !== RECALL_ACTION || !isRecallActionPayload(event.payload)) continue;
    const action = event.payload;
    let perEntity = byImpression.get(action.servedContextId);
    if (perEntity === undefined) {
      perEntity = new Map();
      byImpression.set(action.servedContextId, perEntity);
    }
    const previous = perEntity.get(action.entityId);
    if (previous === undefined || event.acceptedAtMs >= previous.acceptedAtMs) {
      perEntity.set(action.entityId, { payload: action, acceptedAtMs: event.acceptedAtMs });
    }
  }
  const out = new Map<string, ReadonlyMap<string, RecallActionPayload>>();
  for (const [impressionId, perEntity] of byImpression) {
    out.set(
      impressionId,
      new Map([...perEntity].map(([entityId, entry]) => [entityId, entry.payload])),
    );
  }
  return out;
};

/**
 * Turn the joined served × action stream into per-surface calibration
 * samples. PURE given the events (I/O lives in the collector). Each served
 * candidate becomes one sample:
 *   score  = rerankScore ?? fusedScore (raw serving output)
 *   label  = 1 if a POSITIVE action landed on it, else 0
 *   weight = 1 / propensity (inverse-propensity de-biasing, P12)
 *
 * Only impressions that had AT LEAST ONE recorded action contribute — an
 * impression the user never touched carries no observed signal (a served-
 * but-never-engaged impression is missing-not-at-random and would flood
 * the negatives; we condition on "the user engaged with this impression at
 * all", the standard click-model convention).
 */
export const buildCalibrationSamples = (
  events: readonly AcceptedEvent[],
): ReadonlyMap<string, readonly CalibrationSample[]> => {
  const actionsByImpression = latestActionsByImpression(events);
  const bySurface = new Map<string, CalibrationSample[]>();
  for (const event of events) {
    if (event.type !== RECALL_SERVED || !isRecallServedPayload(event.payload)) continue;
    const served: RecallServedPayload = event.payload;
    const perEntity = actionsByImpression.get(served.servedContextId);
    if (perEntity === undefined || perEntity.size === 0) continue; // no engaged signal.
    const surface = surfaceOf(served);
    let samples = bySurface.get(surface);
    if (samples === undefined) {
      samples = [];
      bySurface.set(surface, samples);
    }
    for (const candidate of served.results) {
      const action = perEntity.get(candidate.entityId);
      const label: 0 | 1 = action !== undefined && POSITIVE_ACTIONS.has(action.actionKind) ? 1 : 0;
      const propensity = propensityOf(candidate);
      // Guard: a zero/negative propensity would blow up the weight. Skip
      // it (it would also be a serving-code bug — deterministic serving is
      // always 1.0). Positive-and-finite only.
      if (!(propensity > 0) || !Number.isFinite(propensity)) continue;
      samples.push({ score: rawScoreForCandidate(candidate), label, weight: 1 / propensity });
    }
  }
  return bySurface;
};

/** One surface's calibration + reliability, as recorded in the report. */
export interface SurfaceReliability {
  readonly surface: string;
  readonly fit: SurfaceCalibrationFit;
}

export interface ReliabilityReport {
  /** ISO timestamp the report was computed. */
  readonly generatedAt: string;
  /** Number of equal-width bins in each reliability diagram. */
  readonly numBins: number;
  /** Per-surface calibration + reliability, sorted by surface name. */
  readonly surfaces: readonly SurfaceReliability[];
  /** Convenience roll-up: total engaged-impression candidates scored. */
  readonly totalSamples: number;
}

const DEFAULT_NUM_BINS = 10;

/** Pure report builder over pre-read events — the unit-testable core. */
export const buildReliabilityReport = (
  events: readonly AcceptedEvent[],
  now: () => Date = () => new Date(),
  numBins = DEFAULT_NUM_BINS,
): ReliabilityReport => {
  const bySurface = buildCalibrationSamples(events);
  const surfaces: SurfaceReliability[] = [];
  let totalSamples = 0;
  for (const [surface, samples] of [...bySurface].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    totalSamples += samples.length;
    surfaces.push({ surface, fit: fitSurfaceCalibration(samples, numBins) });
  }
  return {
    generatedAt: now().toISOString(),
    numBins,
    surfaces,
    totalSamples,
  };
};

export interface CollectReliabilityOptions {
  readonly vaultRoot: string;
  readonly eventLog?: EventLog;
  readonly now?: () => Date;
  readonly numBins?: number;
}

/** Read the joined stream + build the report. Read-only, best-effort I/O. */
export const collectReliabilityReport = async (
  options: CollectReliabilityOptions,
): Promise<ReliabilityReport> => {
  const events = await readReliabilityEvents(options.vaultRoot, options.eventLog);
  return buildReliabilityReport(
    events,
    options.now ?? (() => new Date()),
    options.numBins ?? DEFAULT_NUM_BINS,
  );
};

/** Re-export for the artifact reader's shape check. */
export type { ReliabilityDiagram };
