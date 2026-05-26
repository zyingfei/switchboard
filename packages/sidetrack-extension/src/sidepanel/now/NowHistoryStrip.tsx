import type { ReactElement } from 'react';

import type { NowContext } from './nowHistory';
import { pageKindLabel } from './pageKind';

// Lightweight breadcrumb above the Now card.
//
// Shows up to 4 chips (current + 3 prior contexts). Clicking a chip
// "pins" that context so the auto-update from the live tab change
// doesn't immediately replace it. Clicking the head chip (or the
// pinned chip) unpins → back to live mode.
//
// This is NOT a navigation surface; chips never switch the browser
// tab. They only change what Now renders. The spec is explicit
// about this — "active browser tab changes only update Now; the
// app must not auto-switch the user's selected tab" — so giving the
// chips that power would defeat the rule.

export interface NowHistoryStripProps {
  readonly contexts: readonly NowContext[];
  readonly pinnedUrl: string | null;
  readonly onPin: (url: string | null) => void;
}

const compactRel = (iso: string, nowMs: number): string => {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const deltaMin = Math.max(0, Math.round((nowMs - ms) / 60_000));
  if (deltaMin === 0) return 'just now';
  if (deltaMin < 60) return `${String(deltaMin)}m ago`;
  const hrs = Math.round(deltaMin / 60);
  if (hrs < 24) return `${String(hrs)}h ago`;
  return `${String(Math.round(hrs / 24))}d ago`;
};

export const NowHistoryStrip = ({
  contexts,
  pinnedUrl,
  onPin,
}: NowHistoryStripProps): ReactElement | null => {
  // Strip is only useful once at least one PRIOR context exists.
  // Hide entirely for the first observation — chrome with one chip
  // is noise.
  if (contexts.length < 2) return null;
  const nowMs = Date.now();
  return (
    <div
      className="cx-now-history"
      role="navigation"
      aria-label="Recent Now contexts"
      data-testid="now-history-strip"
    >
      {contexts.map((ctx, idx) => {
        const isHead = idx === 0;
        const isPinned = pinnedUrl !== null && pinnedUrl === ctx.url;
        const isActive = isPinned || (pinnedUrl === null && isHead);
        return (
          <button
            type="button"
            key={ctx.url}
            className={
              'cx-now-history-chip' +
              (isActive ? ' is-active' : '') +
              (isHead ? ' is-current' : '')
            }
            data-testid={`now-history-chip-${idx}`}
            title={ctx.url}
            onClick={() => {
              // Clicking the active chip clears the pin (defaults
              // back to live mode showing the current tab); clicking
              // an inactive chip pins it.
              onPin(isActive ? null : ctx.url);
            }}
          >
            <span className="cx-now-history-kind">{pageKindLabel[ctx.kind]}</span>
            <span className="cx-now-history-title">{ctx.title}</span>
            <span className="cx-now-history-when">{compactRel(ctx.enteredAt, nowMs)}</span>
          </button>
        );
      })}
    </div>
  );
};
