// Attribution v1 — prequential (time-ordered replay) evaluation.
//
// The north-star contract (docs/design/2026-07-13-context-model-north-star.md
// §2 "Evaluation") pins the acceptance test: prequential replay on the
// user-asserted edges only, against the frozen 46% heuristic-vote baseline.
// A challenger ships only after beating it there. This module is that test,
// run READ-ONLY over a vault's event store, offline, without a companion.
//
// PREQUENTIAL DISCIPLINE (test-then-train, no peeking):
//   Walk every event in strict acceptance-time order. Maintain, incrementally,
//   exactly the state each arm needs. At each supervised label:
//     1. SCORE the visit using ONLY state folded from strictly-prior events
//        (assert every arm's state timestamp <= the label's timestamp).
//     2. RECORD top-1 / top-3 hit, abstention, head/tail bucket.
//     3. FOLD the label into every arm's state (train after test).
//   The title-join map is likewise time-gated: a label only sees titles from
//   timeline observations accepted at or before its own acceptance time. This
//   matters — a late title-backfill must not leak into an earlier decision.
//
// ARMS (contract §1 R "retrospective signal arbiter" + the frozen baselines):
//   - v1            : the three-family scorer, WEIGHTED-SUM combiner (scoreVisit).
//   - v1-cascade    : the three-family scorer, ORDERED-CASCADE combiner
//                     (scoreVisitCascade) — the study's title→domain→recency
//                     cascade semantics. Same families, same gate, different
//                     ranking, so v1 vs v1-cascade is a clean combiner A/B.
//   - title-lexical : the PLAIN term-overlap primitive alone (state.ts
//                     plainTitleNearestWorkstream) — the study's 40.0% signal,
//                     and now literally the v1 scorer's own title family, so the
//                     baseline scores the challenger's primitive (no drift).
//   - recency       : last-filed workstream alone (study 38.3%, fires 99.8%).
//   - vote4         : the 4-signal majority vote (study's frozen 46.2%):
//                     title-nearest (shared plain overlap), session-majority,
//                     domain-majority, recency — one vote each, ties broken
//                     deterministically.
//   - majority      : the most-filed-so-far workstream (study 28.9% floor).
//
// All arms replay the SAME label stream in the SAME order and see the SAME
// time-gated title/session/domain history — the only thing that varies is how
// each arm turns that shared state into a prediction. That keeps the arm
// comparison an apples-to-apples measurement of the decision rule, which is
// the whole point of the frozen-baseline test. Both v1 arms and the
// title-lexical arm read the SAME AttributionV1State term index (via the shared
// plainTitleOverlap), so the challenger and its yardstick cannot silently drift.

import {
  BROWSER_TIMELINE_OBSERVED,
  isBrowserTimelineObservedPayload,
} from '../../timeline/events.js';
import { USER_ORGANIZED_ITEM, isUserOrganizedItemPayload } from '../../feedback/events.js';
import type { AcceptedEvent } from '../../sync/causal.js';
import {
  applyOrganizingObservation,
  createEmptyAttributionV1State,
  domainDiscriminativeness,
  domainOfUrl,
  NEUTRAL_DISCRIMINATIVENESS,
  plainTitleNearestWorkstreamSuppressed,
  type AttributionV1State,
} from '../state.js';
import { scoreVisit, scoreVisitCascade, type ScoreVisitOptions } from '../scorer.js';

// ---- shared definitions -----------------------------------------------

export const ATTRIBUTION_PREQUENTIAL_ARMS = [
  'v1',
  'v1-cascade',
  'title-lexical',
  'recency',
  'vote4',
  'majority',
] as const;

export type AttributionPrequentialArm = (typeof ATTRIBUTION_PREQUENTIAL_ARMS)[number];

// Same supervised-label definition as state.ts (the study's 515 usable
// move/promote labels): a canonical-url or visit item moved/promoted into a
// non-empty workstream container.
const SUPERVISED_ITEM_KINDS = new Set<string>(['canonical-url', 'visit']);
const SUPERVISED_ACTIONS = new Set<string>(['move', 'promote']);

