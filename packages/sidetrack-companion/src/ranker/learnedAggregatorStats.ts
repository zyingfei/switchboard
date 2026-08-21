// Learned per-node aggregator statistics — a behavioral, incrementally
// maintained SHADOW classifier alongside the hand-maintained domain registry
// in aggregatorProfiles.ts.
//
// WHY THIS EXISTS. aggregatorProfiles.ts is a hand-written per-domain
// registry (ycombinator/reddit/twitter/github/... each with a bespoke
// isItemUrl predicate and title-chrome patterns). It rots: every new
// aggregator needs a new profile, and a domain not on the list gets zero
// protection even if it behaves exactly like a listed one (a personal blog
// vs. a multi-author eng blog vs. a news aggregator all look the same to a
// static list — one label per domain can't capture that hub-ness is a
// BEHAVIOR, not an identity). This module computes the same
// AggregatorPageType decision from vault-derivable counters instead: revisit
// cadence, title churn across captures, same-domain outlink fan-out (the
// original, opener-chain-dependent signal), and three OPENER-INDEPENDENT
// signals added 2026-08-21 to close PR #373's named blind spot — real visits
// to github.com/reddit.com/chatgpt.com/claude.ai items overwhelmingly arrive
// via an external link or bookmark, never a same-domain opener, so the
// opener-chain signal alone structurally never accumulates evidence there:
// (a) URL-population shape (many distinct single-visit deep paths + a
// revisited shallow path), (b) keyword-concept entropy (a content-coherence
// VETO, not an independent qualifier), and (c) shallow-path title-churn
// aggregated across the domain. See each constant's own comment below for
// the exact gate. No domain list, no URL-shape special-casing.
//
// SERVING STATUS (updated 2026-08-21, task #22). The IS-AGGREGATOR (hub)
// decision — "does this hostname get quarantined from domain-key /
// title-path-token grouping at all" — is now CONSULTED by candidates.ts and
// tabsession/similarity.ts, OR-COMBINED with the registry: a hostname is
// treated as an aggregator if EITHER classifier says so (see
// learnedAggregatorServeEnabled). This is a MONOTONIC, strictly-additive
// change — it can only ADD quarantine protection the registry didn't have
// (closing PR #373's blind spot: 677 hostnames on the live test vault the
// registry has no profile for at all), never REMOVE protection the registry
// already provides (every registry-covered domain is still asked, and its
// 'feed'/'item' answer alone is still sufficient to quarantine). Gated
// behind SIDETRACK_LEARNED_AGGREGATOR_SERVE (default ON; =0 is the kill
// switch back to registry-only, byte-identical to pre-task-#22 behavior).
//
// The FEED-VS-ITEM sub-classification (which only matters when the
// separately-gated, default-OFF SIDETRACK_AGGREGATOR_ITEM_SIGNALS narrowing
// is on) stays REGISTRY-ONLY — the 2026-08-21 measurement
// (scripts/measure-learned-aggregator-stats.ts) found a real, if
// safe-directioned (over-suppression, not under-suppression — see the
// COLD-START RULE below), per-URL false-negative pattern on this specific
// sub-decision: platforms that inject volatile metadata into a page's
// <title> across captures (reddit vote/comment counts, ChatGPT/Claude.ai
// auto-renaming a new conversation after its first exchange) trip the
// pre-existing per-URL title-churn-as-feed heuristic even though the
// underlying content object is stable. Not yet replacement-grade; still
// wired into system/workGraphHealth.ts as an observe-only diagnostic for
// this sub-decision specifically. See docs/plans/2026-08-15-foundation-
// program.md's "Learned per-node aggregator stats — design note
// (2026-08-16)" for the full design rationale, the false-friend history
// this must not weaken, and the thresholds' reasoning.
//
// COLD-START RULE (binding). Any URL or domain this module has not seen
// enough evidence for defaults to the CONSERVATIVE / quarantining answer —
// 'feed' for an unknown URL on a known hub domain, and 'not-aggregator' for
// a domain with insufficient evidence to call it a hub at all. The guard
// this module shadows is allowed to be wrong by over-suppressing (an item
// briefly loses signal); it must never be wrong by under-suppressing (a feed
// page's shared chrome links two unrelated stories — the 2026-07-10
// false-friend).
//
// INCREMENTALITY. `applyAggregatorObservation` mutates the counters in
// place, once per observation — O(1) amortized, no rescan of prior
// observations. Per-domain aggregates (max qualifying fan-out, hub-candidate
// count) are updated on the same transition edge, not recomputed by
// scanning every URL in the domain — so both writes AND reads stay O(1)
// (domainStats/isLearnedAggregatorHost never walk the domain's URL set).
// Callers persist a AggregatorStatsState across calls and only ever fold
// NEW observations into it.

import type { AggregatorPageType } from './aggregatorProfiles.js';

// Bound memory on genuinely large hubs (an HN front page accumulates
// thousands of distinct item links over months). Classification only ever
// needs to know whether the set has crossed MIN_HUB_FANOUT, so capping the
// tracked set well above that threshold loses no decision-relevant
// information while keeping per-URL state small.
const MAX_TRACKED_OUTLINK_TARGETS = 64;
const MAX_TRACKED_INBOUND_SOURCES = 32;

// Domain qualifies as a hub only once it has enough distinct URLs to be
// worth distinguishing feed vs. item, AND at least one page whose qualifying
// (revisit/churn-corroborated — see qualifiesAsHubCandidate) same-domain
// outlink fan-out clears this bar. Both are named, tunable constants — never
// a domain-specific override.
export const MIN_DOMAIN_URLS_FOR_HUB = 5;
export const MIN_HUB_FANOUT = 8;
// A URL's own fan-out must clear this to require revisit/churn
// corroboration before counting toward the domain's hub signal (a
// single-visit table-of-contents page on an otherwise single-source blog
// should not alone flip the domain into "hub").
export const MIN_HUB_CANDIDATE_REVISITS = 2;
// An item page should have almost no outbound same-domain fan-out of its
// own (a "back to listing" link or two, not a launching page).
export const ITEM_MAX_OUTLINK_FANOUT = 3;
// Title changed on at least roughly 1 of every 3 adjacent capture pairs —
// the listing signature (content rotates under a stable URL).
export const MIN_TITLE_CHURN_RATE_FOR_FEED = 0.34;

