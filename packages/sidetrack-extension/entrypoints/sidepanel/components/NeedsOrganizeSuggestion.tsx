// Per-row workstream suggestion for the workboard's Needs-Organize
// section. Backed by `bac.suggest_workstream` (PR #76 Track F).
// Renders inline below a thread row's existing label/provider line.

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
  return (
    <div className="nx-suggest" role="group" aria-label="Workstream suggestion">
      <span className="lead">Looks like →</span>
      <span className="ws-sug">
        <span className="hp-dot green" />
        <b>{suggestedLabel}</b>
        <span className="conf">{confidence.toFixed(2)}</span>
      </span>
      <div className="acts">
        <button type="button" className="primary" onClick={onAccept}>
          Accept
        </button>
        <button type="button" onClick={onPickManual}>
          Pick…
        </button>
        <button type="button" className="dismiss" onClick={onDismiss} aria-label="Dismiss">
          ×
        </button>
      </div>
    </div>
  );
}
