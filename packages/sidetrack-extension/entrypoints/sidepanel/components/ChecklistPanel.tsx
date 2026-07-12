import { useState } from 'react';

// §13 step 7 — checklist editor for the workstream detail panel.
// Add / tick / untick / remove. The component is pure: it renders the
// items it's given and calls back on every mutation. The caller owns
// the companion PATCH (updateWorkstream with the new checklist array)
// and the id/timestamp minting, so this stays trivially unit-testable
// and free of clock/uuid concerns.

export interface ChecklistPanelItem {
  readonly id: string;
  readonly text: string;
  readonly checked: boolean;
}

export interface ChecklistPanelProps {
  readonly items: readonly ChecklistPanelItem[];
  // Add a new unchecked item with the given text. Caller mints the id
  // + timestamps and issues the PATCH.
  readonly onAdd: (text: string) => void;
  // Flip the checked state of one item.
  readonly onToggle: (id: string, checked: boolean) => void;
  // Remove one item.
  readonly onRemove: (id: string) => void;
  // Disable inputs while a mutation is in flight.
  readonly busy?: boolean;
}

export function ChecklistPanel({ items, onAdd, onToggle, onRemove, busy = false }: ChecklistPanelProps) {
  const [draft, setDraft] = useState('');

  const commitAdd = (): void => {
    const text = draft.trim();
    if (text.length === 0) return;
    onAdd(text);
    setDraft('');
  };

  const doneCount = items.filter((item) => item.checked).length;

  return (
    <div className="ws-checklist">
      {items.length > 0 ? (
        <div className="ws-checklist-progress mono subtle" aria-label="Checklist progress">
          {String(doneCount)} / {String(items.length)} done
        </div>
      ) : null}
      <ul className="ws-checklist-list" aria-label="Checklist">
        {items.length === 0 ? (
          <li className="ws-checklist-empty subtle">No checklist items yet.</li>
        ) : null}
        {items.map((item) => (
          <li key={item.id} className={'ws-checklist-item' + (item.checked ? ' checked' : '')}>
            <label className="ws-checklist-label">
              <input
                type="checkbox"
                checked={item.checked}
                disabled={busy}
                onChange={(e) => {
                  onToggle(item.id, e.target.checked);
                }}
                aria-label={item.text}
              />
              <span className="ws-checklist-text">{item.text}</span>
            </label>
            <button
              type="button"
              className="btn-link ws-checklist-remove"
              disabled={busy}
              aria-label={`Remove ${item.text}`}
              onClick={() => {
                onRemove(item.id);
              }}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      <div className="ws-checklist-add">
        <input
          type="text"
          className="ws-checklist-add-input"
          placeholder="Add a checklist item…"
          value={draft}
          disabled={busy}
          onChange={(e) => {
            setDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitAdd();
            }
          }}
          aria-label="Add a checklist item"
        />
        <button
          type="button"
          className="btn-link ws-checklist-add-btn"
          disabled={busy || draft.trim().length === 0}
          onClick={commitAdd}
        >
          Add
        </button>
      </div>
    </div>
  );
}
