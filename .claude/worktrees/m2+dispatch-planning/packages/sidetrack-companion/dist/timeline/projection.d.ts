import type { AcceptedEvent } from '../sync/causal.js';
import type { BrowserTimelineObservedPayload, TimelineProvider } from './events.js';
export interface TimelineEntry {
    readonly id: string;
    readonly firstSeenAt: string;
    readonly lastSeenAt: string;
    readonly url: string;
    readonly canonicalUrl?: string;
    readonly title?: string;
    readonly provider?: TimelineProvider;
    readonly visitCount: number;
    readonly workstreamId?: string;
}
export interface TimelineDayProjection {
    readonly date: string;
    readonly entries: readonly TimelineEntry[];
    readonly updatedAt: string;
    readonly entryCount: number;
}
export declare const dayBucketFor: (observedAt: string) => string;
export declare const entryIdFor: (input: {
    canonicalUrl?: string;
    url: string;
}) => string;
export declare const reduceTimelineEvents: (events: readonly BrowserTimelineObservedPayload[]) => readonly TimelineEntry[];
export declare const collectTimelinePayloads: (events: readonly AcceptedEvent[]) => readonly BrowserTimelineObservedPayload[];
export declare const groupByDay: (payloads: readonly BrowserTimelineObservedPayload[]) => ReadonlyMap<string, readonly BrowserTimelineObservedPayload[]>;
export interface TimelineStore {
    readonly putDay: (day: TimelineDayProjection) => Promise<void>;
    readonly readDay: (date: string) => Promise<TimelineDayProjection | null>;
    readonly listDays: () => Promise<readonly string[]>;
}
export declare const createTimelineStore: (vaultRoot: string) => TimelineStore;
export declare const buildDayProjection: (date: string, payloads: readonly BrowserTimelineObservedPayload[]) => TimelineDayProjection;
//# sourceMappingURL=projection.d.ts.map