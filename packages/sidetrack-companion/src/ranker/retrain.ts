import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ConnectionsSnapshot } from '../connections/types.js';
import { USER_ORGANIZED_ITEM } from '../feedback/events.js';
import {
  type FeedbackProjection,
  type FeedbackTrainingLabel,
  projectFeedback,
} from '../feedback/projection.js';
import { writeActiveClosestVisitRankerRevision } from '../producers/closest-visit-revision.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { CANDIDATE_SOURCES, generateCandidates } from './candidates.js';
import { extractFeatures } from './features.js';
import { randomUnrelated } from './negatives.js';
import {
  trainRankerRevision,
  type RankerRevision,
  type RankerTrainingCandidate,
  type TrainRankerInput,
  type TrainRankerOptions,
} from './train.js';
import type { Candidate, CandidateSource } from './types.js';

// Lowered from 50 to 5 (post-PR141 backfill made 50 unreachable in
// practice for normal dogfood cadence). Production cadence is now
// guarded by the cooldown below — they're two halves of the same rule.
export const DEFAULT_RANKER_RETRAIN_LABEL_THRESHOLD = 5;
export const DEFAULT_RANDOM_NEGATIVES_PER_POSITIVE_FROM = 5;
// Cooldown between successful retrains. Even if new-labels >= threshold,
// hold off until cooldown elapses to avoid thrashing during a burst of
// user organizing.
export const DEFAULT_RANKER_RETRAIN_COOLDOWN_MS = 10 * 60_000;
export const RANKER_RETRAIN_STATE_SCHEMA_VERSION = 1;

// Stage 5 / T4 — env-tunable retrain threshold for dogfood.
// Explicit `threshold` option still wins over the env.
export const RANKER_RETRAIN_LABEL_THRESHOLD_ENV = 'SIDETRACK_RANKER_RETRAIN_MIN_LABELS';
// Cooldown env knob, in ms. Override DEFAULT_RANKER_RETRAIN_COOLDOWN_MS.
export const RANKER_RETRAIN_COOLDOWN_MS_ENV = 'SIDETRACK_RANKER_RETRAIN_COOLDOWN_MS';
// Force-train env: set to '1' to bypass threshold + cooldown checks
// (still respects 'unchanged' / 'no-labels' / 'no-training-candidates'
// skip reasons since those reflect real "nothing to train on" states).
export const RANKER_RETRAIN_FORCE_ENV = 'SIDETRACK_RANKER_RETRAIN_FORCE';

const readEnvNumber = (name: string): number | undefined => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
};

// Derive visit→visit positive labels from user-asserted
// `visit_instance_in_workstream` edges. Without this, the projection's
// `(URL, workstreamId)` labels fail `candidateResolvesToTimelineVisits`
// at training time because `workstreamId` isn't a timeline-visit key —
// labels exist on disk but the ranker can never train from them.
//
// Scope rules (mirror T3 to keep label semantics consistent with
// topic seeding):
//   - Only edges with `producedBy.eventType === USER_ORGANIZED_ITEM`
//     count. Inferred attributions stay out.
//   - The visit-instance node must carry `metadata.canonicalUrl`
//     (matches what the timeline-visit projection consumes).
//   - All pairs are emitted directionally (a→b AND b→a) — the ranker
//     is asymmetric on (from, to) input.
export const deriveVisitPairLabelsFromSnapshot = (
  snapshot: ConnectionsSnapshot,
): readonly FeedbackTrainingLabel[] => {
  const canonicalUrlByVisitInstance = new Map<string, string>();
  for (const node of snapshot.nodes) {
    if (node.kind !== 'visit-instance') continue;
    const canonicalUrl = node.metadata.canonicalUrl;
    if (typeof canonicalUrl === 'string' && canonicalUrl.length > 0) {
      canonicalUrlByVisitInstance.set(node.id, canonicalUrl);
    }
  }

  const urlsByWorkstream = new Map<string, Set<string>>();
  for (const edge of snapshot.edges) {
    if (edge.kind !== 'visit_instance_in_workstream') continue;
    if (edge.producedBy.source !== 'event-log') continue;
    if (edge.producedBy.eventType !== USER_ORGANIZED_ITEM) continue;
    const canonicalUrl = canonicalUrlByVisitInstance.get(edge.fromNodeId);
    if (canonicalUrl === undefined) continue;
    const set = urlsByWorkstream.get(edge.toNodeId) ?? new Set<string>();
    set.add(canonicalUrl);
    urlsByWorkstream.set(edge.toNodeId, set);
  }

  const labels: FeedbackTrainingLabel[] = [];
  for (const workstreamId of [...urlsByWorkstream.keys()].sort(compareText)) {
    const list = [...(urlsByWorkstream.get(workstreamId) ?? [])].sort(compareText);
    for (let i = 0; i < list.length; i += 1) {
      const fromId = list[i];
      if (fromId === undefined) continue;
      for (let j = 0; j < list.length; j += 1) {
        if (i === j) continue;
        const toId = list[j];
        if (toId === undefined) continue;
        labels.push({ fromId, toId, weight: 1 });
      }
    }
  }
  return labels;
};

