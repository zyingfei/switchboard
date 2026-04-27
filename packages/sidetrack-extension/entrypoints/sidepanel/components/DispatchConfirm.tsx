import { useState } from 'react';
import { Modal } from './Modal';
import { Icons } from './icons';

export interface DispatchConfirmProps {
  readonly target: string;
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
  screenShareActive = false,
  redactedCount = 2,
  redactedKinds = ['1 GitHub token', '1 email'],
  tokenEstimate = 4200,
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

  return (
    <Modal
      title="Confirm dispatch"
      subtitle={`→ ${target} · paste mode`}
      width={620}
      variant="ink"
      onClose={onCancel}
    >
      <div className="safety-chain">
        <div className="safety-row signal">
          <span className="icon-12">{Icons.lock}</span>
          <div className="safety-text">
            <div>
              <strong className="mono">Redaction fired:</strong> {redactedCount} items removed —{' '}
              <span className="mono">{redactedKinds.join(', ')}</span>
            </div>
            <button type="button" className="reveal-link mono">
              [reveal redacted]
            </button>
          </div>
        </div>

        <div className="safety-row neutral">
          <div className="safety-text" style={{ flex: 1 }}>
            <div className="token-bar-row mono">
              <span>Token budget</span>
              <span>
                {tokenEstimate.toLocaleString()} / {tokenLimit.toLocaleString()}
              </span>
            </div>
            <div className="token-bar">
              <div className={'token-bar-fill ' + tokenLevel} style={{ width: `${String(Math.min(tokenPct, 100))}%` }} />
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
              <>
                No prompt-injection patterns in source content.
              </>
            )}
          </div>
        </div>
      </div>

      <details className="preview-details">
        <summary>Final packet preview</summary>
        <pre className="preview-body mono">
{`# Sidetrack / MVP PRD — context pack

## Workstream
kind: project · created 2026-04-12

## Recent activity
- claude · "Side-panel state machine review"
- chatgpt · "PRD §24.10 wording"
…`}
        </pre>
      </details>

      <div className="composer-row">
        <label>Send mode</label>
        <div className="pill-row">
          <button
            type="button"
            className={'pill ' + (mode === 'paste' ? 'on' : '')}
            onClick={() => { setMode('paste'); }}
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
          onClick={() => { onConfirm(mode); }}
        >
          Confirm dispatch
        </button>
      </div>
    </Modal>
  );
}
