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
}

const isDecided = (record: UrlVisitRecord): boolean =>
  record.currentAttribution !== undefined || record.currentIgnored !== undefined;

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
  if (direct !== undefined) return direct;

  const records = projection === null ? [] : Object.values(projection.byCanonicalUrl);
  const matches = records.filter(
    (record) => input.comparable(record.canonicalUrl) === focusedTabUrl,
  );
  const decided = matches.find(isDecided);
  if (decided !== undefined) return decided;
  if (matches[0] !== undefined) return matches[0];

  return input.synthesize();
};
