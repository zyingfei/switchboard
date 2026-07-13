import {
  confidenceLevelFromProbability,
  confidenceLevelLabel,
  probabilityFromLogit,
} from '../suggestion/confidence';
import type { TabSessionResolutionResult, TabSessionWorkstreamOption } from './types';

// Stage 5 polish — surface the resolver's confidence in human-readable
// terms while keeping the raw numbers available on hover. The
// resolver hands us:
//   - `rawFusionLogit`: real number, log-odds for the top workstream
//     (typically [-5, +5] in practice).
//   - `decision.margin`: gap to the runner-up; larger = clearer winner.
//     Used now as the tie gate — when below TIED_MARGIN_THRESHOLD the
//     level becomes "No clear pick" regardless of how high the logit
//     looks (the model is admitting it can't separate top-1 from
//     top-2; the UI shouldn't invent a winner). Shared with
//     NeedsOrganizeSuggestion (All-Threads) so both surfaces speak
//     the same confidence — labels AND tie-handling — for the same
//     row, against the same resolver (tabsession-resolver-v1).
//   - `dominantSource`: which signal weighed most (ppr / similarity /
//     cluster).

const sourceLabel = (source: 'ppr' | 'similarity' | 'cluster' | 'none'): string => {
  switch (source) {
    case 'ppr':
      return 'related visits';
    case 'similarity':
      return 'similar content';
    case 'cluster':
      return 'topic cluster';
    case 'none':
      return 'no signal';
  }
};

const workstreamLabel = (
  workstreamId: string | undefined,
  workstreams: readonly TabSessionWorkstreamOption[],
): string =>
  workstreamId === undefined
    ? '?'
    : (workstreams.find((w) => w.bac_id === workstreamId)?.path ?? '(removed)');

export interface SuggestionStatsProps {
  readonly suggestion?: TabSessionResolutionResult;
  readonly workstreams: readonly TabSessionWorkstreamOption[];
  // Hide alternatives by default to keep the panel scannable; the
  // primary stats line always renders.
  readonly showAlternatives?: boolean;
  // Stage 5 polish — when the caller wants a visible placeholder for
  // the "resolver returned nothing" case (cold-start URLs, brand-new
  // domains), pass `showEmptyPlaceholder`. Used by the Current Tab
  // card so the user sees an explanation instead of a blank gap.
  readonly showEmptyPlaceholder?: boolean;
  // UX4 — Now-tab compact mode. Inbox triage wants the full
  // "signal: similarity · margin 0.51 · Other candidates: …"
  // breakdown; the Now card just wants the headline (target +
  // confidence). When `compact` is true, the signal row and
  // alternatives row are tucked behind a "details" disclosure.
  readonly compact?: boolean;
  // When page-access (engagement) isn't granted, visit-similarity — the
  // resolver's dominant signal — can never fire, because a visit is only
  // similarity-eligible after ≥5s of focused engagement (which needs the
  // engagement content script). In that state the empty placeholder
  // explains *that's* why and offers the one-click grant, instead of the
  // misleading "first time seeing this URL". `undefined` = unknown
  // (older callers) → keep the original placeholder.
  readonly pageAccessGranted?: boolean;
  readonly onGrantAccess?: () => void;
  // How many times this URL has been visited (from the projection's
  // UrlVisitRecord.visitCount). When the resolver returns zero candidates
  // AND this is a REVISIT (>1), the empty card should say "seen N times —
  // no connections yet" rather than the misleading "first time seeing this
  // URL": the user knows they've been here, and the honest signal is that
  // attribution hasn't found a link yet (often because the >=5s-engagement
  // visit-similarity gate never produced edges). `undefined`/≤1 keeps the
  // original first-seen copy.
  readonly visitCount?: number;
}

