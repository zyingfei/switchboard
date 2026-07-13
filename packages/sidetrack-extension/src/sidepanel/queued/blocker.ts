// Maps the auto-send drain's `lastError` string (the reason it bailed
// shipping a queued follow-up) onto the canonical blocker the loop-state
// chip (§3.2) and the Queued row (§3.3) render. Pure — no React, no
// chrome.* — so the row copy, the chip suffix, and the primary action
// are derived from ONE table and can drift with each other.
//
// VERIFIED against the wiring, not comments: the source strings are the
// exact literals `preflightReasonText` / `findTabForThread` write into
// `QueueItem.lastError` (src/companion/autoSendDrain.ts,
// entrypoints/background.ts:1889). If those strings change, this table
// must change with them — the tests pin the join.

// The canonical blocker kinds. `none` means the item carries no
// lastError: either it has never been drained, or the last drain
// cleared it. Whether `none` is shippable depends on the tab being
// open, which the caller supplies (this module only knows the error).
export type QueueBlockerKind =
  | 'tab-closed'
  | 'auto-send-off'
  | 'provider-opt-out'
  | 'screen-share-safe'
  | 'token-budget'
  | 'send-failed'
  | 'none';

// The action a row offers to clear the blocker. `open` reopens/focuses
// the thread tab then drains (or hands to paste when auto-send is off);
// `send-now` re-fires the drain for an already-open tab; `edit` opens
// the item text inline to shorten it.
export type QueueBlockerAction = 'open' | 'send-now' | 'edit';

export interface QueueBlocker {
  readonly kind: QueueBlockerKind;
  // The row's blocker line copy (§3.3). Empty for `none`.
  readonly rowCopy: string;
  // The chip suffix after "N queued · " (§3.2). For a shippable item
  // (tab open, no blocker) the caller uses "send now" instead.
  readonly chipSuffix: string;
  readonly primaryAction: QueueBlockerAction;
}

// Exact drain literals → canonical kind. Substring match (not equality)
// because `findTabForThread` and the content-script send path emit
// longer, context-carrying strings; we key off a stable fragment.
const classifyLastError = (lastError: string | undefined): QueueBlockerKind => {
  if (lastError === undefined || lastError.trim().length === 0) return 'none';
  const text = lastError.toLowerCase();
  // preflightReasonText('thread-toggle-off')
  if (text.includes('auto-send is off for this thread')) return 'auto-send-off';
  // preflightReasonText('provider-opt-out')
  if (text.includes('not opted in for auto-send')) return 'provider-opt-out';
  // preflightReasonText('screen-share-safe')
  if (text.includes('screen-share-safe mode is on')) return 'screen-share-safe';
  // preflightReasonText('token-budget')
  if (text.includes('exceeds the auto-send token budget')) return 'token-budget';
  // findTabForThread's no-tab reason ("Open the chat tab; auto-send
  // needs the conversation visible…") + the local "No chat tab is open"
  // fallback both signal a closed tab.
  if (text.includes('open the chat tab') || text.includes('no chat tab')) return 'tab-closed';
  // unsupported-provider is rare; treat as a generic send failure the
  // user can retry (no dedicated blocker copy warranted).
  if (text.includes('does not support this provider')) return 'send-failed';
  // Anything else (content-script send failure, transient) → retry.
  return 'send-failed';
};

// §3.3 blocker → copy + action table. `provider` (display label, e.g.
// "ChatGPT") is spliced into the provider-opt-out copy when known.
export const resolveQueueBlocker = (
  lastError: string | undefined,
  provider?: string,
): QueueBlocker => {
  const kind = classifyLastError(lastError);
  switch (kind) {
    case 'tab-closed':
      return {
        kind,
        rowCopy: 'The chat tab is closed.',
        chipSuffix: 'open to send',
        primaryAction: 'open',
      };
    case 'auto-send-off':
      return {
        kind,
        rowCopy: 'Auto-send is off for this thread.',
        chipSuffix: 'auto-send off',
        primaryAction: 'open',
      };
    case 'provider-opt-out':
      return {
        kind,
        rowCopy: `${provider ?? 'This provider'} isn't opted in for auto-send.`,
        chipSuffix: 'not opted in',
        primaryAction: 'open',
      };
    case 'screen-share-safe':
      return {
        kind,
        rowCopy: 'Screen-share-safe mode is on.',
        chipSuffix: 'screen-share-safe',
        primaryAction: 'open',
      };
    case 'token-budget':
      return {
        kind,
        rowCopy: 'This follow-up is over the send limit.',
        chipSuffix: 'over the limit',
        primaryAction: 'edit',
      };
    case 'send-failed':
      return {
        kind,
        rowCopy: 'Send failed — try again.',
        chipSuffix: 'send failed',
        primaryAction: 'send-now',
      };
    case 'none':
      return { kind, rowCopy: '', chipSuffix: 'send now', primaryAction: 'send-now' };
  }
};
