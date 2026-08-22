// W5 — topic production revival + parity instrumentation.
//
// ROOT CAUSE (diagnosed against two real vault copies — see the landing
// note): the SERVED topic producer (leiden-cpm, connectionsMaterializer.ts's
// `servedProducer === 'leiden-cpm'` branch) builds its revision from
// `topicVisitsForBuild`, which — unless `SIDETRACK_CONNECTIONS_TOPIC_FULL_TIMELINE`
// is set — is derived ONLY from the current drain's delta window
// (`timelineDays`, built from `readMergedSince(appliedFrontier)`), not the
// full corpus. `visitSimilarity` itself is already window-INDEPENDENT (the
// W1/M3 full-corpus lane, default on), so a late-arriving signal (the
// classic "window poverty" class this repo has fixed for similarity,
// search-index joins, and the workstream tree — see F8 W1-W4) can change
// `visitSimilarity.revisionId` (e.g. a late ENGAGEMENT_SESSION_AGGREGATED
// requalifying an OLD visit) WITHOUT that visit's original timeline entry
// being part of THIS drain's window. When that coincides with the topic
// cadence being due, `buildLeidenCpmTopicRevision` runs with a visits list
// that can be empty (or missing previously-clustered members), producing
// zero (or far fewer) topics — and `assembleTopicRevisionFromGroups` marks
// every previously-active topic 'death'. The result is written to the
// active slot UNCONDITIONALLY (connectionsMaterializer.ts:~6249), wiping
// the served topic count. Confirmed empirically: both
// ~/.sidetrack-vault/_BAC/connections/topics/current.json and
// ~/.sidetrack-vault-test/_BAC/connections/topics/current.json hold
// zero-topic revisions whose ENTIRE lineage is 'death' entries, each dated
// to a single collapse event — not ongoing churn. The incremental shadow
// (topicIncrementalShadowEnabled) refines OFF the leiden-cpm candidate
// slot, so once that collapsed, the shadow inherited emptiness too (the
// "no-leiden-base" / cache-hit path in connectionsMaterializer.ts serves a
// revision with nothing to refine).
//
// `SIDETRACK_CONNECTIONS_TOPIC_FULL_TIMELINE` already exists inside the
// protected file (connectionsMaterializer.ts) as a documented remedy — a
// cadence-due recompute re-derives the visit set from the FULL event log
// instead of the drain-local window — and it defaults OFF, unlike its
// similarity-layer sibling (`SIDETRACK_SIMILARITY_FULL_CORPUS`, default ON).
//
// TRIED AND REVERTED, not shipped here: an earlier version of this module
// flipped that flag's DEFAULT to on from outside the protected file (a
// bootstrap seam, same posture as drainIdleGate.ts's F9 fix). CI caught a
// real regression before merge, reproduced deterministically (NOT flaky —
// `bun test src/runtime/companion.test.ts src/sync/contract
// /connectionsMaterializer.contentLane.test.ts` fails every time in that
// order, passes every time with the content-lane file alone):
// `topicRecomputeImminent` inside the protected file is unconditionally
// true whenever `previousTopicRevision === null` — i.e. on EVERY fresh
// materializer's first-ever drain, not only cadence-triggered topic
// rebuilds — so flipping the flag added a redundant, extra
// `deps.eventLog.readMerged()` full-log read to every cold boot / every
// freshly-constructed materializer instance. That is exactly the "backlog
// scan" the W7 dirty-source-queue design (`connectionsMaterializer
// .contentLane.test.ts`, "defers content-lane progress accepted during a
// graph drain without a backlog scan") asserts never happens on a
// content-lane-only drain. There is no lever available from outside the
// protected file to scope the flag's effect to "cadence-triggered only,
// not first-drain" — the OR-with-null-previous-revision condition is
// internal to `topicRecomputeImminent`. Since the collapse guard below
// (proven sufficient on its own — see the e2e suite's "backstop" test and
// the real-vault-copy validation in the landing note) already meets the
// task's acceptance bar without touching this flag's default at all, the
// safer choice is to leave it at its pre-existing default and rely solely
// on the guard. An operator who wants the full-timeline behavior can still
// set `SIDETRACK_CONNECTIONS_TOPIC_FULL_TIMELINE=1` by hand, consciously
// accepting the extra read cost on every drain that recomputes. One more
// reason not to lean on it as the primary fix: it reads
// `deps.eventLog.readMerged()`, which walks `_BAC/log` only — a day
// retired by F2's hot-tail retirement (moved to `_BAC/retired/log/...`,
// docs/plans/2026-08-15-foundation-program.md) is silently absent from
// that read, so "full timeline" would mean "the full CURRENTLY-RETAINED
// timeline" post-F2, not true full history.
//
// This module wraps the injectable `TopicRevisionStore` dependency
// (`deps.topicRevisionStore` — already an optional seam in
// createConnectionsMaterializer) with two behaviors, both OUTSIDE the
// protected file:
//
//   1. Collapse guard — refuses to let a leiden-cpm build silently wipe a
//      populated active revision to zero topics. Stateless (compares the
//      incoming write against whatever `readActiveRevision()` returns right
//      now), so it "auto-resets" the moment a healthy build succeeds — there
//      is no persisted latch to get stuck. This mirrors the existing
//      `simFloorSuppressedCollapse` idiom this codebase already uses for
//      similarity edges (materializerDiagnostics.ts / similarityFloorState.ts).
//      KNOWN LIMITATION: this suppresses the DISK pointer flip (current.json
//      keeps pointing at the last healthy revision, which is what
//      workGraphHealth's topicProducer and every store read consume), but it
//      cannot retroactively fix the in-memory `servedTopicRevision` object
//      connectionsMaterializer.ts already computed for THIS ONE drain's
//      snapshot render (visit_in_topic edges) — that is only reachable by
//      editing the protected file. In practice this is a narrow, self-
//      correcting blip (the next successful cadence re-renders it), not the
//      permanent wipe this module fixes.
//   2. Audible per-cycle parity marks — `[topic.cycle] producer=leiden|incremental
//      topics=N members=M churn=...` on every write to the leiden-cpm active
//      slot and the incremental-shadow candidate slot, so both producers'
//      churn accumulates in the log stream the same way (the parity
//      instrument the W5 shadow was always supposed to produce).
//   3. (post-#404 follow-up) STATE CARRY for the incremental shadow lane —
//      when `options.stateCarry` is wired (all four production
//      composition roots do), the incremental candidate-shadow read
//      serves the carried, persisted state (topicIncrementalStateCarry.ts)
//      instead of the raw slot, and the write folds each cycle's output
//      into that state with a membership change-gate and collapse-guard
//      semantics. The `[topic.cycle] producer=incremental` mark gains
//      `carried= priorTopics= priorMembers= delta= partial=
//      collapse-suspect= action=` fields. See that module's header for
//      the measured root cause (sticky-empty prior + fork-per-drain
//      statelessness) and the W7 argument (no event-log reads at all).