// Head/tail boundary — a workstream with >= this many labels is "head". The
// study's 7 head workstreams each cleared 20 labels. Bucketing is a REPORTING
// split computed over the FULL label set (like the study), never a per-visit
// prediction, so using the final counts does not leak into any arm's score.
export const HEAD_WORKSTREAM_LABEL_THRESHOLD = 20;

// A single supervised label pulled from the event stream, with its true
// target and the time-gated title/session/domain the arms may use.
interface PrequentialLabel {
  readonly workstreamId: string;
  readonly canonicalUrl: string;
  readonly atMs: number;
  // Best title known from timeline observations accepted at/before atMs.
  readonly title: string | null;
  // Tab-session known from timeline observations at/before atMs (session arm).
  readonly sessionId: string | null;
  readonly domain: string | null;
}

// ---- per-arm incremental state ----------------------------------------

// The vote / title-lexical / recency / majority arms need cheap incremental
// history that is a strict subset of what the v1 state already tracks, but we
// keep them independent so a bug in one arm can't silently corrupt another's
// measurement (the arms must be genuinely separable). All maps are folded in
// strict time order; nothing here is read before its label's timestamp.
interface SimpleArmState {
  // workstream -> count of labels filed so far (majority + head/tail proxy).
  readonly workstreamLabelCounts: Map<string, number>;
  // domain -> workstream -> asserted count (domain-majority signal). The title
  // signal no longer lives here — it reads the shared AttributionV1State term
  // index via plainTitleOverlap, so the vote's title arm and the scorer's title
  // family are the same primitive.
  readonly domainWorkstreamCounts: Map<string, Map<string, number>>;
  // session -> workstream -> count (session-majority signal).
  readonly sessionWorkstreamCounts: Map<string, Map<string, number>>;
  // last-filed workstream (recency signal).
  lastFiledWorkstreamId: string | null;
  lastFiledAtMs: number | null;
  // the current argmax of workstreamLabelCounts (majority arm), cached.
  majorityWorkstreamId: string | null;
}

const createSimpleArmState = (): SimpleArmState => ({
  workstreamLabelCounts: new Map(),
  domainWorkstreamCounts: new Map(),
  sessionWorkstreamCounts: new Map(),
  lastFiledWorkstreamId: null,
  lastFiledAtMs: null,
  majorityWorkstreamId: null,
});

const incNested = (
  outer: Map<string, Map<string, number>>,
  key: string,
  workstreamId: string,
): void => {
  let inner = outer.get(key);
  if (inner === undefined) {
    inner = new Map();
    outer.set(key, inner);
  }
  inner.set(workstreamId, (inner.get(workstreamId) ?? 0) + 1);
};

// Deterministic argmax over a count map: highest count wins, ties break to the
// lexicographically-smallest workstream id (stable under replay order).
const argmaxWorkstream = (counts: Map<string, number>): string | null => {
  let best: string | null = null;
  let bestCount = 0;
  for (const [workstreamId, count] of counts) {
    if (count > bestCount || (count === bestCount && (best === null || workstreamId < best))) {
      best = workstreamId;
      bestCount = count;
    }
  }
  return best;
};

// Fold a label into the simple arm state (the "train" half of prequential).
const foldSimpleArmState = (state: SimpleArmState, label: PrequentialLabel): void => {
  const prior = state.workstreamLabelCounts.get(label.workstreamId) ?? 0;
  state.workstreamLabelCounts.set(label.workstreamId, prior + 1);
  // Recompute majority only if this label could have changed it.
  const newCount = prior + 1;
  const currentMajorityCount =
    state.majorityWorkstreamId === null
      ? 0
      : (state.workstreamLabelCounts.get(state.majorityWorkstreamId) ?? 0);
  if (
    state.majorityWorkstreamId === null ||
    newCount > currentMajorityCount ||
    (newCount === currentMajorityCount && label.workstreamId < state.majorityWorkstreamId)
  ) {
    state.majorityWorkstreamId = label.workstreamId;
  }

  // NB: the title term index is NOT folded here — the title arms read the
  // shared AttributionV1State (folded separately in the replay loop) so the
  // baseline scores the scorer's own primitive.
  if (label.domain !== null) {
    incNested(state.domainWorkstreamCounts, label.domain, label.workstreamId);
  }
  if (label.sessionId !== null) {
    incNested(state.sessionWorkstreamCounts, label.sessionId, label.workstreamId);
  }
  if (state.lastFiledAtMs === null || label.atMs > state.lastFiledAtMs) {
    state.lastFiledAtMs = label.atMs;
    state.lastFiledWorkstreamId = label.workstreamId;
  }
};

