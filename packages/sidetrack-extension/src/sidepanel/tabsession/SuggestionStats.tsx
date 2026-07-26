import {
  coarseConfidenceWord,
  confidenceLevelFromProbability,
  confidenceLevelLabel,
  probabilityFromLogit,
} from '../suggestion/confidence';
import { GuessLanes } from './GuessLanes';
import { type Possibilities, possibilitiesFrom, suggestionStateFrom } from './resolveOutcome';
import { dominantSourceLabel, endorsementFor } from './suggestionEndorsement';
import {
  guessLaneSignalCount,
  type ResolveOutcomeError,
  type TabSessionResolutionResult,
  type TabSessionWorkstreamOption,
} from './types';

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

const workstreamLabel = (
  workstreamId: string | undefined,
  workstreams: readonly TabSessionWorkstreamOption[],
): string =>
  workstreamId === undefined
    ? '?'
    : (workstreams.find((w) => w.bac_id === workstreamId)?.path ?? '(removed)');

// Compact rendering of the resolver's ranked "Possibilities" — one row per
// candidate: workstream name · plain-word source (dominantSourceLabel) ·
// coarse confidence word (coarseConfidenceWord) · one-click "File here"
// (the EXISTING pick/move flow, passed as onFileHere). No new backend: every
// row files through the same handler the "Yes, that's right" / "Pick
// another…" actions use.
//
// Two shapes, driven by possibilities.hasPrimary:
//   - hasPrimary → a "▸ Other possibilities (N)" <details> disclosure that
//     sits under the prominent endorsed suggestion (already shown above).
//     Collapsed by default so the card stays scannable.
//   - !hasPrimary → the key honesty case the user means: NO confident primary
//     is shown (every candidate is below the policy's confidence bar), so the
//     ranked possibilities ARE the whole story. Surface them openly under
//     "Below confidence bar — possibilities:" instead of the misleading
//     "No signal yet".
function PossibilitiesList({
  possibilities,
  workstreams,
  onFileHere,
}: {
  readonly possibilities: Possibilities;
  readonly workstreams: readonly TabSessionWorkstreamOption[];
  readonly onFileHere?: (workstreamId: string) => void;
}) {
  const { others, hasPrimary } = possibilities;
  if (others.length === 0) return null;
  const rows = others.map((row) => {
    const label = workstreamLabel(row.workstreamId, workstreams);
    const sourceWords = dominantSourceLabel(row.dominantSource);
    const confidenceWord = coarseConfidenceWord(row.level);
    return (
      <li key={`${row.workstreamId}-${String(row.rank)}`} className="suggestion-possibility">
        <span className="suggestion-possibility-name">{label}</span>
        <span className="suggestion-possibility-source mono subtle">· {sourceWords}</span>
        {confidenceWord !== null ? (
          <span className="suggestion-possibility-confidence mono subtle">· {confidenceWord}</span>
        ) : null}
        {onFileHere !== undefined ? (
          <button
            type="button"
            className="btn-link suggestion-possibility-file"
            onClick={() => {
              onFileHere(row.workstreamId);
            }}
            title={`File this page to ${label}`}
          >
            File here
          </button>
        ) : null}
      </li>
    );
  });
  if (hasPrimary) {
    // Collapsed tail under the prominent primary suggestion.
    return (
      <details className="suggestion-possibilities is-collapsible">
        <summary className="suggestion-possibilities-summary">
          Other possibilities ({String(others.length)})
        </summary>
        <ul className="suggestion-possibilities-list">{rows}</ul>
      </details>
    );
  }
  // Expanded — no primary; the possibilities are the whole answer.
  return (
    <div className="suggestion-possibilities is-below-bar">
      <span className="suggestion-possibilities-header mono subtle">
        Below confidence bar — possibilities:
      </span>
      <ul className="suggestion-possibilities-list">{rows}</ul>
    </div>
  );
}

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
  // The last resolve REQUEST for this URL failed (500 / timeout / network)
  // rather than returning an empty result. Rendered as a distinct, honest
  // "companion is busy — retrying" state instead of the misleading "No
  // signal yet" card — during a heavy drain the batch-resolve route 500s
  // ("database is locked") for 20+ seconds, and a page the user has
  // visited repeatedly must not read as "First time seeing this URL". The
  // caller retries on its existing poll cadence; no user action is needed.
  // A populated `suggestion` still wins (see suggestionStateFrom).
  readonly error?: ResolveOutcomeError;
  // The user's ask ("I want to see ALL possibilities when a page is
  // indexed"): render the resolver's FULL ranked candidate list — not just
  // the single top pick — as a compact "Possibilities" list, each row
  // one-click filable via this callback (the EXISTING pick/move flow;
  // handleUrlAttribute on the Current Tab card). When omitted the list still
  // renders read-only (no "File here" button), so the surface degrades
  // cleanly for callers that don't wire filing. `undefined` on the whole
  // prop = the legacy single-suggestion card (list suppressed).
  readonly onFileHere?: (workstreamId: string) => void;
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
  error,
  onFileHere,
}: SuggestionStatsProps) {
  // error !== empty !== pending !== populated — the discriminant that
  // keeps a failed resolve from masquerading as a confident empty card.
  const state = suggestionStateFrom({
    ...(suggestion === undefined ? {} : { suggestion }),
    ...(error === undefined ? {} : { error }),
  });
  if (state === 'error') {
    // A resolve failure, not "no signal". Never render the placeholder-off
    // path silently here: even callers that hide the empty placeholder want
    // the user to know the answer is stale-because-busy, not absent.
    if (!showEmptyPlaceholder) return null;
    return (
      <div className="suggestion-stats is-busy">
        <span className="suggestion-stats-row">
          <span className="suggestion-stats-target">Companion is busy — retrying</span>
          <span
            className="suggestion-stats-info"
            title={
              'Sidetrack couldn’t reach the resolver just now (the companion is busy ' +
              'catching up on a capture drain). This is NOT "no signal" — the check ' +
              'hasn’t completed. It retries automatically on the next refresh; no action needed.'
            }
          >
            ⓘ
          </span>
        </span>
        <span className="suggestion-stats-source mono subtle">
          Retrying automatically — the resolver is catching up
        </span>
      </div>
    );
  }
  if (state === 'pending') {
    // Distinct from "fetched but empty" below — the suggestion has not
    // come back from the companion yet. Saying "No signal yet" here is
    // a lie: we haven't *checked* yet. Render a loading affordance so
    // the user doesn't conclude the resolver gave up before it ran.
    if (!showEmptyPlaceholder) return null;
    return (
      <div className="suggestion-stats is-loading">
        <span className="suggestion-stats-row">
          <span className="suggestion-stats-target subtle">Checking connections…</span>
        </span>
        <span className="suggestion-stats-source mono subtle">
          Asking the companion for related visits, similar pages, and topic membership
        </span>
      </div>
    );
  }
  // From here the state is 'empty' or 'populated'; `suggestion` is defined.
  if (suggestion !== undefined && suggestion.fusedCandidates.length === 0) {
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
              <button
                type="button"
                className="btn-link suggestion-stats-grant"
                onClick={onGrantAccess}
              >
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
    // Guess-lanes honesty (the feature's b-part): the FUSION abstained
    // (zero fused candidates), but that does NOT mean every lane was silent —
    // the graph lane may have a weak edge, the recency lane a recent filing,
    // etc. When at least one lane produced a candidate, a bare "No signal
    // yet"/"No connections yet" headline is a falsehood the user can spot:
    // there IS a lane guess, just not one the fusion was confident enough to
    // stand behind. Replace the headline with an honest partial-guess line and
    // render the lane breakdown right under it. Only when EVERY lane is empty
    // (or lanes are absent — an old companion) does the legacy copy stand.
    const lanes = suggestion.lanes;
    const laneSignal = guessLaneSignalCount(lanes);
    if (laneSignal > 0 && lanes !== undefined) {
      return (
        <div className="suggestion-stats is-empty has-lane-guesses">
          <span className="suggestion-stats-row">
            <span className="suggestion-stats-target subtle">
              No confident pick — lane guesses below
            </span>
            <span
              className="suggestion-stats-info"
              title={
                (isRevisit
                  ? `Seen ${String(visitCount)} times. `
                  : '') +
                'The combined resolver wasn’t confident enough to suggest a workstream, ' +
                'but individual signals below did have guesses. Expand "Guess lanes" to see ' +
                'what each signal thought, and file directly to any of them.'
              }
            >
              ⓘ
            </span>
          </span>
          <span className="suggestion-stats-source mono subtle">
            No single confident pick — expand the lanes to see each signal’s best guess
          </span>
          <GuessLanes
            lanes={lanes}
            workstreams={workstreams}
            {...(onFileHere === undefined ? {} : { onFileHere })}
          />
        </div>
      );
    }
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
        {/* All-lanes-empty (or an old companion, lanes absent) still shows the
            breakdown when lanes ARE present so the user sees every lane's own
            "nothing here because …" reason. GuessLanes renders null on []. */}
        {lanes !== undefined ? (
          <GuessLanes
            lanes={lanes}
            workstreams={workstreams}
            {...(onFileHere === undefined ? {} : { onFileHere })}
          />
        ) : null}
      </div>
    );
  }
  // state === 'populated' here (pending/error/empty all returned above), so
  // `suggestion` is defined with ≥1 candidate. The explicit guard keeps the
  // types honest without a non-null assertion.
  if (suggestion === undefined) return null;
  const top = suggestion.fusedCandidates[0];
  if (top === undefined) return null;
  const probability = probabilityFromLogit(top.rawFusionLogit);
  const margin = suggestion.decision.margin;
  const level = confidenceLevelFromProbability(probability, { margin });
  const label = workstreamLabel(top.workstreamId, workstreams);
  const isTied = level === 'no-clear-pick';
  // Honesty gate: the policy only *endorsed* this pick when the decision is
  // suggest / auto-apply. An action='inbox' decision is a weak guess — the
  // model has a lean but chose not to surface it. Flag it so the headline
  // reads "weak guess — not filed" rather than a confident-looking pick
  // (the live -0.62-margin bug where an inbox decision rendered as a
  // suggestion). Confidence numbers stay visible for power users.
  const isWeakGuess = endorsementFor(suggestion).level === 'weak-guess';
  // The user's ask — the FULL ranked possibilities, one-click filable. With a
  // confident (endorsed) primary this is the collapsed "Other possibilities
  // (N)" tail; for a weak guess (top below the bar) it expands to "Below
  // confidence bar — possibilities:" so the ranked list the resolver had is
  // visible instead of buried behind the single de-emphasised guess.
  const possibilities = possibilitiesFrom(suggestion);
  // Calibration honesty (R2): there is no calibrated attribution-surface
  // reliability fit (the only /v1/system/reliability surface is `dejavu`,
  // and its raw ECE is ~0.61 — badly miscalibrated). So the fusion-logit
  // sigmoid is NOT a trustworthy probability: we must not print it as a
  // headline "%". Keep the qualitative ordinal level on the card (a
  // defensible lean) and move the raw margin/logit/percent into the ⓘ
  // tooltip, explicitly labelled as UNCALIBRATED diagnostics. If an
  // attribution fit with reasonable ECE ever lands, this is where the
  // calibrated confidence would surface on the card instead.
  // When the leader's margin is tiny the resolver is admitting it
  // can't separate the top candidates. Force the alternatives row on
  // so the user sees the near-ties instead of an invented winner.
  const showAlts = showAlternatives || isTied;
  const tooltip =
    (isWeakGuess
      ? 'Weak guess — filed to inbox. The model has a lean but it fell ' +
        'below the resolver’s confidence bar, so nothing was suggested.\n\n'
      : '') +
    'Uncalibrated diagnostics — these numbers are raw model internals, ' +
    'not a calibrated probability (no reliability fit for this surface). ' +
    'Read them as a rough lean, not a % chance:\n' +
    `· lean ${confidenceLevelLabel(level)} (raw sigmoid ${Math.round(probability * 100)}%).\n` +
    `· raw logit ${top.rawFusionLogit.toFixed(2)} ` +
    `(higher = stronger lean, typically -5 to +5).\n` +
    `· margin to runner-up ${margin.toFixed(2)} (bigger = clearer winner).\n` +
    `· dominant signal ${top.dominantSource} — ${dominantSourceLabel(top.dominantSource)}.`;
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
        signal: {top.dominantSource} ({dominantSourceLabel(top.dominantSource)}) · margin{' '}
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
    <div
      className={`suggestion-stats is-${level}${compact ? ' is-compact' : ''}${
        isWeakGuess ? ' is-weak-guess' : ''
      }`}
      data-endorsement={isWeakGuess ? 'weak-guess' : 'endorsed'}
    >
      <span className="suggestion-stats-row">
        {isWeakGuess ? (
          <span
            className="suggestion-stats-weak"
            title="Below the resolver's confidence bar — filed to inbox, not suggested. Confirm to teach it."
          >
            weak guess — filed to inbox
          </span>
        ) : null}
        <span className="suggestion-stats-target">{label}</span>
        {/* Qualitative lean only — the raw % is uncalibrated and lives in
            the ⓘ tooltip labelled as diagnostics (see above). */}
        <span className="suggestion-stats-confidence">{confidenceLevelLabel(level)}</span>
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
      {/* The user's ask: the FULL ranked possibilities, each one-click
          filable. Collapsed under the endorsed primary; expanded when the
          top is only a weak guess (below the confidence bar). Renders
          nothing when there is a single candidate. */}
      <PossibilitiesList
        possibilities={possibilities}
        workstreams={workstreams}
        {...(onFileHere === undefined ? {} : { onFileHere })}
      />
      {/* Guess-lanes — even when the fusion HAS a confident pick, the user
          asked to see what every individual lane thought behind a click.
          Renders null when lanes are absent (old companion). */}
      {suggestion.lanes !== undefined ? (
        <GuessLanes
          lanes={suggestion.lanes}
          workstreams={workstreams}
          {...(onFileHere === undefined ? {} : { onFileHere })}
        />
      ) : null}
    </div>
  );
}
