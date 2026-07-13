// Suggestion honesty — the panel must not present a candidate the
// resolver's policy did NOT endorse in the same visual language as a
// real suggestion.
//
// The resolver's policy (companion tabsession/policy.ts) returns one of
// three actions:
//   - 'auto-apply' → confident enough to apply on its own (endorsed)
//   - 'suggest'    → confident enough to surface as a suggestion (endorsed)
//   - 'inbox'      → NOT endorsed. A top fused candidate may still exist
//                    (the model has a lean), but it failed the score /
//                    margin / corroboration gates. This is a *weak guess*,
//                    not a suggestion.
//
// The live bug this closes: a decision with action='inbox' and margin
// -0.62 was rendered as a "Suggested" badge + provenance, indistinguishable
// from an endorsed pick. This module is the single source of truth for
// "did the policy endorse this?" so the badge, provenance row, and any
// impression emit all agree.

import type {
  TabSessionPageEvidenceSummary,
  TabSessionResolutionResult,
  TabSessionResolverCandidate,
} from './types';

export type EndorsementLevel =
  // policy endorsed the top candidate (action suggest / auto-apply)
  | 'endorsed'
  // there is a top candidate but the policy did NOT endorse it (inbox)
  | 'weak-guess'
  // no candidate at all
  | 'none';

export interface SuggestionEndorsement {
  readonly level: EndorsementLevel;
  readonly action: TabSessionResolutionResult['decision']['action'] | null;
  readonly workstreamId: string | undefined;
  readonly margin: number;
}

/** Classify a resolution against the policy contract. The policy sets
 * decision.workstreamId ONLY for endorsed (suggest / auto-apply) actions;
 * for 'inbox' the lean lives in fusedCandidates[0]. */
export const endorsementFor = (
  suggestion: TabSessionResolutionResult | undefined,
): SuggestionEndorsement => {
  if (suggestion === undefined) {
    return { level: 'none', action: null, workstreamId: undefined, margin: 0 };
  }
  const action = suggestion.decision.action;
  const margin = suggestion.decision.margin;
  const endorsedWorkstreamId = suggestion.decision.workstreamId;
  const topCandidate = suggestion.fusedCandidates[0];
  // Endorsed: the policy chose suggest / auto-apply AND named a workstream.
  if (
    (action === 'suggest' || action === 'auto-apply') &&
    endorsedWorkstreamId !== undefined
  ) {
    return { level: 'endorsed', action, workstreamId: endorsedWorkstreamId, margin };
  }
  // Weak guess: policy said inbox (or an endorsed action with no id, which
  // shouldn't happen) but a top candidate exists. Read the lean from the
  // fused candidate, NOT the decision (decision.workstreamId is absent here).
  if (topCandidate !== undefined) {
    return { level: 'weak-guess', action, workstreamId: topCandidate.workstreamId, margin };
  }
  return { level: 'none', action, workstreamId: undefined, margin };
};

// ---- Reason chips -------------------------------------------------------
//
// The resolver hands per-candidate reasons[] with a coarse `source`
// (ppr / similarity / cluster). Map those to plain-language chips. The
// similarity source is split by whether page-content evidence backs it:
// with a content vector it's a real "content match"; title-only it's a
// weaker "title match" (the companion embeds title-only until the page
// gets deeper access). This mirrors the honesty already in
// SuggestionStats' empty states.

export type ReasonChipKind = 'graph' | 'content' | 'title' | 'topic';

export interface ReasonChip {
  readonly kind: ReasonChipKind;
  readonly label: string;
  readonly title: string;
}

const CHIP_LABEL: Record<ReasonChipKind, string> = {
  graph: 'via graph proximity',
  content: 'content match',
  title: 'title match',
  topic: 'topic cluster',
};

const CHIP_TITLE: Record<ReasonChipKind, string> = {
  graph: 'Related through visit/link edges in the connections graph (PPR).',
  content: 'Page content resembles pages already in this workstream.',
  title: 'Only the title/URL resembles this workstream (no deeper page content indexed yet).',
  topic: 'This page sits in a topic cluster dominated by this workstream.',
};

/** True when the page has an indexed content vector — the resolver's
 * similarity is then backed by page body, not just the title. Drives the
 * content-vs-title chip split. */
const hasContentVector = (evidence: TabSessionPageEvidenceSummary | undefined): boolean =>
  evidence?.vector !== undefined && (evidence.vector.dimensions ?? 0) > 0;

/** Build the ordered, de-duplicated reason chips for a candidate. Order:
 * graph → content/title → topic (strongest structural signal first). */
export const reasonChipsFor = (
  candidate: TabSessionResolverCandidate | undefined,
  pageEvidence: TabSessionPageEvidenceSummary | undefined,
): readonly ReasonChip[] => {
  if (candidate === undefined) return [];
  const kinds = new Set<ReasonChipKind>();
  for (const reason of candidate.reasons) {
    switch (reason.source) {
      case 'ppr':
        kinds.add('graph');
        break;
      case 'similarity':
        kinds.add(hasContentVector(pageEvidence) ? 'content' : 'title');
        break;
      case 'cluster':
        kinds.add('topic');
        break;
    }
  }
  const order: readonly ReasonChipKind[] = ['graph', 'content', 'title', 'topic'];
  return order
    .filter((kind) => kinds.has(kind))
    .map((kind) => ({ kind, label: CHIP_LABEL[kind], title: CHIP_TITLE[kind] }));
};

// ---- Aggregator quiet state ---------------------------------------------
//
// Broad multi-topic platforms (news aggregators, social, search) share a
// URL skeleton across unrelated topics, so structural similarity between
// two of their pages is an untrustworthy false-friend. The companion
// guards this (ranker/candidates.ts COARSE_MULTI_TOPIC_DOMAINS,
// tabsession/similarity.ts). The panel mirrors the registrable-domain set
// so it can explain the resulting quiet ("Broad site — waiting for stronger
// evidence") instead of leaving a bare "No signal".

const COARSE_MULTI_TOPIC_DOMAINS: ReadonlySet<string> = new Set([
  'ycombinator.com',
  'reddit.com',
  'lobste.rs',
  'twitter.com',
  'x.com',
  't.co',
  'youtube.com',
  'youtu.be',
  'facebook.com',
  'instagram.com',
  'linkedin.com',
  'medium.com',
  'substack.com',
  'quora.com',
  'pinterest.com',
  'tumblr.com',
  'stackoverflow.com',
  'stackexchange.com',
  'google.com',
  'bing.com',
  'duckduckgo.com',
  'chatgpt.com',
  'openai.com',
  'claude.ai',
]);

/** True when `hostname` belongs to a broad multi-topic platform — mirror of
 * the companion's isCoarseMultiTopicDomain, matched by registrable domain
 * so any subdomain qualifies. */
export const isAggregatorHost = (hostname: string | undefined): boolean => {
  if (hostname === undefined) return false;
  const host = hostname.toLowerCase().replace(/^www\./u, '').replace(/\.$/u, '');
  if (host.length === 0) return false;
  const labels = host.split('.');
  for (let index = 0; index < labels.length - 1; index += 1) {
    if (COARSE_MULTI_TOPIC_DOMAINS.has(labels.slice(index).join('.'))) return true;
  }
  return false;
};

/** Host from a URL, or undefined if unparseable. */
export const hostFromUrl = (url: string | undefined): string | undefined => {
  if (url === undefined) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
};