// ---- arm predictions (over prior-only state) --------------------------

// Title-nearest for the vote AND the title-lexical arm: the shared VENUE-
// SUPPRESSED plain term-overlap primitive (state.ts
// plainTitleNearestWorkstreamSuppressed) read against the SAME AttributionV1State
// the v1 scorer uses, with the SAME per-domain brand-term suppression AND the
// SAME below-neutral conditioning (suppress only where the domain's learned
// discriminativeness is below neutral — the hubs). This IS the scorer's title
// family — no separate IDF/BM25 model, no parallel term index — so the frozen
// baseline scores the challenger's own primitive (brand suppression included)
// and the two cannot drift.
const titleNearestWorkstream = (
  state: AttributionV1State,
  title: string | null,
  domain: string | null,
): string | null => {
  const suppressDomain =
    domain !== null &&
    domainDiscriminativeness(state, domain).discriminativeness < NEUTRAL_DISCRIMINATIVENESS
      ? domain
      : null;
  return plainTitleNearestWorkstreamSuppressed(state, title, suppressDomain);
};

// Domain-majority for the vote: the argmax workstream for the visit's domain,
// UNCONDITIONALLY (unlike v1's conditional-domain family, the study's plain
// domain-majority signal votes even on hubs — that is exactly why it only
// reaches 24.3% alone and needs the vote to temper it).
const domainMajorityWorkstream = (state: SimpleArmState, domain: string | null): string | null => {
  if (domain === null) return null;
  const perWs = state.domainWorkstreamCounts.get(domain);
  return perWs === undefined ? null : argmaxWorkstream(perWs);
};

const sessionMajorityWorkstream = (
  state: SimpleArmState,
  sessionId: string | null,
): string | null => {
  if (sessionId === null) return null;
  const perWs = state.sessionWorkstreamCounts.get(sessionId);
  return perWs === undefined ? null : argmaxWorkstream(perWs);
};

// The 4-signal majority vote (study's frozen 46.2% baseline). Each of the four
// signals casts at most one vote for its predicted workstream; the workstream
// with the most votes wins. Ties are broken by the signal-priority order
// title > session > domain > recency (the study's cascade order), then by
// lexicographic id — so the outcome is fully deterministic and reproduces the
// cascade's tendency when the vote is split.
interface Vote4Prediction {
  readonly workstreamId: string | null;
  readonly votes: number;
}

const VOTE4_PRIORITY: readonly ('title' | 'session' | 'domain' | 'recency')[] = [
  'title',
  'session',
  'domain',
  'recency',
];

const vote4Predict = (
  state: SimpleArmState,
  v1State: AttributionV1State,
  label: PrequentialLabel,
): Vote4Prediction => {
  const signals: Record<'title' | 'session' | 'domain' | 'recency', string | null> = {
    // Title uses the SHARED venue-suppressed plain-overlap primitive (the
    // scorer's own family), keyed on the label's domain for brand suppression.
    title: titleNearestWorkstream(v1State, label.title, label.domain),
    session: sessionMajorityWorkstream(state, label.sessionId),
    domain: domainMajorityWorkstream(state, label.domain),
    recency: state.lastFiledWorkstreamId,
  };
  // Tally votes; remember the best signal-priority that voted for each ws.
  const tally = new Map<string, number>();
  const bestPriority = new Map<string, number>();
  VOTE4_PRIORITY.forEach((signal, priorityIndex) => {
    const vote = signals[signal];
    if (vote === null) return;
    tally.set(vote, (tally.get(vote) ?? 0) + 1);
    if (!bestPriority.has(vote)) bestPriority.set(vote, priorityIndex);
  });
  let winner: string | null = null;
  let winnerVotes = 0;
  let winnerPriority = Number.POSITIVE_INFINITY;
  for (const [workstreamId, votes] of tally) {
    const priority = bestPriority.get(workstreamId) ?? Number.POSITIVE_INFINITY;
    if (
      votes > winnerVotes ||
      (votes === winnerVotes && priority < winnerPriority) ||
      (votes === winnerVotes && priority === winnerPriority && (winner === null || workstreamId < winner))
    ) {
      winner = workstreamId;
      winnerVotes = votes;
      winnerPriority = priority;
    }
  }
  return { workstreamId: winner, votes: winnerVotes };
};

