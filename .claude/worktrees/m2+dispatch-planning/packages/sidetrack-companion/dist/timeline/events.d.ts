export declare const BROWSER_TIMELINE_OBSERVED: "browser.timeline.observed";
export type TimelineEventType = typeof BROWSER_TIMELINE_OBSERVED;
export type TimelineProvider = 'chatgpt' | 'claude' | 'gemini' | 'generic';
export type TimelineTransition = 'activated' | 'updated' | 'completed' | 'closed';
export interface BrowserTimelineObservedPayload {
    readonly eventId: string;
    readonly observedAt: string;
    readonly url: string;
    readonly canonicalUrl?: string;
    readonly title?: string;
    readonly provider?: TimelineProvider;
    readonly transition: TimelineTransition;
    readonly tabIdHash?: string;
    readonly windowIdHash?: string;
    readonly workstreamId?: string;
}
export declare const TIMELINE_URL_MAX_LENGTH = 4096;
export declare const TIMELINE_TITLE_MAX_LENGTH = 1024;
export declare const TIMELINE_HASH_MAX_LENGTH = 64;
export declare const TIMELINE_EVENT_ID_MAX_LENGTH = 256;
export declare const isBrowserTimelineObservedPayload: (value: unknown) => value is BrowserTimelineObservedPayload;
//# sourceMappingURL=events.d.ts.map