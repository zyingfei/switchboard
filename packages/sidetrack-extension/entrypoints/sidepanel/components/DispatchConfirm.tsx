import { useState } from 'react';
import { Modal } from './Modal';
import { Icons } from './icons';

// Lane the dispatch belongs to — drives the side-effect preview
// header above the safety chain. The 4 lanes correspond to the
// 4 visible outcomes the user can experience post-confirm:
//   - chat-paste: copy body + open AI chat tab
//   - chat-auto:  open AI chat tab + auto-paste + auto-send
//   - coding:     copy body, paste into your terminal session
//   - export:     download a .md file to Downloads
export type DispatchKindForPreview = 'chat-paste' | 'chat-auto' | 'coding' | 'export';

export interface DispatchConfirmProps {
  readonly target: string;
  // The actual composed packet body. Required — the modal previews
  // EXACTLY what is about to ship. Previously this was a hardcoded
  // stub which silently shipped the wrong text into the dispatch
  // confirmation, masking the real content.
  readonly body: string;
  // Which side-effect category this dispatch falls into. Drives the
  // single-sentence "Will ..." header that spells out exactly what
  // will happen post-confirm. Optional for back-compat; defaults to
  // chat-paste which matches the historical behaviour.
  readonly dispatchKind?: DispatchKindForPreview;
  readonly screenShareActive?: boolean;
  readonly redactedCount?: number;
  readonly redactedKinds?: readonly string[];
  readonly tokenEstimate?: number;
  readonly tokenLimit?: number;
  readonly injectionDetected?: boolean;
  readonly autoSendOptedIn?: boolean;
  readonly onCancel: () => void;
  readonly onEdit: () => void;
  readonly onConfirm: (mode: 'paste' | 'auto_send') => void;
}

/**
 * §24.10 ship-blocking safety chain rendered side-by-side.
 *
 * All four primitives must be visible before the user confirms dispatch:
 * - Redaction (PII / API key removal)
 * - Token budget (vs target model context window)
 * - Screen-share-safe (mask if `getDisplayMedia` is active)
 * - Captured-page injection scrub (warn if source has injection patterns)
 *
 * Per Q5, paste-mode is locked; auto-send is opt-in per provider.
 */
