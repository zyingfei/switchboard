const scoreFor = (signals, workstreamId) => {
    const lexical = signals.lexical[workstreamId] ?? 0;
    const vector = signals.vector[workstreamId] ?? 0;
    const link = signals.link[workstreamId] ?? 0;
    return {
        workstreamId,
        score: Math.min(Math.max(lexical * 0.3 + vector * 0.5 + link * 0.2, 0), 1),
        breakdown: { lexical, vector, link },
    };
};
export const scoreSuggestions = (input, opts = {}) => {
    const threshold = opts.threshold ?? 0.55;
    void input.thread;
    return input.workstreams
        .map((workstream) => scoreFor(input.signals, workstream.id))
        .filter((suggestion) => suggestion.score >= threshold)
        .sort((left, right) => right.score - left.score);
};
//# sourceMappingURL=score.js.map