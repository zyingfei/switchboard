// Sync Contract v1 — plugin-side timeline event constant + types.
//
// Mirrors `packages/sidetrack-companion/src/timeline/events.ts`.
// Kept as a separate copy (not a cross-package import) so the
// extension's wxt build doesn't pull companion code; the companion-
// side registry coverage test is what enforces the constant matches.

export const BROWSER_TIMELINE_OBSERVED = 'browser.timeline.observed' as const;

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
  readonly tabSessionId?: string;
  readonly openerTabSessionId?: string;
  // The active-workstream pointer at observation time, when one was
  // focused in the side panel. The companion's projection rolls this
  // onto the timeline-visit node metadata; the snapshot emits a
  // `visit_in_workstream` edge from it. This is the ambient
  // attribution path (when no Class A user assertion exists for a
  // URL, the active workstream during browsing is the best guess).
  readonly workstreamId?: string;
  readonly payloadVersion?: number;
  readonly dimensions?: Record<string, unknown>;
}

// Plugin-tier minimal shape: the side panel's local active window
// renders a simplified entry view. The companion-side
// TimelineEntry is the projection-bucket shape; this is the
// per-observation shape carried in the active set + spool.
export interface ActiveTimelineObservation {
  readonly payload: BrowserTimelineObservedPayload;
  // The edge dot is allocated when the entry is admitted; recorded
  // here so spool drain can include it on the wire and dedupe
  // re-emits idempotently.
  readonly edgeDot?: { readonly replicaId: string; readonly seq: number };
}
