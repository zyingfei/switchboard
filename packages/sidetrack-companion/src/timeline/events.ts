// Sync Contract v1 — browser.timeline.observed event.
//
// Emitted by the plugin when the user's browser activates or
// navigates to a tab. Class F (plugin-tier active window) +
// Class B (companion-side daily projection over events).
//
// Privacy posture (see docs/timeline.md):
//   - URL + canonical URL + title + provider only.
//   - tabIdHash / windowIdHash are hashed at the plugin (with
//     edgeReplicaId as salt) — companion never sees raw chrome IDs.
//   - No DOM, no screenshots, no input text, no cookies.
//
// Coalescing rules live on the plugin side (see
// packages/sidetrack-extension/src/timeline/observer.ts). One event
// per (tabIdHash, canonicalUrl, ~30s window). The companion treats
// every accepted event as a discrete observation.

export const BROWSER_TIMELINE_OBSERVED = 'browser.timeline.observed' as const;

export type TimelineEventType = typeof BROWSER_TIMELINE_OBSERVED;

export type TimelineProvider = 'chatgpt' | 'claude' | 'gemini' | 'generic';

export type TimelineTransition = 'activated' | 'updated' | 'completed' | 'closed';

export interface BrowserTimelineObservedPayload {
  // Plugin-generated, content-derived id. Used as clientEventId on
  // the companion so re-emits dedupe at the event log.
  readonly eventId: string;
  readonly observedAt: string;
  readonly url: string;
  readonly canonicalUrl?: string;
  readonly title?: string;
  readonly provider?: TimelineProvider;
  readonly transition: TimelineTransition;
  readonly tabIdHash?: string;
  readonly windowIdHash?: string;
  // Active-workstream attribution (Phase 4). When the user has a
  // workstream focused in the side panel at observation time, the
  // observer stamps this on the event so the connections graph can
  // emit `visit_in_workstream` and ambient browsing (search /
  // YouTube / generic doc pages) attaches to the right flow without
  // needing the URL to be pasted into a chat. Optional — visits
  // observed without an active workstream stay orphan, exactly the
  // same as before this field existed.
  readonly workstreamId?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isProvider = (value: unknown): value is TimelineProvider =>
  value === 'chatgpt' ||
  value === 'claude' ||
  value === 'gemini' ||
  value === 'generic';

const isTransition = (value: unknown): value is TimelineTransition =>
  value === 'activated' ||
  value === 'updated' ||
  value === 'completed' ||
  value === 'closed';

// Reviewer-flagged DoS bound: cap URL / title fields so a malformed
// or malicious payload can't bloat the projection file. Real URLs
// rarely exceed 2 KB; 4 KB leaves headroom. Titles cap a bit lower.
export const TIMELINE_URL_MAX_LENGTH = 4096;
export const TIMELINE_TITLE_MAX_LENGTH = 1024;
export const TIMELINE_HASH_MAX_LENGTH = 64;
export const TIMELINE_EVENT_ID_MAX_LENGTH = 256;

export const isBrowserTimelineObservedPayload = (
  value: unknown,
): value is BrowserTimelineObservedPayload => {
  if (!isRecord(value)) return false;
  if (typeof value['eventId'] !== 'string' || (value['eventId'] as string).length > TIMELINE_EVENT_ID_MAX_LENGTH) {
    return false;
  }
  if (typeof value['observedAt'] !== 'string' || (value['observedAt'] as string).length > 64) {
    return false;
  }
  if (typeof value['url'] !== 'string' || (value['url'] as string).length > TIMELINE_URL_MAX_LENGTH) {
    return false;
  }
  if (!isTransition(value['transition'])) return false;
  if (value['canonicalUrl'] !== undefined) {
    if (typeof value['canonicalUrl'] !== 'string') return false;
    if ((value['canonicalUrl'] as string).length > TIMELINE_URL_MAX_LENGTH) return false;
  }
  if (value['title'] !== undefined) {
    if (typeof value['title'] !== 'string') return false;
    if ((value['title'] as string).length > TIMELINE_TITLE_MAX_LENGTH) return false;
  }
  if (value['provider'] !== undefined && !isProvider(value['provider'])) return false;
  if (value['tabIdHash'] !== undefined) {
    if (typeof value['tabIdHash'] !== 'string') return false;
    if ((value['tabIdHash'] as string).length > TIMELINE_HASH_MAX_LENGTH) return false;
  }
  if (value['windowIdHash'] !== undefined) {
    if (typeof value['windowIdHash'] !== 'string') return false;
    if ((value['windowIdHash'] as string).length > TIMELINE_HASH_MAX_LENGTH) return false;
  }
  if (value['workstreamId'] !== undefined) {
    if (typeof value['workstreamId'] !== 'string') return false;
    // Same shape constraint as bac-id elsewhere (alnum + hyphen +
    // underscore, bounded length). Defensive check at the import
    // boundary; the side-panel sets this from chrome.storage so a
    // stolen bridge key shouldn't be able to inject arbitrary text.
    if ((value['workstreamId'] as string).length === 0) return false;
    if ((value['workstreamId'] as string).length > 128) return false;
    if (!/^[A-Za-z0-9_-]+$/u.test(value['workstreamId'] as string)) return false;
  }
  return true;
};