// v1 top-k over the current v1 state, for either combiner. Returns the ranked
// workstream ids and whether the scorer abstained (so the abstention arm can be
// measured). `combiner` selects the weighted-sum (scoreVisit) or ordered
// cascade (scoreVisitCascade); `options` lets the harness sweep the evidence
// gate for the tradeoff curve.
interface V1Prediction {
  readonly ranked: readonly string[];
  readonly abstained: boolean;
}

const v1Predict = (
  v1State: AttributionV1State,
  label: PrequentialLabel,
  combiner: 'weighted' | 'cascade',
  options: ScoreVisitOptions = {},
): V1Prediction => {
  const score = combiner === 'cascade' ? scoreVisitCascade : scoreVisit;
  const result = score(
    { title: label.title ?? '', url: label.canonicalUrl, ...(label.domain === null ? {} : { domain: label.domain }) },
    v1State,
    options,
  );
  return {
    ranked: result.candidates.map((candidate) => candidate.workstreamId),
    abstained: result.action === 'abstain' || result.candidates.length === 0,
  };
};

// Title-lexical-alone (the study's frozen 40.0% baseline): "title term-overlap
// → nearest workstream", the PLAIN primitive the study measured standalone.
// This is now LITERALLY the v1 scorer's title family (shared plainTitleOverlap
// over the same AttributionV1State) — the 2026-07-16 iteration replaced the old
// BM25/IDF family with exactly this primitive because it scores 39.6% top-1
// standalone vs the BM25 family's 25.6% on this vault. It is also the same
// title signal the vote uses, so the vote's ~44% is an honest ensemble over the
// same primitive rather than a different, stronger title model.
const titleLexicalAlonePredict = (
  v1State: AttributionV1State,
  label: PrequentialLabel,
): string | null => titleNearestWorkstream(v1State, label.title, label.domain);

// ---- metrics ----------------------------------------------------------

export interface ArmMetrics {
  readonly arm: AttributionPrequentialArm;
  // Fraction of ALL labels where the arm's top-1 == the true workstream.
  readonly top1: number;
  // Fraction where the true workstream is in the arm's top-3.
  readonly top3: number;
  // top-1 restricted to head-workstream labels (>= threshold labels).
  readonly head: number;
  // top-1 restricted to tail-workstream labels.
  readonly tail: number;
  // Fraction of labels where the arm produced NO prediction (abstained).
  readonly abstainRate: number;
  // Precision when suggesting: of the labels where the arm DID predict, the
  // fraction it got right. This is the abstention-first number that matters.
  readonly precisionWhenSuggesting: number;
  // Raw tallies for auditability.
  readonly labelCount: number;
  readonly top1Hits: number;
  readonly top3Hits: number;
  readonly abstentions: number;
  readonly headLabelCount: number;
  readonly tailLabelCount: number;
}

// Per-arm running tallies during replay.
interface ArmTally {
  top1Hits: number;
  top3Hits: number;
  abstentions: number;
  headLabels: number;
  tailLabels: number;
  headTop1Hits: number;
  tailTop1Hits: number;
}

const createArmTally = (): ArmTally => ({
  top1Hits: 0,
  top3Hits: 0,
  abstentions: 0,
  headLabels: 0,
  tailLabels: 0,
  headTop1Hits: 0,
  tailTop1Hits: 0,
});

