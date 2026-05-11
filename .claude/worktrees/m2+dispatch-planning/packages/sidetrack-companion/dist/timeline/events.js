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
export const BROWSER_TIMELINE_OBSERVED = 'browser.timeline.observed';
const isRecord = (value) => typeof value === 'object' && value !== null;
const isProvider = (value) => value === 'chatgpt' ||
    value === 'claude' ||
    value === 'gemini' ||
    value === 'generic';
const isTransition = (value) => value === 'activated' ||
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
export const isBrowserTimelineObservedPayload = (value) => {
    if (!isRecord(value))
        return false;
    if (typeof value['eventId'] !== 'string' || value['eventId'].length > TIMELINE_EVENT_ID_MAX_LENGTH) {
        return false;
    }
    if (typeof value['observedAt'] !== 'string' || value['observedAt'].length > 64) {
        return false;
    }
    if (typeof value['url'] !== 'string' || value['url'].length > TIMELINE_URL_MAX_LENGTH) {
        return false;
    }
    if (!isTransition(value['transition']))
        return false;
    if (value['canonicalUrl'] !== undefined) {
        if (typeof value['canonicalUrl'] !== 'string')
            return false;
        if (value['canonicalUrl'].length > TIMELINE_URL_MAX_LENGTH)
            return false;
    }
    if (value['title'] !== undefined) {
        if (typeof value['title'] !== 'string')
            return false;
        if (value['title'].length > TIMELINE_TITLE_MAX_LENGTH)
            return false;
    }
    if (value['provider'] !== undefined && !isProvider(value['provider']))
        return false;
    if (value['tabIdHash'] !== undefined) {
        if (typeof value['tabIdHash'] !== 'string')
            return false;
        if (value['tabIdHash'].length > TIMELINE_HASH_MAX_LENGTH)
            return false;
    }
    if (value['windowIdHash'] !== undefined) {
        if (typeof value['windowIdHash'] !== 'string')
            return false;
        if (value['windowIdHash'].length > TIMELINE_HASH_MAX_LENGTH)
            return false;
    }
    if (value['workstreamId'] !== undefined) {
        if (typeof value['workstreamId'] !== 'string')
            return false;
        // Same shape constraint as bac-id elsewhere (alnum + hyphen +
        // underscore, bounded length). Defensive check at the import
        // boundary; the side-panel sets this from chrome.storage so a
        // stolen bridge key shouldn't be able to inject arbitrary text.
        if (value['workstreamId'].length === 0)
            return false;
        if (value['workstreamId'].length > 128)
            return false;
        if (!/^[A-Za-z0-9_-]+$/u.test(value['workstreamId']))
            return false;
    }
    return true;
};
//# sourceMappingURL=events.js.map