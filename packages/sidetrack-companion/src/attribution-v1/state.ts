// Attribution v1 — derived state (drain-time artifact, incremental).
//
// The v1 scorer (scorer.ts) is a fixed, explainable three-family model
// justified by the 2026-07-14 vault study (docs/design/2026-07-13-context-
// model-north-star.md §1-§2). It runs in SHADOW only this wave — the
// incumbent resolver keeps serving. This module builds the state the
// scorer reads:
//
//   - Per-workstream member-title term index, with IDF computed ACROSS
//     workstreams so venue/hub terms ("github", "hn", "chatgpt", "gemini")
//     that appear in most workstreams get near-zero weight automatically —
//     the study's "domains are venues, not topics" finding, made a property
//     of the index rather than a hardcoded stoplist.
//   - Domain -> workstream history map with an ambiguity flag: single-
//     workstream domains are the 69%-precision regime the conditional-domain
//     family fires on; measured-multi domains ("hubs") are hard-suppressed.
//     Asserted labels and inferred attributions are tracked SEPARATELY so
//     the scorer can weight asserted evidence and audit the split.
//   - Last-filed workstream + timestamp: the recency family's 38.3% floor.
//   - Per-workstream label counts: head/tail routing (top-k on the tail)
//     and the beta-binomial precision gate.
//
// COST DISCIPLINE (mirrors workGraphHealth / section15 artifacts): the
// accumulator is a pure counter. Terms and domains are stored as RAW
// document-frequency counts; IDF and precision are derived at read/score
// time. That makes the two update paths trivially equivalent:
//   - buildAttributionV1State(events): rebuild-from-log on first run.
//   - applyOrganizingEvent(state, ...): incremental per new label at drain.
// applyOrganizingEvent MUST produce byte-identical state to a full rebuild
// over the same event prefix — the equivalence test (state.test.ts) asserts
// this. Keep every field order-independent (accumulate into Maps, never
// depend on iteration order) so replay-order does not change the artifact.

import {
  BROWSER_TIMELINE_OBSERVED,
  isBrowserTimelineObservedPayload,
} from '../timeline/events.js';
import { USER_ORGANIZED_ITEM, isUserOrganizedItemPayload } from '../feedback/events.js';
import type { AcceptedEvent } from '../sync/causal.js';

// The label kinds the v1 scorer supervises on. Both carry a canonical URL
// itemId and a workstream toContainer; the study counted exactly these as
// the 515 usable move/promote labels.
const SUPERVISED_ITEM_KINDS = new Set<string>(['canonical-url', 'visit']);
const SUPERVISED_ACTIONS = new Set<string>(['move', 'promote']);

// Event types the rebuild path reads. Both are sparse relative to the
// engagement-heavy log, so the typed store read (forEachChunkOfTypes) stays
// cheap — see readAttributionV1SourceEvents in artifact.ts.
export const ATTRIBUTION_V1_SOURCE_EVENT_TYPES: readonly string[] = [
  USER_ORGANIZED_ITEM,
  BROWSER_TIMELINE_OBSERVED,
];

// ---- tokenization -----------------------------------------------------

// A small English stopword subset (shared spirit with suggestions/tokens.ts
// but kept local — this module must not depend on the suggestion scorer).
// Deliberately does NOT include venue/hub terms: those are suppressed by
// the cross-workstream IDF, not a stoplist, so the mechanism is measured
// rather than hardcoded (north-star §2).
const STOPWORDS = new Set<string>([
  'the', 'and', 'for', 'that', 'with', 'this', 'from', 'are', 'was', 'were',
  'you', 'your', 'but', 'not', 'have', 'has', 'had', 'what', 'when', 'where',
  'why', 'how', 'can', 'could', 'should', 'would', 'about', 'into', 'over',
  'than', 'then', 'them', 'they', 'their', 'our', 'out', 'all', 'any', 'too',
  'very', 'just', 'more', 'most', 'some', 'such', 'only', 'own', 'same',
  'both', 'each', 'few', 'its', 'his', 'her', 'she', 'him', 'who', 'will',
]);

const MIN_TOKEN_LEN = 3;

// Word-level tokenizer. Lowercased, punctuation-split, stopword- and
// length-filtered. No trigrams here: BM25 term weighting wants discrete
// document terms, and trigram inflation would distort the IDF the venue-
// suppression relies on.
export const tokenizeTitle = (title: string): readonly string[] =>
  title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/u)
    .filter((token) => token.length >= MIN_TOKEN_LEN && !STOPWORDS.has(token));

// Distinct terms of a title — the document unit for IDF (document
// frequency counts each term once per member title).
const distinctTitleTerms = (title: string): readonly string[] => [
  ...new Set(tokenizeTitle(title)),
];

// Registrable-ish host of a URL. We keep the full host (the study treats
// "chatgpt.com", "github.com", "news.ycombinator.com" as venues); a
// leading "www." is stripped so www/non-www don't split a domain's history.
export const domainOfUrl = (url: string): string | null => {
  try {
    const host = new URL(url).host.toLowerCase();
    if (host.length === 0) return null;
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return null;
  }
};