const finalizeArm = (
  arm: AttributionPrequentialArm,
  tally: ArmTally,
  labelCount: number,
): ArmMetrics => {
  const suggested = labelCount - tally.abstentions;
  return {
    arm,
    top1: labelCount === 0 ? 0 : tally.top1Hits / labelCount,
    top3: labelCount === 0 ? 0 : tally.top3Hits / labelCount,
    head: tally.headLabels === 0 ? 0 : tally.headTop1Hits / tally.headLabels,
    tail: tally.tailLabels === 0 ? 0 : tally.tailTop1Hits / tally.tailLabels,
    abstainRate: labelCount === 0 ? 0 : tally.abstentions / labelCount,
    precisionWhenSuggesting: suggested === 0 ? 0 : tally.top1Hits / suggested,
    labelCount,
    top1Hits: tally.top1Hits,
    top3Hits: tally.top3Hits,
    abstentions: tally.abstentions,
    headLabelCount: tally.headLabels,
    tailLabelCount: tally.tailLabels,
  };
};

// ---- label extraction (time-ordered, title/session-joined) ------------

interface RawLabel {
  readonly workstreamId: string;
  readonly canonicalUrl: string;
  readonly atMs: number;
}

const parseSupervisedLabel = (event: AcceptedEvent): RawLabel | null => {
  if (event.type !== USER_ORGANIZED_ITEM || !isUserOrganizedItemPayload(event.payload)) return null;
  const p = event.payload;
  if (!SUPERVISED_ITEM_KINDS.has(p.itemKind) || !SUPERVISED_ACTIONS.has(p.action)) return null;
  if (typeof p.toContainer !== 'string' || p.toContainer.length === 0) return null;
  if (p.itemId.length === 0) return null;
  return { workstreamId: p.toContainer, canonicalUrl: p.itemId, atMs: event.acceptedAtMs };
};

// Stable acceptance-time order. Ties (equal acceptedAtMs) break on replica id
// then seq so the replay is fully deterministic and matches the accepted
// causal order the drain path uses.
const byAcceptanceTime = (a: AcceptedEvent, b: AcceptedEvent): number =>
  a.acceptedAtMs - b.acceptedAtMs ||
  (a.dot.replicaId < b.dot.replicaId ? -1 : a.dot.replicaId > b.dot.replicaId ? 1 : 0) ||
  a.dot.seq - b.dot.seq;

// ---- the replay -------------------------------------------------------

export interface PrequentialReport {
  readonly labelCount: number;
  readonly distinctWorkstreamCount: number;
  readonly headWorkstreamCount: number;
  readonly tailWorkstreamCount: number;
  readonly arms: readonly ArmMetrics[];
  // Convenience: the head/tail label totals (same across arms).
  readonly headLabelCount: number;
  readonly tailLabelCount: number;
}

// Options for the replay. `v1MinSuggestScore` overrides the scorer's evidence
// gate for BOTH v1 arms — the CLI sweeps it to report the abstention/precision
// tradeoff curve; the default run uses the shipping constant.
export interface RunPrequentialOptions {
  readonly v1MinSuggestScore?: number;
}

