export interface ThreadSummary {
    readonly id: string;
}
export interface WorkstreamSummary {
    readonly id: string;
}
export interface SignalSet {
    readonly lexical: Readonly<Record<string, number>>;
    readonly vector: Readonly<Record<string, number>>;
    readonly link: Readonly<Record<string, number>>;
}
export interface Suggestion {
    readonly workstreamId: string;
    readonly score: number;
    readonly breakdown: {
        readonly lexical: number;
        readonly vector: number;
        readonly link: number;
    };
}
export declare const scoreSuggestions: (input: {
    readonly thread: ThreadSummary;
    readonly workstreams: readonly WorkstreamSummary[];
    readonly signals: SignalSet;
}, opts?: {
    readonly threshold?: number;
}) => readonly Suggestion[];
//# sourceMappingURL=score.d.ts.map