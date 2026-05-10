import type { ConnectionsSnapshot } from '../connections/types.js';
import type { AcceptedEvent } from '../sync/causal.js';
import type { EventLog } from '../sync/eventLog.js';
import { TAB_SESSION_ATTRIBUTION_INFERRED } from './events.js';
import type { AttributionPolicyMode, AttributionPolicyTelemetry } from './policy.js';
import { projectTabSessions, type TabSessionProjection } from './projection.js';
import {
  inferredAttributionPayloadFromResolution,
  resolveAttribution,
  type ResolutionResult,
} from './resolver.js';

export type AutoApplyTabSessionAttributionStatus =
  | 'applied'
  | 'skipped-existing-attribution'
  | 'skipped-policy';

export interface AutoApplyTabSessionAttributionResult {
  readonly status: AutoApplyTabSessionAttributionStatus;
  readonly resolution: ResolutionResult;
  readonly accepted?: AcceptedEvent;
  readonly projection: TabSessionProjection;
}

export interface AutoApplyTabSessionAttributionInput {
  readonly eventLog: EventLog;
  readonly snapshot: ConnectionsSnapshot;
  readonly tabSessionId: string;
  readonly policyMode?: AttributionPolicyMode;
  readonly policyTelemetry?: AttributionPolicyTelemetry;
}

const aggregateIdForInferredAttribution = (tabSessionId: string): string =>
  `tabsession-inferred:${tabSessionId}`;

const clientEventIdForResolution = (result: ResolutionResult): string =>
  [
    'tabsession-inferred',
    result.tabSessionId,
    result.policyMode,
    result.decision.workstreamId ?? 'none',
    result.reasons.dependencyKey,
  ].join(':');

export const autoApplyTabSessionAttribution = async (
  input: AutoApplyTabSessionAttributionInput,
): Promise<AutoApplyTabSessionAttributionResult> => {
  const beforeEvents = await input.eventLog.readMerged();
  const beforeProjection = projectTabSessions(beforeEvents);
  const existing = beforeProjection.bySessionId.get(input.tabSessionId)?.currentAttribution;
  const resolution = resolveAttribution({
    tabSessionId: input.tabSessionId,
    snapshot: input.snapshot,
    projection: beforeProjection,
    events: beforeEvents,
    ...(input.policyMode === undefined ? {} : { policyMode: input.policyMode }),
    ...(input.policyTelemetry === undefined ? {} : { policyTelemetry: input.policyTelemetry }),
  });

  if (existing !== undefined && existing.source !== 'inferred') {
    return {
      status: 'skipped-existing-attribution',
      resolution,
      projection: beforeProjection,
    };
  }

  const payload = inferredAttributionPayloadFromResolution(resolution);
  if (payload === null) {
    return {
      status: 'skipped-policy',
      resolution,
      projection: beforeProjection,
    };
  }

  const aggregateId = aggregateIdForInferredAttribution(input.tabSessionId);
  const accepted = await input.eventLog.appendServerObserved({
    clientEventId: clientEventIdForResolution(resolution),
    aggregateId,
    type: TAB_SESSION_ATTRIBUTION_INFERRED,
    payload: { ...payload },
  });

  return {
    status: 'applied',
    resolution,
    accepted,
    projection: projectTabSessions(await input.eventLog.readMerged()),
  };
};