// ---------------------------------------------------------------------------
// Opener-independent hub signals (2026-08-21, task #22 — closing PR #373's
// named blind spot). The fan-out gate above requires OBSERVING a same-domain
// launch -> item opener chain (NAVIGATION_COMMITTED.openerVisitId inside the
// domain). Real visits to github.com/reddit.com/chatgpt.com/claude.ai items
// overwhelmingly arrive via EXTERNAL links or bookmarks — the browser tab
// that lands on the item never had a same-domain opener at all, so those
// domains structurally never accumulate qualifying fan-out no matter how
// much they get visited (0% learned/registry agreement on exactly these
// domains was PR #373's measured, named blind spot). The signals below infer
// hub-ness from the SHAPE of the domain's visit population instead of from
// an observed launch edge — still purely behavioral/structural (no domain
// list, no per-domain override), just keyed on different evidence.
//
// (a) URL-POPULATION SHAPE. A hub's item pages are each visited once (or a
// handful of times) via distinct deep paths (many rows); its feed/listing
// surfaces are comparatively few, shallow, and get revisited (a handful of
// rows, each with many observations). A single-source blog or personal-notes
// domain has no such split — its distinct URLs are all roughly equally
// (in)frequently visited regardless of path depth. "Shallow" vs. "deep" is
// PATH SEGMENT COUNT, the same generic URL-structure primitive
// firstPathSegmentOf already uses — never a per-domain path grammar.
export const SHALLOW_PATH_MAX_SEGMENTS = 1;
export const DEEP_PATH_MIN_SEGMENTS = 2;
// Mirrors MIN_HUB_FANOUT by intent: "many distinct single-visit deep URLs"
// is the population-shape analogue of "one page that fans out to many" —
// same bar, different evidence source.
export const MIN_DEEP_SINGLE_VISIT_URLS_FOR_HUB = MIN_HUB_FANOUT;
// At least one shallow (listing-shaped) URL must show REPEAT traffic —
// reuses the same revisit bar the fan-out-candidate gate uses
// (MIN_HUB_CANDIDATE_REVISITS) so a single coincidentally-revisited page
// can't alone qualify a domain that never showed it elsewhere.
export const MIN_SHALLOW_REVISITED_URLS_FOR_HUB = 1;

// (c) SHALLOW-PATH TITLE CHURN. The existing per-URL title-churn signal
// (MIN_TITLE_CHURN_RATE_FOR_FEED) already requires OBSERVING the SAME URL
// change title across captures — opener-independent by construction, but it
// only ever speaks to that one URL. Aggregated across a domain's SHALLOW
// paths specifically (root, listing, feed-shaped surfaces — deep item pages
// are expected to be title-STABLE, so mixing them in would dilute the
// signal), a high churn rate corroborates hub-shape even when no single
// shallow URL individually cleared the per-URL bar yet. Needs a minimum
// sample (adjacent-capture pairs) before the rate is trusted — the same
// cold-start caution every other gate here applies.
export const MIN_SHALLOW_CHURN_SAMPLES_FOR_SIGNAL = 3;

// (b) KEYWORD-CONCEPT ENTROPY VETO. See DomainAggregatorCounters.
// keywordConceptEntropyBits for what this counts and why it's a CONTENT
// signal the URL/path-structure signals above can't see. Consulted as a
// VETO ONLY (can turn a structurally hub-shaped domain into not-aggregator;
// never the reverse) — the cold-start rule ("wrong by over-suppressing is
// acceptable, wrong by under-suppressing never is") means an absence of
// keyword data must never BLOCK a hub call the structural signals already
// support, only a POSITIVE low-entropy reading may override one. Needs a
// minimum sample (distinct keyword-concept-bearing observations) before the
// entropy reading is trusted.
export const MIN_KEYWORD_CONCEPT_SAMPLES_FOR_VETO = 4;
// "Low" here means close to 0 bits, not merely below-average — a domain
// whose few tagged pages share 1-2 concepts (near-total agreement).
export const LOW_KEYWORD_ENTROPY_VETO_BITS = 0.5;

export interface UrlAggregatorCounters {
  /** Distinct BROWSER_TIMELINE_OBSERVED captures that carried a title. */
  readonly captureCount: number;
  readonly lastTitleNormalized: string | null;
  /** Adjacent-capture title deltas (churn), among captures with a title. */
  readonly titleChangeCount: number;
  /** Distinct same-domain canonical URLs this URL was observed opening or
   * navigation-chaining to (bounded, see MAX_TRACKED_OUTLINK_TARGETS). */
  readonly outlinkTargets: ReadonlySet<string>;
  /** Total outlink observations, deduped or not — retained for diagnostics. */
  readonly outlinkObservationCount: number;
  /** Distinct URLs that opened/chained into this one (bounded). */
  readonly inboundSources: ReadonlySet<string>;
  readonly firstObservedAtMs: number;
  readonly lastObservedAtMs: number;
  /** Total observations of ANY kind folded for this URL (title-bearing or
   *  not, opener/previous edge or not) — unlike captureCount, this counts
   *  every visit, so it is the "how many times was this exact URL visited"
   *  measure the population-shape signal (a) is built on. */
  readonly observationCount: number;
  /** Non-empty path segment count, computed once from the URL and cached
   *  (a stable structural property, never re-derived per read). Feeds the
   *  population-shape signal (a) — see SHALLOW_PATH_MAX_SEGMENTS /
   *  DEEP_PATH_MIN_SEGMENTS. */
  readonly pathDepth: number;
}

