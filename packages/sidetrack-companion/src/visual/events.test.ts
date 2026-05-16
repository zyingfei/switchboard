import { describe, expect, it } from 'vitest';

import { CONTRACT_REGISTRY } from '../sync/contract/registry.js';
import { VISUAL_FINGERPRINT_OBSERVED, isVisualFingerprintObservedPayload } from './events.js';

const validPayload = {
  payloadVersion: 1,
  visitId: 'visit:https://example.test/a',
  domHash: 'a'.repeat(64),
  observedAt: '2026-05-08T12:00:00.000Z',
} as const;

describe('visual fingerprint events', () => {
  it('accepts DOM-skeleton-only fingerprint observations', () => {
    expect(isVisualFingerprintObservedPayload(validPayload)).toBe(true);
  });

  it('rejects screenshots, perceptual hashes, contents, and dimensions', () => {
    expect(isVisualFingerprintObservedPayload({ ...validPayload, pHash: 'abc' })).toBe(false);
    expect(isVisualFingerprintObservedPayload({ ...validPayload, screenshot: 'abc' })).toBe(false);
    expect(isVisualFingerprintObservedPayload({ ...validPayload, contents: 'abc' })).toBe(false);
    expect(isVisualFingerprintObservedPayload({ ...validPayload, dimensions: {} })).toBe(false);
  });

  it('registers visual observations as dimensionless Class F inputs to connections', () => {
    const entry = CONTRACT_REGISTRY.find(
      (candidate) => candidate.eventType === VISUAL_FINGERPRINT_OBSERVED,
    );

    expect(entry?.currentPayloadVersion).toBe(1);
    expect(entry?.allowedDimensions).toEqual([]);
    expect(entry?.surfaces.map((surface) => surface.surface)).toEqual([
      'plugin-visual-fingerprint',
      'connections-template-projection',
    ]);
  });
});
