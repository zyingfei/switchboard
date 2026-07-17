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

// Cross-workstream inverse document frequency for a term. Smoothed IDF over
// the workstream count: terms in most workstreams (venues/hubs) approach 0.
// idf = ln(1 + (W - df + 0.5) / (df + 0.5)) where W = workstream count,
// df = number of workstreams carrying the term. This BM25-style form is
// always positive and monotone-decreasing in df.
export const termIdf = (state: AttributionV1State, term: string): number => {
  const totalWorkstreams = state.workstreams.size;
  if (totalWorkstreams === 0) return 0;
  const df = state.globalTermWorkstreamFreq.get(term) ?? 0;
  return Math.log(1 + (totalWorkstreams - df + 0.5) / (df + 0.5));
};

// Average member-title document length (in distinct-term count) across all
// workstreams — the BM25 length-normalization base. Falls back to 1 when no
// members have been folded yet.
export const averageMemberTermCount = (state: AttributionV1State): number => {
  if (state.totalMemberCount === 0) return 1;
  let totalTerms = 0;
  for (const stats of state.workstreams.values()) {
    for (const count of stats.termDocFreq.values()) totalTerms += count;
  }
  return totalTerms / state.totalMemberCount;
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