export interface DomainAggregatorCounters {
  readonly distinctUrlCount: number;
  /** Max qualifying outlink fan-out over any URL in the domain (0 if none
   * qualifies — see qualifiesAsHubCandidate). */
  readonly maxQualifyingOutlinkFanout: number;
  /** Count of URLs whose qualifying fan-out clears MIN_HUB_FANOUT. */
  readonly hubCandidateCount: number;
  /** Diagnostic only, not a classification gate (see design note): entropy
   * of the domain's first-path-segment distribution. Aggregator platforms
   * often normalize path shape (HN's uniform `/item`), so this alone does
   * not reliably separate a hub from a single-source blog. */
  readonly firstPathSegmentEntropyBits: number;
  /**
   * Entropy of the domain's keyword-CONCEPT distribution (keywordConcepts.ts
   * concept ids, folded from AggregatorVisitObservation.keywordConceptIds).
   * CONSULTED as a VETO by isLearnedAggregatorHost (2026-08-21, task #22) —
   * see MIN_KEYWORD_CONCEPT_SAMPLES_FOR_VETO / LOW_KEYWORD_ENTROPY_VETO_BITS
   * for the exact gate; it can only turn a structurally hub-shaped domain
   * into not-aggregator, never the reverse (the cold-start rule: absence of
   * data must never BLOCK a hub call the structural signals already
   * support).
   *
   * WHY THIS ADDS SIGNAL THE PATH-SEGMENT ENTROPY DOESN'T (PR #373's named
   * blind spot: "cannot distinguish single-source blogs from true
   * aggregators"). Path shape is a URL-STRUCTURE property — a hub can
   * normalize it away (HN's uniform `/item`) or a single-author blog can
   * vary it a lot (dated permalinks, category prefixes) without being an
   * aggregator at all. Keyword-concept entropy is a CONTENT-TOPIC property:
   * a true aggregator's items span many unrelated concepts (low agreement
   * page to page), while a single-source blog — even one with wildly
   * different URL shapes — writes about a comparatively narrow, low-entropy
   * set of concepts. Low entropy here is evidence FOR "coherent single
   * source" independent of what the path segment entropy says; the two
   * signals are complementary, not redundant, which is exactly the
   * combination PR #373 asked for and did not have.
   *
   * 0 when the domain has no keyword-concept observations at all (not "low
   * entropy" — see entropyBitsOf's own empty-input behavior). Zero,
   * degenerate/near-zero, and "no data" are NOT distinguished by this single
   * number — see keywordConceptObservationCount for that distinction, which
   * is exactly why the veto gates on a minimum sample count rather than
   * reading this field alone.
   */
  readonly keywordConceptEntropyBits: number;
  /** Count of observations that supplied a non-empty keywordConceptIds for
   *  this domain (folded, not deduped by URL) — the sample-size gate
   *  keywordConceptEntropyBits' veto use needs to avoid trusting entropy
   *  computed from 1-2 tagged pages. */
  readonly keywordConceptObservationCount: number;
  /** Count of distinct URLs in this domain, DEEP path (see
   *  DEEP_PATH_MIN_SEGMENTS), observed exactly once so far — signal (a),
   *  half of the population-shape hub gate (see
   *  MIN_DEEP_SINGLE_VISIT_URLS_FOR_HUB). Falls as a previously single-visit
   *  URL gets revisited — NOT monotonic, unlike hubCandidateCount. */
  readonly deepSingleVisitUrlCount: number;
  /** Count of distinct URLs in this domain, SHALLOW path (see
   *  SHALLOW_PATH_MAX_SEGMENTS), revisited at least
   *  MIN_HUB_CANDIDATE_REVISITS times — signal (a)'s other half (see
   *  MIN_SHALLOW_REVISITED_URLS_FOR_HUB). Monotonic, same style as
   *  hubCandidateCount. */
  readonly shallowHighRevisitUrlCount: number;
  /** Adjacent-capture title-churn rate (see MIN_TITLE_CHURN_RATE_FOR_FEED),
   *  aggregated across this domain's SHALLOW-path URLs only — signal (c).
   *  0 when shallowTitleChurnSampleCount is 0 (no data, not "no churn" —
   *  same "0 vs. no-data" caution as keywordConceptEntropyBits; read the
   *  sample count alongside this before trusting it). */
  readonly shallowTitleChurnRate: number;
  /** Adjacent-capture pairs this domain's shallow-path churn rate is
   *  computed over — the sample-size gate for shallowTitleChurnRate (see
   *  MIN_SHALLOW_CHURN_SAMPLES_FOR_SIGNAL). */
  readonly shallowTitleChurnSampleCount: number;
}

interface MutableUrlCounters {
  captureCount: number;
  lastTitleNormalized: string | null;
  titleChangeCount: number;
  outlinkTargets: Set<string>;
  outlinkObservationCount: number;
  inboundSources: Set<string>;
  firstObservedAtMs: number;
  lastObservedAtMs: number;
  /** Cached qualification result so domain aggregates can be updated on the
   * transition edge (O(1)) instead of rescanning every URL in the domain on
   * each read. Qualification is monotonic — every input (captureCount,
   * titleChangeCount, outlinkTargets.size) only grows, so once true it never
   * becomes false. */
  countedAsHubCandidate: boolean;
  /** See UrlAggregatorCounters.observationCount / pathDepth. pathDepth is
   *  computed once at creation (a stable structural property of the URL);
   *  observationCount increments on every applyObservation call for this
   *  URL. */
  observationCount: number;
  readonly pathDepth: number;
  /** Population-shape (signal a) transition flags — see
   *  AggregatorStatsState.refreshPopulationShape for the O(1) transition
   *  logic these guard. countedAsDeepSingleVisit is NOT monotonic (a URL
   *  can leave "single-visit" on its second observation);
   *  countedAsShallowHighRevisit is monotonic, same style as
   *  countedAsHubCandidate. */
  countedAsDeepSingleVisit: boolean;
  countedAsShallowHighRevisit: boolean;
}

