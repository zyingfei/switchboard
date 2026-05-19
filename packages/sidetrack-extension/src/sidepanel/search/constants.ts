// Shared search timing / threshold constants — P3 Phase 4.
//
// Debounce and the min-query-length gate were per-surface: the recall
// hook waited 300ms, the FocusView "add page" search 250ms, and both
// independently re-implemented the "< 3 chars ⇒ don't search" gate.
// The side panel therefore felt inconsistent while typing depending
// on which box you were in. Centralized here so every search surface
// waits the same and ignores the same too-short queries; per-call
// overrides (e.g. unit tests passing a tiny debounce) still win.
//
// 300ms is the dominant existing default (the recall hook + the
// content-query backend embed cost favour slightly fewer in-flight
// queries over marginally snappier feedback); FocusView is brought
// up from 250ms to match.
export const SEARCH_DEBOUNCE_MS = 300;

// Queries shorter than this never hit the companion — sub-3-char
// substrings are almost all noise and each query is an embed +
// hybrid-retrieval round-trip.
export const SEARCH_MIN_QUERY_CHARS = 3;