// ---- state types ------------------------------------------------------

// Per-workstream accumulator. Term counts are raw document frequencies:
// termDocFreq[term] = number of member titles in THIS workstream that
// contain `term` at least once. `memberCount` is the workstream's document
// count (labels with a joinable title). `labelCount` counts ALL supervised
// labels for the workstream (head/tail + beta-binomial gate), including
// those whose title could not be joined.
export interface WorkstreamTermStats {
  readonly termDocFreq: Map<string, number>;
  memberCount: number;
  labelCount: number;
}

// Domain -> per-workstream label tallies, split by evidence provenance so
// the ambiguity flag can be audited. `asserted` counts user.organized.item
// labels; `inferred` counts system attributions (reserved for future
// wiring — kept separate per the contract so asserted evidence dominates).
export interface DomainHistory {
  readonly asserted: Map<string, number>;
  readonly inferred: Map<string, number>;
}

export interface AttributionV1State {
  // Per-workstream term stats keyed by workstream id.
  readonly workstreams: Map<string, WorkstreamTermStats>;
  // Global document frequency: term -> number of workstreams whose member
  // titles contain the term (cross-workstream IDF numerator input). This is
  // the venue-suppression signal: a term in most workstreams -> low IDF.
  readonly globalTermWorkstreamFreq: Map<string, number>;
  // Domain -> workstream history.
  readonly domains: Map<string, DomainHistory>;
  // Last-filed workstream + its label acceptance time (recency family).
  lastFiledWorkstreamId: string | null;
  lastFiledAtMs: number | null;
  // Total supervised labels folded (auditing / global priors).
  totalLabelCount: number;
  // Total member titles joined (documents for BM25 avg-length + IDF base).
  totalMemberCount: number;
}

export const createEmptyAttributionV1State = (): AttributionV1State => ({
  workstreams: new Map(),
  globalTermWorkstreamFreq: new Map(),
  domains: new Map(),
  lastFiledWorkstreamId: null,
  lastFiledAtMs: null,
  totalLabelCount: 0,
  totalMemberCount: 0,
});

// ---- incremental fold -------------------------------------------------

const incMap = (map: Map<string, number>, key: string, by = 1): void => {
  map.set(key, (map.get(key) ?? 0) + by);
};

const ensureWorkstream = (
  state: AttributionV1State,
  workstreamId: string,
): WorkstreamTermStats => {
  let stats = state.workstreams.get(workstreamId);
  if (stats === undefined) {
    stats = { termDocFreq: new Map(), memberCount: 0, labelCount: 0 };
    state.workstreams.set(workstreamId, stats);
  }
  return stats;
};

const ensureDomain = (state: AttributionV1State, domain: string): DomainHistory => {
  let history = state.domains.get(domain);
  if (history === undefined) {
    history = { asserted: new Map(), inferred: new Map() };
    state.domains.set(domain, history);
  }
  return history;
};

// A single supervised organizing observation to fold. `title` is the
// best-effort title joined for `canonicalUrl` (undefined ⇒ term index gets
// no member for this label, but the label still counts toward labelCount /
// domain history / recency). `atMs` is the label acceptance time.
export interface OrganizingObservation {
  readonly workstreamId: string;
  readonly canonicalUrl: string;
  readonly title?: string;
  readonly atMs: number;
  // Provenance: 'asserted' (user.organized.item) vs 'inferred' (system
  // attribution). v1 folds only asserted; the split is tracked for audit.
  readonly provenance: 'asserted' | 'inferred';
}

// Fold one organizing observation into the state IN PLACE. This is the
// incremental drain path AND the inner loop of the rebuild path, so the two
// are equivalent by construction.
export const applyOrganizingObservation = (
  state: AttributionV1State,
  observation: OrganizingObservation,
): void => {
  const stats = ensureWorkstream(state, observation.workstreamId);
  stats.labelCount += 1;
  state.totalLabelCount += 1;

  // Recency: latest label acceptance wins. Tie-break on nothing — equal
  // timestamps keep the earlier-folded workstream, which is stable under
  // replay because rebuild folds in the same accepted order.
  if (state.lastFiledAtMs === null || observation.atMs > state.lastFiledAtMs) {
    state.lastFiledAtMs = observation.atMs;
    state.lastFiledWorkstreamId = observation.workstreamId;
  }

  // Domain history (asserted vs inferred tracked separately).
  const domain = domainOfUrl(observation.canonicalUrl);
  if (domain !== null) {
    const history = ensureDomain(state, domain);
    incMap(observation.provenance === 'asserted' ? history.asserted : history.inferred,
      observation.workstreamId);
  }

  // Term index: only when a title joined. Each distinct term is one
  // document-frequency increment for the workstream; the first time a
  // workstream gains a term, its global (cross-workstream) frequency ticks.
  if (observation.title !== undefined && observation.title.length > 0) {
    stats.memberCount += 1;
    state.totalMemberCount += 1;
    for (const term of distinctTitleTerms(observation.title)) {
      const priorInWorkstream = stats.termDocFreq.get(term) ?? 0;
      if (priorInWorkstream === 0) {
        // First member of THIS workstream to carry the term ⇒ the term's
        // cross-workstream workstream-frequency rises by one.
        incMap(state.globalTermWorkstreamFreq, term);
      }
      stats.termDocFreq.set(term, priorInWorkstream + 1);
    }
  }
};

