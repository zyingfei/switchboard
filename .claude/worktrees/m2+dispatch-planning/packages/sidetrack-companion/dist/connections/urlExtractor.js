// URL extraction for connections content-derived edges.
//
// Pure function — given free text (a captured turn, a dispatch body,
// or an annotation note), return canonical URL strings whose form
// matches what the timeline-visit reducer uses to id visit nodes.
//
// Pipeline per candidate match:
//   1. Regex-extract `https?://...` runs.
//   2. Trim trailing punctuation (`.,;:!?)\]}>`).
//   3. Run through `sanitizeTimelineUrl` — drops fragments and the
//      auth-token-style query params the timeline pipeline already
//      strips, so the form here matches what timeline visits store.
//   4. Apply the same fragment + trailing-slash strip the connections
//      reducer uses (`stripFragmentAndTrailingSlash`) so the canonical
//      key matches `entryIdFor` from `timeline/projection.ts`.
//
// Defensive cap: 32 URLs per call — protects the reducer from a
// pathological message that pastes hundreds of links.
import { sanitizeTimelineUrl } from '../timeline/sanitize.js';
const URL_RE = /\bhttps?:\/\/[^\s<>"'\)\]\}]+/giu;
const TRAILING_PUNCT_RE = /[.,;:!?\)\]\}>]+$/u;
const MAX_URLS_PER_CALL = 32;
const stripFragmentAndTrailingSlash = (url) => url.replace(/#.*$/u, '').replace(/\/+$/u, '');
export const extractUrlsFromText = (text) => {
    if (typeof text !== 'string' || text.length === 0)
        return [];
    const seen = new Set();
    const out = [];
    for (const match of text.matchAll(URL_RE)) {
        if (out.length >= MAX_URLS_PER_CALL)
            break;
        const trimmed = match[0].replace(TRAILING_PUNCT_RE, '');
        if (trimmed.length === 0)
            continue;
        let sanitized;
        try {
            sanitized = sanitizeTimelineUrl(trimmed);
        }
        catch {
            continue;
        }
        if (sanitized.length === 0)
            continue;
        let parsed;
        try {
            parsed = new URL(sanitized);
        }
        catch {
            continue;
        }
        if (parsed.host.length === 0)
            continue;
        const canonical = stripFragmentAndTrailingSlash(sanitized);
        if (seen.has(canonical))
            continue;
        seen.add(canonical);
        out.push(canonical);
    }
    return out;
};
//# sourceMappingURL=urlExtractor.js.map