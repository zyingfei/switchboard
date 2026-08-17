// Keyword-profile offline population — joins the keyword-concept layer
// (enrichment/keywordIndexStore.ts + keywordConceptStore.ts, PR #385) into
// per-workstream concept profiles (prototypeKeywordProfile.ts's pure math),
// on the SAME background cadence as prototype generation
// (prototypeGeneration.ts's tick) — never on a request path.
//
// GRACEFUL DEGRADATION. A page the keyword layer has not indexed yet
// (keywordsForPage returns undefined — never processed) or a keyword the
// concept store has not assigned yet (conceptForKeyword returns undefined)
// simply contributes nothing for that member. This signal's coverage grows
// as the keyword-layer's own backfill lane (keywordBackfillLane.ts) catches
// up — no blocking, no error, matches the same eventual-completeness
// contract that lane's own header documents.

import type { WorkstreamEvidenceItem } from './prototypeEvidence.js';
import {
  buildWorkstreamConceptProfiles,
  type PrototypeKeywordProfileSet,
  type WorkstreamKeywordMember,
} from './prototypeKeywordProfile.js';

export interface KeywordLookupDeps {
  readonly keywordsForPage: (pageKey: string) => readonly string[] | undefined;
  readonly conceptForKeyword: (keyword: string) => string | undefined;
}

/** Page key convention documented in search-index/keywordIndexStore.ts's
 *  header: the SAME `kind:id` key contentEnrichment.ts's GistLookup uses
 *  ('url:<canonicalUrl>'), not re-exported as a function there, so the
 *  literal format is reproduced here rather than imported across a
 *  dependency edge workstreams/ does not otherwise need. */
export const pageKeyForUrl = (canonicalUrl: string): string => `url:${canonicalUrl}`;

/**
 * Join each workstream's evidence members against the keyword-concept
 * layer and build the tf-idf profile set. Pure given its deps (no I/O of
 * its own beyond calling the injected lookup functions) — never throws.
 */
export const buildKeywordProfilesForWorkstreams = (
  byWorkstream: ReadonlyMap<string, readonly WorkstreamEvidenceItem[]>,
  deps: KeywordLookupDeps,
): PrototypeKeywordProfileSet => {
  const members = new Map<string, readonly WorkstreamKeywordMember[]>();
  for (const [workstreamId, items] of byWorkstream) {
    const memberList: WorkstreamKeywordMember[] = [];
    for (const item of items) {
      const keywords = deps.keywordsForPage(pageKeyForUrl(item.canonicalUrl));
      if (keywords === undefined || keywords.length === 0) continue;
      const pairs = keywords.flatMap((keyword) => {
        const conceptId = deps.conceptForKeyword(keyword);
        return conceptId === undefined ? [] : [{ keyword, conceptId }];
      });
      if (pairs.length > 0) memberList.push({ pairs });
    }
    members.set(workstreamId, memberList);
  }
  return buildWorkstreamConceptProfiles(members);
};