// ---- rebuild-from-log -------------------------------------------------

// Parse a supervised label event into (workstreamId, canonicalUrl, atMs).
// Returns null for non-supervised events.
const parseOrganizingLabel = (
  event: AcceptedEvent,
): { readonly workstreamId: string; readonly canonicalUrl: string; readonly atMs: number } | null => {
  if (event.type !== USER_ORGANIZED_ITEM || !isUserOrganizedItemPayload(event.payload)) return null;
  const p = event.payload;
  if (!SUPERVISED_ITEM_KINDS.has(p.itemKind) || !SUPERVISED_ACTIONS.has(p.action)) return null;
  if (typeof p.toContainer !== 'string' || p.toContainer.length === 0) return null;
  if (p.itemId.length === 0) return null;
  return { workstreamId: p.toContainer, canonicalUrl: p.itemId, atMs: event.acceptedAtMs };
};

// Build the title-by-canonical-url join map from timeline observations.
// First non-empty title per canonical url wins (stable under replay: the
// events arrive in accepted order and we keep the earliest). This mirrors
// the study's 98.8% join coverage.
export const buildTitleIndex = (events: readonly AcceptedEvent[]): Map<string, string> => {
  const titleByUrl = new Map<string, string>();
  for (const event of events) {
    if (event.type !== BROWSER_TIMELINE_OBSERVED) continue;
    if (!isBrowserTimelineObservedPayload(event.payload)) continue;
    const p = event.payload;
    const url = p.canonicalUrl !== undefined && p.canonicalUrl.length > 0 ? p.canonicalUrl : p.url;
    if (url.length === 0) continue;
    if (p.title !== undefined && p.title.length > 0 && !titleByUrl.has(url)) {
      titleByUrl.set(url, p.title);
    }
  }
  return titleByUrl;
};

// Rebuild the full state from an event slice. Timeline events supply the
// title join; organizing labels are folded in accepted order. Equivalent to
// createEmptyAttributionV1State() + applyOrganizingObservation per label.
export const buildAttributionV1State = (
  events: readonly AcceptedEvent[],
): AttributionV1State => {
  const titleByUrl = buildTitleIndex(events);
  const state = createEmptyAttributionV1State();
  for (const event of events) {
    const label = parseOrganizingLabel(event);
    if (label === null) continue;
    const title = titleByUrl.get(label.canonicalUrl);
    applyOrganizingObservation(state, {
      workstreamId: label.workstreamId,
      canonicalUrl: label.canonicalUrl,
      ...(title === undefined ? {} : { title }),
      atMs: label.atMs,
      provenance: 'asserted',
    });
  }
  return state;
};

// ---- derived views (read-time, cheap) ---------------------------------

// PLAIN title term-overlap — the study's best-measured cold signal (§1 R:
// 40.0% top-1 alone) and, per the 2026-07-16 prequential finding, STRONGER
// standalone than the BM25/IDF/length-normalized family it replaces (39.6% vs
// 25.6% on this vault: the IDF/normalization actively mis-ranked the correct
// workstream ~35% of the time plain overlap would have won). This is the ONE
// implementation of the primitive — the v1 scorer's title family AND the
// prequential eval's `title-lexical` / vote-title arms both call it against the
// same `AttributionV1State`, so the challenger and its yardstick cannot drift.
//
// For each distinct query term, add each workstream's member document-frequency
// for that term (how many of the workstream's member titles carry it). A term
// shared by many members of a workstream is stronger evidence for it; a
// workstream that never carried the term contributes nothing. NO cross-
// workstream IDF and NO BM25 length normalization — those are exactly what the
// finding said to drop. Venue suppression is NOT the title family's job here;
// it lives where the data said it works (the conditional-domain family's
// ambiguity gate). Returns a workstream -> raw overlap-count map (empty when
// the title has no folded terms), plus, per workstream, which query terms it
// matched (for auditable scorer reasons).
export interface PlainTitleOverlap {
  // workstream id -> summed member document-frequency over matched query terms.
  readonly scores: Map<string, number>;
  // workstream id -> the query terms that matched at least one of its members.
  readonly matchedTerms: Map<string, string[]>;
}

