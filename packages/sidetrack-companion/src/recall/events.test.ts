import { describe, expect, it } from 'vitest';

import {
  isRecallServedCandidateSnapshot,
  isRecallServedPayload,
  isServingConfigFingerprint,
  propensityOf,
  surfaceOf,
  type RecallServedCandidateSnapshot,
  type RecallServedPayload,
} from './events.js';

// A v1 impression as written before S1 existed: no propensity on any
// candidate, no surface, no servingConfig on the payload. Every reader
// (calibration, credit assignment, health) must still parse these.
const legacyV1Payload = (): Record<string, unknown> => ({
  payloadVersion: 1,
  servedContextId: 'ctx-legacy-1',
  query: 'kubeconfig aws',
  intent: 'search',
  results: [
    {
      entityId: 'ent-a',
      sourceKind: 'semantic_query',
      fusedScore: 0.9,
      servedPosition: 0,
    },
    {
      entityId: 'ent-b',
      sourceKind: 'bm25',
      fusedScore: 0.7,
      servedPosition: 1,
    },
  ],
  rerankApplied: false,
  sequenceNumber: 42,
  servedAt: '2026-07-01T00:00:00.000Z',
});

// A v2 impression with the full S1 surface: per-candidate propensity, the
// explicit surface discriminator, and the serving-config fingerprint.
const v2Payload = (): Record<string, unknown> => ({
  payloadVersion: 2,
  servedContextId: 'ctx-v2-1',
  query: 'rust async',
  intent: 'dejavu',
  surface: 'dejavu',
  servingConfig: {
    chunkVectors: false,
    provenanceDownweight: false,
    learnedRerank: true,
    crossEncoderRerank: true,
    armId: 'exp-42',
  },
  results: [
    {
      entityId: 'ent-c',
      sourceKind: 'semantic_query',
      fusedScore: 0.95,
      servedPosition: 0,
      propensity: 1.0,
    },
  ],
  rerankApplied: true,
  rerankTopK: 20,
  sequenceNumber: 7,
  servedAt: '2026-07-13T00:00:00.000Z',
});

describe('isRecallServedPayload — schema-version union', () => {
  it('accepts a legacy v1 payload with no S1 fields', () => {
    expect(isRecallServedPayload(legacyV1Payload())).toBe(true);
  });

  it('accepts a v2 payload with propensity/surface/servingConfig', () => {
    expect(isRecallServedPayload(v2Payload())).toBe(true);
  });

  it('rejects an unknown payloadVersion (0 / 3)', () => {
    expect(isRecallServedPayload({ ...legacyV1Payload(), payloadVersion: 0 })).toBe(false);
    expect(isRecallServedPayload({ ...v2Payload(), payloadVersion: 3 })).toBe(false);
  });

  it('rejects a non-string surface when present', () => {
    expect(isRecallServedPayload({ ...v2Payload(), surface: 123 })).toBe(false);
  });

  it('rejects an empty-string surface (degenerate bucket key)', () => {
    expect(isRecallServedPayload({ ...v2Payload(), surface: '' })).toBe(false);
  });

  it('rejects a malformed servingConfig when present', () => {
    expect(
      isRecallServedPayload({ ...v2Payload(), servingConfig: { chunkVectors: 'yes' } }),
    ).toBe(false);
  });

  it('round-trips a v2 payload through JSON without dropping S1 fields', () => {
    const original = v2Payload() as unknown as RecallServedPayload;
    const roundTripped: unknown = JSON.parse(JSON.stringify(original));
    expect(isRecallServedPayload(roundTripped)).toBe(true);
    const parsed = roundTripped as RecallServedPayload;
    expect(parsed.payloadVersion).toBe(2);
    expect(parsed.surface).toBe('dejavu');
    expect(parsed.servingConfig?.learnedRerank).toBe(true);
    expect(parsed.servingConfig?.crossEncoderRerank).toBe(true);
    expect(parsed.servingConfig?.armId).toBe('exp-42');
    expect(parsed.results[0]?.propensity).toBe(1.0);
  });
});

