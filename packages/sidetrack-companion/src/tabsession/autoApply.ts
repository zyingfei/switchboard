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
  | 'skipped-policy'
  | 'skipped-disabled';

// Env gate. Auto-apply is ON by default; the env is an opt-OUT for
// users who want preview-only behavior. Set
// SIDETRACK_TABSESSION_RESOLVER_AUTO_APPLY=0 (or 'false') to disable.
// Auto-apply is reversible: the user's manual `user_asserted` move
// always beats the synthesized `inferred` attribution on precedence
// tie-break. Mirrors the URL-level gate in `urls/autoApply.ts`.
export const TABSESSION_RESOLVER_AUTO_APPLY_ENV =
  'SIDETRACK_TABSESSION_RESOLVER_AUTO_APPLY';

const autoApplyEnabled = (): boolean => {
  const raw = process.env[TABSESSION_RESOLVER_AUTO_APPLY_ENV];
  if (raw === undefined || raw === '') return true;
  return raw !== '0' && raw.toLowerCase() !== 'false';
};

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

  // Env gate. We compute the resolution either way (cheap, side-effect-free)
  // so the response surface in dryRun-like calls stays consistent. We just
  // don't commit the event when auto-apply is off. Mirrors the URL gate.
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