const RANKER_RETRAIN_STATE_RELATIVE_PATH = '_BAC/connections/closest-visit/retrain-state.json';
const TIMELINE_VISIT_PREFIX = 'timeline-visit:';
const TOPIC_PREFIX = 'topic:';
const WORKSTREAM_PREFIX = 'workstream:';

const stripTimelineVisitPrefix = (value: string): string =>
  value.startsWith(TIMELINE_VISIT_PREFIX) ? value.slice(TIMELINE_VISIT_PREFIX.length) : value;

// Map each `topic:`/`workstream:` container node id to the set of
// member timeline-visit canonical URLs the snapshot attributes to it.
//
//   - `topic:<id>`     ← `visit_in_topic` edges
//                        (from = `timeline-visit:<url>`, to = `topic:<id>`)
//   - `workstream:<id>` ← direct `visit_in_workstream` /
//                          `visit_instance_in_workstream` edges PLUS
//                          transitive membership through
//                          `topic_in_workstream` (every member of a
//                          topic that lives in the workstream).
//
// `visit-instance` edges carry their canonical URL on the source node's
// `metadata.canonicalUrl` (same convention the positive derivation
// consumes); every other membership edge already references the
// `timeline-visit:<url>` node directly.
const containerMembersFromSnapshot = (
  snapshot: ConnectionsSnapshot,
): ReadonlyMap<string, ReadonlySet<string>> => {
  const canonicalUrlByVisitInstance = new Map<string, string>();
  for (const node of snapshot.nodes) {
    if (node.kind !== 'visit-instance') continue;
    const canonicalUrl = node.metadata.canonicalUrl;
    if (typeof canonicalUrl === 'string' && canonicalUrl.length > 0) {
      canonicalUrlByVisitInstance.set(node.id, canonicalUrl);
    }
  }

  const topicMembers = new Map<string, Set<string>>();
  const workstreamMembers = new Map<string, Set<string>>();
  const topicsByWorkstream = new Map<string, Set<string>>();

  const addMember = (
    target: Map<string, Set<string>>,
    containerId: string,
    canonicalUrl: string,
  ): void => {
    const set = target.get(containerId) ?? new Set<string>();
    set.add(canonicalUrl);
    target.set(containerId, set);
  };

  for (const edge of snapshot.edges) {
    if (edge.kind === 'visit_in_topic' && edge.toNodeId.startsWith(TOPIC_PREFIX)) {
      const url = stripTimelineVisitPrefix(edge.fromNodeId);
      if (url.length > 0 && url !== edge.fromNodeId) addMember(topicMembers, edge.toNodeId, url);
      continue;
    }
    if (edge.kind === 'visit_in_workstream' && edge.toNodeId.startsWith(WORKSTREAM_PREFIX)) {
      const url = stripTimelineVisitPrefix(edge.fromNodeId);
      if (url.length > 0 && url !== edge.fromNodeId) {
        addMember(workstreamMembers, edge.toNodeId, url);
      }
      continue;
    }
    if (
      edge.kind === 'visit_instance_in_workstream' &&
      edge.toNodeId.startsWith(WORKSTREAM_PREFIX)
    ) {
      const url = canonicalUrlByVisitInstance.get(edge.fromNodeId);
      if (url !== undefined) addMember(workstreamMembers, edge.toNodeId, url);
      continue;
    }
    if (
      edge.kind === 'topic_in_workstream' &&
      edge.fromNodeId.startsWith(TOPIC_PREFIX) &&
      edge.toNodeId.startsWith(WORKSTREAM_PREFIX)
    ) {
      const set = topicsByWorkstream.get(edge.toNodeId) ?? new Set<string>();
      set.add(edge.fromNodeId);
      topicsByWorkstream.set(edge.toNodeId, set);
    }
  }

  // Fold each workstream's topic members into the workstream itself so a
  // negative against a workstream covers the visits the snapshot only
  // attributes to it transitively (via its topics).
  for (const [workstreamId, topicIds] of topicsByWorkstream) {
    for (const topicId of topicIds) {
      for (const url of topicMembers.get(topicId) ?? []) {
        addMember(workstreamMembers, workstreamId, url);
      }
    }
  }

  const merged = new Map<string, ReadonlySet<string>>();
  for (const [containerId, urls] of topicMembers) merged.set(containerId, urls);
  for (const [containerId, urls] of workstreamMembers) merged.set(containerId, urls);
  return merged;
};

