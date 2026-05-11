// Sync Contract v1 / Class B — Connections graph types.
//
// Connections is an evidence-first visualization layer over the
// joins already present in the merged event log + companion vault
// projections. The plan (kind-prancing-river.md) is the load-
// bearing reference.
//
// MVP discipline:
//   - Only deterministic edges with provenance.
//   - No inference, no recommendations, no time-proximity edges.
//   - Same input durable state → byte-equal snapshot bytes
//     (reducer is order-independent; updatedAt = max observedAt).
//
// Capture-notes and reminder-for-thread/_workstream from the
// original 15-edge list are plugin-only state today; the MVP
// covers the 13 deterministic edges that the companion vault
// observes directly.
// Helper id minters — exported so the materializer / tests / HTTP
// routes can build ids without re-implementing the convention.
export const nodeIdFor = (kind, key) => `${kind}:${key}`;
export const edgeIdFor = (kind, fromNodeId, toNodeId) => `edge:${kind}:${fromNodeId}:${toNodeId}`;
//# sourceMappingURL=types.js.map