import {
  TOPIC_INCREMENTAL_REVISION_KEY,
  TOPIC_LEIDEN_CPM_REVISION_KEY,
  type TopicRevision,
  type TopicRevisionStore,
} from '../producers/topic-revision.js';
import { buildServedTopicProducerReport } from './servedTopicProducer.js';
import type {
  IncrementalTopicStateCarry,
  IncrementalTopicStateSeedSource,
} from './topicIncrementalStateCarry.js';

// Referenced only in the collapse-suppressed log line below (an
// informational pointer to the manual escape hatch) — see the module
// header's "TRIED AND REVERTED" note for why this module does not flip
// the flag's default itself.
export const TOPIC_FULL_TIMELINE_ENV = 'SIDETRACK_CONNECTIONS_TOPIC_FULL_TIMELINE';

const memberCount = (revision: TopicRevision): number =>
  revision.topics.reduce((sum, topic) => sum + topic.memberCanonicalUrls.length, 0);

const formatChurn = (churnP50: number | null, churnP90: number | null): string =>
  `p50:${churnP50 === null ? 'n/a' : String(churnP50)},p90:${churnP90 === null ? 'n/a' : String(churnP90)}`;

export interface TopicProductionGuardOptions {
  /** Test seam — swap in a spy instead of console.warn. */
  readonly log?: (line: string) => void;
  /**
   * State carry for the incremental shadow lane (see
   * topicIncrementalStateCarry.ts's header). When present, the
   * incremental candidate-shadow READ serves the carried state (an empty
   * persisted slot is treated as absent, with a cycle-legit seed
   * fallback: legacy slot, then the served active revision — never a
   * backlog scan), and the incremental candidate-shadow WRITE folds each
   * cycle's output into the carried state (adopt / update / cursor-only
   * / collapse-suspect), emitting the extended `[topic.cycle]` parity
   * mark (carried= priorTopics= priorMembers= delta= partial=
   * collapse-suspect=). Omitted (existing tests / bespoke tooling): the
   * pre-state-carry behavior is byte-identical.
   */
  readonly stateCarry?: IncrementalTopicStateCarry;
}