interface MutableDomainCounters {
  distinctUrlCount: number;
  firstPathSegmentCounts: Map<string, number>;
  maxQualifyingOutlinkFanout: number;
  hubCandidateCount: number;
  /** See DomainAggregatorCounters.keywordConceptEntropyBits /
   *  keywordConceptObservationCount. */
  keywordConceptCounts: Map<string, number>;
  keywordConceptObservationCount: number;
  /** See DomainAggregatorCounters.deepSingleVisitUrlCount /
   *  shallowHighRevisitUrlCount — signal (a), maintained on the transition
   *  edge by AggregatorStatsState.refreshPopulationShape. */
  deepSingleVisitUrlCount: number;
  shallowHighRevisitUrlCount: number;
  /** See DomainAggregatorCounters.shallowTitleChurnRate /
   *  shallowTitleChurnSampleCount — signal (c), folded alongside the
   *  existing per-URL title-churn bookkeeping in applyObservation. */
  shallowChurnNumerator: number;
  shallowChurnDenominator: number;
}

const freezeUrlCounters = (mutable: MutableUrlCounters): UrlAggregatorCounters => ({
  captureCount: mutable.captureCount,
  lastTitleNormalized: mutable.lastTitleNormalized,
  titleChangeCount: mutable.titleChangeCount,
  outlinkTargets: mutable.outlinkTargets,
  outlinkObservationCount: mutable.outlinkObservationCount,
  inboundSources: mutable.inboundSources,
  firstObservedAtMs: mutable.firstObservedAtMs,
  lastObservedAtMs: mutable.lastObservedAtMs,
  observationCount: mutable.observationCount,
  pathDepth: mutable.pathDepth,
});