export function SuggestionStats({
  suggestion,
  workstreams,
  showAlternatives = false,
  showEmptyPlaceholder = false,
  compact = false,
  pageAccessGranted,
  onGrantAccess,
  visitCount,
}: SuggestionStatsProps) {
  if (suggestion === undefined) {
    // Distinct from "fetched but empty" below — the suggestion has not
    // come back from the companion yet. Saying "No signal yet" here is
    // a lie: we haven't *checked* yet. Render a loading affordance so
    // the user doesn't conclude the resolver gave up before it ran.
    if (!showEmptyPlaceholder) return null;
    return (
      <div className="suggestion-stats is-loading">
        <span className="suggestion-stats-row">
          <span className="suggestion-stats-target subtle">Checking signals…</span>
        </span>
        <span className="suggestion-stats-source mono subtle">
          Asking the companion for related visits, similarity, and topic membership
        </span>
      </div>
    );
  }
  if (suggestion.fusedCandidates.length === 0) {
    if (!showEmptyPlaceholder) return null;
    // Page access off → the similarity signal can't fire at all (every
    // visit fails the ≥5s engagement gate), so the resolver returns
    // empty for *everything*, not just brand-new URLs. Surface the real
    // reason + the fix instead of the generic first-seen copy.
    if (pageAccessGranted === false) {
      return (
        <div className="suggestion-stats is-empty needs-access">
          <span className="suggestion-stats-row">
            <span className="suggestion-stats-target subtle">No signal — page access off</span>
            <span
              className="suggestion-stats-info"
              title={
                'Attribution leans on page engagement: Sidetrack relates a page to your ' +
                'workstreams from how its content + dwell resemble pages you’ve worked in. ' +
                'Without page access it only sees the URL + title, so it can’t relate new pages ' +
                '— every page reads "no signal". Grant access (focus / scroll / copy stay local) ' +
                'to turn this on for pages you read going forward.'
              }
            >
              ⓘ
            </span>
          </span>
          <span className="suggestion-stats-source mono subtle">
            Attribution needs page engagement.{' '}
            {onGrantAccess !== undefined ? (
              <button type="button" className="btn-link suggestion-stats-grant" onClick={onGrantAccess}>
                Grant access
              </button>
            ) : (
              <>Enable it in the “Deeper page access” banner.</>
            )}
          </span>
        </div>
      );
    }
    // The resolver needs ≥1 of these three to fire for a URL:
    //   - PPR adjacency to a workstream (related visit edges exist)
    //   - Visit similarity score above threshold (a workstream page
    //     looks textually similar)
    //   - Topic cluster posterior > 0 (URL belongs to a topic that
    //     has dominant workstream attribution)
    // For a brand-new URL on a new host with no prior context, all
    // three are zero — that's not a bug, it's "we don't know yet".
    // The Graph button (⇄ Graph in the Current Tab / Inbox card head
    // row) is the diagnostic affordance: clicking it shows whether
    // the neighborhood exists at all.
    //
    // Distinguish a REVISIT from a genuine first visit: if the projection
    // has already seen this URL more than once, "First time seeing this
    // URL" is a lie the user can spot. Say so honestly — the real signal
    // is "seen N times, still no connections" (typically because the
    // ≥5s-engagement visit-similarity gate never yielded edges). First
    // visits keep the original copy.
    const isRevisit = typeof visitCount === 'number' && visitCount > 1;
    return (
      <div className="suggestion-stats is-empty">
        <span className="suggestion-stats-row">
          <span className="suggestion-stats-target subtle">
            {isRevisit ? 'No connections yet' : 'No signal yet'}
          </span>
          <span
            className="suggestion-stats-info"
            title={
              (isRevisit
                ? `Seen ${String(visitCount)} times, but attribution hasn’t linked this URL yet.\n`
                : '') +
              'Sidetrack checked three signals and all came up empty:\n' +
              '· no related visits link to a workstream (PPR=0)\n' +
              '· no workstream pages look similar (similarity=0)\n' +
              '· this URL is not in any topic cluster yet (topic=0)\n\n' +
              'Click "⇄ Graph" to see what Sidetrack does know about this URL, ' +
              'or move similar pages to a workstream to teach the resolver.'
            }
          >
            ⓘ
          </span>
        </span>
        <span className="suggestion-stats-source mono subtle">
          {isRevisit
            ? `Seen ${String(visitCount)} times — no connections yet, hover ⓘ for what was checked`
            : 'First time seeing this URL — hover ⓘ for what was checked'}
        </span>
      </div>
    );
  }
  const top = suggestion.fusedCandidates[0];
  if (top === undefined) return null;
  const probability = probabilityFromLogit(top.rawFusionLogit);
  const margin = suggestion.decision.margin;
  const level = confidenceLevelFromProbability(probability, { margin });
  const label = workstreamLabel(top.workstreamId, workstreams);
  const isTied = level === 'no-clear-pick';
  // When the leader's margin is tiny the resolver is admitting it
  // can't separate the top candidates. Force the alternatives row on
  // so the user sees the near-ties instead of an invented winner.
  const showAlts = showAlternatives || isTied;
  const tooltip =
    `Confidence: ${Math.round(probability * 100)}% (${confidenceLevelLabel(level)}).\n` +
    `Raw logit ${top.rawFusionLogit.toFixed(2)} ` +
    `(higher = more confident, typically -5 to +5).\n` +
    `Margin to runner-up: ${margin.toFixed(2)} (bigger = clearer winner).\n` +
    `Dominant signal: ${top.dominantSource} — ${sourceLabel(top.dominantSource)}.`;
  const alternatives = showAlts
    ? suggestion.fusedCandidates.slice(1, 3).map((cand) => {
        const altProbability = probabilityFromLogit(cand.rawFusionLogit);
        return {
          path: workstreamLabel(cand.workstreamId, workstreams),
          // Alternatives are scored individually — they aren't the
          // leader, so the tie gate doesn't apply to them.
          level: confidenceLevelFromProbability(altProbability),
          probability: altProbability,
        };
      })
    : [];
  // UX4 — in compact mode the signal + alternatives rows tuck into
  // a <details> disclosure so the headline (target + confidence) is
  // the only thing the user sees at rest. The tooltip on the info
  // chip still surfaces the same numbers for power users.
  const detail = (
    <>
      <span className="suggestion-stats-source mono">
        signal: {top.dominantSource} ({sourceLabel(top.dominantSource)}) · margin{' '}
        {margin.toFixed(2)}
      </span>
      {alternatives.length > 0 ? (
        <span className="suggestion-stats-alts">
          <span className="muted">{isTied ? 'Near-tied candidates:' : 'Other candidates:'}</span>
          {alternatives.map((alt, i) => (
            <span key={`${alt.path}-${String(i)}`} className="suggestion-stats-alt">
              {alt.path} · {confidenceLevelLabel(alt.level)} ({Math.round(alt.probability * 100)}%)
            </span>
          ))}
        </span>
      ) : null}
    </>
  );
  return (
    <div className={`suggestion-stats is-${level}${compact ? ' is-compact' : ''}`}>
      <span className="suggestion-stats-row">
        <span className="suggestion-stats-target">{label}</span>
        <span className="suggestion-stats-confidence">
          {confidenceLevelLabel(level)} · {Math.round(probability * 100)}%
        </span>
        <span className="suggestion-stats-info" title={tooltip} aria-label={tooltip}>
          ⓘ
        </span>
      </span>
      {compact ? (
        <details className="suggestion-stats-details">
          <summary className="suggestion-stats-details-summary">Why</summary>
          {detail}
        </details>
      ) : (
        detail
      )}
    </div>
  );
}
