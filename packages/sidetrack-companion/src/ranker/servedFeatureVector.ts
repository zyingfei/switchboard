// Move 1 — point-in-time served-feature encoding.
//
// The impression snapshot (recall/events.ts RecallServedCandidateSnapshot)
// stores the ranker feature vector AS IT WAS AT SERVE TIME, so the trainer
// reads the point-in-time truth instead of re-deriving features against a
// drifted graph. We store a plain number[] aligned to the canonical
// feature-key order (CANDIDATE_PAIR_FEATURE_KEYS) — NOT per-feature names
// per row — plus a separate featureSchemaVersion on the snapshot so the
// trainer can detect schema drift and refuse to mix incompatible columns.
//
// These two helpers are the single encode/decode pair: serve-time capture
// (pipeline.ts) encodes; the trainer (retrain-impressions.ts) decodes. Both
// key off the same exported CANDIDATE_PAIR_FEATURE_KEYS so column indices
// can never drift between the two call sites.

import {
  CANDIDATE_PAIR_FEATURE_KEYS,
  FEATURE_SCHEMA_VERSION,
  type CandidatePairFeatures,
} from './feature-schema.js';

/**
 * Encode a CandidatePairFeatures object into a dense number[] aligned to
 * CANDIDATE_PAIR_FEATURE_KEYS. Missing/non-finite entries encode as 0 to
 * match the trainer's stableFeatureObject / featureValue behavior exactly,
 * so an encoded-then-decoded row is feature-by-feature identical to what
 * the trainer would have built.
 */
export const encodeServedFeatureVector = (features: CandidatePairFeatures): number[] =>
  CANDIDATE_PAIR_FEATURE_KEYS.map((key) => {
    const value = features[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  });

/**
 * Decode a served feature vector back into a CandidatePairFeatures object.
 * Returns null when the vector length does not match the current schema's
 * key count — the caller MUST then fall back to reconstruction rather than
 * consuming a misaligned vector. `schemaVersion` on the object is stamped
 * from the CURRENT FEATURE_SCHEMA_VERSION; callers gate on the snapshot's
 * featureSchemaVersion === FEATURE_SCHEMA_VERSION before calling this.
 */
export const decodeServedFeatureVector = (
  vector: readonly number[],
): CandidatePairFeatures | null => {
  if (vector.length !== CANDIDATE_PAIR_FEATURE_KEYS.length) return null;
  const out = {} as Record<keyof CandidatePairFeatures, number>;
  for (let index = 0; index < CANDIDATE_PAIR_FEATURE_KEYS.length; index += 1) {
    const key = CANDIDATE_PAIR_FEATURE_KEYS[index];
    if (key === undefined) return null;
    out[key] = vector[index] ?? 0;
  }
  // schemaVersion is a literal-typed column; overwrite with the canonical
  // constant so the reconstructed object satisfies CandidatePairFeatures.
  out.schemaVersion = FEATURE_SCHEMA_VERSION;
  return out as CandidatePairFeatures;
};