export const plainTitleOverlap = (
  state: AttributionV1State,
  title: string | null,
): PlainTitleOverlap => {
  const scores = new Map<string, number>();
  const matchedTerms = new Map<string, string[]>();
  if (title === null) return { scores, matchedTerms };
  const terms = new Set(tokenizeTitle(title));
  if (terms.size === 0) return { scores, matchedTerms };
  for (const [workstreamId, stats] of state.workstreams) {
    let score = 0;
    const matched: string[] = [];
    for (const term of terms) {
      const df = stats.termDocFreq.get(term) ?? 0;
      if (df === 0) continue;
      score += df;
      matched.push(term);
    }
    if (score > 0) {
      scores.set(workstreamId, score);
      matchedTerms.set(workstreamId, matched);
    }
  }
  return { scores, matchedTerms };
};

// Argmax over a plain-overlap score map (deterministic ties → lexicographically-
// smallest id). Shared by both nearest-workstream helpers below.
const argmaxTitleScores = (scores: Map<string, number>): string | null => {
  let best: string | null = null;
  let bestScore = 0;
  for (const [workstreamId, score] of scores) {
    if (score > bestScore || (score === bestScore && (best === null || workstreamId < best))) {
      best = workstreamId;
      bestScore = score;
    }
  }
  return best;
};

// The single plain-overlap nearest workstream (argmax of plainTitleOverlap),
// deterministic ties → lexicographically-smallest id. Domain-free variant,
// retained for callers with no domain context.
export const plainTitleNearestWorkstream = (
  state: AttributionV1State,
  title: string | null,
): string | null => argmaxTitleScores(plainTitleOverlap(state, title).scores);

// The venue-suppressed nearest workstream for a visit on `domain` (argmax of
// plainTitleOverlapSuppressed). This is the eval's `title-lexical` arm and the
// vote's title signal — sharing the SAME suppressed primitive the v1 scorer's
// title family uses keeps the frozen-baseline comparison honest (the challenger
// and its yardstick read identical evidence, including the brand-term
// suppression).
export const plainTitleNearestWorkstreamSuppressed = (
  state: AttributionV1State,
  title: string | null,
  domain: string | null,
): string | null => argmaxTitleScores(plainTitleOverlapSuppressed(state, title, domain).scores);

// Cross-workstream inverse document frequency for a term. Smoothed IDF over
// the workstream count: terms in most workstreams (venues/hubs) approach 0.
// idf = ln(1 + (W - df + 0.5) / (df + 0.5)) where W = workstream count,
// df = number of workstreams carrying the term. This BM25-style form is
// always positive and monotone-decreasing in df. RETAINED as a derived view
// (the state test asserts venue terms get lower IDF) but the v1 scorer no
// longer uses it — the title family is now plain overlap (see above).
export const termIdf = (state: AttributionV1State, term: string): number => {
  const totalWorkstreams = state.workstreams.size;
  if (totalWorkstreams === 0) return 0;
  const df = state.globalTermWorkstreamFreq.get(term) ?? 0;
  return Math.log(1 + (totalWorkstreams - df + 0.5) / (df + 0.5));
};

// Domain -> the single workstream it maps to, or null when the domain is
// unseen OR measured-ambiguous (maps to >1 workstream on asserted labels).
// Ambiguity is measured over ASSERTED labels only — the conditional-domain
// family fires only in the 69%-precision single-workstream regime.
export interface DomainVerdict {
  readonly workstreamId: string | null;
  readonly ambiguous: boolean;
  // Asserted labels for the winning workstream / all workstreams on this
  // domain — surfaced in scorer reasons for auditability.
  readonly assertedForWinner: number;
  readonly assertedTotal: number;
  readonly distinctWorkstreams: number;
}

export const domainVerdict = (state: AttributionV1State, domain: string): DomainVerdict => {
  const history = state.domains.get(domain);
  if (history === undefined || history.asserted.size === 0) {
    return {
      workstreamId: null,
      ambiguous: false,
      assertedForWinner: 0,
      assertedTotal: 0,
      distinctWorkstreams: 0,
    };
  }
  let total = 0;
  let winner: string | null = null;
  let winnerCount = 0;
  for (const [workstreamId, count] of history.asserted) {
    total += count;
    if (count > winnerCount || (count === winnerCount && (winner === null || workstreamId < winner))) {
      winner = workstreamId;
      winnerCount = count;
    }
  }
  const distinctWorkstreams = history.asserted.size;
  const ambiguous = distinctWorkstreams > 1;
  return {
    workstreamId: ambiguous ? null : winner,
    ambiguous,
    assertedForWinner: winnerCount,
    assertedTotal: total,
    distinctWorkstreams,
  };
};

// Supervised label count for a workstream (head/tail routing + gate prior).
export const workstreamLabelCount = (state: AttributionV1State, workstreamId: string): number =>
  state.workstreams.get(workstreamId)?.labelCount ?? 0;

