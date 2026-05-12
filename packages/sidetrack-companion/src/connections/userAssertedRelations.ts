// Stage 5 / T3 — bootstrap topics from user assertions.
//
// `buildTopicRevision` has accepted a `userAssertedRelations` argument
// since Stage 1, but the materializer never populated it. With
// metadata-only similarity producing zero edges in dogfood, that left
// topic clusters empty even when the user had explicitly attributed
// dozens of URLs to a workstream. This module derives relation pairs
// from URL + tab-session attribution so the union-find topic builder
// merges them into shared components without waiting for similarity to
// light up.
//
// Scope rules (kept narrow on purpose):
//   - Only `source: 'user_asserted'` attribution counts. Inferred
//     attribution stays out of the seed set — letting inferred edges
//     drive topic membership would create a feedback loop where
//     low-confidence guesses become topology.
//   - Visit keys are canonical URLs (post fragment+trailing-slash
//     strip) to match what `buildTopicRevision` consumes.
//   - Tab-session relations use the URL projection's
//     `tabSessionIds` field to enumerate URLs observed in a session.

import type { TopicVisit, UserAssertedVisitRelation } from './topicClusterer.js';
import type { TabSessionProjection } from '../tabsession/projection.js';
import type { UrlProjection } from '../urls/projection.js';

const stripFragmentAndTrailingSlash = (url: string): string =>
  url.replace(/#.*$/u, '').replace(/\/+$/u, '');

const compareString = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const sortedUnique = (values: readonly string[]): readonly string[] => {
  const set = new Set(values);
  return [...set].sort(compareString);
};

const pairwiseRelations = (
  kind: UserAssertedVisitRelation['kind'],
  visitKeys: readonly string[],
): UserAssertedVisitRelation[] => {
  const out: UserAssertedVisitRelation[] = [];
  const sorted = sortedUnique(visitKeys);
  for (let i = 0; i < sorted.length; i += 1) {
    const fromVisitKey = sorted[i];
    if (fromVisitKey === undefined) continue;
    for (let j = i + 1; j < sorted.length; j += 1) {
      const toVisitKey = sorted[j];
      if (toVisitKey === undefined) continue;
      out.push({ kind, fromVisitKey, toVisitKey });
    }
  }
  return out;
};

export interface DeriveUserAssertedRelationsInput {
  readonly urlProjection: UrlProjection;
  readonly tabSessionProjection: TabSessionProjection;
  // Canonical URLs the topic builder will see this run. Relations to
  // canonical URLs absent from the timeline projection are dropped —
  // an in_workstream pair only makes sense if both endpoints actually
  // exist as topic-builder candidates.
  readonly knownCanonicalUrls: ReadonlySet<string>;
}

export const deriveUserAssertedRelations = (
  input: DeriveUserAssertedRelationsInput,
): readonly UserAssertedVisitRelation[] => {
  const knownCanonicalUrls = input.knownCanonicalUrls;

  // URL-level user assertions: group canonical URLs by current
  // user-asserted workstream and emit pairwise relations.
  const urlsByWorkstream = new Map<string, string[]>();
  for (const record of input.urlProjection.byCanonicalUrl.values()) {
    const attribution = record.currentAttribution;
    if (attribution === undefined) continue;
    // 'user_asserted' (direct URL move) and 'thread' (derived from
    // a thread attribution) both reflect explicit user intent and
    // count as seeds. 'inferred' / 'tab-group-*' do not.
    if (attribution.source !== 'user_asserted' && attribution.source !== 'thread') continue;
    if (attribution.workstreamId === null) continue;
    const canonical = stripFragmentAndTrailingSlash(record.canonicalUrl);
    if (!knownCanonicalUrls.has(canonical)) continue;
    const list = urlsByWorkstream.get(attribution.workstreamId) ?? [];
    list.push(canonical);
    urlsByWorkstream.set(attribution.workstreamId, list);
  }

  // Tab-session-level user assertions: enumerate canonical URLs
  // observed in each user-asserted tab session, group by workstream,
  // and emit pairwise relations. Re-uses the URL projection's
  // `tabSessionIds` field so we don't need to walk timeline events.
  const tabSessionUrls = urlsByTabSessionId(input.urlProjection);
  for (const record of input.tabSessionProjection.bySessionId.values()) {
    const attribution = record.currentAttribution;
    if (attribution === undefined) continue;
    // TabSessionAttribution doesn't carry the 'thread' source —
    // that's URL-projection-only. Only the direct user_asserted
    // path seeds tab-session relations.
    if (attribution.source !== 'user_asserted') continue;
    if (attribution.workstreamId === null) continue;
    const sessionUrls = tabSessionUrls.get(record.tabSessionId) ?? [];
    const list = urlsByWorkstream.get(attribution.workstreamId) ?? [];
    for (const url of sessionUrls) {
      const canonical = stripFragmentAndTrailingSlash(url);
      if (!knownCanonicalUrls.has(canonical)) continue;
      list.push(canonical);
    }
    if (list.length > 0) urlsByWorkstream.set(attribution.workstreamId, list);
  }

  const relations: UserAssertedVisitRelation[] = [];
  for (const workstreamId of [...urlsByWorkstream.keys()].sort(compareString)) {
    const urls = urlsByWorkstream.get(workstreamId) ?? [];
    relations.push(...pairwiseRelations('in_workstream', urls));
  }
  return relations;
};

const urlsByTabSessionId = (projection: UrlProjection): Map<string, string[]> => {
  const out = new Map<string, string[]>();
  for (const record of projection.byCanonicalUrl.values()) {
    for (const tabSessionId of record.tabSessionIds) {
      const list = out.get(tabSessionId) ?? [];
      list.push(record.canonicalUrl);
      out.set(tabSessionId, list);
    }
  }
  return out;
};

// Build the set of canonical URLs the topic builder will see this run.
// Mirrors `topicVisitFromEntry` in the materializer so we filter
// userAssertedRelations against the same key set.
export const knownCanonicalUrlsFor = (
  visits: readonly TopicVisit[],
): ReadonlySet<string> => {
  const out = new Set<string>();
  for (const visit of visits) {
    if (visit.canonicalUrl.length === 0) continue;
    out.add(visit.canonicalUrl);
  }
  return out;
};