// Run the full prequential replay. `events` is the raw (any-order) event
// slice; we sort a shallow copy by acceptance time here so callers can pass
// the store's replica-ordered read directly.
export const runAttributionPrequential = (
  events: readonly AcceptedEvent[],
  options: RunPrequentialOptions = {},
): PrequentialReport => {
  const v1Options: ScoreVisitOptions =
    options.v1MinSuggestScore === undefined ? {} : { minSuggestScore: options.v1MinSuggestScore };
  const ordered = [...events].sort(byAcceptanceTime);

  // First pass over timeline events builds NOTHING ahead of time — we advance
  // a timeline cursor in lockstep with the label walk so title/session joins
  // are strictly time-gated. Collect timeline observations (already ordered)
  // and label events separately.
  const timeline: { atMs: number; url: string; title: string | null; sessionId: string | null }[] = [];
  const labels: RawLabel[] = [];
  for (const event of ordered) {
    if (event.type === BROWSER_TIMELINE_OBSERVED && isBrowserTimelineObservedPayload(event.payload)) {
      const p = event.payload;
      const url = p.canonicalUrl !== undefined && p.canonicalUrl.length > 0 ? p.canonicalUrl : p.url;
      if (url.length === 0) continue;
      timeline.push({
        atMs: event.acceptedAtMs,
        url,
        title: p.title !== undefined && p.title.length > 0 ? p.title : null,
        sessionId: p.tabSessionId !== undefined && p.tabSessionId.length > 0 ? p.tabSessionId : null,
      });
      continue;
    }
    const label = parseSupervisedLabel(event);
    if (label !== null) labels.push(label);
  }

  // Head/tail membership: computed from the FINAL per-workstream label totals
  // over the whole replayed set (a reporting split, not a decision input).
  const finalCounts = new Map<string, number>();
  for (const label of labels) {
    finalCounts.set(label.workstreamId, (finalCounts.get(label.workstreamId) ?? 0) + 1);
  }
  const headWorkstreams = new Set<string>();
  for (const [workstreamId, count] of finalCounts) {
    if (count >= HEAD_WORKSTREAM_LABEL_THRESHOLD) headWorkstreams.add(workstreamId);
  }

  // Incremental state per arm. v1 uses the real AttributionV1State so the arm
  // is byte-for-byte the shipping scorer; the simpler arms share one folded
  // SimpleArmState (their signals are disjoint reads of it).
  const v1State = createEmptyAttributionV1State();
  const simple = createSimpleArmState();

  // Time-gated title/session join: a growing cursor over the timeline array.
  // We keep the FIRST non-empty title/session per url observed at/before the
  // current label's time (mirrors buildTitleIndex's "earliest wins", but with
  // the no-peeking time bound the offline artifact build does not need).
  const titleByUrl = new Map<string, string>();
  const sessionByUrl = new Map<string, string>();
  let timelineCursor = 0;

  const tallies: Record<AttributionPrequentialArm, ArmTally> = {
    v1: createArmTally(),
    'v1-cascade': createArmTally(),
    'title-lexical': createArmTally(),
    recency: createArmTally(),
    vote4: createArmTally(),
    majority: createArmTally(),
  };

  const scoreArm = (
    arm: AttributionPrequentialArm,
    label: PrequentialLabel,
    ranked: readonly string[],
    isHead: boolean,
  ): void => {
    const tally = tallies[arm];
    if (isHead) tally.headLabels += 1;
    else tally.tailLabels += 1;
    if (ranked.length === 0) {
      tally.abstentions += 1;
      return;
    }
    const top1 = ranked[0] === label.workstreamId;
    const top3 = ranked.slice(0, 3).includes(label.workstreamId);
    if (top1) {
      tally.top1Hits += 1;
      if (isHead) tally.headTop1Hits += 1;
      else tally.tailTop1Hits += 1;
    }
    if (top3) tally.top3Hits += 1;
  };

  for (const raw of labels) {
    // Advance the timeline cursor to include every observation accepted
    // strictly at/before this label's acceptance time — the no-peeking bound.
    while (timelineCursor < timeline.length && timeline[timelineCursor]!.atMs <= raw.atMs) {
      const obs = timeline[timelineCursor]!;
      if (obs.title !== null && !titleByUrl.has(obs.url)) titleByUrl.set(obs.url, obs.title);
      if (obs.sessionId !== null && !sessionByUrl.has(obs.url)) sessionByUrl.set(obs.url, obs.sessionId);
      timelineCursor += 1;
    }

    const label: PrequentialLabel = {
      workstreamId: raw.workstreamId,
      canonicalUrl: raw.canonicalUrl,
      atMs: raw.atMs,
      title: titleByUrl.get(raw.canonicalUrl) ?? null,
      sessionId: sessionByUrl.get(raw.canonicalUrl) ?? null,
      domain: domainOfUrl(raw.canonicalUrl),
    };

    // NO PEEKING assertion: every arm's newest folded state must predate (or
    // equal) this label's timestamp. If a fold ever ran ahead, the replay is
    // invalid — fail loudly rather than report a leaked number.
    if (v1State.lastFiledAtMs !== null && v1State.lastFiledAtMs > label.atMs) {
      throw new Error(
        `prequential no-peeking violation: v1 state time ${String(v1State.lastFiledAtMs)} > label time ${String(label.atMs)}`,
      );
    }
    if (simple.lastFiledAtMs !== null && simple.lastFiledAtMs > label.atMs) {
      throw new Error(
        `prequential no-peeking violation: simple state time ${String(simple.lastFiledAtMs)} > label time ${String(label.atMs)}`,
      );
    }

    const isHead = headWorkstreams.has(label.workstreamId);

    // --- test (predict from prior-only state) ---
    const v1 = v1Predict(v1State, label, 'weighted', v1Options);
    scoreArm('v1', label, v1.ranked, isHead);

    const v1Cascade = v1Predict(v1State, label, 'cascade', v1Options);
    scoreArm('v1-cascade', label, v1Cascade.ranked, isHead);

    const titleLexical = titleLexicalAlonePredict(v1State, label);
    scoreArm('title-lexical', label, titleLexical === null ? [] : [titleLexical], isHead);

    const recency = simple.lastFiledWorkstreamId;
    scoreArm('recency', label, recency === null ? [] : [recency], isHead);

    const vote = vote4Predict(simple, v1State, label);
    scoreArm('vote4', label, vote.workstreamId === null ? [] : [vote.workstreamId], isHead);

    const majority = simple.majorityWorkstreamId;
    scoreArm('majority', label, majority === null ? [] : [majority], isHead);

    // --- train (fold the label into every arm's state) ---
    applyOrganizingObservation(v1State, {
      workstreamId: label.workstreamId,
      canonicalUrl: label.canonicalUrl,
      ...(label.title === null ? {} : { title: label.title }),
      atMs: label.atMs,
      provenance: 'asserted',
    });
    foldSimpleArmState(simple, label);
  }

  const headLabelCount = tallies.v1.headLabels;
  const tailLabelCount = tallies.v1.tailLabels;

  const arms = ATTRIBUTION_PREQUENTIAL_ARMS.map((arm) =>
    finalizeArm(arm, tallies[arm], labels.length),
  );

  return {
    labelCount: labels.length,
    distinctWorkstreamCount: finalCounts.size,
    headWorkstreamCount: headWorkstreams.size,
    tailWorkstreamCount: finalCounts.size - headWorkstreams.size,
    arms,
    headLabelCount,
    tailLabelCount,
  };
};