const isContainerId = (value: string): boolean =>
  value.startsWith(TOPIC_PREFIX) || value.startsWith(WORKSTREAM_PREFIX);

// Mirror `deriveVisitPairLabelsFromSnapshot` for the negative side.
// Projection emits `ignore` / `split` / `user.flow.rejected` negatives
// shaped `(timeline-visit:<url>, topic:<id>)` or `(…, workstream:<id>)`
// (or the container on `fromId`). The container endpoint is not a
// timeline-visit key, so `candidateResolvesToTimelineVisits` silently
// drops the whole negative before training. Resolve each container
// endpoint to its member timeline-visit URLs (from the snapshot) and
// emit a correctly-shaped negative visit↔visit pair per member.
//
// Already-(visit, visit) negatives pass through unchanged. Containers
// with no snapshot members yield nothing. Self-pairs are skipped and
// the result is deduped + deterministically ordered. The resolution
// gate is NOT weakened — this only reshapes containers into the visit
// pairs the gate already accepts.
export const deriveNegativeVisitPairLabelsFromSnapshot = (
  feedback: FeedbackProjection,
  snapshot: ConnectionsSnapshot,
): readonly FeedbackTrainingLabel[] => {
  if (feedback.negativeLabels.length === 0) return [];
  const membersByContainer = containerMembersFromSnapshot(snapshot);

  const seen = new Set<string>();
  const labels: FeedbackTrainingLabel[] = [];
  const emit = (fromId: string, toId: string, weight: number): void => {
    if (fromId.length === 0 || toId.length === 0) return;
    if (fromId === toId) return;
    const key = `${fromId} ${toId} ${String(weight)}`;
    if (seen.has(key)) return;
    seen.add(key);
    labels.push({ fromId, toId, weight });
  };

  for (const label of feedback.negativeLabels) {
    const fromIsContainer = isContainerId(label.fromId);
    const toIsContainer = isContainerId(label.toId);

    // Already a visit↔visit (or otherwise non-container) negative —
    // leave the resolution gate to accept/reject it as-is.
    if (!fromIsContainer && !toIsContainer) {
      emit(label.fromId, label.toId, label.weight);
      continue;
    }

    if (toIsContainer && !fromIsContainer) {
      const visitUrl = stripTimelineVisitPrefix(label.fromId);
      for (const memberUrl of [...(membersByContainer.get(label.toId) ?? [])].sort(compareText)) {
        emit(visitUrl, memberUrl, label.weight);
      }
      continue;
    }

    if (fromIsContainer && !toIsContainer) {
      const visitUrl = stripTimelineVisitPrefix(label.toId);
      for (const memberUrl of [...(membersByContainer.get(label.fromId) ?? [])].sort(compareText)) {
        emit(memberUrl, visitUrl, label.weight);
      }
      continue;
    }

    // Both endpoints are containers (e.g. topic-into-workstream split):
    // expand to the Cartesian product of their members so every
    // cross-container visit pair becomes a negative.
    const fromMembers = [...(membersByContainer.get(label.fromId) ?? [])].sort(compareText);
    const toMembers = [...(membersByContainer.get(label.toId) ?? [])].sort(compareText);
    for (const fromUrl of fromMembers) {
      for (const toUrl of toMembers) {
        emit(fromUrl, toUrl, label.weight);
      }
    }
  }

  return labels;
};

export const augmentFeedbackWithVisitPairLabels = (
  feedback: FeedbackProjection,
  snapshot: ConnectionsSnapshot,
): FeedbackProjection => {
  const visitPairLabels = deriveVisitPairLabelsFromSnapshot(snapshot);
  const negativeVisitPairLabels = deriveNegativeVisitPairLabelsFromSnapshot(feedback, snapshot);
  if (visitPairLabels.length === 0 && negativeVisitPairLabels.length === 0) return feedback;
  return {
    ...feedback,
    positiveLabels: [...feedback.positiveLabels, ...visitPairLabels],
    negativeLabels: [...feedback.negativeLabels, ...negativeVisitPairLabels],
  };
};

export interface RankerTrainingLabelDatasetFingerprint {
  readonly hash: string;
  readonly labelCount: number;
  readonly positiveLabelCount: number;
  readonly negativeLabelCount: number;
}

