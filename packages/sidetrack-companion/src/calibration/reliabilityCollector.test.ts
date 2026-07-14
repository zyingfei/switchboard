import { describe, expect, it } from 'vitest';

import type { AcceptedEvent } from '../sync/causal.js';
import {
  RECALL_ACTION,
  RECALL_SERVED,
  type RecallActionKind,
  type RecallActionPayload,
  type RecallServedCandidateSnapshot,
  type RecallServedPayload,
} from '../recall/events.js';
import { buildCalibrationSamples, buildReliabilityReport } from './reliabilityCollector.js';

const BASE_TIME = Date.parse('2026-07-13T00:00:00.000Z');

const event = <TPayload>(input: {
  seq: number;
  type: string;
  payload: TPayload;
  acceptedAtMs?: number;
}): AcceptedEvent<TPayload> => ({
  clientEventId: `evt-${String(input.seq)}`,
  dot: { replicaId: 'replica-a', seq: input.seq },
  deps: {},
  aggregateId: `agg-${String(input.seq)}`,
  type: input.type,
  payload: input.payload,
  acceptedAtMs: input.acceptedAtMs ?? BASE_TIME + input.seq,
});

const candidate = (
  entityId: string,
  servedPosition: number,
  overrides: Partial<RecallServedCandidateSnapshot> = {},
): RecallServedCandidateSnapshot => ({
  entityId,
  sourceKind: 'semantic_query',
  fusedScore: 1 / (servedPosition + 1),
  servedPosition,
  propensity: 1.0,
  ...overrides,
});

const served = (
  seq: number,
  servedContextId: string,
  candidates: readonly RecallServedCandidateSnapshot[],
  surface: string,
): AcceptedEvent<RecallServedPayload> =>
  event({
    seq,
    type: RECALL_SERVED,
    payload: {
      payloadVersion: 2,
      servedContextId,
      query: 'q',
      intent: surface,
      surface,
      results: candidates,
      rerankApplied: false,
      sequenceNumber: seq,
      servedAt: new Date(BASE_TIME + seq * 1_000).toISOString(),
    },
    acceptedAtMs: BASE_TIME + seq * 1_000,
  });

const action = (
  seq: number,
  servedContextId: string,
  entityId: string,
  actionKind: RecallActionKind,
): AcceptedEvent<RecallActionPayload> =>
  event({
    seq,
    type: RECALL_ACTION,
    payload: {
      payloadVersion: 1,
      servedContextId,
      entityId,
      actionKind,
      actionAt: new Date(BASE_TIME + seq * 1_000).toISOString(),
    },
    acceptedAtMs: BASE_TIME + seq * 1_000,
  });

describe('buildCalibrationSamples', () => {
  it('labels a clicked candidate positive and a non-clicked one negative', () => {
    const events: AcceptedEvent[] = [
      served(1, 'ctx-1', [candidate('a', 0), candidate('b', 1)], 'search'),
      action(2, 'ctx-1', 'a', 'click'),
    ];
    const bySurface = buildCalibrationSamples(events);
    const search = bySurface.get('search');
    expect(search).toBeDefined();
    expect(search?.length).toBe(2);
    const a = search?.find((s) => s.score === candidate('a', 0).fusedScore);
    const b = search?.find((s) => s.score === candidate('b', 1).fusedScore);
    expect(a?.label).toBe(1); // clicked
    expect(b?.label).toBe(0); // shown, not engaged
  });

  it('treats an explicit reject as a negative even though the candidate was acted on', () => {
    const events: AcceptedEvent[] = [
      served(1, 'ctx-1', [candidate('a', 0)], 'search'),
      action(2, 'ctx-1', 'a', 'reject'),
    ];
    const samples = buildCalibrationSamples(events).get('search');
    expect(samples?.[0]?.label).toBe(0);
  });

  it('skips impressions with no recorded action (missing-not-at-random)', () => {
    const events: AcceptedEvent[] = [served(1, 'ctx-1', [candidate('a', 0)], 'search')];
    expect(buildCalibrationSamples(events).size).toBe(0);
  });

  it('groups by surface, not intent, when they diverge', () => {
    // Two impressions with the SAME intent but DIFFERENT surface must
    // land in separate calibration buckets.
    const searchImpression = served(1, 'ctx-1', [candidate('a', 0)], 'search');
    const dejavuImpression = {
      ...served(3, 'ctx-2', [candidate('c', 0)], 'search'),
      payload: {
        ...served(3, 'ctx-2', [candidate('c', 0)], 'search').payload,
        surface: 'dejavu',
      },
    } as AcceptedEvent<RecallServedPayload>;
    const events: AcceptedEvent[] = [
      searchImpression,
      action(2, 'ctx-1', 'a', 'click'),
      dejavuImpression,
      action(4, 'ctx-2', 'c', 'click'),
    ];
    const bySurface = buildCalibrationSamples(events);
    expect(bySurface.has('search')).toBe(true);
    expect(bySurface.has('dejavu')).toBe(true);
  });

  it('applies inverse-propensity weight (1 / propensity)', () => {
    const events: AcceptedEvent[] = [
      served(1, 'ctx-1', [candidate('a', 0, { propensity: 0.25 })], 'search'),
      action(2, 'ctx-1', 'a', 'click'),
    ];
    const samples = buildCalibrationSamples(events).get('search');
    expect(samples?.[0]?.weight).toBeCloseTo(4, 12); // 1 / 0.25
  });

  it('defaults propensity to 1.0 on a legacy candidate with no propensity', () => {
    const legacy = candidate('a', 0);
    delete (legacy as { propensity?: number }).propensity;
    const events: AcceptedEvent[] = [
      served(1, 'ctx-1', [legacy], 'search'),
      action(2, 'ctx-1', 'a', 'click'),
    ];
    const samples = buildCalibrationSamples(events).get('search');
    expect(samples?.[0]?.weight).toBe(1);
  });

  it('skips a candidate with a non-positive propensity', () => {
    const events: AcceptedEvent[] = [
      served(1, 'ctx-1', [candidate('a', 0, { propensity: 0 })], 'search'),
      action(2, 'ctx-1', 'a', 'click'),
    ];
    expect(buildCalibrationSamples(events).get('search')?.length ?? 0).toBe(0);
  });

  it('prefers rerankScore over fusedScore as the raw calibrator input', () => {
    const events: AcceptedEvent[] = [
      served(1, 'ctx-1', [candidate('a', 0, { rerankScore: 2.5, fusedScore: 0.1 })], 'search'),
      action(2, 'ctx-1', 'a', 'click'),
    ];
    const samples = buildCalibrationSamples(events).get('search');
    expect(samples?.[0]?.score).toBe(2.5);
  });
});

