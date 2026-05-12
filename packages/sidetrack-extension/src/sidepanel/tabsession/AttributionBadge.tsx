import type {
  TabSessionRecord,
  TabSessionResolutionResult,
  TabSessionWorkstreamOption,
} from './types';

const workstreamLabel = (
  workstreamId: string | null | undefined,
  workstreams: readonly TabSessionWorkstreamOption[],
): string => {
  if (workstreamId === null || workstreamId === undefined) return '?';
  // If the referenced workstream is gone (user deleted it after attribution
  // landed) fall back to a human marker instead of leaking the raw bac_id.
  return (
    workstreams.find((workstream) => workstream.bac_id === workstreamId)?.path ??
    '(removed)'
  );
};

// Visual state distinguishes how a URL ended up attributed:
//   user-asserted: you moved it (solid, no extra marker)
//   inferred: resolver auto-applied it (solid + sparkle marker)
//   thread: derived from thread→workstream membership (solid + thread marker)
//   suggested: not yet applied, resolver has a guess (dashed)
//   empty: no attribution, no suggestion (placeholder)
type BadgeVariant = 'user-asserted' | 'inferred' | 'thread' | 'suggested' | 'empty';

const variantFor = (
  attribution: TabSessionRecord['currentAttribution'] | undefined,
  suggested: boolean,
): BadgeVariant => {
  if (attribution !== undefined && attribution.workstreamId !== null) {
    if (attribution.source === 'inferred') return 'inferred';
    if (attribution.source === 'thread') return 'thread';
    return 'user-asserted';
  }
  return suggested ? 'suggested' : 'empty';
};

const titleFor = (variant: BadgeVariant, label: string): string => {
  switch (variant) {
    case 'user-asserted':
      return `Moved here by you: ${label}`;
    case 'inferred':
      return `Auto-suggested — click to confirm or change: ${label}`;
    case 'thread':
      return `From thread attribution: ${label}`;
    case 'suggested':
      return `Suggested by Sidetrack: ${label}`;
    case 'empty':
      return 'No attribution';
  }
};

const markerFor = (variant: BadgeVariant): string | null => {
  switch (variant) {
    case 'inferred':
      // Sparkle = "this came from the resolver, not you."
      return '✨';
    case 'thread':
      // Loop = "derived from a thread relationship."
      return '↺';
    case 'user-asserted':
    case 'suggested':
    case 'empty':
      return null;
  }
};

export interface AttributionBadgeProps {
  readonly record?: TabSessionRecord;
  readonly suggestion?: TabSessionResolutionResult;
  readonly workstreams: readonly TabSessionWorkstreamOption[];
}

export function AttributionBadge({ record, suggestion, workstreams }: AttributionBadgeProps) {
  const attribution = record?.currentAttribution;
  const suggestedWorkstreamId = suggestion?.decision.workstreamId;
  const label = workstreamLabel(attribution?.workstreamId ?? suggestedWorkstreamId, workstreams);
  const variant = variantFor(attribution, suggestedWorkstreamId !== undefined);
  const marker = markerFor(variant);
  return (
    <span
      className={`tab-session-badge is-${variant}`}
      title={titleFor(variant, label)}
      data-attribution-variant={variant}
    >
      {marker !== null ? <span className="tab-session-badge-marker" aria-hidden>{marker}</span> : null}
      <span className="tab-session-badge-label">{label}</span>
    </span>
  );
}
