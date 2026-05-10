export interface SearchUrlInfo {
    readonly canonicalUrl: string;
    readonly query: string;
}
export declare const detectSearchUrl: (input: string) => SearchUrlInfo | null;
export declare const sanitizeTimelineUrl: (input: string) => string;
export declare const sanitizeTimelinePayload: <T extends {
    readonly url: string;
    readonly canonicalUrl?: string;
}>(payload: T) => T;
//# sourceMappingURL=sanitize.d.ts.map