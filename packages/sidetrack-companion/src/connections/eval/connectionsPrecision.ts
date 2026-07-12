// Wave 0 — freeze-safe eval spine (report-only).
//
// Scored-connections precision harness. Scores the LIVE graph's served
// similarity edges (the `closest_visit` ranker edges + `visit_resembles_visit`
// visit-similarity edges, both confidence='inferred') against the user's
// asserted/accepted signal (user.flow.confirmed = a true relation the user
// endorsed; user.flow.rejected = a false relation the user vetoed), and
// reports PRECISION BY M4 EVIDENCE TIER (title_only | metadata |
// content_vector) so we can see whether the fancier evidence tiers actually
// buy precision or whether the title-only floor is doing the work.
//
// READ-ONLY over the committed snapshot + the accepted event log. Nothing
// here influences serving. Runs WITHOUT the companion.

import {
  USER_FLOW_CONFIRMED,
  USER_FLOW_REJECTED,
  isUserFlowConfirmedPayload,
  isUserFlowRejectedPayload,
} from '../../feedback/events.js';
import type { AcceptedEvent } from '../../sync/causal.js';
import type { ConnectionEdge, ConnectionsSnapshot } from '../types.js';

/** The M4 evidence tiers stamped onto served similarity edges, plus an
 *  `unknown` bucket for legacy edges emitted before the tier landed. */
export type EvidenceTierBucket = 'title_only' | 'metadata' | 'content_vector' | 'unknown';

/** The served similarity edge kinds this harness scores. Both are
 *  confidence='inferred' predictions the graph SERVED to the user. */
export const SERVED_SIMILARITY_EDGE_KINDS: ReadonlySet<string> = new Set([
  'closest_visit',
  'visit_resembles_visit',
]);

const UNORDERED_SEP = ' ';

/** Order-independent pair key so a user signal on (a,b) matches a served
 *  edge on (b,a) — relatedness is symmetric. */
const unorderedPairKey = (left: string, right: string): string =>
  left < right ? `${left}${UNORDERED_SEP}${right}` : `${right}${UNORDERED_SEP}${left}`;

export interface AcceptedUserSignal {
  /** Pairs the user CONFIRMED are related (positive ground truth). */
  readonly confirmedPairs: ReadonlySet<string>;
  /** Pairs the user REJECTED as unrelated (negative ground truth). */
  readonly rejectedPairs: ReadonlySet<string>;
}

/**
 * Build the accepted-user-signal ground truth from the merged event log.
 * Later events win: if the user confirms then later rejects the same pair,
 * the pair is rejected (and vice-versa). Ordered by acceptedAtMs.
 */
export const buildAcceptedUserSignal = (merged: readonly AcceptedEvent[]): AcceptedUserSignal => {
  const latestByPair = new Map<string, { confirmed: boolean; acceptedAtMs: number }>();
  const ordered = [...merged].sort((left, right) => left.acceptedAtMs - right.acceptedAtMs);
  for (const event of ordered) {
    let confirmed: boolean;
    let fromId: string;
    let toId: string;
    if (event.type === USER_FLOW_CONFIRMED && isUserFlowConfirmedPayload(event.payload)) {
      confirmed = true;
      fromId = event.payload.fromId;
      toId = event.payload.toId;
    } else if (event.type === USER_FLOW_REJECTED && isUserFlowRejectedPayload(event.payload)) {
      confirmed = false;
      fromId = event.payload.fromId;
      toId = event.payload.toId;
    } else {
      continue;
    }
    const key = unorderedPairKey(fromId, toId);
    const previous = latestByPair.get(key);
    if (previous === undefined || event.acceptedAtMs >= previous.acceptedAtMs) {
      latestByPair.set(key, { confirmed, acceptedAtMs: event.acceptedAtMs });
    }
  }
  const confirmedPairs = new Set<string>();
  const rejectedPairs = new Set<string>();
  for (const [key, entry] of latestByPair) {
    if (entry.confirmed) confirmedPairs.add(key);
    else rejectedPairs.add(key);
  }
  return { confirmedPairs, rejectedPairs };
};

/**
 * The user signal keys pairs by the `timeline-visit:<url>` node id (the
 * feedback events' fromId/toId), which is exactly the served edge's
 * fromNodeId/toNodeId. So the served edge's node ids are the join key with
 * no transform needed.
 */
const edgePairKey = (edge: ConnectionEdge): string =>
  unorderedPairKey(edge.fromNodeId, edge.toNodeId);