export interface RankerRetrainState {
  readonly schemaVersion: typeof RANKER_RETRAIN_STATE_SCHEMA_VERSION;
  readonly lastTrainedLabelDatasetHash: string;
  readonly lastTrainedLabelCount: number;
  readonly lastTrainedPositiveLabelCount: number;
  readonly lastTrainedNegativeLabelCount: number;
  readonly activeRevisionId: string;
  readonly rankerTrainingDatasetHash: string;
  readonly updatedAt: number;
}

export type RankerRetrainSkipReason =
  | 'no-labels'
  | 'unchanged'
  | 'below-threshold'
  | 'cooldown'
  | 'no-training-candidates';

export type RankerRetrainPlan =
  | {
      readonly action: 'train';
      readonly fingerprint: RankerTrainingLabelDatasetFingerprint;
      readonly newLabelCount: number;
    }
  | {
      readonly action: 'skip';
      readonly reason: Exclude<RankerRetrainSkipReason, 'no-training-candidates'>;
      readonly fingerprint: RankerTrainingLabelDatasetFingerprint;
      readonly newLabelCount: number;
    };

export type RankerRetrainResult =
  | {
      readonly status: 'trained';
      readonly revisionId: string;
      readonly fingerprint: RankerTrainingLabelDatasetFingerprint;
      readonly newLabelCount: number;
      readonly candidateCount: number;
    }
  | {
      readonly status: 'skipped';
      readonly reason: RankerRetrainSkipReason;
      readonly fingerprint: RankerTrainingLabelDatasetFingerprint;
      readonly newLabelCount: number;
      readonly candidateCount?: number;
    }
  | {
      readonly status: 'failed';
      readonly error: string;
      readonly fingerprint: RankerTrainingLabelDatasetFingerprint;
      readonly newLabelCount: number;
      readonly candidateCount: number;
    };

export interface RankerRetrainContext {
  readonly merged: readonly AcceptedEvent[];
  readonly snapshot: ConnectionsSnapshot;
}

export type RankerRetrainer = (context: RankerRetrainContext) => Promise<RankerRetrainResult>;

export type TrainRankerRevisionFn = (input: TrainRankerInput) => Promise<RankerRevision>;
export type WriteActiveRankerRevisionFn = (
  vaultRoot: string,
  revision: RankerRevision,
) => Promise<void>;

export interface PlanRankerRetrainInput {
  readonly fingerprint: RankerTrainingLabelDatasetFingerprint;
  readonly state: RankerRetrainState | null;
  readonly threshold?: number | undefined;
  /** Cooldown in ms since last successful train; ignored when `force` set. */
  readonly cooldownMs?: number | undefined;
  /** `Date.now()` for cooldown comparison; injected for tests. */
  readonly nowMs?: number | undefined;
  /** Bypasses threshold + cooldown when true. */
  readonly force?: boolean | undefined;
}

export interface BuildRankerTrainingCandidatesInput {
  readonly feedback: FeedbackProjection;
  readonly merged: readonly AcceptedEvent[];
  readonly snapshot: ConnectionsSnapshot;
  readonly randomNegativeCandidatesPerPositive?: number | undefined;
}

export interface MaybeRetrainClosestVisitRankerInput extends RankerRetrainContext {
  readonly vaultRoot: string;
  readonly threshold?: number | undefined;
  // Plan Part 8 / TODO-R7: a forced retrigger bypasses the *policy*
  // gates (threshold + cooldown). planRankerRetrain still returns skip
  // for the *substance* gates (no-labels / unchanged /
  // no-training-candidates) — a manual retrigger may not manufacture a
  // healthier model than the data supports.
  readonly force?: boolean | undefined;
  readonly randomNegativeCandidatesPerPositive?: number | undefined;
  readonly trainOptions?: TrainRankerOptions | undefined;
  readonly train?: TrainRankerRevisionFn | undefined;
  readonly writeActiveRevision?: WriteActiveRankerRevisionFn | undefined;
  readonly readState?: ((vaultRoot: string) => Promise<RankerRetrainState | null>) | undefined;
  readonly writeState?:
    | ((vaultRoot: string, state: RankerRetrainState) => Promise<void>)
    | undefined;
}