// ---- domain discriminativeness (continuous, learned) ------------------
//
// The 2026-07-16 iteration replaces the conditional-domain family's BINARY
// gate (single-workstream domain fires; multi-workstream hub hard-suppressed)
// with a CONTINUOUS discriminativeness score learned per domain from the
// vault's own filing history — the north-star §2 direction ("the per-domain
// dispersion table from the study is the initial coherence prior, MEASURED
// rather than hardcoded"). The hardcoded COARSE_MULTI_TOPIC_DOMAINS list
// (ranker/candidates.ts) is demoted to exactly that: a PRIOR that low
// discriminativeness initializes with, and that accumulated evidence overrides.
//
// DEFINITION. For a domain D with per-workstream asserted/inferred label
// tallies, discriminativeness = 1 − normalizedEntropy(workstream | domain).
//   - Entropy H = −Σ p_w · log(p_w) over the smoothed workstream distribution.
//   - normalizedEntropy = H / log(K) where K is the number of DISTINCT
//     workstreams the smoothed distribution spreads mass over (the max entropy
//     for K outcomes is log K). K=1 ⇒ H=0 ⇒ discriminativeness = 1 (a domain
//     seen for exactly one workstream is perfectly discriminative). K=0 (unseen,
//     no prior) ⇒ neutral (0.5) by convention.
//   - discriminativeness ∈ [0, 1]: 1 = domain implies one workstream (the old
//     "single-workstream 69%-precision regime"); → 0 = domain spread evenly
//     across many workstreams (the old "measured-ambiguous hub"); 0.5 = neutral
//     (no evidence either way — the low-data default for UNLISTED domains).
//
// BAYESIAN SMOOTHING. Raw entropy over a handful of labels is noisy: a domain
// seen twice, both for the same workstream, would read as perfectly
// discriminative on n=2. We smooth the workstream distribution toward a NEUTRAL
// PRIOR (maximal-entropy over the observed support) with symmetric-Dirichlet
// pseudo-counts, so low-sample domains shrink toward "no signal" (neutral) and
// only accumulate confidence with real evidence. Concretely, each observed
// workstream w gets smoothed mass proportional to (evidence_w + α), where α is
// the per-workstream pseudo-count. Asserted labels are weighted fully; inferred
// attributions are down-weighted (INFERRED_LABEL_WEIGHT) so asserted evidence
// dominates (contract: "asserted labels weighted over inferred").
//
// THE LIST AS A PRIOR (not a gate). A listed coarse-multi-topic domain (HN,
// reddit, youtube, chatgpt, …) is initialized as if it carried prior evidence
// of HIGH dispersion: we inject LISTED_PRIOR_PSEUDO_MASS of pseudo-labels spread
// across LISTED_PRIOR_WORKSTREAMS synthetic buckets, which pushes its smoothed
// entropy up (discriminativeness DOWN) at n=0. As the domain accumulates real
// asserted labels concentrated on ONE workstream, that real mass overwhelms the
// diffuse prior and the discriminativeness climbs — the list can be OVERRIDDEN
// by evidence, which is exactly what the design asked for. Unlisted low-data
// domains get NO such prior: they initialize neutral (0.5).

// α — the symmetric-Dirichlet per-workstream pseudo-count. One pseudo-label per
// observed workstream. Small relative to real label volume so a well-evidenced
// domain trusts its data, but large enough that n=1..2 domains shrink hard
// toward neutral. Documented value, not a tuned grid.
export const DOMAIN_DIRICHLET_ALPHA = 1.0;

// Inferred attributions count for less than asserted labels when measuring
// dispersion (contract: asserted weighted over inferred). v1 folds only
// asserted today, so this is forward-wiring; kept explicit for the audit.
export const INFERRED_LABEL_WEIGHT = 0.25;

// Neutral discriminativeness — the low-data default for an UNLISTED domain and
// the value a domain smooths toward with no concentrating evidence. 0.5 sits at
// the midpoint of [0,1]; below it a domain is "worse than neutral" (dispersed),
// above it "better than neutral" (concentrated).
export const NEUTRAL_DISCRIMINATIVENESS = 0.5;

// The list-as-prior parameters. A listed domain is seeded, at n=0, with
// LISTED_PRIOR_PSEUDO_MASS total pseudo-label weight spread EVENLY across
// LISTED_PRIOR_WORKSTREAMS synthetic buckets. Even spread ⇒ maximal prior
// entropy ⇒ minimal prior discriminativeness. The mass is chosen so that a
// listed domain with NO real data reads at discriminativeness 0 (hard-suppressed
// initially — reproducing the old binary gate for the no-evidence case), while
// real concentrated evidence can OVERRIDE it within a realistic label budget for
// this vault: with 6 buckets × 0.75 = 4.5 diffuse pseudo-mass, a listed domain
// whose labels concentrate on one workstream crosses NEUTRAL (0.5) at ~13
// concentrated labels and keeps climbing — enough that a single click cannot
// unlock a hub, but a genuinely single-workstream "listed" domain earns its
// discriminativeness back over time (the design's "list demoted to a prior").
export const LISTED_PRIOR_WORKSTREAMS = 6;
export const LISTED_PRIOR_PSEUDO_MASS = 4.5;

