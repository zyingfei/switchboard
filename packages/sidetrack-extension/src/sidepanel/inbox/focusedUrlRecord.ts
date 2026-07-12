// Single source of truth for "given the focused browser tab, which
// UrlVisitRecord (with its attribution) does the side panel act on?".
//
// This used to be two ad-hoc memos in the 8k-line App.tsx
// (focusedUrlRecord + focusedDisplayUrlRecord) whose synthetic
// fallback silently dropped currentAttribution — so a page the user
// already filed kept re-showing the suggestion/confirm UI. Centralised
// + pure here so it has one tested behaviour instead of four
// disagreeing reconstructions.

import type { UrlProjection, UrlVisitRecord } from '../tabsession/types';

export interface ResolveFocusedUrlRecordInput {
  /** The focused tab's URL already run through `comparableTabUrl`. */
  readonly focusedTabUrl: string | null;
  readonly projection: UrlProjection | null;
  /** `comparableTabUrl` — the panel's URL-normalisation function. */
  readonly comparable: (url: string | undefined) => string | null;
  /** Build a live-tab synthetic record when the URL is unknown. */
  readonly synthesize: () => UrlVisitRecord;
  /**
   * True when the focused URL is the LIVE active tab (not a pinned,
   * read-only prior context). Only then may a matched record that
   * carries an attribution but no captured display title be overlaid
   * with the live tab's title — overlaying a pinned card would show
   * the live tab's title on the pinned context.
   */
  readonly isLiveFocus?: boolean;
}

const isDecided = (record: UrlVisitRecord): boolean =>
  record.currentAttribution !== undefined || record.currentIgnored !== undefined;

const blankToUndefined = (input: string | undefined): string | undefined => {
  if (input === undefined) return undefined;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * A URL filed into a workstream before it was ever visited has a
 * projection record with an attribution but NO captured display title
 * (visitCount 0, latestTitle absent) — the focused-tab card then shows
 * the literal "(untracked tab)". For the LIVE focused tab the real page
 * is right there, so overlay the live-tab synthesized
 * latestUrl/latestTitle/provider while preserving the record's
 * currentAttribution/attributionHistory (and pageEvidence, visitCount,
 * …). No-op unless `isLiveFocus` and the record lacks a real title, so
 * pinned cards and already-titled records are returned untouched.
 */
const withLiveDisplay = (
  matched: UrlVisitRecord,
  input: ResolveFocusedUrlRecordInput,
): UrlVisitRecord => {
  if (input.isLiveFocus !== true) return matched;
  if (blankToUndefined(matched.latestTitle) !== undefined) return matched;
  const live = input.synthesize();
  // Guard each live field through blankToUndefined (same as the title
  // check above) so a blank synthesized value can never clobber the
  // matched record back into "(untracked tab)".
  const liveUrl = blankToUndefined(live.latestUrl);
  const liveTitle = blankToUndefined(live.latestTitle);
  const liveProvider = blankToUndefined(live.provider);
  return {
    ...matched,
    ...(liveUrl === undefined ? {} : { latestUrl: liveUrl }),
    ...(liveTitle === undefined ? {} : { latestTitle: liveTitle }),
    ...(liveProvider === undefined ? {} : { provider: liveProvider }),
  };
};

/**
 * Resolution order:
 *  1. Exact canonical key — the companion keys `byCanonicalUrl` by the
 *     query-preserving canonical URL, so an exact hit is authoritative.
 *  2. Comparable-form matches. When several records normalise to the
 *     same comparable URL, a record carrying a user/inferred decision
 *     wins over a decision-less one — otherwise an already-filed page
 *     could resolve to a sibling record and re-ask.
 *  3. Not in the projection at all → synthesize from the live tab.
 */
export const resolveFocusedUrlRecord = (
  input: ResolveFocusedUrlRecordInput,
): UrlVisitRecord | undefined => {
  const { focusedTabUrl, projection } = input;
  if (focusedTabUrl === null) return undefined;

  const direct = projection?.byCanonicalUrl[focusedTabUrl];
  if (direct !== undefined) return withLiveDisplay(direct, input);

  const records = projection === null ? [] : Object.values(projection.byCanonicalUrl);
  const matches = records.filter(
    (record) => input.comparable(record.canonicalUrl) === focusedTabUrl,
  );
  const decided = matches.find(isDecided);
  if (decided !== undefined) return withLiveDisplay(decided, input);
  if (matches[0] !== undefined) return withLiveDisplay(matches[0], input);

  return input.synthesize();
};