const sourceOrder = new Map<CandidateSource, number>(
  CANDIDATE_SOURCES.map((source, index) => [source, index]),
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const sha256Hex = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

const parseTimestamp = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const maxFinite = (current: number, candidate: number | null): number =>
  candidate === null || candidate <= current ? current : candidate;

const isHex64 = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

const isRankerRetrainState = (value: unknown): value is RankerRetrainState => {
  if (!isRecord(value)) return false;
  return (
    value['schemaVersion'] === RANKER_RETRAIN_STATE_SCHEMA_VERSION &&
    isHex64(value['lastTrainedLabelDatasetHash']) &&
    isNonNegativeInteger(value['lastTrainedLabelCount']) &&
    isNonNegativeInteger(value['lastTrainedPositiveLabelCount']) &&
    isNonNegativeInteger(value['lastTrainedNegativeLabelCount']) &&
    typeof value['activeRevisionId'] === 'string' &&
    value['activeRevisionId'].length > 0 &&
    isHex64(value['rankerTrainingDatasetHash']) &&
    typeof value['updatedAt'] === 'number' &&
    Number.isFinite(value['updatedAt'])
  );
};

const normalizedThreshold = (threshold: number | undefined): number =>
  Math.max(1, Math.floor(threshold ?? DEFAULT_RANKER_RETRAIN_LABEL_THRESHOLD));

const normalizedRandomNegativeCount = (count: number | undefined): number =>
  Math.max(0, Math.floor(count ?? DEFAULT_RANDOM_NEGATIVES_PER_POSITIVE_FROM));

const labelKey = (label: FeedbackTrainingLabel): string => `${label.fromId}\u0000${label.toId}`;

const sortedLabelRows = (
  kind: 'positive' | 'negative',
  labels: readonly FeedbackTrainingLabel[],
): readonly {
  readonly kind: 'positive' | 'negative';
  readonly fromId: string;
  readonly toId: string;
  readonly weight: number;
}[] =>
  labels
    .map((label) => ({
      kind,
      fromId: label.fromId,
      toId: label.toId,
      weight: label.weight,
    }))
    .sort(
      (left, right) =>
        compareText(left.kind, right.kind) ||
        compareText(left.fromId, right.fromId) ||
        compareText(left.toId, right.toId) ||
        left.weight - right.weight,
    );

export const fingerprintFeedbackTrainingLabels = (
  feedback: FeedbackProjection,
): RankerTrainingLabelDatasetFingerprint => {
  const positive = sortedLabelRows('positive', feedback.positiveLabels);
  const negative = sortedLabelRows('negative', feedback.negativeLabels);
  const body = JSON.stringify({
    schemaVersion: feedback.schemaVersion,
    labels: [...positive, ...negative],
  });
  return {
    hash: sha256Hex(body),
    labelCount: positive.length + negative.length,
    positiveLabelCount: positive.length,
    negativeLabelCount: negative.length,
  };
};

const normalizedCooldownMs = (cooldownMs: number | undefined): number => {
  if (cooldownMs === undefined || !Number.isFinite(cooldownMs)) {
    return DEFAULT_RANKER_RETRAIN_COOLDOWN_MS;
  }
  return Math.max(0, Math.floor(cooldownMs));
};

export const planRankerRetrain = ({
  fingerprint,
  state,
  threshold,
  cooldownMs,
  nowMs,
  force,
}: PlanRankerRetrainInput): RankerRetrainPlan => {
  if (fingerprint.labelCount === 0) {
    return { action: 'skip', reason: 'no-labels', fingerprint, newLabelCount: 0 };
  }

  if (state?.lastTrainedLabelDatasetHash === fingerprint.hash) {
    return { action: 'skip', reason: 'unchanged', fingerprint, newLabelCount: 0 };
  }

  const previousLabelCount = state?.lastTrainedLabelCount ?? 0;
  const newLabelCount = Math.max(0, fingerprint.labelCount - previousLabelCount);

  // Force flag bypasses the next two checks entirely but still respects
  // 'no-labels' + 'unchanged' (which mean there's literally nothing
  // new to learn).
  if (force === true) {
    return { action: 'train', fingerprint, newLabelCount };
  }

  if (newLabelCount < normalizedThreshold(threshold)) {
    return { action: 'skip', reason: 'below-threshold', fingerprint, newLabelCount };
  }

  // Cooldown — avoid retraining more than once per cooldown window
  // even if labels keep arriving. Skipped when state has never trained
  // (`state === null`) since there's no prior train to wait on.
  if (state !== null) {
    const lastTrainedAtMs = state.updatedAt;
    const cooldown = normalizedCooldownMs(cooldownMs);
    const now = nowMs ?? Date.now();
    if (cooldown > 0 && now - lastTrainedAtMs < cooldown) {
      return { action: 'skip', reason: 'cooldown', fingerprint, newLabelCount };
    }
  }

  return { action: 'train', fingerprint, newLabelCount };
};

export const rankerRetrainStatePath = (vaultRoot: string): string =>
  join(vaultRoot, RANKER_RETRAIN_STATE_RELATIVE_PATH);

const writeAtomic = async (path: string, body: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${String(process.pid)}.tmp`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, path);
};

export const readRankerRetrainState = async (
  vaultRoot: string,
): Promise<RankerRetrainState | null> => {
  try {
    const parsed = JSON.parse(await readFile(rankerRetrainStatePath(vaultRoot), 'utf8')) as unknown;
    return isRankerRetrainState(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const writeRankerRetrainState = async (
  vaultRoot: string,
  state: RankerRetrainState,
): Promise<void> => {
  await writeAtomic(rankerRetrainStatePath(vaultRoot), `${JSON.stringify(state, null, 2)}\n`);
};

const visitKeyFromNodeOrRaw = (value: string): string =>
  value.startsWith(TIMELINE_VISIT_PREFIX) ? value.slice(TIMELINE_VISIT_PREFIX.length) : value;

const timelineVisitKeys = (snapshot: ConnectionsSnapshot): readonly string[] =>
  [
    ...new Set(
      snapshot.nodes
        .filter((node) => node.kind === 'timeline-visit')
        .map((node) => visitKeyFromNodeOrRaw(node.id))
        .filter((visitKey) => visitKey.length > 0),
    ),
  ].sort(compareText);

const pairKeyForCandidate = (candidate: Candidate): string =>
  `${candidate.fromVisitId}\u0000${candidate.toVisitId}`;

const sourceSort = (left: CandidateSource, right: CandidateSource): number =>
  (sourceOrder.get(left) ?? 0) - (sourceOrder.get(right) ?? 0) || compareText(left, right);

const mergeSources = (
  left: readonly CandidateSource[],
  right: readonly CandidateSource[],
): readonly CandidateSource[] => [...new Set([...left, ...right])].sort(sourceSort);

const putCandidate = (candidates: Map<string, Candidate>, candidate: Candidate): void => {
  const key = pairKeyForCandidate(candidate);
  const existing = candidates.get(key);
  if (existing === undefined) {
    candidates.set(key, {
      ...candidate,
      sources: mergeSources([], candidate.sources),
    });
    return;
  }
  candidates.set(key, {
    ...existing,
    sources: mergeSources(existing.sources, candidate.sources),
    generatedAt: Math.max(existing.generatedAt, candidate.generatedAt),
  });
};

const candidateResolvesToTimelineVisits = (
  candidate: Candidate,
  visitKeys: ReadonlySet<string>,
): boolean =>
  visitKeys.has(visitKeyFromNodeOrRaw(candidate.fromVisitId)) &&
  visitKeys.has(visitKeyFromNodeOrRaw(candidate.toVisitId)) &&
  visitKeyFromNodeOrRaw(candidate.fromVisitId) !== visitKeyFromNodeOrRaw(candidate.toVisitId);

const maxObservedAt = (merged: readonly AcceptedEvent[], snapshot: ConnectionsSnapshot): number => {
  let generatedAt = parseTimestamp(snapshot.updatedAt) ?? 0;
  for (const event of merged) {
    if (Number.isFinite(event.acceptedAtMs)) {
      generatedAt = Math.max(generatedAt, event.acceptedAtMs);
    }
  }
  for (const edge of snapshot.edges) {
    generatedAt = maxFinite(generatedAt, parseTimestamp(edge.observedAt));
  }
  return generatedAt;
};

const addFeedbackLabelCandidates = (
  candidates: Map<string, Candidate>,
  labels: readonly FeedbackTrainingLabel[],
  source: CandidateSource,
  generatedAt: number,
  visitKeys: ReadonlySet<string>,
): void => {
  for (const label of labels) {
    const candidate = {
      fromVisitId: label.fromId,
      toVisitId: label.toId,
      sources: [source],
      generatedAt,
    } satisfies Candidate;
    if (candidateResolvesToTimelineVisits(candidate, visitKeys))
      putCandidate(candidates, candidate);
  }
};

const positiveLabelFromIds = (
  feedback: FeedbackProjection,
  visitKeys: ReadonlySet<string>,
): readonly string[] =>
  [
    ...new Set(
      feedback.positiveLabels
        .filter((label) => visitKeys.has(visitKeyFromNodeOrRaw(label.fromId)))
        .map((label) => label.fromId),
    ),
  ].sort(compareText);

const blockedLabelPairsByFrom = (
  feedback: FeedbackProjection,
): ReadonlyMap<string, ReadonlySet<string>> => {
  const byFrom = new Map<string, Set<string>>();
  for (const label of [...feedback.positiveLabels, ...feedback.negativeLabels]) {
    let set = byFrom.get(label.fromId);
    if (set === undefined) {
      set = new Set<string>();
      byFrom.set(label.fromId, set);
    }
    set.add(labelKey(label));
  }
  return byFrom;
};

const addRandomNegativeCandidates = (
  candidates: Map<string, Candidate>,
  input: BuildRankerTrainingCandidatesInput,
  visitKeysList: readonly string[],
  visitKeys: ReadonlySet<string>,
  generatedAt: number,
): void => {
  const count = normalizedRandomNegativeCount(input.randomNegativeCandidatesPerPositive);
  if (count === 0) return;

  const blockedByFrom = blockedLabelPairsByFrom(input.feedback);
  for (const fromVisitId of positiveLabelFromIds(input.feedback, visitKeys)) {
    const blocked = blockedByFrom.get(fromVisitId) ?? new Set<string>();
    const sampleBudget = count + blocked.size;
    const sampled = randomUnrelated(
      fromVisitId,
      visitKeysList,
      sampleBudget,
      `${fromVisitId}:${fingerprintFeedbackTrainingLabels(input.feedback).hash}`,
      {
        existingEdges: input.snapshot.edges,
        generatedAt,
      },
    ).filter((candidate) => !blocked.has(pairKeyForCandidate(candidate)));

    for (const candidate of sampled.slice(0, count)) {
      if (candidateResolvesToTimelineVisits(candidate, visitKeys)) {
        putCandidate(candidates, candidate);
      }
    }
  }
};

export const buildRankerTrainingCandidates = ({
  feedback,
  merged,
  snapshot,
  randomNegativeCandidatesPerPositive,
}: BuildRankerTrainingCandidatesInput): readonly RankerTrainingCandidate[] => {
  const visitKeysList = timelineVisitKeys(snapshot);
  const visitKeys = new Set(visitKeysList);
  if (visitKeys.size === 0) return [];

  const candidates = new Map<string, Candidate>();
  const generatedAt = maxObservedAt(merged, snapshot);
  const context = { merged: [...merged], existingEdges: [...snapshot.edges] };

  for (const fromVisitId of visitKeysList) {
    for (const candidate of generateCandidates(fromVisitId, context)) {
      if (candidateResolvesToTimelineVisits(candidate, visitKeys)) {
        putCandidate(candidates, candidate);
      }
    }
  }

  addFeedbackLabelCandidates(
    candidates,
    feedback.positiveLabels,
    'same_workstream',
    generatedAt,
    visitKeys,
  );
  addFeedbackLabelCandidates(
    candidates,
    feedback.negativeLabels,
    'recently_skipped',
    generatedAt,
    visitKeys,
  );
  addRandomNegativeCandidates(
    candidates,
    {
      feedback,
      merged,
      snapshot,
      ...(randomNegativeCandidatesPerPositive === undefined
        ? {}
        : { randomNegativeCandidatesPerPositive }),
    },
    visitKeysList,
    visitKeys,
    generatedAt,
  );

  return [...candidates.values()]
    .sort(
      (left, right) =>
        compareText(left.fromVisitId, right.fromVisitId) ||
        compareText(left.toVisitId, right.toVisitId),
    )
    .map((candidate) => ({
      candidate,
      features: extractFeatures(candidate, { merged: [...merged], snapshot }),
    }));
};

const stateFromRevision = (
  fingerprint: RankerTrainingLabelDatasetFingerprint,
  revision: RankerRevision,
): RankerRetrainState => ({
  schemaVersion: RANKER_RETRAIN_STATE_SCHEMA_VERSION,
  lastTrainedLabelDatasetHash: fingerprint.hash,
  lastTrainedLabelCount: fingerprint.labelCount,
  lastTrainedPositiveLabelCount: fingerprint.positiveLabelCount,
  lastTrainedNegativeLabelCount: fingerprint.negativeLabelCount,
  activeRevisionId: revision.revisionId,
  rankerTrainingDatasetHash: revision.trainingDatasetHash,
  updatedAt: revision.trainedAt,
});

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const maybeRetrainClosestVisitRanker = async ({
  vaultRoot,
  merged,
  snapshot,
  threshold,
  force: forceInput,
  randomNegativeCandidatesPerPositive,
  trainOptions,
  train = trainRankerRevision,
  writeActiveRevision = writeActiveClosestVisitRankerRevision,
  readState = readRankerRetrainState,
  writeState = writeRankerRetrainState,
}: MaybeRetrainClosestVisitRankerInput): Promise<RankerRetrainResult> => {
  const baseFeedback = projectFeedback(merged);
  const feedback = augmentFeedbackWithVisitPairLabels(baseFeedback, snapshot);
  const fingerprint = fingerprintFeedbackTrainingLabels(feedback);
  const state = await readState(vaultRoot);
  const resolvedThreshold = threshold ?? readEnvNumber(RANKER_RETRAIN_LABEL_THRESHOLD_ENV);
  const cooldownEnv = readEnvNumber(RANKER_RETRAIN_COOLDOWN_MS_ENV);
  const forceEnv = process.env[RANKER_RETRAIN_FORCE_ENV];
  const force = forceInput === true || forceEnv === '1' || forceEnv === 'true';
  const plan = planRankerRetrain({
    fingerprint,
    state,
    ...(resolvedThreshold === undefined ? {} : { threshold: resolvedThreshold }),
    ...(cooldownEnv === undefined ? {} : { cooldownMs: cooldownEnv }),
    force,
  });

  if (plan.action === 'skip') {
    return {
      status: 'skipped',
      reason: plan.reason,
      fingerprint,
      newLabelCount: plan.newLabelCount,
    };
  }

  const candidates = buildRankerTrainingCandidates({
    feedback,
    merged,
    snapshot,
    ...(randomNegativeCandidatesPerPositive === undefined
      ? {}
      : { randomNegativeCandidatesPerPositive }),
  });
  if (candidates.length === 0) {
    return {
      status: 'skipped',
      reason: 'no-training-candidates',
      fingerprint,
      newLabelCount: plan.newLabelCount,
      candidateCount: 0,
    };
  }

  try {
    const revision = await train({
      feedback,
      candidates,
      ...(trainOptions === undefined ? {} : { options: trainOptions }),
    });
    await writeActiveRevision(vaultRoot, revision);
    await writeState(vaultRoot, stateFromRevision(fingerprint, revision));
    return {
      status: 'trained',
      revisionId: revision.revisionId,
      fingerprint,
      newLabelCount: plan.newLabelCount,
      candidateCount: candidates.length,
    };
  } catch (error) {
    return {
      status: 'failed',
      error: errorMessage(error),
      fingerprint,
      newLabelCount: plan.newLabelCount,
      candidateCount: candidates.length,
    };
  }
};

// Stage 5 polish — Worker-thread spawn helper for ranker retrain.
// The LightGBM training math AND the cold-path file reads
// (readMerged, snapshot readCurrent) all run inside the worker so
// /v1/status + every other warm-path poll stay responsive while
// retrain is in flight.
//
// The worker accepts a minimal serializable job (vaultRoot + knobs),
// constructs its own EventLog + connectionsStore inside the worker
// context, and runs the full retrain pipeline. Mirrors the
// `connectionsReconcileWorker.entry.ts` pattern that already
// background-runs the materializer drain.
//
// The worker entry lives at `./retrain.worker.js` after build (the
// matching .ts file in this directory).
export interface RunMaybeRetrainInWorkerInput {
  readonly vaultRoot: string;
  readonly threshold?: number;
  readonly force?: boolean;
  readonly randomNegativeCandidatesPerPositive?: number;
  readonly trainOptions?: TrainRankerOptions;
}

export const runMaybeRetrainInWorker = async (
  input: RunMaybeRetrainInWorkerInput,
): Promise<RankerRetrainResult> => {
  // Lazy-import worker_threads so the dual-purpose module (re-exported
  // for unit tests in addition to the production code path) doesn't
  // crash environments where worker_threads isn't available (e.g.
  // future browser-side reuse). Lazy + dynamic also keeps the worker
  // entry off the cold-start critical path.
  const { Worker } = await import('node:worker_threads');
  const workerUrl = new URL('./retrain.worker.js', import.meta.url);
  return await new Promise<RankerRetrainResult>((resolve, reject) => {
    const worker = new Worker(workerUrl, { workerData: input });
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    worker.once(
      'message',
      (
        msg:
          | { readonly ok: true; readonly result: RankerRetrainResult }
          | { readonly ok: false; readonly error: string },
      ) => {
        settle(() => {
          if (msg.ok) {
            resolve(msg.result);
          } else {
            reject(new Error(msg.error));
          }
        });
        void worker.terminate();
      },
    );
    worker.once('error', (err) => {
      settle(() => {
        reject(err);
      });
    });
    worker.once('exit', (code) => {
      settle(() => {
        if (code !== 0) {
          reject(new Error(`Ranker retrain worker exited with code ${String(code)}`));
        } else {
          // Code 0 with no message means the worker finished without
          // sending a result — treat as a generic failure rather than
          // hanging the promise forever.
          reject(new Error('Ranker retrain worker exited without producing a result'));
        }
      });
    });
  });
};