// ---- threshold curve (evidence-gate tradeoff) -------------------------

// One point on the abstention/precision tradeoff curve for a v1 combiner: at a
// given MIN_SUGGEST_SCORE, how often it abstains, and — of the times it does
// suggest — how precise it is (plus raw top-1 over all labels for context).
export interface ThresholdCurvePoint {
  readonly minSuggestScore: number;
  readonly top1: number;
  readonly abstainRate: number;
  readonly precisionWhenSuggesting: number;
}

// The candidate thresholds the north-star's abstention-first calibration is
// judged on. 0 = gate effectively off (raw combiner top-1, ~no abstention);
// the higher points progressively trade coverage for precision. Reported at 3–4
// points per the task; MIN_SUGGEST_SCORE is chosen from this curve.
export const THRESHOLD_CURVE_POINTS: readonly number[] = [0, 1, 3, 6];

// Re-run the replay once per candidate threshold and pull the v1 (weighted-sum)
// arm's tradeoff at each. Cheap: the replay is O(labels × workstreams) and the
// vault has ~492 labels × 33 workstreams. Used by the CLI to print the curve.
export const runV1ThresholdCurve = (
  events: readonly AcceptedEvent[],
  thresholds: readonly number[] = THRESHOLD_CURVE_POINTS,
): readonly ThresholdCurvePoint[] =>
  thresholds.map((minSuggestScore) => {
    const report = runAttributionPrequential(events, { v1MinSuggestScore: minSuggestScore });
    const v1 = report.arms.find((a) => a.arm === 'v1');
    return {
      minSuggestScore,
      top1: v1?.top1 ?? 0,
      abstainRate: v1?.abstainRate ?? 0,
      precisionWhenSuggesting: v1?.precisionWhenSuggesting ?? 0,
    };
  });

