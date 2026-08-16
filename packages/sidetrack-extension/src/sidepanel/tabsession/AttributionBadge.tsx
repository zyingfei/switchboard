import { isLaneFallbackCandidate, LANE_FALLBACK_PICK_TITLE } from './laneFallbackPick';
import { endorsementFor } from './suggestionEndorsement';
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
//   suggested: resolver ENDORSED this guess (policy suggest/auto-apply, dashed)
//   weak-guess: resolver has a lean but did NOT endorse it (policy inbox —
//               below the score/margin/corroboration gates). Rendered muted
//               so it never masquerades as a real suggestion.
//   ignored: user said "don't bother me about this URL" (struck-through)
//   empty: no attribution, no suggestion (placeholder)
type BadgeVariant =
  | 'user-asserted'
  | 'inferred'
  | 'thread'
  | 'suggested'
  | 'weak-guess'
  | 'ignored'
  | 'empty';

const variantFor = (
  attribution: TabSessionRecord['currentAttribution'] | undefined,
  ignored: TabSessionRecord['currentIgnored'] | undefined,
  guess: 'endorsed' | 'weak' | 'none',
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
  if (guess === 'endorsed') return 'suggested';
  if (guess === 'weak') return 'weak-guess';
  return 'empty';
};

const titleFor = (
  variant: BadgeVariant,
  label: string,
  // The weak lean came from the companion's lane fallback (no fusion at all,
  // page-content evidence only). Same muted 'weak-guess' variant — the badge
  // must not gain a new visual state for it — but the hover text has to tell
  // the truth about WHERE the name came from, because "isn't confident enough
  // to suggest it" implies a fusion score that never existed here.
  laneFallback = false,
): string => {
  if (variant === 'weak-guess' && laneFallback) {
    return `Unconfirmed: ${label} — ${LANE_FALLBACK_PICK_TITLE}`;
  }
  switch (variant) {
    case 'user-asserted':
      return `Moved here by you: ${label}`;
    case 'inferred':
      return `Auto-suggested — click to confirm or change: ${label}`;
    case 'thread':
      return `From thread attribution: ${label}`;
    case 'suggested':
      return `Suggested by Sidetrack: ${label}`;
    case 'weak-guess':
      return `Weak guess — filed to inbox. Sidetrack leans toward ${label} but isn’t confident enough to suggest it. Confirm or pick another to teach it.`;
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
    case 'weak-guess':
      // Question mark = "a lean, not a decision."
      return '?';
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
  // The resolver's guess lives in decision.workstreamId ONLY when the policy
  // endorsed it (suggest / auto-apply). For an action:'inbox' decision that
  // field is absent — the top fused candidate carries the (un-endorsed) lean.
  // endorsementFor() is the single source of truth so the badge, provenance
  // row, and impression emit all agree on "did the policy endorse this?".
  const endorsement = endorsementFor(suggestion);
  const suggestedWorkstreamId = endorsement.workstreamId ?? null;
  const guess: 'endorsed' | 'weak' | 'none' =
    endorsement.level === 'endorsed'
      ? 'endorsed'
      : endorsement.level === 'weak-guess'
        ? 'weak'
        : 'none';
  const variant = variantFor(attribution, ignored, guess);
  // Only meaningful for the un-endorsed lean (a real attribution or an endorsed
  // suggestion never carries a synthesized candidate).
  const laneFallback = isLaneFallbackCandidate(suggestion?.fusedCandidates[0]);
  // The lane-fallback pick already renders a full "Unconfirmed — from page
  // content (AI-assisted)" chip immediately beside this badge; keeping the '?'
  // marker too made the header read "?ai" — two hedges for one fact (live
  // report, 2026-07-28). The marker stays for the ORDINARY weak-guess, where
  // it is the only uncertainty signal.
  const marker = laneFallback ? null : markerFor(variant);
  // No attribution and no guess: show a muted dash, not a confusing "?" — the
  // tooltip and the provenance row already say "No attribution".
  const namedLabel =
    variant === 'empty'
      ? '—'
      : ignored !== undefined
        ? 'ignored'
        : workstreamLabel(attribution?.workstreamId ?? suggestedWorkstreamId, workstreams);
  // Fusion HELD (no candidates reached fusion) and this lean is the
  // synthesized below-floor lane-fallback pick — showing the workstream name
  // in the "In workstream:" badge reads as a real, endorsed filing even
  // though nothing was filed. Say the neutral thing instead; the actual
  // guessed name still lives in the tooltip (titleFor uses `namedLabel`) and
  // in SuggestionStats' "Below confidence bar — possibilities" list.
  const label = variant === 'weak-guess' && laneFallback ? 'No good guess yet' : namedLabel;
  return (
    <span
      className={`tab-session-badge is-${variant}`}
      title={titleFor(variant, namedLabel, laneFallback)}
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
