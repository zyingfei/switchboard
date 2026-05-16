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
  return workstreams.find((workstream) => workstream.bac_id === workstreamId)?.path ?? '(removed)';
};

// Visual state distinguishes how a URL ended up attributed:
//   user-asserted: you moved it (solid, no extra marker)
//   inferred: resolver auto-applied it (solid + sparkle marker)
//   thread: derived from thread→workstream membership (dotted + loop)
//   suggested: not yet applied, resolver has a guess (dashed)
//   ignored: user said "don't bother me about this URL" (struck-through)
//   empty: no attribution, no suggestion (placeholder)
type BadgeVariant = 'user-asserted' | 'inferred' | 'thread' | 'suggested' | 'ignored' | 'empty';

const variantFor = (
  attribution: TabSessionRecord['currentAttribution'] | undefined,
  ignored: TabSessionRecord['currentIgnored'] | undefined,
  suggested: boolean,
): BadgeVariant => {
  // Real user-asserted attribution wins over an existing ignore — the
  // projection mutator clears ignored on re-organize. Defensive fallback
  // here too in case the two coexist for any reason.
  if (attribution !== undefined && attribution.workstreamId !== null) {
    if (attribution.source === 'inferred') return 'inferred';
    if (attribution.source === 'thread') return 'thread';
    return 'user-asserted';
  }
  if (ignored !== undefined) return 'ignored';
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
    case 'ignored':
      return 'Ignored — you said don’t bother me about this URL';
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
    case 'ignored':
      // Slash = "muted / dismissed."
      return '⊘';
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
  const ignored = record?.currentIgnored;
  const suggestedWorkstreamId = suggestion?.decision.workstreamId;
  const label =
    ignored !== undefined
      ? 'ignored'
      : workstreamLabel(attribution?.workstreamId ?? suggestedWorkstreamId, workstreams);
  const variant = variantFor(attribution, ignored, suggestedWorkstreamId !== undefined);
  const marker = markerFor(variant);
  return (
    <span
      className={`tab-session-badge is-${variant}`}
      title={titleFor(variant, label)}
      data-attribution-variant={variant}
    >
      {marker !== null ? (
        <span className="tab-session-badge-marker" aria-hidden>
          {marker}
        </span>
      ) : null}
      <span className="tab-session-badge-label">{label}</span>
    </span>
  );
}
