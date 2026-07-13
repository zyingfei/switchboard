// Recall v2 — page-feature-driven retrieval arms.
//
// Two serving arms connect built-but-unserved retrieval intelligence to
// the semantic-query lane, EVIDENCE-GATED under the P1 freeze
// (ADR-0011). Each is a clean on/off toggle so the replay/eval harness
// can run arm-vs-arm and the eval-spine verdict — not optimism — sets
// the production default.
//
//   1. chunkVectors — prefer doc-level max-chunk pooling over
//      `documents_chunks_vec` (passage-level content vectors, already
//      backfilled but never queried at serve) instead of the whole-doc
//      average in `docs_vec`. Passage retrieval finds the SECTION that
//      matches, not the doc centroid.
//      Flag: SIDETRACK_RECALL_CHUNK_VECTORS.
//
//   2. provenanceDownweight — down-weight title-only KNN hits (docs with
//      `body_indexed = 0`, e.g. bare timeline visits) relative to
//      content-derived hits, using the `bodyIndexed` provenance already
//      returned by `queryVector`. A title-only vector is a weaker
//      relevance signal than a body-derived one at the same cosine.
//      Flag: SIDETRACK_RECALL_PROVENANCE_DOWNWEIGHT.
//
// DEFAULTS. Both are default OFF. This is the honest eval-spine verdict,
// not timidity: the recall replay harness cannot yet score these arms
// against the fixtures with real chunk-vector coverage on the live
// vault, so neither flip is authorized by evidence and must not default
// ON (mirrors ADR-0011 amendment 2026-07-12b's
// SIDETRACK_SIMILARITY_CONTENT_CORPUS reasoning). When the harness scores
// an arm as a win, flip its default in a follow-up citing the recorded
// verdict — the same evidence-gated protocol the OWNER DIRECTIVE
// requires.

/** Resolved retrieval-arm configuration for one pipeline run. Injected
 *  via PipelineDeps so the eval harness can force each arm per-run
 *  without mutating process env (arm-vs-arm replay). Production omits it
 *  and the pipeline reads the env defaults below. */
export interface RetrievalArms {
  /** Prefer chunk-vector KNN + doc-level max-chunk pooling in the
   *  semantic-query lane where clean chunk vectors exist. */
  readonly chunkVectors: boolean;
  /** Down-weight title-only (body_indexed = 0) KNN hits in fusion. */
  readonly provenanceDownweight: boolean;
}

export const chunkVectorsEnabled = (): boolean =>
  process.env['SIDETRACK_RECALL_CHUNK_VECTORS'] === '1';

export const provenanceDownweightEnabled = (): boolean =>
  process.env['SIDETRACK_RECALL_PROVENANCE_DOWNWEIGHT'] === '1';

/** Env-backed default arms. Read once per run in `runRecall`. */
export const retrievalArmsFromEnv = (): RetrievalArms => ({
  chunkVectors: chunkVectorsEnabled(),
  provenanceDownweight: provenanceDownweightEnabled(),
});

// Provenance down-weight multiplier applied to a title-only hit's cosine
// BEFORE the semantic floors + gap gate. A title-only vector at cosine c
// is treated as cosine `c * TITLE_ONLY_COSINE_MULTIPLIER` for ranking
// and gating purposes; content hits are untouched (multiplier 1.0). 0.85
// is a mild penalty — enough to break ties toward content and to let a
// weak title-only hit fall under the relative floor, without erasing a
// genuinely strong title match (a title-only visit whose title is an
// exact query match is still useful). Calibration is deferred to the
// replay harness (same "defaults from intuition; sweep pending" posture
// as the tiering constants); the flag stays OFF until then.
export const TITLE_ONLY_COSINE_MULTIPLIER = 0.85;