export function DispatchConfirm({
  target,
  body,
  dispatchKind = 'chat-paste',
  screenShareActive = false,
  // No stub defaults — caller must pass the real numbers. Stubs
  // silently masked an actual bug where 0-redaction dispatches
  // showed "1 GitHub token, 1 email" anyway.
  redactedCount = 0,
  redactedKinds = [],
  tokenEstimate = 0,
  tokenLimit = 200_000,
  injectionDetected = false,
  autoSendOptedIn = false,
  onCancel,
  onEdit,
  onConfirm,
}: DispatchConfirmProps) {
  const [mode, setMode] = useState<'paste' | 'auto_send'>('paste');
  const tokenPct = Math.round((tokenEstimate / tokenLimit) * 100);
  const tokenLevel: 'green' | 'amber' | 'over' =
    tokenPct < 80 ? 'green' : tokenPct < 100 ? 'amber' : 'over';
  const overBudget = tokenLevel === 'over';

  // Build the "Will ..." sentence. The user kept asking "where does
  // this go?" — spell it out. Lane is decided by the caller based on
  // the packet's target + the user's auto-send opt-in setting.
  const sideEffectText = ((): string => {
    switch (dispatchKind) {
      case 'chat-paste':
        return `Will copy the packet to your clipboard and open ${target} in a new tab. Paste to send.`;
      case 'chat-auto':
        return `Will open ${target} in a new tab, auto-paste the packet, and auto-send it.`;
      case 'coding':
        return `Will copy the packet to your clipboard. Paste it into your ${target} session.`;
      case 'export':
        return `Will save the packet as a Markdown file to your Downloads folder.`;
    }
  })();

  return (
    <Modal
      title="Confirm dispatch"
      subtitle={`→ ${target} · paste mode`}
      width={620}
      variant="ink"
      onClose={onCancel}
    >
      {/* Side-effect preview — single sentence so the user knows
          exactly what clicking Confirm will do. Sits above the
          safety chain. The user kept asking "where does this go?"
          — this answers it before they have to click. */}
      <div className="dispatch-side-effect mono">{sideEffectText}</div>

      <div className="safety-chain">
        {redactedCount > 0 ? (
          <div className="safety-row signal">
            <span className="icon-12">{Icons.lock}</span>
            <div className="safety-text">
              <div>
                <strong className="mono">Redaction fired:</strong> {redactedCount} item
                {redactedCount === 1 ? '' : 's'} removed
                {redactedKinds.length > 0 ? (
                  <>
                    {' '}
                    — <span className="mono">{redactedKinds.join(', ')}</span>
                  </>
                ) : null}
              </div>
              <button type="button" className="reveal-link mono">
                [reveal redacted]
              </button>
            </div>
          </div>
        ) : (
          <div className="safety-row green">
            <span className="icon-12">{Icons.check}</span>
            <div className="safety-text mono">
              No PII / API-key patterns detected. Nothing redacted.
            </div>
          </div>
        )}

        <div className="safety-row neutral">
          <div className="safety-text" style={{ flex: 1 }}>
            <div className="token-bar-row mono">
              <span>Token budget</span>
              <span>
                {tokenEstimate.toLocaleString()} / {tokenLimit.toLocaleString()}
              </span>
            </div>
            <div className="token-bar">
              <div
                className={'token-bar-fill ' + tokenLevel}
                style={{ width: `${String(Math.min(tokenPct, 100))}%` }}
              />
            </div>
          </div>
        </div>

        <div className={'safety-row ' + (screenShareActive ? 'signal' : 'green')}>
          <span className="icon-12">{screenShareActive ? Icons.cast : Icons.check}</span>
          <div className="safety-text mono">
            {screenShareActive ? (
              <>
                <strong>Screen-share active</strong> — packet contents will be visible to viewers.
              </>
            ) : (
              <>
                Screen-share <strong>not</strong> active · safe to dispatch.
              </>
            )}
          </div>
        </div>

        <div className={'safety-row ' + (injectionDetected ? 'signal' : 'green')}>
          <span className="icon-12">{injectionDetected ? Icons.alert : Icons.check}</span>
          <div className="safety-text mono">
            {injectionDetected ? (
              <>
                <strong>Captured-page injection detected</strong> — wrapped in{' '}
                <code>{'<context>...</context>'}</code> markers automatically.
              </>
            ) : (
              <>No prompt-injection patterns in source content.</>
            )}
          </div>
        </div>
      </div>

      <details className="preview-details" open>
        <summary>Final packet preview</summary>
        <pre className="preview-body mono">{body}</pre>
      </details>

      <div className="composer-row">
        <label>Send mode</label>
        <div className="pill-row">
          <button
            type="button"
            className={'pill ' + (mode === 'paste' ? 'on' : '')}
            onClick={() => {
              setMode('paste');
            }}
          >
            Paste mode <span className="mono">(default)</span>
          </button>
          <button
            type="button"
            className="pill"
            disabled={!autoSendOptedIn}
            title="Auto-send is opt-in per provider in Settings"
          >
            <span className="icon-12">{Icons.lock}</span> Auto-send · not enabled for {target}
          </button>
        </div>
        <div className="hint">
          <em>Paste mode is locked per §24.10. Opt-in to auto-send per provider in Settings.</em>
        </div>
      </div>

      <div className="modal-foot">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-ghost" onClick={onEdit}>
          Edit packet
        </button>
        <div className="spacer" />
        <button
          type="button"
          className="btn btn-primary"
          disabled={overBudget}
          onClick={() => {
            onConfirm(mode);
          }}
        >
          Confirm dispatch
        </button>
      </div>
    </Modal>
  );
}
