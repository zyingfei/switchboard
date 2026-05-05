// Per-row workstream suggestion for the workboard's Needs-Organize
// section. Backed by `bac.suggest_workstream` (PR #76 Track F).
// Renders inline below a thread row's existing label/provider line.
//
// Two visual modes, decided by whether confidence > 0:
//  - "recommended" (confidence > 0): "Looks like → <name> 0.42"
//    with a confidence dot. The Accept button files into <name>.
//  - "no auto" (confidence === 0): plain manual-picker affordance,
//    no fake recommendation. Showing "Pick a workstream… 0.00"
//    with a green dot read as a real suggestion that confidently
//    pointed at "Pick a workstream…", which is nonsense.

interface NeedsOrganizeSuggestionProps {
  readonly suggestedLabel: string;
  readonly confidence: number;
  readonly onAccept: () => void;
  readonly onPickManual: () => void;
  readonly onDismiss: () => void;
}

export function NeedsOrganizeSuggestion({
  suggestedLabel,
  confidence,
  onAccept,
  onPickManual,
  onDismiss,
}: NeedsOrganizeSuggestionProps) {
  const hasRecommendation = confidence > 0;
  return (
    <div className="nx-suggest" role="group" aria-label="Workstream suggestion">
      {hasRecommendation ? (
        <>
          <span className="lead">Looks like →</span>
          <span className="ws-sug">
            <span className="hp-dot green" />
            <b>{suggestedLabel}</b>
            <span className="conf">{confidence.toFixed(2)}</span>
          </span>
        </>
      ) : (
        <span className="lead">No auto-suggestion — pick a workstream:</span>
      )}
      <div className="acts">
        {hasRecommendation ? (
          <button type="button" className="primary" onClick={onAccept}>
            Accept
          </button>
        ) : null}
        <button type="button" className={hasRecommendation ? '' : 'primary'} onClick={onPickManual}>
          Pick…
        </button>
        <button type="button" className="dismiss" onClick={onDismiss} aria-label="Dismiss">
          ×
        </button>
      </div>
    </div>
  );
}
