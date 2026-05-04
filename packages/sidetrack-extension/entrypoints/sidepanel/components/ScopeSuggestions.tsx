import { Icons } from './icons';

// Composer scope-picker suggestions — top-3 suggested workstreams shown
// inline in the PacketComposer. Backed by `bac.suggest_workstream`
// (shipped in PR #76 Track F). When the suggestion layer returns no
// candidates above threshold, the parent should render nothing and
// fall back to the existing manual scope picker.

export interface ScopeSuggestion {
  readonly id: string;
  readonly label: string;
  readonly confidence: number;
  readonly reason: string;
}

interface ScopeSuggestionsProps {
  readonly suggestions: readonly ScopeSuggestion[];
  readonly value: string | null;
  readonly onChange: (id: string) => void;
  readonly onPickManual?: () => void;
}

export function ScopeSuggestions({
  suggestions,
  value,
  onChange,
  onPickManual,
}: ScopeSuggestionsProps) {
  if (suggestions.length === 0) {
    return null;
  }
  return (
    <div className="scope-sugs">
      <div className="scope-sugs-head">
        <span>Suggested scope</span>
        <span className="muted">on-device match</span>
      </div>
      <div className="scope-sugs-rows">
        {suggestions.map((s) => {
          const selected = value === s.id;
          return (
            <button
              key={s.id}
              type="button"
              className={'scope-sug' + (selected ? ' on' : '')}
              onClick={() => {
                onChange(s.id);
              }}
            >
              <span className="conf-bar">
                <span style={{ width: `${String(Math.round(s.confidence * 100))}%` }} />
              </span>
              <div className="r1">
                <span className="check">{selected ? Icons.check : null}</span>
                <span className="name">{s.label}</span>
                <span className="conf-num">{s.confidence.toFixed(2)}</span>
              </div>
              <div className="r2">{s.reason}</div>
            </button>
          );
        })}
      </div>
      {onPickManual !== undefined ? (
        <button type="button" className="scope-pick" onClick={onPickManual}>
          or pick manually…
        </button>
      ) : null}
    </div>
  );
}
