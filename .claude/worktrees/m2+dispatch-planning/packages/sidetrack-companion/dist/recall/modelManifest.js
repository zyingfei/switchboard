// Pinned-revision manifest for the recall embedding model. The
// rebuild path's MODEL_ID derivation includes the revision so a
// model swap (or a bug-fix HF revision bump) marks the index stale
// through the existing lifecycle path. The dim + prefix fields are
// load-bearing for the embedder; the dtype list is a fallback
// cascade for the ONNX runtime.
export const RECALL_MODEL = {
    modelId: 'Xenova/multilingual-e5-small',
    // Pinned HF commit sha (https://huggingface.co/api/models/
    // Xenova/multilingual-e5-small as of 2025-07-22). Bumping this
    // value invalidates every existing index entry through the
    // lifecycle stale-check (MODEL_ID embeds the revision). Refresh
    // by re-running `curl https://huggingface.co/api/models/
    // Xenova/multilingual-e5-small | jq .sha` and updating below.
    revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
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
//# sourceMappingURL=modelManifest.js.map