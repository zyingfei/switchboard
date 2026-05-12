import type { ConnectionsSnapshot } from '../connections/types.js';
import type { AttributionPolicyMode, AttributionPolicyTelemetry } from '../tabsession/policy.js';
import {
  inferredUrlAttributionPayloadFromResolution,
  resolveUrlAttribution,
  type UrlResolutionResult,
} from '../tabsession/resolver.js';
import type { AcceptedEvent } from '../sync/causal.js';
import type { EventLog } from '../sync/eventLog.js';
import { URL_ATTRIBUTION_INFERRED } from './events.js';
import { projectUrls, type UrlProjection } from './projection.js';

export type AutoApplyUrlAttributionStatus =
  | 'applied'
  | 'skipped-existing-attribution'
  | 'skipped-ignored'
  | 'skipped-policy'
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

export const autoApplyUrlAttribution = async (
  input: AutoApplyUrlAttributionInput,
): Promise<AutoApplyUrlAttributionResult> => {
  const beforeEvents = await input.eventLog.readMerged();
  const beforeProjection = projectUrls(beforeEvents);
  const existing = beforeProjection.byCanonicalUrl.get(input.canonicalUrl)?.currentAttribution;
  const resolution = resolveUrlAttribution({
    canonicalUrl: input.canonicalUrl,
    snapshot: input.snapshot,
    events: beforeEvents,
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

  const payload = inferredUrlAttributionPayloadFromResolution(resolution);
  if (payload === null) {
    return {
      status: 'skipped-policy',
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

  return {
    status: 'applied',
    resolution,
    accepted,
    projection: projectUrls(await input.eventLog.readMerged()),
  };
};
