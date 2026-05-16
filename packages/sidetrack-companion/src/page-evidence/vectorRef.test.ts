import { describe, expect, it } from 'vitest';

import { compatibleVectorRefs, vectorIdFor } from './vectorRef.js';

describe('page-evidence vector refs', () => {
  it('only treats same model, version, and dimensions as comparable', () => {
    const base = {
      vectorId: 'a',
      modelId: 'model-a',
      modelVersion: 'rev-a',
      dimensions: 384,
    };

    expect(compatibleVectorRefs(base, { ...base, vectorId: 'b' })).toBe(true);
    expect(compatibleVectorRefs(base, { ...base, modelId: 'model-b' })).toBe(false);
    expect(compatibleVectorRefs(base, { ...base, modelVersion: 'rev-b' })).toBe(false);
    expect(compatibleVectorRefs(base, { ...base, dimensions: 768 })).toBe(false);
    expect(compatibleVectorRefs(base, undefined)).toBe(false);
  });

  it('keys vector ids by canonical URL, content hash, and vector identity', () => {
    const first = vectorIdFor({
      canonicalUrl: 'https://example.test/a',
      contentHash: 'hash-a',
      modelId: 'model-a',
      modelVersion: 'rev-a',
      dimensions: 384,
    });
    const second = vectorIdFor({
      canonicalUrl: 'https://example.test/a',
      contentHash: 'hash-a',
      modelId: 'model-a',
      modelVersion: 'rev-b',
      dimensions: 384,
    });

    expect(first).not.toBe(second);
  });
});
