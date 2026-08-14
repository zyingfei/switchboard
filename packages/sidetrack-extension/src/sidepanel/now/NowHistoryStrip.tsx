import type { ReactElement } from 'react';

import type { NowContext } from './nowHistory';
import { pageKindLabel } from './pageKind';
import { formatRelative } from '../../util/time';

// Lightweight breadcrumb above the Now card.
//
// Shows up to 4 chips (current + 3 prior contexts). Clicking an
// inactive chip pins that context — App.tsx's `displayedFocusedTabUrl`
// swap then re-renders the Now card from the projection record for
// that URL (UX5). Clicking the active chip unpins → back to live.
// The chip never auto-switches the BROWSER tab (spec rule); pin
// affects rendering only.

export interface NowHistoryStripProps {
  readonly contexts: readonly NowContext[];
  readonly pinnedUrl: string | null;
  readonly onPin: (url: string | null) => void;
}

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
        // UX-discoverability: tooltip explains what clicking does
        // (the chip is just a small pill and users wouldn't guess
        // the pin/restore behaviour from looking at it).
        const tooltip = isActive
          ? isPinned
            ? `Pinned: ${ctx.url}\nClick to return to the live tab`
            : `Live current tab: ${ctx.url}`
          : `Click to pin and view this prior context (no browser-tab switch).\n${ctx.url}`;
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
            title={tooltip}
            aria-label={tooltip}
            onClick={() => {
              // Clicking the active chip clears the pin (defaults
              // back to live mode showing the current tab); clicking
              // an inactive chip pins it.
              onPin(isActive ? null : ctx.url);
            }}
          >
            <span className="cx-now-history-kind">{pageKindLabel[ctx.kind]}</span>
            <span className="cx-now-history-title">{ctx.title}</span>
            <span className="cx-now-history-when">
              {formatRelative(ctx.enteredAt, { short: true, nowMs })}
            </span>
          </button>
        );
      })}
    </div>
  );
};
