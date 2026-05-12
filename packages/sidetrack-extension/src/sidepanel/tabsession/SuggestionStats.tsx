import type {
  TabSessionResolutionResult,
  TabSessionWorkstreamOption,
} from './types';

// Stage 5 polish — surface the resolver's confidence in human-readable
// terms while keeping the raw numbers available on hover. The
// resolver hands us:
//   - `rawFusionLogit`: real number, log-odds for the top workstream
//     (typically [-5, +5] in practice).
//   - `decision.margin`: gap to the runner-up; larger = clearer winner.
//   - `dominantSource`: which signal weighed most (ppr / similarity /
//     cluster).
// We turn the logit into a probability via sigmoid and bucket it into
// 5 labels. The ⓘ tooltip carries the raw values + a one-line
// explanation of the [-1, 1] scale.

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

type ConfidenceLevel = 'highly-likely' | 'likely' | 'possible' | 'unlikely' | 'not-likely';

const confidenceLevelFromLogit = (logit: number): ConfidenceLevel => {
  const p = sigmoid(logit);
  if (p >= 0.8) return 'highly-likely';
  if (p >= 0.6) return 'likely';
  if (p >= 0.4) return 'possible';
  if (p >= 0.2) return 'unlikely';
  return 'not-likely';
};

const labelForLevel = (level: ConfidenceLevel): string => {
  switch (level) {
    case 'highly-likely':
      return 'Highly likely';
    case 'likely':
      return 'Likely';
    case 'possible':
      return 'Possible';
    case 'unlikely':
      return 'Unlikely';
    case 'not-likely':
      return 'Not likely';
  }
};

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
    : workstreams.find((w) => w.bac_id === workstreamId)?.path ?? '(removed)';

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
}

export function SuggestionStats({
  suggestion,
  workstreams,
  showAlternatives = false,
  showEmptyPlaceholder = false,
}: SuggestionStatsProps) {
  if (suggestion === undefined || suggestion.fusedCandidates.length === 0) {
    if (!showEmptyPlaceholder) return null;
    return (
      <div className="suggestion-stats is-empty">
        <span className="suggestion-stats-row">
          <span className="suggestion-stats-target subtle">No signal yet</span>
          <span
            className="suggestion-stats-info"
            title={
              'Sidetrack has no related visits, similar pages, or topic-cluster ' +
              'evidence for this URL yet. Move a few similar pages into a ' +
              'workstream and suggestions will start appearing.'
            }
          >
            ⓘ
          </span>
        </span>
        <span className="suggestion-stats-source mono subtle">
          Move similar pages into a workstream to teach Sidetrack
        </span>
      </div>
    );
  }
  const top = suggestion.fusedCandidates[0];
  if (top === undefined) return null;
  const level = confidenceLevelFromLogit(top.rawFusionLogit);
  const probability = sigmoid(top.rawFusionLogit);
  const margin = suggestion.decision.margin;
  const label = workstreamLabel(top.workstreamId, workstreams);
  const tooltip =
    `Confidence: ${Math.round(probability * 100)}% (${labelForLevel(level)}).\n` +
    `Raw logit ${top.rawFusionLogit.toFixed(2)} ` +
    `(higher = more confident, typically -5 to +5).\n` +
    `Margin to runner-up: ${margin.toFixed(2)} (bigger = clearer winner).\n` +
    `Dominant signal: ${top.dominantSource} — ${sourceLabel(top.dominantSource)}.`;
  const alternatives = showAlternatives
    ? suggestion.fusedCandidates.slice(1, 3).map((cand) => ({
        path: workstreamLabel(cand.workstreamId, workstreams),
        level: confidenceLevelFromLogit(cand.rawFusionLogit),
        probability: sigmoid(cand.rawFusionLogit),
      }))
    : [];
  return (
    <div className={`suggestion-stats is-${level}`}>
      <span className="suggestion-stats-row">
        <span className="suggestion-stats-target">{label}</span>
        <span className="suggestion-stats-confidence">
          {labelForLevel(level)} · {Math.round(probability * 100)}%
        </span>
        <span className="suggestion-stats-info" title={tooltip} aria-label={tooltip}>
          ⓘ
        </span>
      </span>
      <span className="suggestion-stats-source mono">
        signal: {top.dominantSource} ({sourceLabel(top.dominantSource)}) · margin{' '}
        {margin.toFixed(2)}
      </span>
      {alternatives.length > 0 ? (
        <span className="suggestion-stats-alts">
          <span className="muted">Other candidates:</span>
          {alternatives.map((alt, i) => (
            <span key={`${alt.path}-${String(i)}`} className="suggestion-stats-alt">
              {alt.path} · {labelForLevel(alt.level)} ({Math.round(alt.probability * 100)}%)
            </span>
          ))}
        </span>
      ) : null}
    </div>
  );
}
