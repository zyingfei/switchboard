// Join AggregatorVisitObservation.canonicalUrl -> keyword-concept ids, so
// callers that only hold NAVIGATION_COMMITTED/BROWSER_TIMELINE_OBSERVED
// events (which never carry keyword-concept data — that lives in the
// separate keyword-index.db / keyword-concepts.db stores the gist-keywords
// pipeline maintains, PR #385) can still populate
// AggregatorVisitObservation.keywordConceptIds and light up
// learnedAggregatorStats.ts's keywordConceptEntropyBits content-coherence
// veto (see that module for what the veto does and why).
//
// KEPT SEPARATE FROM learnedAggregatorStatsEvents.ts ON PURPOSE. That
// adapter is a pure, synchronous fold over an event batch (its own header
// comment: "keeps that module free of event-log/visitId bookkeeping"). The
// keyword join is neither pure (it's a store read) nor synchronous (store
// construction is async) — bolting it on there would make every caller of
// aggregatorObservationsFromEvents pay for two extra SQLite handles even
// when it doesn't want keyword data (most callers don't: the events adapter
// itself is unit-tested with zero I/O). Callers that DO want it call
// createAggregatorKeywordConceptLookup once and pass the result through
// withKeywordConceptIds — an explicit opt-in step, not a hidden default.
//
// BEST-EFFORT, NEVER A HARD DEPENDENCY. A vault that predates the
// gist-keywords feature (or one where the backfill lane hasn't reached a
// given page yet) has no row for a URL; conceptIdsForUrl returns undefined
// and withKeywordConceptIds leaves that observation exactly as it was
// (keywordConceptIds omitted). learnedAggregatorStats.ts already treats "no
// keyword-concept observations" as informationally empty, never as a
// negative signal (see its keywordConceptEntropyBits doc comment) — so a
// vault with zero keyword coverage behaves identically to how this module
// behaved before PR #385, and a partially-covered vault only ever ADDS
// veto evidence, never removes evidence the structural signals already
// found.

import {
  createKeywordConceptStore,
  type KeywordConceptStore,
} from '../enrichment/keywordConceptStore.js';
import { createKeywordIndexStore, type KeywordIndexStore } from '../search-index/keywordIndexStore.js';
import type { AggregatorVisitObservation } from './learnedAggregatorStats.js';

// Same `kind:id` page-key convention keywordIndexStore.ts's own header
// describes (contentEnrichment.ts's foldKey('url', canonicalUrl)) — a
// caller that already has a canonical URL addresses the store with zero
// translation.
const pageKeyForUrl = (canonicalUrl: string): string => `url:${canonicalUrl}`;

export interface AggregatorKeywordConceptLookup {
  /** Concept ids for a canonical URL's page, or undefined when the page has
   *  no keyword-index row yet, or its keywords have no concept assignment
   *  yet — both are "no data", not "zero/coherent" (see
   *  learnedAggregatorStats.ts's keywordConceptEntropyBits doc comment for
   *  why that distinction matters to the caller). */
  readonly conceptIdsForUrl: (canonicalUrl: string) => readonly string[] | undefined;
  readonly close: () => void;
}

/** Open both keyword stores read/write (their own constructors' only mode —
 *  see keywordIndexStore.ts / keywordConceptStore.ts headers on why: small,
 *  additive-schema, self-healing SQLite files, same family as every other
 *  store this codebase opens fresh per caller) and return a synchronous
 *  lookup closure. Caller owns the lifetime — call close() when done (the
 *  measurement CLI closes after one pass; a caller that polls repeatedly,
 *  e.g. a health check, should keep one lookup open across polls rather
 *  than reopening per poll). */
export const createAggregatorKeywordConceptLookup = async (
  vaultRoot: string,
): Promise<AggregatorKeywordConceptLookup> => {
  const keywordIndex: KeywordIndexStore = await createKeywordIndexStore(vaultRoot);
  const concepts: KeywordConceptStore = await createKeywordConceptStore(vaultRoot);
  return {
    conceptIdsForUrl: (canonicalUrl) => {
      const keywords = keywordIndex.keywordsForPage(pageKeyForUrl(canonicalUrl));
      if (keywords === undefined || keywords.length === 0) return undefined;
      const conceptIds = concepts.conceptIdsForKeywords(keywords);
      return conceptIds.length === 0 ? undefined : conceptIds;
    },
    close: () => {
      keywordIndex.close();
      concepts.close();
    },
  };
};

/** Pure — attach keywordConceptIds to observations using an already-open
 *  lookup. Never mutates an input observation; returns the SAME object
 *  reference when the lookup has no data for it (so callers that
 *  reference-compare for change detection elsewhere still work). */
export const withKeywordConceptIds = (
  observations: readonly AggregatorVisitObservation[],
  lookup: AggregatorKeywordConceptLookup,
): readonly AggregatorVisitObservation[] =>
  observations.map((observation) => {
    if (observation.keywordConceptIds !== undefined) return observation;
    const conceptIds = lookup.conceptIdsForUrl(observation.canonicalUrl);
    return conceptIds === undefined ? observation : { ...observation, keywordConceptIds: conceptIds };
  });
