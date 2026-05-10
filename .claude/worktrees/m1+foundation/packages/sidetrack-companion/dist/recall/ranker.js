const clampLimit = (limit) => Math.min(Math.max(limit ?? 10, 1), 50);
const cosine = (left, right) => {
    const length = Math.min(left.length, right.length);
    let dot = 0;
    for (let index = 0; index < length; index += 1) {
        dot += (left[index] ?? 0) * (right[index] ?? 0);
    }
    return dot;
};
export const freshnessDecay = (capturedAt, now) => {
    const ageMs = now.getTime() - Date.parse(capturedAt);
    const ageDays = ageMs / (24 * 60 * 60 * 1000);
    if (ageDays <= 3) {
        return 1;
    }
    if (ageDays <= 21) {
        return 0.85;
    }
    if (ageDays <= 92) {
        return 0.7;
    }
    if (ageDays <= 1096) {
        return 0.5;
    }
    return 0.3;
};
export const rank = (queryEmbedding, items, now, opts = {}) => items
    // OR-Set tombstone filter — single-replica reader treats a
    // tombstoned entry as deleted. The future multi-replica reader
    // will resolve tombstones at merge time before this point.
    .filter((item) => item.tombstoned !== true)
    .filter((item) => opts.workstreamMembership?.(item.threadId) ?? true)
    .map((item) => {
    const similarity = cosine(queryEmbedding, item.embedding);
    const freshness = freshnessDecay(item.capturedAt, now);
    return {
        id: item.id,
        threadId: item.threadId,
        capturedAt: item.capturedAt,
        similarity,
        freshness,
        score: similarity * freshness,
    };
})
    .sort((left, right) => right.score - left.score)
    .slice(0, clampLimit(opts.limit));
//# sourceMappingURL=ranker.js.map