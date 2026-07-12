import type { ConnectionsSnapshot } from '../connections/types.js';
import type { AttributionPolicyMode, AttributionPolicyTelemetry } from '../tabsession/policy.js';
import {
  inferredUrlAttributionPayloadFromResolution,
  resolveUrlAttribution,
  type UrlResolutionResult,
} from '../tabsession/resolver.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { getCaughtUpSharedEventStore } from '../sync/eventStore.js';
import type { EventLog } from '../sync/eventLog.js';
import { URL_ATTRIBUTION_INFERRED } from './events.js';
import {
  createEmptyUrlProjectionAccumulator,
  deserializeUrlProjection,
  foldEventIntoUrlProjectionAccumulator,
  projectUrls,
  serializeUrlProjection,
  type SerializedUrlProjection,
  type UrlProjection,
  urlProjectionAccumulatorFromSerialized,
  urlProjectionFromAccumulator,
} from './projection.js';

export type AutoApplyUrlAttributionStatus =
  | 'applied'
  | 'skipped-existing-attribution'
  | 'skipped-ignored'
  | 'skipped-policy'
  | 'skipped-grace-window'
  | 'skipped-disabled';

// Env gate. Auto-apply is ON by default; the env is an opt-OUT for
// users who want preview-only behavior. Set
// SIDETRACK_URL_RESOLVER_AUTO_APPLY=0 (or 'false') to disable.
// Auto-apply is reversible: the user's manual `user_asserted` move
// always beats the synthesized `inferred` attribution on precedence
// tie-break.
export const URL_RESOLVER_AUTO_APPLY_ENV = 'SIDETRACK_URL_RESOLVER_AUTO_APPLY';

const autoApplyEnabled = (): boolean => {
  const raw = process.env[URL_RESOLVER_AUTO_APPLY_ENV];
  if (raw === undefined || raw === '') return true;
  return raw !== '0' && raw.toLowerCase() !== 'false';
};

export interface AutoApplyUrlAttributionResult {
  readonly status: AutoApplyUrlAttributionStatus;
  readonly resolution: UrlResolutionResult;
  readonly accepted?: AcceptedEvent;
  readonly projection: UrlProjection;
}

export interface AutoApplyUrlAttributionInput {
  readonly eventLog: EventLog;
  readonly snapshot: ConnectionsSnapshot;
  readonly canonicalUrl: string;
  readonly events?: readonly AcceptedEvent[];
  readonly urlProjection?: SerializedUrlProjection;
  readonly vaultRoot?: string;
  readonly useEventCandidateSimilarity?: boolean;
  readonly policyMode?: AttributionPolicyMode;
  readonly policyTelemetry?: AttributionPolicyTelemetry;
}

const aggregateIdForInferredAttribution = (canonicalUrl: string): string =>
  `url-inferred:${canonicalUrl}`;

const clientEventIdForResolution = (result: UrlResolutionResult): string =>
  [
    'url-inferred',
    result.canonicalUrl,
    result.policyMode,
    result.decision.workstreamId ?? 'none',
    result.reasons.dependencyKey,
  ].join(':');

const projectUrlsFromStoreOrLog = async (
  eventLog: EventLog,
  vaultRoot: string | undefined,
): Promise<UrlProjection> => {
  if (vaultRoot === undefined) return projectUrls(await eventLog.readMerged());
  const store = await getCaughtUpSharedEventStore(vaultRoot);
  if (store === null) return projectUrls(await eventLog.readMerged());
  const accumulator = createEmptyUrlProjectionAccumulator();
  await store.forEachChunk((chunk) => {
    for (const event of chunk) foldEventIntoUrlProjectionAccumulator(accumulator, event);
  }, 2000);
  return urlProjectionFromAccumulator(accumulator);
};

