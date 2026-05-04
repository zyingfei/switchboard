import { Icons } from './icons';

// Coding-session attach offer banner. Replaces the silent modal trigger
// with a visible banner — when the extension's content-script detects
// a coding-agent web surface (Codex web, Claude Code web, Cursor cloud),
// the user sees an inline offer instead of a surprise modal.
//
// Detection state ships with PR #78 (Track U). For now this component
// accepts pre-shaped props so it can render from fixture data; once
// PR #78 lands the parent wires up `codingAttach.listPendingOffers()`
// from chrome.storage.local.

export interface CodingOffer {
  readonly tabId: number;
  readonly surfaceLabel: string;
  readonly cwd?: string;
  readonly branch?: string;
  readonly suggestedWorkstreamLabel: string;
}

interface CodingOfferBannerProps {
  readonly offer: CodingOffer;
  readonly onAccept: () => void;
  readonly onDismiss: () => void;
}

export function CodingOfferBanner({ offer, onAccept, onDismiss }: CodingOfferBannerProps) {
  return (
    <div className="sp-banner offer" role="status">
      <span className="b-glyph">{Icons.chat}</span>
      <div className="b-body">
        <b>{offer.surfaceLabel} session detected</b>
        {offer.cwd !== undefined || offer.branch !== undefined ? (
          <span className="muted">
            {offer.cwd !== undefined ? (
              <>
                cwd <code>{offer.cwd}</code>
              </>
            ) : null}
            {offer.cwd !== undefined && offer.branch !== undefined ? ' · ' : null}
            {offer.branch !== undefined ? (
              <>
                branch <code>{offer.branch}</code>
              </>
            ) : null}
          </span>
        ) : null}
      </div>
      <div className="b-actions">
        <button type="button" className="b-ghost" onClick={onDismiss}>
          Dismiss
        </button>
        <button type="button" className="b-primary" onClick={onAccept}>
          Attach to {offer.suggestedWorkstreamLabel}
        </button>
      </div>
    </div>
  );
}
