export interface ThreadText {
    readonly threadId: string;
    readonly text: string;
}
export interface QuoteMatch {
    readonly fromThreadId: string;
    readonly toThreadId: string;
    readonly recordIdHashPrefix: string;
}
export declare const findThreadQuotes: (inputs: readonly ThreadText[]) => readonly QuoteMatch[];
//# sourceMappingURL=quoteIndex.d.ts.map