/**
 * Wrap a `TopicRevisionStore` so it can be injected via
 * `createConnectionsMaterializer({ ..., topicRevisionStore })` (an existing
 * optional seam — connectionsMaterializer.ts falls back to
 * `createTopicRevisionStore(deps.vaultRoot)` when omitted). See module
 * header for the collapse-guard + parity-mark behavior this adds.
 */
export const wrapTopicRevisionStoreForProduction = (
  inner: TopicRevisionStore,
  options: TopicProductionGuardOptions = {},
): TopicRevisionStore => {
  const log = options.log ?? ((line: string) => console.warn(line));
  const stateCarry = options.stateCarry;

  // What the incremental read path last served as the shadow's prior —
  // the same value the materializer used as `previousRevision` for this
  // cycle's build, so the parity mark's churn is computed against the
  // ACTUAL base, not whatever happens to be in the legacy slot. Seed
  // marks are logged once per (process, source) — production drains are
  // fork-per-drain children, so this is at most one line per drain
  // during the bootstrap window.
  let lastIncrementalPrior: TopicRevision | null = null;
  let lastIncrementalSeedSource: IncrementalTopicStateSeedSource = 'none';
  let lastIncrementalReadDone = false;
  const seedSourcesLogged = new Set<string>();

  const canSeedIncrementalFrom = (revision: TopicRevision): boolean =>
    revision.topics.length > 0 &&
    (revision.algorithmVersion === TOPIC_LEIDEN_CPM_REVISION_KEY ||
      revision.algorithmVersion === TOPIC_INCREMENTAL_REVISION_KEY);

  const readIncrementalPrior = async (): Promise<TopicRevision | null> => {
    if (stateCarry === undefined) {
      return inner.readCandidateShadowRevision(TOPIC_INCREMENTAL_REVISION_KEY);
    }
    const carried = await stateCarry.readCarriedRevision();
    if (carried !== null) {
      lastIncrementalPrior = carried;
      lastIncrementalSeedSource = 'state';
      lastIncrementalReadDone = true;
      return carried;
    }
    // No carried state yet — seed from the first populated cycle-legit
    // artifact. An EMPTY legacy slot is treated as absent (the
    // sticky-empty trap this module kills); the served active revision
    // is only a valid refinement base when it is leiden-built (or a
    // prior incremental) — never a foreign producer's clustering.
    const legacy = await inner.readCandidateShadowRevision(TOPIC_INCREMENTAL_REVISION_KEY);
    if (legacy !== null && canSeedIncrementalFrom(legacy)) {
      if (!seedSourcesLogged.has('legacy-slot')) {
        seedSourcesLogged.add('legacy-slot');
        log(
          `[topic.state] seed base=legacy-slot topics=${String(legacy.topics.length)} ` +
            `revision=${legacy.revisionId}`,
        );
      }
      lastIncrementalPrior = legacy;
      lastIncrementalSeedSource = 'legacy-slot';
      lastIncrementalReadDone = true;
      return legacy;
    }
    const active = await inner.readActiveRevision();
    if (active !== null && canSeedIncrementalFrom(active)) {
      if (!seedSourcesLogged.has('active-leiden')) {
        seedSourcesLogged.add('active-leiden');
        log(
          `[topic.state] seed base=active-leiden topics=${String(active.topics.length)} ` +
            `revision=${active.revisionId}`,
        );
      }
      lastIncrementalPrior = active;
      lastIncrementalSeedSource = 'active-leiden';
      lastIncrementalReadDone = true;
      return active;
    }
    lastIncrementalPrior = null;
    lastIncrementalSeedSource = 'none';
    lastIncrementalReadDone = true;
    return null;
  };

  const readCandidateShadowRevision = async (
    candidate: string,
  ): Promise<TopicRevision | null> => {
    if (candidate !== TOPIC_INCREMENTAL_REVISION_KEY || stateCarry === undefined) {
      return inner.readCandidateShadowRevision(candidate);
    }
    return readIncrementalPrior();
  };

  const putActiveRevision = async (revision: TopicRevision): Promise<void> => {
    if (revision.algorithmVersion !== TOPIC_LEIDEN_CPM_REVISION_KEY) {
      await inner.putActiveRevision(revision);
      return;
    }
    const previous = await inner.readActiveRevision();
    const report = buildServedTopicProducerReport('leiden-cpm', revision, previous);
    log(
      `[topic.cycle] producer=leiden topics=${String(revision.topics.length)} ` +
        `members=${String(memberCount(revision))} churn=${formatChurn(report.churnP50, report.churnP90)} ` +
        `revision=${revision.revisionId}`,
    );
    const collapsed =
      previous !== null && previous.topics.length > 0 && revision.topics.length === 0;
    if (collapsed) {
      log(
        `[topic.collapse-suppressed] producer=leiden previousTopics=${String(previous.topics.length)} ` +
          `keepingActive=${previous.revisionId} suppressedRevision=${revision.revisionId} ` +
          `visitSimilarityRevisionId=${revision.visitSimilarityRevisionId} ` +
          `(recovers on the next non-window-poor cadence; manual escape hatch ` +
          `${TOPIC_FULL_TIMELINE_ENV}=1 trades extra full-log reads for immediacy ` +
          `— see topicProductionRevival.ts)`,
      );
      // Persist the built (empty) revision for audit/lineage continuity —
      // just don't move the active pointer. Stateless: the very next
      // healthy write goes through the `!collapsed` branch below with no
      // reset required.
      await inner.putRevision(revision);
      return;
    }
    await inner.putActiveRevision(revision);
  };

  const putCandidateShadowRevision = async (
    candidate: string,
    revision: TopicRevision,
  ): Promise<void> => {
    if (candidate !== TOPIC_INCREMENTAL_REVISION_KEY) {
      await inner.putCandidateShadowRevision(candidate, revision);
      return;
    }
    if (stateCarry === undefined) {
      // Pre-state-carry behavior, byte-identical (tests / bespoke tooling
      // that wrap without a carry).
      const previous = await inner.readCandidateShadowRevision(candidate);
      const report = buildServedTopicProducerReport('leiden-cpm', revision, previous);
      log(
        `[topic.cycle] producer=incremental topics=${String(revision.topics.length)} ` +
          `members=${String(memberCount(revision))} churn=${formatChurn(report.churnP50, report.churnP90)} ` +
          `revision=${revision.revisionId}`,
      );
      await inner.putCandidateShadowRevision(candidate, revision);
      return;
    }
    // Churn vs the ACTUAL prior this cycle's build refined from (the
    // value the read path served); fall back to a fresh read when the
    // caller wrote without reading first (bespoke tooling).
    const previous = lastIncrementalReadDone ? lastIncrementalPrior : await readIncrementalPrior();
    const seedSource = lastIncrementalSeedSource;
    // Consume the memo: the next cycle's put must not reuse this cycle's
    // prior if the caller skips the read (the carry itself stays fresh).
    lastIncrementalReadDone = false;
    const report = buildServedTopicProducerReport('leiden-cpm', revision, previous);
    const active = await inner.readActiveRevision();
    const decision = await stateCarry.recordCycleResult(revision, {
      activeRevision: active,
      seedSource,
    });
    log(
      `[topic.cycle] producer=incremental topics=${String(revision.topics.length)} ` +
        `members=${String(memberCount(revision))} churn=${formatChurn(report.churnP50, report.churnP90)} ` +
        `carried=${String(decision.carried)} priorTopics=${String(decision.priorTopicCount)} ` +
        `priorMembers=${String(decision.priorMemberCount)} delta=${String(decision.membershipDelta)} ` +
        `partial=${String(decision.partial)} collapse-suspect=${String(
          decision.action === 'collapse-suspect',
        )} action=${decision.action} revision=${revision.revisionId}`,
    );
    switch (decision.action) {
      case 'collapse-suspect':
        // Never persist empty-over-populated on the shadow lane: the
        // carried state and the legacy slot keep the prior; the empty
        // build is persisted for audit/lineage only (mirrors the leiden
        // active-slot guard above).
        await inner.putRevision(revision);
        return;
      case 'adopt':
      case 'update':
        // Membership changed — mirror the carried state into the legacy
        // candidate slot so raw readers (workGraphHealth) stay in sync.
        await inner.putCandidateShadowRevision(candidate, revision);
        return;
      case 'cursor-only':
      case 'observe-empty':
        // Change-gate: membership identical (or nothing to keep) — no
        // slot rewrite. The cursor (when ids advanced) already persisted
        // inside recordCycleResult, so the next drain's skip-gate still
        // sees the fresh revisionId via the carried read.
        return;
    }
  };

  return {
    ...inner,
    putActiveRevision,
    putCandidateShadowRevision,
    readCandidateShadowRevision,
  };
};