// The hardcoded coarse-multi-topic domain set, demoted from a binary gate to a
// discriminativeness PRIOR. Matched by REGISTRABLE domain (last two labels), so
// every subdomain qualifies (news.ycombinator.com, old.reddit.com,
// gemini.google.com, …) — the same matching semantics as the ranker list this
// was lifted from (ranker/candidates.ts COARSE_MULTI_TOPIC_DOMAINS). The v1
// scorer NEVER hard-suppresses on this list anymore; it only uses it to lower
// the initial discriminativeness of a listed domain, which real filing evidence
// then overrides. Keep in sync with the ranker list by INTENT, not by import
// (this module must not depend on the ranker).
export const COARSE_MULTI_TOPIC_DOMAIN_PRIOR: ReadonlySet<string> = new Set<string>([
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

// Registrable domain (last two dot-labels) of a host — the granularity the
// coarse-multi-topic prior matches on, so subdomains inherit the prior. Returns
// the input unchanged when it has fewer than two labels. Pure string op; no PSL
// (the ranker list is likewise PSL-free — good enough for these well-known
// two-label registrables).
export const registrableDomainOf = (domain: string): string => {
  const parts = domain.split('.');
  if (parts.length < 2) return domain;
  return `${parts[parts.length - 2]!}.${parts[parts.length - 1]!}`;
};

// True when a domain (any subdomain) is in the coarse-multi-topic prior set.
export const isCoarseMultiTopicPriorDomain = (domain: string): boolean =>
  COARSE_MULTI_TOPIC_DOMAIN_PRIOR.has(registrableDomainOf(domain));

// The learned per-domain discriminativeness, with Bayesian smoothing and the
// list-as-prior. Returns discriminativeness ∈ [0,1] plus the audit inputs
// (effective sample size, distinct-workstream count, winner) the artifact table
// and scorer reasons surface. Pure read over the folded DomainHistory.
export interface DomainDiscriminativeness {
  readonly domain: string;
  // 1 − normalizedEntropy(workstream | domain), smoothed. ∈ [0,1].
  readonly discriminativeness: number;
  // The workstream carrying the most (asserted-weighted) evidence, or null when
  // the domain has no real evidence (prior-only / unseen).
  readonly winnerWorkstreamId: string | null;
  // Asserted-weighted evidence for the winner / all workstreams on this domain
  // (REAL labels only — excludes the synthetic prior). For audit + reasons.
  readonly assertedForWinner: number;
  readonly assertedTotal: number;
  readonly distinctWorkstreams: number;
  // Whether this domain drew the coarse-multi-topic prior (audit: shows the
  // list's influence, and whether evidence has overridden it).
  readonly listedPrior: boolean;
}

// Compute the asserted-weighted per-workstream evidence for a domain (asserted
// full weight; inferred down-weighted). Returns an empty map for an unseen
// domain. The winner and totals are over REAL evidence only.
const domainWeightedEvidence = (history: DomainHistory | undefined): Map<string, number> => {
  const evidence = new Map<string, number>();
  if (history === undefined) return evidence;
  for (const [workstreamId, count] of history.asserted) {
    evidence.set(workstreamId, (evidence.get(workstreamId) ?? 0) + count);
  }
  for (const [workstreamId, count] of history.inferred) {
    if (count === 0) continue;
    evidence.set(workstreamId, (evidence.get(workstreamId) ?? 0) + count * INFERRED_LABEL_WEIGHT);
  }
  return evidence;
};

export const domainDiscriminativeness = (
  state: AttributionV1State,
  domain: string,
): DomainDiscriminativeness => {
  const history = state.domains.get(domain);
  const evidence = domainWeightedEvidence(history);
  const listedPrior = isCoarseMultiTopicPriorDomain(domain);

  // Real-evidence audit fields (winner, totals) — over REAL labels only.
  let assertedTotal = 0;
  let winnerWorkstreamId: string | null = null;
  let assertedForWinner = 0;
  for (const [workstreamId, weight] of evidence) {
    assertedTotal += weight;
    if (
      weight > assertedForWinner ||
      (weight === assertedForWinner && (winnerWorkstreamId === null || workstreamId < winnerWorkstreamId))
    ) {
      winnerWorkstreamId = workstreamId;
      assertedForWinner = weight;
    }
  }
  const distinctWorkstreams = evidence.size;

  // Build the SMOOTHED mass vector we take entropy over. Start from the real
  // asserted-weighted evidence; add α per observed workstream (symmetric
  // Dirichlet); then, for a listed domain, add the diffuse list prior across
  // synthetic buckets that no real workstream can cancel out (they raise
  // entropy until real concentrated mass dominates them).
  const masses: number[] = [];
  for (const weight of evidence.values()) masses.push(weight + DOMAIN_DIRICHLET_ALPHA);
  if (listedPrior) {
    const perBucket = LISTED_PRIOR_PSEUDO_MASS / LISTED_PRIOR_WORKSTREAMS;
    for (let i = 0; i < LISTED_PRIOR_WORKSTREAMS; i += 1) masses.push(perBucket);
  }

  // No evidence AND no prior ⇒ neutral (the unlisted low-data default). A listed
  // domain always has prior buckets, so it never lands here.
  if (masses.length === 0) {
    return {
      domain,
      discriminativeness: NEUTRAL_DISCRIMINATIVENESS,
      winnerWorkstreamId,
      assertedForWinner,
      assertedTotal,
      distinctWorkstreams,
      listedPrior,
    };
  }
  // A single smoothed outcome (K=1) is perfectly discriminative: the only way
  // to reach K=1 is an unlisted domain seen for exactly one workstream with no
  // prior buckets. Entropy 0 ⇒ discriminativeness 1.
  const k = masses.length;
  if (k === 1) {
    return {
      domain,
      discriminativeness: 1,
      winnerWorkstreamId,
      assertedForWinner,
      assertedTotal,
      distinctWorkstreams,
      listedPrior,
    };
  }
  let total = 0;
  for (const m of masses) total += m;
  let entropy = 0;
  for (const m of masses) {
    const p = m / total;
    if (p > 0) entropy -= p * Math.log(p);
  }
  const normalizedEntropy = entropy / Math.log(k);
  const discriminativeness = 1 - normalizedEntropy;
  return {
    domain,
    // Clamp for numerical safety (float error can nudge slightly outside [0,1]).
    discriminativeness: Math.min(1, Math.max(0, discriminativeness)),
    winnerWorkstreamId,
    assertedForWinner,
    assertedTotal,
    distinctWorkstreams,
    listedPrior,
  };
};

// Full per-domain discriminativeness table (every folded domain), sorted most-
// to least-discriminative then by domain for determinism. Exported into the
// artifact for inspection and used by the eval's arm-table diagnostics.
export const domainDiscriminativenessTable = (
  state: AttributionV1State,
): readonly DomainDiscriminativeness[] => {
  const rows = [...state.domains.keys()].map((domain) => domainDiscriminativeness(state, domain));
  rows.sort((a, b) =>
    b.discriminativeness !== a.discriminativeness
      ? b.discriminativeness - a.discriminativeness
      : a.domain < b.domain
        ? -1
        : a.domain > b.domain
          ? 1
          : 0,
  );
  return rows;
};

// ---- venue/brand-term suppression (per-domain, targeted) --------------
//
// The first live shadow record caught v1 false-firing on the HACKER NEWS FRONT
// PAGE: the plain title overlap matched the venue/brand tokens in stored member
// titles ("Hacker News" appears in many HN member titles as a suffix), so a
// visit whose title was literally "Hacker News" scored a large overlap against
// the workstream those members live in. The incumbent correctly abstained.
//
// FIX (targeted, NOT global IDF — the 2026-07-16 finding already showed global
// IDF loses to plain overlap). When scoring title overlap for a visit on domain
// D, suppress terms that are part of D's OWN brand/name:
//   1. Brand tokens derived from the domain STRING itself (the registrable
//      domain's labels: "ycombinator", "reddit", "youtube", …), plus a small
//      static map for well-known brands whose display name differs from the
//      host ("hacker","news" for news.ycombinator.com).
//   2. The most-frequent shared token(s) across THAT domain's own stored member
//      titles — the data-driven half: whatever token nearly every member title
//      on the domain carries is site chrome, not topic ("hacker"/"news" on
//      news.ycombinator.com fall out of the member titles automatically).
// Only terms on domain D are suppressed for a visit on domain D — this is not a
// global stoplist, so a genuine topical term that happens to be a brand token
// elsewhere is untouched. Purely additive to the plain-overlap primitive.

// Brand tokens whose display name differs from the host string. Keyed by
// registrable domain. Small and explicit — the domain-string derivation below
// covers the rest ("reddit" from reddit.com, etc.). Kept minimal on purpose;
// the data-driven shared-token half generalizes to domains not listed here.
const STATIC_BRAND_TOKENS: ReadonlyMap<string, readonly string[]> = new Map([
  ['ycombinator.com', ['hacker', 'news', 'ycombinator']],
  ['news.ycombinator.com', ['hacker', 'news', 'ycombinator']],
]);

// Fraction of a domain's member titles a token must appear in to count as site
// chrome (the data-driven brand-token half). A token in ≥ this share of the
// domain's members is treated as venue/brand, not topic. 0.6 = "most members
// carry it" (the north-star's venue-term intuition), tolerant of the odd member
// title that omits the suffix.
export const DOMAIN_CHROME_TOKEN_SHARE = 0.6;

// Minimum member titles on a domain before the data-driven shared-token
// suppression engages — below this the "most-frequent shared token" is not yet
// a reliable venue signal (a domain seen twice can't distinguish chrome from
// coincidence). The domain-string tokens (static + derived) always apply.
export const DOMAIN_CHROME_MIN_MEMBERS = 3;

// Per-workstream member titles are not stored verbatim in the folded state
// (only per-workstream term document-frequencies are). To derive a DOMAIN's
// shared member tokens we need per-domain title term counts, which the state
// does not carry. So the data-driven half operates on a small per-visit input:
// the caller passes the domain and we combine (a) domain-string tokens with (b)
// the domain's chrome tokens computed from a supplied term→member-count map
// when available. To keep the state artifact unchanged this wave, the scorer
// derives (b) from the domain's own member titles via the venue-token index
// built below at fold time is NOT added; instead brandTokensForDomain uses only
// the domain-string + static map, and the shared-token half is exercised in the
// eval/tests through domainChromeTokens over an explicit title corpus. This
// keeps the artifact schema stable while still suppressing the observed HN case
// (its brand tokens ARE domain-string/static: "hacker","news","ycombinator").

// The domain-string + static brand tokens for a domain (always available, no
// corpus needed). Lowercased, length/stopword-filtered through the same
// tokenizer the title family uses so the sets are comparable.
//
// Derives ONLY from the REGISTRABLE domain's non-TLD label(s) — NOT the full
// host. Subdomain labels are frequently real topic words ("engineering" in
// engineering.fb.com, "docs" in docs.rust-lang.org, "blog" in blog.acme.io);
// tokenizing them as "brand" would wrongly strip topical terms from titles (a
// 2026-07-16 vault measurement caught "engineering" being suppressed 89×). The
// registrable label ("fb", "rust-lang", "acme") IS the site's own name and is
// safe to suppress. Well-known sites whose display name differs from the host
// (Hacker News on news.ycombinator.com) get their extra tokens from the static
// map, keyed by BOTH the registrable and the full host so a subdomain-specific
// brand ("hacker","news") can still be listed.
export const brandTokensForDomain = (domain: string): Set<string> => {
  const tokens = new Set<string>();
  const registrable = registrableDomainOf(domain);
  // Domain-string tokens: tokenize the registrable domain's labels EXCEPT the
  // TLD. Subdomain labels are deliberately excluded (see above).
  const registrableLabels = registrable.split('.');
  const tld = registrableLabels.length > 0 ? registrableLabels[registrableLabels.length - 1]! : '';
  for (const label of registrableLabels) {
    if (label === tld) continue;
    for (const token of tokenizeTitle(label)) tokens.add(token);
  }
  for (const token of STATIC_BRAND_TOKENS.get(registrable) ?? STATIC_BRAND_TOKENS.get(domain) ?? []) {
    tokens.add(token);
  }
  return tokens;
};

// Data-driven chrome tokens for a domain, given that domain's member titles:
// the tokens appearing in ≥ DOMAIN_CHROME_TOKEN_SHARE of the titles (site
// chrome). Requires ≥ DOMAIN_CHROME_MIN_MEMBERS titles; below that returns
// empty. Exposed for tests and the eval; the scorer combines this with
// brandTokensForDomain when a corpus is available.
export const domainChromeTokens = (memberTitles: readonly string[]): Set<string> => {
  const chrome = new Set<string>();
  const n = memberTitles.length;
  if (n < DOMAIN_CHROME_MIN_MEMBERS) return chrome;
  const docFreq = new Map<string, number>();
  for (const title of memberTitles) {
    for (const term of new Set(tokenizeTitle(title))) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
  }
  const threshold = DOMAIN_CHROME_TOKEN_SHARE * n;
  for (const [term, df] of docFreq) {
    if (df >= threshold) chrome.add(term);
  }
  return chrome;
};

// Plain title overlap with venue/brand-term suppression for a visit on `domain`.
// Identical to plainTitleOverlap except the query terms that are brand tokens of
// `domain` are dropped BEFORE scoring, so a visit whose title is only the site's
// own name/chrome scores no overlap (the HN-front-page fix). `extraChromeTokens`
// lets the caller inject the data-driven shared-token set for the domain when a
// member-title corpus is available (eval/tests); the scorer passes the
// domain-string + static tokens, which already cover the observed HN case.
export const plainTitleOverlapSuppressed = (
  state: AttributionV1State,
  title: string | null,
  domain: string | null,
  extraChromeTokens: ReadonlySet<string> = new Set(),
): PlainTitleOverlap => {
  const scores = new Map<string, number>();
  const matchedTerms = new Map<string, string[]>();
  if (title === null) return { scores, matchedTerms };
  const brand = domain === null ? new Set<string>() : brandTokensForDomain(domain);
  const terms = new Set<string>();
  for (const term of tokenizeTitle(title)) {
    if (brand.has(term) || extraChromeTokens.has(term)) continue;
    terms.add(term);
  }
  if (terms.size === 0) return { scores, matchedTerms };
  for (const [workstreamId, stats] of state.workstreams) {
    let score = 0;
    const matched: string[] = [];
    for (const term of terms) {
      const df = stats.termDocFreq.get(term) ?? 0;
      if (df === 0) continue;
      score += df;
      matched.push(term);
    }
    if (score > 0) {
      scores.set(workstreamId, score);
      matchedTerms.set(workstreamId, matched);
    }
  }
  return { scores, matchedTerms };
};
