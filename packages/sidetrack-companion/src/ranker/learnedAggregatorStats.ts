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
// cadence, title churn across captures, and same-domain outlink fan-out. No
// domain list, no URL-shape special-casing.
//
// SHADOW ONLY. This module does not change any serving decision. It is
// wired into system/workGraphHealth.ts as an observe-only diagnostic that
// measures how often the learned classifier agrees with the registry. The
// registry keeps deciding for candidates.ts and tabsession/similarity.ts.
// See docs/plans/2026-08-15-foundation-program.md's "Learned per-node
// aggregator stats — design note (2026-08-16)" for the full design
// rationale, the false-friend history this must not weaken, and the
// thresholds' reasoning.
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
}

interface MutableDomainCounters {
  distinctUrlCount: number;
  firstPathSegmentCounts: Map<string, number>;
  maxQualifyingOutlinkFanout: number;
  hubCandidateCount: number;
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

    if (observation.title !== undefined && observation.title.length > 0) {
      const normalized = normalizeTitle(observation.title);
      url.captureCount += 1;
      if (url.lastTitleNormalized !== null && url.lastTitleNormalized !== normalized) {
        url.titleChangeCount += 1;
      }
      url.lastTitleNormalized = normalized;
      this.refreshHubCandidacy(observation.canonicalUrl, url);
    }

    if (observation.openerCanonicalUrl !== undefined) {
      this.recordOutlink(observation.openerCanonicalUrl, observation.canonicalUrl, observation.observedAtMs);
    }
    if (observation.previousCanonicalUrl !== undefined) {
      this.recordOutlink(observation.previousCanonicalUrl, observation.canonicalUrl, observation.observedAtMs);
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

/** Domain qualifies as a hub — replaces isAggregatorHost. Conservative:
 * insufficient evidence (few distinct URLs, no qualifying fan-out) means
 * 'not-aggregator', matching the registry's default for anything it
 * doesn't list. */
export const isLearnedAggregatorHost = (state: AggregatorStatsState, hostname: string): boolean => {
  const domain = registrableDomainOf(hostname);
  const counters = state.domainStats(domain);
  if (counters === undefined) return false;
  return (
    counters.distinctUrlCount >= MIN_DOMAIN_URLS_FOR_HUB &&
    counters.maxQualifyingOutlinkFanout >= MIN_HUB_FANOUT
  );
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

  // Hub domain, ambiguous URL, no positive item evidence: conservative
  // default (binding).
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