// ---- verdict ----------------------------------------------------------

export type PrequentialVerdictLabel = 'beats-baseline' | 'matches-baseline-better-abstention' | 'loses';

export interface PrequentialVerdict {
  readonly verdict: PrequentialVerdictLabel;
  readonly rationale: string;
  // The two arms the rule compares.
  readonly v1Top1: number;
  readonly voteTop1: number;
  readonly v1PrecisionWhenSuggesting: number;
  readonly v1AbstainRate: number;
}

// Verdict rule (task spec):
//   beats-baseline if v1 top1 > vote top1 by >= 2pts
//     OR (within 2pts AND precision-when-suggesting >= 60%
//         with abstainRate consistent with the ~80% never-organized base rate);
//   loses otherwise.
// The "matches-baseline-better-abstention" label is the within-2pts branch: v1
// does not clearly beat the vote on raw top-1 but earns its keep by suggesting
// far less often at higher precision — the abstention-first win the north-star
// asks for. We treat abstainRate as "consistent with the base rate" when it is
// meaningfully non-trivial (>= 40%): the owner leaves ~80% of URLs unfiled, so
// an abstention-first scorer SHOULD decline often; a near-zero abstain rate
// would mean the gate is not doing its job.
export const ABSTENTION_BASE_RATE_FLOOR = 0.4;
export const PRECISION_WHEN_SUGGESTING_FLOOR = 0.6;
export const TOP1_BEAT_MARGIN = 0.02;

export const buildPrequentialVerdict = (report: PrequentialReport): PrequentialVerdict => {
  const v1 = report.arms.find((a) => a.arm === 'v1');
  const vote = report.arms.find((a) => a.arm === 'vote4');
  if (v1 === undefined || vote === undefined) {
    return {
      verdict: 'loses',
      rationale: 'v1 or vote4 arm missing from the report',
      v1Top1: 0,
      voteTop1: 0,
      v1PrecisionWhenSuggesting: 0,
      v1AbstainRate: 0,
    };
  }
  const delta = v1.top1 - vote.top1;
  const base = {
    v1Top1: v1.top1,
    voteTop1: vote.top1,
    v1PrecisionWhenSuggesting: v1.precisionWhenSuggesting,
    v1AbstainRate: v1.abstainRate,
  };
  if (delta >= TOP1_BEAT_MARGIN) {
    return {
      verdict: 'beats-baseline',
      rationale: `v1 top-1 ${(v1.top1 * 100).toFixed(1)}% beats vote ${(vote.top1 * 100).toFixed(1)}% by ${(delta * 100).toFixed(1)}pts (>= 2pts)`,
      ...base,
    };
  }
  const withinMargin = Math.abs(delta) < TOP1_BEAT_MARGIN;
  if (
    withinMargin &&
    v1.precisionWhenSuggesting >= PRECISION_WHEN_SUGGESTING_FLOOR &&
    v1.abstainRate >= ABSTENTION_BASE_RATE_FLOOR
  ) {
    return {
      verdict: 'matches-baseline-better-abstention',
      rationale: `v1 top-1 within ${(TOP1_BEAT_MARGIN * 100).toFixed(0)}pts of vote, but precision-when-suggesting ${(v1.precisionWhenSuggesting * 100).toFixed(1)}% >= 60% at abstain rate ${(v1.abstainRate * 100).toFixed(1)}% (base-rate consistent)`,
      ...base,
    };
  }
  return {
    verdict: 'loses',
    rationale: `v1 top-1 ${(v1.top1 * 100).toFixed(1)}% vs vote ${(vote.top1 * 100).toFixed(1)}% (Δ${(delta * 100).toFixed(1)}pts); precision-when-suggesting ${(v1.precisionWhenSuggesting * 100).toFixed(1)}%, abstain ${(v1.abstainRate * 100).toFixed(1)}% — did not clear the abstention-first bar`,
    ...base,
  };
};