describe('buildReliabilityReport', () => {
  it('reports per-surface fits sorted by surface name with a stable clock', () => {
    const events: AcceptedEvent[] = [
      served(1, 'ctx-1', [candidate('a', 0), candidate('b', 1)], 'search'),
      action(2, 'ctx-1', 'a', 'click'),
      served(3, 'ctx-2', [candidate('c', 0)], 'dejavu'),
      action(4, 'ctx-2', 'c', 'click'),
    ];
    const report = buildReliabilityReport(events, () => new Date(BASE_TIME), 10);
    expect(report.generatedAt).toBe(new Date(BASE_TIME).toISOString());
    expect(report.numBins).toBe(10);
    // Sorted: dejavu before search.
    expect(report.surfaces.map((s) => s.surface)).toEqual(['dejavu', 'search']);
    expect(report.totalSamples).toBe(3); // 2 in search + 1 in dejavu
    const search = report.surfaces.find((s) => s.surface === 'search');
    expect(search?.fit.sampleCount).toBe(2);
    expect(search?.fit.positiveCount).toBe(1);
    // Each surface exposes raw + platt + temperature reliability diagrams.
    expect(search?.fit.rawReliability.bins.length).toBe(10);
    expect(search?.fit.plattReliability.bins.length).toBe(10);
    expect(search?.fit.temperatureReliability.bins.length).toBe(10);
  });

  it('parses legacy v1 impressions (no surface / propensity) via fallbacks', () => {
    // A v1 served payload: no surface (→ falls back to intent), no
    // per-candidate propensity (→ weight 1.0).
    const legacyCandidate = candidate('a', 0);
    delete (legacyCandidate as { propensity?: number }).propensity;
    const v1Served = {
      ...served(1, 'ctx-1', [legacyCandidate], 'search'),
      payload: {
        payloadVersion: 1 as const,
        servedContextId: 'ctx-1',
        query: 'q',
        intent: 'focus',
        results: [legacyCandidate],
        rerankApplied: false,
        sequenceNumber: 1,
        servedAt: new Date(BASE_TIME).toISOString(),
      } satisfies RecallServedPayload,
    } as AcceptedEvent<RecallServedPayload>;
    const events: AcceptedEvent[] = [v1Served, action(2, 'ctx-1', 'a', 'click')];
    const report = buildReliabilityReport(events, () => new Date(BASE_TIME), 10);
    // Surface falls back to intent 'focus'.
    expect(report.surfaces.map((s) => s.surface)).toEqual(['focus']);
    expect(report.totalSamples).toBe(1);
  });

  it('produces an empty report for no engaged impressions', () => {
    const report = buildReliabilityReport([], () => new Date(BASE_TIME), 10);
    expect(report.surfaces.length).toBe(0);
    expect(report.totalSamples).toBe(0);
  });
});