describe('isRecallServedCandidateSnapshot — propensity optionality', () => {
  it('accepts a legacy row with no propensity', () => {
    const row: Record<string, unknown> = {
      entityId: 'ent-a',
      sourceKind: 'bm25',
      fusedScore: 0.5,
      servedPosition: 3,
    };
    expect(isRecallServedCandidateSnapshot(row)).toBe(true);
  });

  it('accepts a row with a numeric propensity', () => {
    const row: Record<string, unknown> = {
      entityId: 'ent-a',
      sourceKind: 'bm25',
      fusedScore: 0.5,
      servedPosition: 3,
      propensity: 0.25,
    };
    expect(isRecallServedCandidateSnapshot(row)).toBe(true);
  });

  it('rejects a non-numeric propensity', () => {
    const row: Record<string, unknown> = {
      entityId: 'ent-a',
      sourceKind: 'bm25',
      fusedScore: 0.5,
      servedPosition: 3,
      propensity: '1.0',
    };
    expect(isRecallServedCandidateSnapshot(row)).toBe(false);
  });

  it('rejects an out-of-range propensity (≤0, >1, non-finite)', () => {
    const base = { entityId: 'ent-a', sourceKind: 'bm25', fusedScore: 0.5, servedPosition: 3 };
    expect(isRecallServedCandidateSnapshot({ ...base, propensity: 0 })).toBe(false);
    expect(isRecallServedCandidateSnapshot({ ...base, propensity: -0.5 })).toBe(false);
    expect(isRecallServedCandidateSnapshot({ ...base, propensity: 1.5 })).toBe(false);
    expect(isRecallServedCandidateSnapshot({ ...base, propensity: Infinity })).toBe(false);
    expect(isRecallServedCandidateSnapshot({ ...base, propensity: Number.NaN })).toBe(false);
    // Boundary: exactly 1.0 (deterministic serving) is valid.
    expect(isRecallServedCandidateSnapshot({ ...base, propensity: 1 })).toBe(true);
  });
});

describe('isServingConfigFingerprint', () => {
  it('accepts an empty fingerprint (all arms unrecorded)', () => {
    expect(isServingConfigFingerprint({})).toBe(true);
  });

  it('accepts a fully-populated fingerprint', () => {
    expect(
      isServingConfigFingerprint({
        chunkVectors: true,
        provenanceDownweight: false,
        learnedRerank: true,
        crossEncoderRerank: false,
        armId: 'a1',
      }),
    ).toBe(true);
  });

  it('rejects a non-boolean arm flag', () => {
    expect(isServingConfigFingerprint({ chunkVectors: 1 })).toBe(false);
  });

  it('rejects a non-string armId', () => {
    expect(isServingConfigFingerprint({ armId: 7 })).toBe(false);
  });
});

describe('surfaceOf / propensityOf — legacy fallbacks', () => {
  it('surfaceOf falls back to intent on a v1 payload', () => {
    const payload = legacyV1Payload() as unknown as RecallServedPayload;
    expect(surfaceOf(payload)).toBe('search');
  });

  it('surfaceOf prefers the explicit surface on a v2 payload', () => {
    const payload = { ...v2Payload(), intent: 'search', surface: 'dejavu' } as unknown as
      RecallServedPayload;
    expect(surfaceOf(payload)).toBe('dejavu');
  });

  it('propensityOf falls back to 1.0 on a legacy candidate with no propensity', () => {
    const row: RecallServedCandidateSnapshot = {
      entityId: 'ent-a',
      sourceKind: 'bm25',
      fusedScore: 0.5,
      servedPosition: 0,
    };
    expect(propensityOf(row)).toBe(1);
  });

  it('propensityOf returns the explicit value when present', () => {
    const row: RecallServedCandidateSnapshot = {
      entityId: 'ent-a',
      sourceKind: 'bm25',
      fusedScore: 0.5,
      servedPosition: 0,
      propensity: 0.4,
    };
    expect(propensityOf(row)).toBe(0.4);
  });
});
