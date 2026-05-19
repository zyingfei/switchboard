import { createHash } from 'node:crypto';

import type { VectorRef } from './types.js';

export const compatibleVectorRefs = (left?: VectorRef, right?: VectorRef): boolean =>
  left !== undefined &&
  right !== undefined &&
  left.modelId === right.modelId &&
  left.modelVersion === right.modelVersion &&
  left.dimensions === right.dimensions;

export const vectorIdFor = (input: {
  readonly canonicalUrl: string;
  readonly contentHash: string;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly dimensions: number;
}): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        canonicalUrl: input.canonicalUrl,
        contentHash: input.contentHash,
        modelId: input.modelId,
        modelVersion: input.modelVersion,
        dimensions: input.dimensions,
      }),
    )
    .digest('hex');
