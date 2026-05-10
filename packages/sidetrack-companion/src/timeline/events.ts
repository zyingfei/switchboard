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
  // Stable tab-session identity minted by the extension. Phase 1
  // uses this instead of the active workstream pointer as the
  // browser-visit attribution primitive. openerTabSessionId is
  // optional and present only when Chrome exposes an opener chain.
  readonly tabSessionId?: string;
  readonly openerTabSessionId?: string;
  // Legacy optional field accepted for backwards compatibility with
  // older Class F spool entries. New extension observations do not
  // stamp workstreamId; Phase 2 restores visit_in_workstream through
  // explicit tab-session attribution.
  readonly workstreamId?: string;
  readonly payloadVersion?: number;
  readonly dimensions?: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const hasValidPayloadExtensionFields = (value: Record<string, unknown>): boolean =>
  (value['payloadVersion'] === undefined ||
    (typeof value['payloadVersion'] === 'number' && value['payloadVersion'] >= 1)) &&
  (value['dimensions'] === undefined || isRecord(value['dimensions']));

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
export const TIMELINE_TAB_SESSION_ID_MAX_LENGTH = 128;

const isStableId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= TIMELINE_TAB_SESSION_ID_MAX_LENGTH &&
  /^[A-Za-z0-9_-]+$/u.test(value);

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
  if (value['tabSessionId'] !== undefined && !isStableId(value['tabSessionId'])) return false;
  if (
    value['openerTabSessionId'] !== undefined &&
    !isStableId(value['openerTabSessionId'])
  ) {
    return false;
  }
  if (!hasValidPayloadExtensionFields(value)) return false;
  if (value['workstreamId'] !== undefined) {
    // Backwards-compatible validation for older active-pointer
    // observations.
    if (!isStableId(value['workstreamId'])) return false;
  }
  return true;
};