const entropyBitsOf = (counts: ReadonlyMap<string, number>): number => {
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  if (total === 0) return 0;
  let entropy = 0;
  for (const count of counts.values()) {
    if (count === 0) continue;
    const probability = count / total;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
};

// A URL's fan-out only counts toward the domain's hub signal once it clears
// a revisit/churn bar — see design note. Prevents a single-visit
// table-of-contents page from alone flipping a single-source blog into
// "hub".
const qualifiesAsHubCandidate = (counters: MutableUrlCounters): boolean =>
  counters.outlinkTargets.size >= MIN_HUB_FANOUT &&
  (counters.captureCount >= MIN_HUB_CANDIDATE_REVISITS || counters.titleChangeCount >= 1);

// registrable-ish domain: last two labels. Deliberately the same simple
// suffix technique aggregatorProfiles.ts's normalizeHost uses (not eTLD+1
// aware — co.uk-style suffixes are a known simplification the registry
// shares) — a generic STRUCTURAL heuristic, not a per-domain list.
export const registrableDomainOf = (hostname: string): string => {
  const host = hostname.toLowerCase().replace(/^www\./u, '').replace(/\.$/u, '');
  const labels = host.split('.').filter((label) => label.length > 0);
  if (labels.length <= 2) return host;
  return labels.slice(-2).join('.');
};

const hostnameOf = (canonicalUrl: string): string | null => {
  try {
    return new URL(canonicalUrl).hostname;
  } catch {
    return null;
  }
};

const firstPathSegmentOf = (canonicalUrl: string): string => {
  try {
    const parsed = new URL(canonicalUrl);
    const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
    return segments[0] ?? '';
  } catch {
    return '';
  }
};

// Non-empty path segment count — the generic structural primitive signal
// (a)'s shallow/deep split is built on (SHALLOW_PATH_MAX_SEGMENTS /
// DEEP_PATH_MIN_SEGMENTS). Same "URL-STRUCTURE, not domain-specific" spirit
// as firstPathSegmentOf; a malformed URL depth-counts as 0 (shallow), the
// conservative direction (never spuriously "deep").
const pathSegmentCountOf = (canonicalUrl: string): number => {
  try {
    const parsed = new URL(canonicalUrl);
    return parsed.pathname.split('/').filter((segment) => segment.length > 0).length;
  } catch {
    return 0;
  }
};

const normalizeTitle = (title: string): string => title.trim().toLowerCase();

/** Incrementally maintained per-URL and per-domain behavioral counters. Feed
 * new observations with applyAggregatorObservation(s); read with
 * classifyLearnedAggregatorPage / isLearnedAggregatorHost, or the raw
 * urlStats/domainStats accessors for diagnostics. */
export class AggregatorStatsState {
  private readonly urlCounters = new Map<string, MutableUrlCounters>();
  private readonly domainCounters = new Map<string, MutableDomainCounters>();

  /** Read-only view of a single URL's counters, or undefined if never
   * observed (the cold-start case callers must handle conservatively). */
  urlStats(canonicalUrl: string): UrlAggregatorCounters | undefined {
    const mutable = this.urlCounters.get(canonicalUrl);
    return mutable === undefined ? undefined : freezeUrlCounters(mutable);
  }

  /** Read-only view of a domain's counters, or undefined if never observed.
   * O(1) — the derived fields are maintained on write, never recomputed by
   * scanning the domain's URLs (except the small, bounded
   * first-path-segment entropy, which is O(distinct segments)). */
  domainStats(domain: string): DomainAggregatorCounters | undefined {
    const mutable = this.domainCounters.get(domain);
    if (mutable === undefined) return undefined;
    return {
      distinctUrlCount: mutable.distinctUrlCount,
      maxQualifyingOutlinkFanout: mutable.maxQualifyingOutlinkFanout,
      hubCandidateCount: mutable.hubCandidateCount,
      firstPathSegmentEntropyBits: entropyBitsOf(mutable.firstPathSegmentCounts),
      keywordConceptEntropyBits: entropyBitsOf(mutable.keywordConceptCounts),
      keywordConceptObservationCount: mutable.keywordConceptObservationCount,
      deepSingleVisitUrlCount: mutable.deepSingleVisitUrlCount,
      shallowHighRevisitUrlCount: mutable.shallowHighRevisitUrlCount,
      shallowTitleChurnRate:
        mutable.shallowChurnDenominator === 0
          ? 0
          : mutable.shallowChurnNumerator / mutable.shallowChurnDenominator,
      shallowTitleChurnSampleCount: mutable.shallowChurnDenominator,
    };
  }

  /** Every distinct canonical URL observed so far (for measurement/eval
   * tooling — not on any serving or shadow-diagnostic hot path). */
  observedUrls(): readonly string[] {
    return [...this.urlCounters.keys()];
  }

  private mutableUrl(canonicalUrl: string, observedAtMs: number): MutableUrlCounters {
    const existing = this.urlCounters.get(canonicalUrl);
    if (existing !== undefined) return existing;
    const created: MutableUrlCounters = {
      captureCount: 0,
      lastTitleNormalized: null,
      titleChangeCount: 0,
      outlinkTargets: new Set(),
      outlinkObservationCount: 0,
      inboundSources: new Set(),
      firstObservedAtMs: observedAtMs,
      lastObservedAtMs: observedAtMs,
      countedAsHubCandidate: false,
      observationCount: 0,
      pathDepth: pathSegmentCountOf(canonicalUrl),
      countedAsDeepSingleVisit: false,
      countedAsShallowHighRevisit: false,
    };
    this.urlCounters.set(canonicalUrl, created);
    const hostname = hostnameOf(canonicalUrl);
    if (hostname !== null) {
      const domain = registrableDomainOf(hostname);
      const domainCounters = this.domainCounters.get(domain) ?? {
        distinctUrlCount: 0,
        firstPathSegmentCounts: new Map<string, number>(),
        maxQualifyingOutlinkFanout: 0,
        hubCandidateCount: 0,
        keywordConceptCounts: new Map<string, number>(),
        keywordConceptObservationCount: 0,
        deepSingleVisitUrlCount: 0,
        shallowHighRevisitUrlCount: 0,
        shallowChurnNumerator: 0,
        shallowChurnDenominator: 0,
      };
      domainCounters.distinctUrlCount += 1;
      const segment = firstPathSegmentOf(canonicalUrl);
      domainCounters.firstPathSegmentCounts.set(
        segment,
        (domainCounters.firstPathSegmentCounts.get(segment) ?? 0) + 1,
      );
      this.domainCounters.set(domain, domainCounters);
    }
    return created;
  }

  /** Recheck whether `url` newly qualifies as a hub candidate (monotonic —
   * the "newly counted" transition fires once per URL) and fold it into the
   * domain aggregates. Called after any counter on `url` changes. */
  private refreshHubCandidacy(canonicalUrl: string, counters: MutableUrlCounters): void {
    const qualifiesNow = qualifiesAsHubCandidate(counters);
    if (!qualifiesNow) return;
    const hostname = hostnameOf(canonicalUrl);
    if (hostname === null) return;
    const domainCounters = this.domainCounters.get(registrableDomainOf(hostname));
    if (domainCounters === undefined) return;
    if (!counters.countedAsHubCandidate) {
      counters.countedAsHubCandidate = true;
      domainCounters.hubCandidateCount += 1;
    }
    domainCounters.maxQualifyingOutlinkFanout = Math.max(
      domainCounters.maxQualifyingOutlinkFanout,
      counters.outlinkTargets.size,
    );
  }

  /** Signal (a) — fold `url`'s latest observationCount into the domain's
   *  population-shape aggregates. Called once per applyObservation (every
   *  observation counts toward "how many times was this URL visited",
   *  unlike refreshHubCandidacy which only fires on title/outlink changes).
   *  Unlike hub candidacy, deepSingleVisitUrlCount is NOT monotonic — a URL
   *  leaves "single-visit" the moment it's revisited, so this both
   *  increments AND decrements on the matching transition edges; still O(1)
   *  per call, never a rescan. */
  private refreshPopulationShape(canonicalUrl: string, counters: MutableUrlCounters): void {
    const hostname = hostnameOf(canonicalUrl);
    if (hostname === null) return;
    const domainCounters = this.domainCounters.get(registrableDomainOf(hostname));
    if (domainCounters === undefined) return;

    if (counters.pathDepth >= DEEP_PATH_MIN_SEGMENTS) {
      if (counters.observationCount === 1) {
        counters.countedAsDeepSingleVisit = true;
        domainCounters.deepSingleVisitUrlCount += 1;
      } else if (counters.observationCount === 2 && counters.countedAsDeepSingleVisit) {
        counters.countedAsDeepSingleVisit = false;
        domainCounters.deepSingleVisitUrlCount -= 1;
      }
    }

    if (
      counters.pathDepth <= SHALLOW_PATH_MAX_SEGMENTS &&
      !counters.countedAsShallowHighRevisit &&
      counters.observationCount >= MIN_HUB_CANDIDATE_REVISITS
    ) {
      counters.countedAsShallowHighRevisit = true;
      domainCounters.shallowHighRevisitUrlCount += 1;
    }
  }

  private recordOutlink(sourceCanonicalUrl: string, targetCanonicalUrl: string, observedAtMs: number): void {
    if (sourceCanonicalUrl === targetCanonicalUrl) return;
    const sourceHost = hostnameOf(sourceCanonicalUrl);
    const targetHost = hostnameOf(targetCanonicalUrl);
    if (sourceHost === null || targetHost === null) return;
    // Same-domain fan-out only — a hub's identity is "launches many
    // same-domain items", not "links off-site" (HN's story links are
    // off-domain; its comments-page links are same-domain and ARE the
    // fan-out signal).
    if (registrableDomainOf(sourceHost) !== registrableDomainOf(targetHost)) return;
    const source = this.mutableUrl(sourceCanonicalUrl, observedAtMs);
    const target = this.mutableUrl(targetCanonicalUrl, observedAtMs);
    source.outlinkObservationCount += 1;
    if (source.outlinkTargets.size < MAX_TRACKED_OUTLINK_TARGETS) {
      source.outlinkTargets.add(targetCanonicalUrl);
    }
    if (target.inboundSources.size < MAX_TRACKED_INBOUND_SOURCES) {
      target.inboundSources.add(sourceCanonicalUrl);
    }
    this.refreshHubCandidacy(sourceCanonicalUrl, source);
  }

  /** Fold one observation into this state, in place. O(1) amortized — never
   * rescans prior observations. Persist this object across calls and only
   * ever pass NEW observations (the incrementality property this module is
   * built around). Returns `this` for chaining convenience. */
  applyObservation(observation: AggregatorVisitObservation): this {
    const url = this.mutableUrl(observation.canonicalUrl, observation.observedAtMs);
    url.lastObservedAtMs = Math.max(url.lastObservedAtMs, observation.observedAtMs);
    url.firstObservedAtMs = Math.min(url.firstObservedAtMs, observation.observedAtMs);

    // Signal (a) — every observation is a visit, title or not; population
    // shape needs the true revisit count, not just title-bearing captures.
    url.observationCount += 1;
    this.refreshPopulationShape(observation.canonicalUrl, url);

    if (observation.title !== undefined && observation.title.length > 0) {
      const normalized = normalizeTitle(observation.title);
      const hadPriorTitle = url.lastTitleNormalized !== null;
      const titleChanged = hadPriorTitle && url.lastTitleNormalized !== normalized;
      url.captureCount += 1;
      if (titleChanged) {
        url.titleChangeCount += 1;
      }
      url.lastTitleNormalized = normalized;
      this.refreshHubCandidacy(observation.canonicalUrl, url);

      // Signal (c) — fold this URL's adjacent-capture churn pair into the
      // domain's SHALLOW-path aggregate (see
      // DomainAggregatorCounters.shallowTitleChurnRate). Deep item pages are
      // deliberately excluded — they are expected to be title-stable, so
      // including them would dilute the listing-churn signal this exists to
      // detect.
      if (url.pathDepth <= SHALLOW_PATH_MAX_SEGMENTS && hadPriorTitle) {
        const hostname = hostnameOf(observation.canonicalUrl);
        if (hostname !== null) {
          const domainCounters = this.domainCounters.get(registrableDomainOf(hostname));
          if (domainCounters !== undefined) {
            domainCounters.shallowChurnDenominator += 1;
            if (titleChanged) domainCounters.shallowChurnNumerator += 1;
          }
        }
      }
    }

    if (observation.openerCanonicalUrl !== undefined) {
      this.recordOutlink(observation.openerCanonicalUrl, observation.canonicalUrl, observation.observedAtMs);
    }
    if (observation.previousCanonicalUrl !== undefined) {
      this.recordOutlink(observation.previousCanonicalUrl, observation.canonicalUrl, observation.observedAtMs);
    }

    // See DomainAggregatorCounters.keywordConceptEntropyBits /
    // keywordConceptObservationCount — content-coherence veto input (b).
    // `mutableUrl` above already created this URL's domain counters (if this
    // is the URL's first sighting), so the lookup here always hits once any
    // URL in the domain has been observed.
    if (observation.keywordConceptIds !== undefined && observation.keywordConceptIds.length > 0) {
      const hostname = hostnameOf(observation.canonicalUrl);
      if (hostname !== null) {
        const domainCounters = this.domainCounters.get(registrableDomainOf(hostname));
        if (domainCounters !== undefined) {
          domainCounters.keywordConceptObservationCount += 1;
          for (const conceptId of observation.keywordConceptIds) {
            domainCounters.keywordConceptCounts.set(
              conceptId,
              (domainCounters.keywordConceptCounts.get(conceptId) ?? 0) + 1,
            );
          }
        }
      }
    }

    return this;
  }
}

/** One discrete visit/navigation observation. Fields are independent — a
 * caller may supply title-only (from BROWSER_TIMELINE_OBSERVED) or
 * edge-only (from NAVIGATION_COMMITTED) observations; both update the same
 * per-URL counters. opener/previous canonical URLs are pre-resolved by the
 * caller (visitId -> canonicalUrl joins happen at the adapter, keeping this
 * module free of event-log/visitId bookkeeping). */
export interface AggregatorVisitObservation {
  readonly canonicalUrl: string;
  readonly observedAtMs: number;
  readonly title?: string;
  readonly openerCanonicalUrl?: string;
  readonly previousCanonicalUrl?: string;
  /** Concept ids (keywordConcepts.ts) for this page's gist keywords, when
   *  the keyword layer has processed it. Additive shadow input (2026-08-16,
   *  "gist keywords as sparse-data clustering features") — see
   *  DomainAggregatorCounters.keywordConceptEntropyBits. Optional; omitted
   *  on every observation reproduces this module's prior behavior exactly. */
  readonly keywordConceptIds?: readonly string[];
}

export const createEmptyAggregatorStatsState = (): AggregatorStatsState => new AggregatorStatsState();

/** Fold one observation into `state`, in place. Free function mirror of
 * `state.applyObservation(observation)` — kept as the primary exported entry
 * point so call sites read as a pure-looking fold even though the
 * implementation mutates for O(1) amortized cost. */
export const applyAggregatorObservation = (
  state: AggregatorStatsState,
  observation: AggregatorVisitObservation,
): AggregatorStatsState => state.applyObservation(observation);

/** Fold a batch of observations. Equivalent to calling
 * applyAggregatorObservation once per observation in order — provided as a
 * convenience; does not change the incrementality contract (still only
 * touches the observations passed in, never re-derives from history). */
export const applyAggregatorObservations = (
  state: AggregatorStatsState,
  observations: readonly AggregatorVisitObservation[],
): AggregatorStatsState => {
  for (const observation of observations) state.applyObservation(observation);
  return state;
};

/** Which evidence a domain has for hub-ness, and the resulting call — a
 *  single source of truth shared by isLearnedAggregatorHost (the decision)
 *  and the measurement CLI (the "why", per-domain breakdown). Each `*Shaped`
 *  field is independently gate-able evidence; `qualifiesAsHub` is the OR of
 *  every positive gate, vetoed by content-coherence when that veto's own
 *  sample-size bar is cleared. */
export interface AggregatorHubEvidence {
  /** Opener-chain fan-out evidence (the original, PR #373 signal) — a
   *  same-domain page observed launching >= MIN_HUB_FANOUT distinct items,
   *  revisit/churn-corroborated. */
  readonly fanoutShaped: boolean;
  /** Signal (a) — URL-population shape, opener-independent (see
   *  MIN_DEEP_SINGLE_VISIT_URLS_FOR_HUB / MIN_SHALLOW_REVISITED_URLS_FOR_HUB). */
  readonly populationShaped: boolean;
  /** Signal (c) — shallow-path title churn crosses the listing bar with
   *  enough samples to trust it, opener-independent. */
  readonly shallowChurnShaped: boolean;
  /** Signal (b) — enough keyword-concept samples AND low entropy: positive
   *  evidence the domain is a COHERENT single source, contradicting
   *  whichever `*Shaped` gate(s) above are true. Only meaningful when at
   *  least one `*Shaped` gate is true; a veto with nothing to veto is a
   *  no-op by construction (qualifiesAsHub is already false). */
  readonly contentCoherenceVeto: boolean;
  /** distinctUrlCount cleared MIN_DOMAIN_URLS_FOR_HUB AND at least one
   *  structural gate fired AND the content veto did not fire. */
  readonly qualifiesAsHub: boolean;
}

const shallowChurnShapedFor = (counters: DomainAggregatorCounters): boolean =>
  counters.shallowTitleChurnSampleCount >= MIN_SHALLOW_CHURN_SAMPLES_FOR_SIGNAL &&
  counters.shallowTitleChurnRate >= MIN_TITLE_CHURN_RATE_FOR_FEED;

const contentCoherenceVetoFor = (counters: DomainAggregatorCounters): boolean =>
  counters.keywordConceptObservationCount >= MIN_KEYWORD_CONCEPT_SAMPLES_FOR_VETO &&
  counters.keywordConceptEntropyBits <= LOW_KEYWORD_ENTROPY_VETO_BITS;

/** Evaluate every hub-evidence gate for a domain's counters. Pure — takes
 *  the already-frozen DomainAggregatorCounters, no state lookup. */
export const aggregatorHubEvidenceFor = (counters: DomainAggregatorCounters): AggregatorHubEvidence => {
  const fanoutShaped = counters.maxQualifyingOutlinkFanout >= MIN_HUB_FANOUT;
  const populationShaped =
    counters.deepSingleVisitUrlCount >= MIN_DEEP_SINGLE_VISIT_URLS_FOR_HUB &&
    counters.shallowHighRevisitUrlCount >= MIN_SHALLOW_REVISITED_URLS_FOR_HUB;
  const shallowChurnShaped = shallowChurnShapedFor(counters);
  const contentCoherenceVeto = contentCoherenceVetoFor(counters);
  const structurallyShaped = fanoutShaped || populationShaped || shallowChurnShaped;
  return {
    fanoutShaped,
    populationShaped,
    shallowChurnShaped,
    contentCoherenceVeto,
    qualifiesAsHub:
      counters.distinctUrlCount >= MIN_DOMAIN_URLS_FOR_HUB && structurallyShaped && !contentCoherenceVeto,
  };
};

/** Domain qualifies as a hub — replaces isAggregatorHost. Conservative:
 * insufficient evidence (few distinct URLs, no qualifying structural gate)
 * means 'not-aggregator', matching the registry's default for anything it
 * doesn't list. Three independent structural gates (fan-out, population
 * shape, shallow churn — see AggregatorHubEvidence), any one of which is
 * sufficient; a content-coherence veto (enough keyword-concept samples AND
 * low entropy) can override all three — see aggregatorHubEvidenceFor. */
export const isLearnedAggregatorHost = (state: AggregatorStatsState, hostname: string): boolean => {
  const domain = registrableDomainOf(hostname);
  const counters = state.domainStats(domain);
  if (counters === undefined) return false;
  return aggregatorHubEvidenceFor(counters).qualifiesAsHub;
};

const titleChurnRate = (counters: UrlAggregatorCounters): number =>
  counters.captureCount <= 1 ? 0 : counters.titleChangeCount / (counters.captureCount - 1);

/** Classify a single canonical URL — replaces classifyAggregatorPage. See
 * the design note for the full decision order and its rationale. */
export const classifyLearnedAggregatorPage = (
  state: AggregatorStatsState,
  canonicalUrl: string,
): AggregatorPageType => {
  const hostname = hostnameOf(canonicalUrl);
  if (hostname === null) return 'not-aggregator';
  if (!isLearnedAggregatorHost(state, hostname)) return 'not-aggregator';

  const urlCounters = state.urlStats(canonicalUrl);
  // Cold start on a known hub domain: conservative quarantine (binding).
  if (urlCounters === undefined) return 'feed';

  // The URL is itself a qualifying fan-out/listing page.
  if (
    urlCounters.outlinkTargets.size >= MIN_HUB_FANOUT &&
    (urlCounters.captureCount >= MIN_HUB_CANDIDATE_REVISITS || urlCounters.titleChangeCount >= 1)
  ) {
    return 'feed';
  }

  // Content keeps changing under a stable URL — the listing signature.
  if (urlCounters.captureCount >= 2 && titleChurnRate(urlCounters) >= MIN_TITLE_CHURN_RATE_FOR_FEED) {
    return 'feed';
  }

  // Positive item evidence: reached from a same-domain hub page, and this
  // URL doesn't itself fan out much. Deliberately does not require a
  // revisit — most real items are visited once.
  const domain = registrableDomainOf(hostname);
  const reachedFromHub = [...urlCounters.inboundSources].some((source) => {
    const sourceHost = hostnameOf(source);
    if (sourceHost === null || registrableDomainOf(sourceHost) !== domain) return false;
    const sourceCounters = state.urlStats(source);
    return sourceCounters !== undefined && sourceCounters.outlinkTargets.size >= MIN_HUB_FANOUT;
  });
  if (reachedFromHub && urlCounters.outlinkTargets.size <= ITEM_MAX_OUTLINK_FANOUT) {
    return 'item';
  }

  // OPENER-INDEPENDENT positive item evidence (2026-08-21, task #22 — PR
  // #373's named blind spot). A real visit to a github.com/reddit.com/
  // chatgpt.com/claude.ai item overwhelmingly arrives via an external link
  // or bookmark: the tab that lands there never had a same-domain opener,
  // so `reachedFromHub` above is structurally never true for these domains
  // no matter how much they're visited — the domain can clear
  // isLearnedAggregatorHost (now that populationShaped/shallowChurnShaped
  // don't need opener evidence either), but every one of its item pages
  // still fell through to the conservative 'feed' default below. A DEEP
  // path (see DEEP_PATH_MIN_SEGMENTS) on a domain we've already
  // independently qualified as a hub, that isn't itself a qualifying
  // listing page (checked above) and shows no title churn of its own
  // (checked above), is presumptively an item — the same structural
  // reasoning signal (a) uses at the domain level, applied per-URL. A
  // SHALLOW ambiguous URL still falls through to 'feed' (the conservative
  // default is unchanged for the case this can't speak to).
  if (urlCounters.pathDepth >= DEEP_PATH_MIN_SEGMENTS && urlCounters.outlinkTargets.size <= ITEM_MAX_OUTLINK_FANOUT) {
    return 'item';
  }

  // Hub domain, ambiguous (shallow) URL, no positive item evidence:
  // conservative default (binding).
  return 'feed';
};

/** Convenience mirror of aggregatorProfiles.ts's URL-string entry point. */
export const classifyLearnedAggregatorUrl = (state: AggregatorStatsState, url: string): AggregatorPageType => {
  try {
    return classifyLearnedAggregatorPage(state, new URL(url).toString());
  } catch {
    return 'not-aggregator';
  }
};

// ---------------------------------------------------------------------------
// Serving kill switch (2026-08-21, task #22). Consulted by BOTH serving call
// sites (ranker/candidates.ts, tabsession/similarity.ts) before building an
// AggregatorStatsState from their local event batch and OR-combining
// isLearnedAggregatorHost with the registry's isAggregatorHost — see the
// module header's SERVING STATUS section for the exact contract (additive
// only; registry protection is never removed). Kept HERE, not in either
// call site, so both consult the exact same flag under the exact same name
// — "one classifier" in spirit even though the OR-combine keeps two call
// sites' actual predicates. Call-time + case-insensitive, same idiom as
// candidates.ts's aggregatorGroupingGuardEnabled /
// aggregatorItemSignalsEnabled (togglable in tests, no restart needed).
export const learnedAggregatorServeEnabled = (): boolean => {
  const raw = process.env['SIDETRACK_LEARNED_AGGREGATOR_SERVE']?.toLowerCase();
  return raw !== '0' && raw !== 'false';
};

// ---------------------------------------------------------------------------
// Shadow agreement — pure reducer over (registryType, learnedType) pairs.
// Wired into system/workGraphHealth.ts as the aggregator.learned-stats-shadow
// diagnostic row's metrics.

export type AggregatorConfusionKey = `${AggregatorPageType}->${AggregatorPageType}`;

export interface AggregatorShadowAgreement {
  readonly totalClassified: number;
  readonly agreementCount: number;
  readonly disagreementCount: number;
  readonly agreementRate: number;
  /** Registry called it an aggregator (feed/item); learned called it
   * not-aggregator — the classifier under-reaching the registry. */
  readonly registryOnlyAggregatorCount: number;
  /** Learned called it an aggregator; registry has no profile for the
   * domain at all — the classifier finding hubs the hand list doesn't
   * cover (the entire point of this replacement). */
  readonly learnedOnlyAggregatorCount: number;
  /** Both called it an aggregator but disagreed feed vs. item. */
  readonly feedVsItemDisagreementCount: number;
  readonly confusion: Readonly<Partial<Record<AggregatorConfusionKey, number>>>;
}

export const buildAggregatorShadowAgreement = (
  pairs: readonly { readonly registryType: AggregatorPageType; readonly learnedType: AggregatorPageType }[],
): AggregatorShadowAgreement => {
  let agreementCount = 0;
  let registryOnlyAggregatorCount = 0;
  let learnedOnlyAggregatorCount = 0;
  let feedVsItemDisagreementCount = 0;
  const confusion: Partial<Record<AggregatorConfusionKey, number>> = {};

  for (const { registryType, learnedType } of pairs) {
    const key: AggregatorConfusionKey = `${registryType}->${learnedType}`;
    confusion[key] = (confusion[key] ?? 0) + 1;
    if (registryType === learnedType) {
      agreementCount += 1;
      continue;
    }
    const registryIsAggregator = registryType !== 'not-aggregator';
    const learnedIsAggregator = learnedType !== 'not-aggregator';
    if (registryIsAggregator && !learnedIsAggregator) registryOnlyAggregatorCount += 1;
    else if (!registryIsAggregator && learnedIsAggregator) learnedOnlyAggregatorCount += 1;
    else if (registryIsAggregator && learnedIsAggregator) feedVsItemDisagreementCount += 1;
  }

  const totalClassified = pairs.length;
  return {
    totalClassified,
    agreementCount,
    disagreementCount: totalClassified - agreementCount,
    agreementRate: totalClassified === 0 ? 0 : agreementCount / totalClassified,
    registryOnlyAggregatorCount,
    learnedOnlyAggregatorCount,
    feedVsItemDisagreementCount,
    confusion,
  };
};