const evidenceTierOf = (edge: ConnectionEdge): EvidenceTierBucket => {
  const tier = edge.metadata?.['evidenceTier'];
  if (tier === 'title_only' || tier === 'metadata' || tier === 'content_vector') return tier;
  return 'unknown';
};

export interface TierPrecision {
  readonly tier: EvidenceTierBucket;
  /** Served edges of this tier whose pair the user judged (confirmed or
   *  rejected). Precision is only defined over judged edges. */
  readonly judgedCount: number;
  readonly truePositives: number;
  readonly falsePositives: number;
  /** truePositives / judgedCount, or null when no edges of this tier were
   *  judged (precision is undefined, not zero — don't lie). */
  readonly precision: number | null;
  /** All served edges of this tier, judged or not (coverage context). */
  readonly servedCount: number;
}

export interface ConnectionsPrecisionReport {
  readonly totalServedSimilarityEdges: number;
  readonly judgedServedEdges: number;
  readonly confirmedSignalPairs: number;
  readonly rejectedSignalPairs: number;
  readonly byTier: readonly TierPrecision[];
  /** Overall precision across all judged served edges regardless of tier. */
  readonly overallPrecision: number | null;
}

const TIER_ORDER: readonly EvidenceTierBucket[] = [
  'content_vector',
  'metadata',
  'title_only',
  'unknown',
];

/**
 * Score the snapshot's served similarity edges against the accepted user
 * signal and report precision per evidence tier.
 */
export const computeConnectionsPrecision = (
  snapshot: ConnectionsSnapshot,
  signal: AcceptedUserSignal,
): ConnectionsPrecisionReport => {
  const servedEdges = snapshot.edges.filter(
    (edge) => SERVED_SIMILARITY_EDGE_KINDS.has(edge.kind) && edge.confidence === 'inferred',
  );

  const tallies = new Map<
    EvidenceTierBucket,
    { served: number; judged: number; tp: number; fp: number }
  >();
  for (const tier of TIER_ORDER) tallies.set(tier, { served: 0, judged: 0, tp: 0, fp: 0 });

  let judgedTotal = 0;
  let tpTotal = 0;
  for (const edge of servedEdges) {
    const tier = evidenceTierOf(edge);
    const tally = tallies.get(tier)!;
    tally.served += 1;
    const key = edgePairKey(edge);
    const isConfirmed = signal.confirmedPairs.has(key);
    const isRejected = signal.rejectedPairs.has(key);
    if (!isConfirmed && !isRejected) continue;
    tally.judged += 1;
    judgedTotal += 1;
    if (isConfirmed) {
      tally.tp += 1;
      tpTotal += 1;
    } else {
      tally.fp += 1;
    }
  }

  const byTier: TierPrecision[] = TIER_ORDER.map((tier) => {
    const tally = tallies.get(tier)!;
    return {
      tier,
      judgedCount: tally.judged,
      truePositives: tally.tp,
      falsePositives: tally.fp,
      precision: tally.judged === 0 ? null : tally.tp / tally.judged,
      servedCount: tally.served,
    };
  });

  return {
    totalServedSimilarityEdges: servedEdges.length,
    judgedServedEdges: judgedTotal,
    confirmedSignalPairs: signal.confirmedPairs.size,
    rejectedSignalPairs: signal.rejectedPairs.size,
    byTier,
    overallPrecision: judgedTotal === 0 ? null : tpTotal / judgedTotal,
  };
};

/** Format the precision-by-tier table for CLI output. */
export const formatConnectionsPrecisionReport = (report: ConnectionsPrecisionReport): string => {
  const header =
    `servedSimilarityEdges=${String(report.totalServedSimilarityEdges)} ` +
    `judged=${String(report.judgedServedEdges)} ` +
    `signal(confirmed=${String(report.confirmedSignalPairs)}, ` +
    `rejected=${String(report.rejectedSignalPairs)})`;
  const rows = report.byTier.map((tier) => {
    const precision = tier.precision === null ? '  n/a' : tier.precision.toFixed(4);
    return (
      `  ${tier.tier.padEnd(14)} ` +
      `precision=${precision} ` +
      `(tp=${String(tier.truePositives)} fp=${String(tier.falsePositives)} ` +
      `judged=${String(tier.judgedCount)} served=${String(tier.servedCount)})`
    );
  });
  const overall =
    report.overallPrecision === null
      ? 'overall precision=n/a (no served edge falls on a user-judged pair)'
      : `overall precision=${report.overallPrecision.toFixed(4)}`;
  return [header, ...rows, overall].join('\n');
};
