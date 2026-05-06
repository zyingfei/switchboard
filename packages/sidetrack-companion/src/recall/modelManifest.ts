// Pinned-revision manifest for the recall embedding model. The
// rebuild path's MODEL_ID derivation includes the revision so a
// model swap (or a bug-fix HF revision bump) marks the index stale
// through the existing lifecycle path. The dim + prefix fields are
// load-bearing for the embedder; the dtype list is a fallback
// cascade for the ONNX runtime.

export interface RecallModelManifest {
  readonly modelId: string;
  // Exact HF revision (commit sha or tag). When empty/undefined the
  // model verifier reports `verified: false` and falls back to a
  // presence-only check. We ship a placeholder so the field is
  // structurally present until the real sha lands.
  readonly revision: string;
  readonly embeddingDim: number;
  readonly dtypePreference: readonly ('q8' | 'fp16' | 'fp32')[];
  readonly inputPrefix: string;
  readonly transformersVersionRange: string;
}

export const RECALL_MODEL: RecallModelManifest = {
  modelId: 'Xenova/multilingual-e5-small',
  // TODO: pin exact HF commit sha once a stable release is selected.
  // Until then the manifest carries a synthetic identifier that's
  // still distinct from "unset" so the lifecycle's stale check can
  // detect a future swap.
  revision: 'unpinned-2026-05',
  embeddingDim: 384,
  dtypePreference: ['q8', 'fp16', 'fp32'],
  inputPrefix: 'query: ',
  transformersVersionRange: '^3.8.1',
};

// Identity string the lifecycle compares against the on-disk index
// header. Bumping the revision here marks every existing entry
// stale and triggers a background rebuild. The `#prefix-query-v1`
// suffix preserves the back-compat scheme so a chunk-schema bump
// can layer on a `#chunk-v1` if needed without colliding.
export const RECALL_MODEL_ID = `${RECALL_MODEL.modelId}#rev=${RECALL_MODEL.revision}#prefix-query-v1`;
