import { createPortal } from 'react-dom';

import { Icons } from './icons';

// Déjà-vu pop-on-highlight — fixed-position popover that surfaces prior
// threads matching the current selection. Backed by `bac.recall` (PR #76
// Track D). Anchored to the selection's bounding rect by the caller.
//
// Content-script integration is the parent's responsibility — this
// component is presentational. The parent must:
//   1. Listen to `selectionchange` in the host page
//   2. Debounce (300ms) and call `bac.recall(selection.text)`
//   3. If results, mount this popover via React + computed top/left
//   4. Dismiss on outside click, Escape, or new selection

export interface DejaVuItem {
  readonly id: string;
  readonly providerLabel: string;
  readonly providerKey: 'gpt' | 'claude' | 'gemini' | 'codex' | 'web';
  readonly title: string;
  readonly snippet: string;
  readonly relativeWhen: string;
  readonly score: number;
}

interface DejaVuPopoverProps {
  readonly items: readonly DejaVuItem[];
  readonly anchor: { readonly top: number; readonly left: number };
  readonly onJump: (item: DejaVuItem) => void;
  readonly onDismiss: () => void;
  readonly onMute?: () => void;
}

export function DejaVuPopover({
  items,
  anchor,
  onJump,
  onDismiss,
  onMute,
}: DejaVuPopoverProps) {
  if (items.length === 0) {
    return null;
  }
  const popover = (
    <div
      className="deja-pop"
      role="dialog"
      aria-label="Déjà-vu — prior threads found"
      style={{ top: anchor.top, left: anchor.left }}
    >
      <div className="deja-head">
        <span className="hp-dot signal" />
        <span>Seen this before</span>
        <span className="meta">
          {String(items.length)} prior thread{items.length === 1 ? '' : 's'}
        </span>
        <button type="button" className="close" onClick={onDismiss} aria-label="Dismiss">
          {Icons.close}
        </button>
      </div>
      <div className="deja-list">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className="deja-row"
            onClick={() => {
              onJump(item);
            }}
          >
            <div className="r1">
              <span className={`hp-row prov-pill ${item.providerKey}`}>{item.providerLabel}</span>
              <span className="title">{item.title}</span>
              <span className="score" title="similarity">
                {item.score.toFixed(2)}
              </span>
            </div>
            <div className="r2">{item.snippet}</div>
            <div className="r3">
              <span>{item.relativeWhen}</span>
              <span className="jump">jump ›</span>
            </div>
          </button>
        ))}
      </div>
      <div className="deja-foot">
        <span className="muted">on-device · vector recall</span>
        {onMute !== undefined ? (
          <button type="button" onClick={onMute}>
            Don&apos;t show again for this page
          </button>
        ) : null}
      </div>
    </div>
  );
  return createPortal(popover, document.body);
}
