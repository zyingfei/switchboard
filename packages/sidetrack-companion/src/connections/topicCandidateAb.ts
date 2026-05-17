// Generic, algorithm-agnostic A/B comparison for OBSERVATIONAL topic
// clustering candidates (HDBSCAN, the algorithm-comparison sweep).
//
// This is deliberately separate from `buildShadowDiagnostics` in
// topicShadowCandidate.ts: that one is specific to the SERVED
// idf-rkn-split shadow (it carries the prune pipeline's
// reciprocalK / minLexicalScore / highDfTerms). These candidates are
// pure observational alternatives clustered over the same visits, so
// the only meaningful comparison is the algorithm-agnostic shape +
// distribution of the resulting clustering vs the same baseline the
// shadow A/B uses (the union-find `topicRevision`). The metric math
// mirrors `buildShadowDiagnostics` so the numbers are directly
// comparable across the union-find / idf-rkn-split / HDBSCAN lanes in
// the HealthPanel experiments table.

import type { TopicRevision } from '../producers/topic-revision.js';

export interface TopicCandidateAbDiagnostics {
  readonly candidate: string;
  readonly enabled: true;
  readonly algorithmVersion: string;
  readonly baselineAlgorithmVersion: string;
  readonly candidateRevisionId: string;
  readonly baselineRevisionId: string;
  readonly baselineTopicCount: number;
  readonly candidateTopicCount: number;
  readonly topicCountDelta: number;
  readonly baselineMaxTopicSize: number;
  readonly candidateMaxTopicSize: number;
  readonly baselineMaxTopicShare: number;
  readonly candidateMaxTopicShare: number;
  readonly eligibleVisitCount: number;
  readonly candidateAssignedVisitCount: number;
  readonly noiseShare: number;
  readonly perVisitChurn: number;
  readonly runtimeMs: number;
  // Honest skip-vs-build signal: true ⇒ this sample was derived from a
  // reused persisted revision (no clustering this drain, runtimeMs 0),
  // mirroring buildReusedShadowDiagnostics.
  readonly reused: boolean;
}

const roundMetric = (value: number): number => Number(value.toFixed(6));

const topicCountFor = (revision: TopicRevision): number => revision.topics.length;

const memberCountFor = (revision: TopicRevision): number =>
  revision.topics.reduce((sum, topic) => sum + topic.memberCanonicalUrls.length, 0);

const maxTopicSizeFor = (revision: TopicRevision): number =>
  Math.max(0, ...revision.topics.map((topic) => topic.memberCanonicalUrls.length));

const visitToTopicMap = (revision: TopicRevision): ReadonlyMap<string, string> => {
  const out = new Map<string, string>();
  for (const topic of revision.topics) {
    for (const member of topic.memberCanonicalUrls) out.set(member, topic.topicId);
  }
  return out;
};

const perVisitChurn = (baseline: TopicRevision, candidate: TopicRevision): number => {
  const baselineByVisit = visitToTopicMap(baseline);
  const candidateByVisit = visitToTopicMap(candidate);
  if (baselineByVisit.size === 0) return 0;
  let changed = 0;
  for (const [visitKey, baselineTopicId] of baselineByVisit.entries()) {
    if (candidateByVisit.get(visitKey) !== baselineTopicId) changed += 1;
  }
  return changed / baselineByVisit.size;
};

// Pure, cheap: only counts/maps over already-materialized revisions —
// no clustering. Safe to call every drain (incl. the skip path, with
// the persisted candidate revision + runtimeMs 0 / reused true).
export const compareTopicRevisions = (params: {
  readonly baselineRevision: TopicRevision;
  readonly candidateRevision: TopicRevision;
  readonly candidate: string;
  readonly runtimeMs: number;
  readonly reused: boolean;
}): TopicCandidateAbDiagnostics => {
  const { baselineRevision, candidateRevision } = params;
  const baselineMembers = Math.max(1, memberCountFor(baselineRevision));
  const candidateMembers = memberCountFor(candidateRevision);
  const baselineMax = maxTopicSizeFor(baselineRevision);
  const candidateMax = maxTopicSizeFor(candidateRevision);
  return {
    candidate: params.candidate,
    enabled: true,
    algorithmVersion: candidateRevision.algorithmVersion,
    baselineAlgorithmVersion: baselineRevision.algorithmVersion,
    candidateRevisionId: candidateRevision.revisionId,
    baselineRevisionId: baselineRevision.revisionId,
    baselineTopicCount: topicCountFor(baselineRevision),
    candidateTopicCount: topicCountFor(candidateRevision),
    topicCountDelta: topicCountFor(candidateRevision) - topicCountFor(baselineRevision),
    baselineMaxTopicSize: baselineMax,
    candidateMaxTopicSize: candidateMax,
    baselineMaxTopicShare: roundMetric(baselineMax / baselineMembers),
    candidateMaxTopicShare: roundMetric(candidateMax / baselineMembers),
    eligibleVisitCount: baselineMembers,
    candidateAssignedVisitCount: candidateMembers,
    noiseShare: roundMetric((baselineMembers - candidateMembers) / baselineMembers),
    perVisitChurn: roundMetric(perVisitChurn(baselineRevision, candidateRevision)),
    runtimeMs: roundMetric(params.runtimeMs),
    reused: params.reused,
  };
};

// Default ON (the user asked for these dormant candidates to run by
// default). Disable per-candidate with the env var → 'off'/'false'/
// '0'/'none', mirroring shouldBuildTopicShadowCandidate.
const DISABLED_VALUES = new Set(['off', 'false', '0', 'none']);

export const shouldBuildTopicHdbscanCandidate = (): boolean => {
  const raw = process.env['SIDETRACK_TOPIC_HDBSCAN_CANDIDATE'];
  if (raw === undefined) return true;
  return !DISABLED_VALUES.has(raw.trim().toLowerCase());
};