export const autoApplyUrlAttribution = async (
  input: AutoApplyUrlAttributionInput,
): Promise<AutoApplyUrlAttributionResult> => {
  const beforeEvents = input.events ?? (await input.eventLog.readMerged());
  const beforeProjection =
    input.urlProjection === undefined
      ? input.events === undefined
        ? await projectUrlsFromStoreOrLog(input.eventLog, input.vaultRoot)
        : projectUrls(beforeEvents)
      : deserializeUrlProjection(input.urlProjection);
  const existing = beforeProjection.byCanonicalUrl.get(input.canonicalUrl)?.currentAttribution;
  const resolution = resolveUrlAttribution({
    canonicalUrl: input.canonicalUrl,
    snapshot: input.snapshot,
    events: beforeEvents,
    ...(input.useEventCandidateSimilarity === undefined
      ? {}
      : { useEventCandidateSimilarity: input.useEventCandidateSimilarity }),
    ...(input.policyMode === undefined ? {} : { policyMode: input.policyMode }),
    ...(input.policyTelemetry === undefined ? {} : { policyTelemetry: input.policyTelemetry }),
  });

  // Env gate. We compute the resolution either way (cheap, side-effect-free)
  // so the response surface in dryRun-like calls stays consistent. We just
  // don't commit the event when auto-apply is off.
  if (!autoApplyEnabled()) {
    return {
      status: 'skipped-disabled',
      resolution,
      projection: beforeProjection,
    };
  }

  if (existing !== undefined && existing.source !== 'inferred') {
    return {
      status: 'skipped-existing-attribution',
      resolution,
      projection: beforeProjection,
    };
  }

  // Ignored URLs never get auto-attributed. User explicitly said
  // "don't bother me." Reversible — re-organizing the URL into a
  // workstream clears the ignore flag (via upsertAttribution).
  const ignored = beforeProjection.byCanonicalUrl.get(input.canonicalUrl)?.currentIgnored;
  if (ignored !== undefined) {
    return {
      status: 'skipped-ignored',
      resolution,
      projection: beforeProjection,
    };
  }

  // Grace window: a freshly-captured URL must stay a triageable Inbox
  // row on its first observation, instead of being auto-filed before
  // the user can even see it (the reported "graph-adjacent page
  // auto-attributed to a workstream, never an Inbox row"). visitCount
  // is incremented per observe (1 = seen exactly once). Auto-apply
  // only assists on a revisit (>= 2) when still high-confidence — the
  // user's manual decision on the first visit always wins. An
  // already-inferred record is exempt so re-runs/idempotency still
  // reconcile.
  const record = beforeProjection.byCanonicalUrl.get(input.canonicalUrl);
  if (existing?.source !== 'inferred' && (record === undefined || record.visitCount <= 1)) {
    return {
      status: 'skipped-grace-window',
      resolution,
      projection: beforeProjection,
    };
  }

  const payload = inferredUrlAttributionPayloadFromResolution(resolution);
  if (payload === null) {
    return {
      status: 'skipped-policy',
      resolution,
      projection: beforeProjection,
    };
  }

  // Idempotency: if an inferred attribution already points to the
  // same workstream, re-appending only changes the dependencyKey-laden
  // clientEventId and produces an event that's byte-different but
  // semantically identical. That feedback loop ran 344 inferred events
  // for 15 visits in the cross-replica e2e and starved the peer event
  // budget. Skip when the decision matches the current inferred state.
  if (existing?.source === 'inferred' && existing.workstreamId === payload.workstreamId) {
    return {
      status: 'skipped-existing-attribution',
      resolution,
      projection: beforeProjection,
    };
  }

  const accepted = await input.eventLog.appendServerObserved({
    clientEventId: clientEventIdForResolution(resolution),
    aggregateId: aggregateIdForInferredAttribution(input.canonicalUrl),
    type: URL_ATTRIBUTION_INFERRED,
    payload: { ...payload },
  });
  if (input.urlProjection !== undefined) {
    const accumulator = urlProjectionAccumulatorFromSerialized(
      serializeUrlProjection(beforeProjection),
    );
    foldEventIntoUrlProjectionAccumulator(accumulator, accepted);
    return {
      status: 'applied',
      resolution,
      accepted,
      projection: urlProjectionFromAccumulator(accumulator),
    };
  }

  return {
    status: 'applied',
    resolution,
    accepted,
    projection: await projectUrlsFromStoreOrLog(input.eventLog, input.vaultRoot),
  };
};
