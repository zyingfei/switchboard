import { useState } from 'react';
import { Modal } from './Modal';
import { Icons } from './icons';
import { SafetyChainSummary, type SafetyCheck } from './SafetyChainSummary';

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
  // The source thread's provider + model the user had selected when
  // the captured turns were taken (e.g. "Gemini · Thinking" or
  // "Claude · Sonnet 4.6"). Surfaced as a small subtitle so the user
  // sees which model the context came from before they ship it
  // elsewhere. Display-only — never used to route or pick a model
  // in the destination tab.
  readonly sourceLabel?: string;
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
 * Ship-blocking safety chain rendered side-by-side.
 *
 * All four primitives must be visible before the user confirms dispatch:
 * - Redaction (PII / API key removal)
 * - Token budget (vs target model context window)
 * - Screen-share-safe (mask if `getDisplayMedia` is active)
 * - Captured-page injection scrub (warn if source has injection patterns)
 *
 * Send mode default follows the per-provider auto-send opt-in: AI
 * providers default to auto-send, coding agents and exports stay on
 * paste mode (auto-send doesn't apply to those targets).
 */
export function DispatchConfirm({
  target,
  sourceLabel,
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
  const [mode, setMode] = useState<'paste' | 'auto_send'>(
    autoSendOptedIn ? 'auto_send' : 'paste',
  );
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

  const subtitle =
    sourceLabel !== undefined && sourceLabel.length > 0
      ? `${sourceLabel} → ${target}`
      : `→ ${target}`;

  return (
    <Modal
      title="Confirm dispatch"
      subtitle={subtitle}
      width={620}
      variant="ink"
      onClose={onCancel}
    >
      {/* Side-effect preview — single sentence so the user knows
          exactly what clicking Confirm will do. Sits above the
          safety chain. The user kept asking "where does this go?"
          — this answers it before they have to click. */}
      <div className="dispatch-side-effect mono">{sideEffectText}</div>

      {(() => {
        const checks: readonly SafetyCheck[] = [
          {
            key: 'redaction',
            label: 'redaction',
            status: redactedCount > 0 ? 'warn' : 'ok',
            detail:
              redactedCount > 0
                ? `${String(redactedCount)} span${redactedCount === 1 ? '' : 's'} masked${redactedKinds.length > 0 ? ` — ${redactedKinds.join(', ')}` : ''}`
                : 'no PII / API-key patterns detected',
          },
          {
            key: 'token-budget',
            label: 'token budget',
            status: overBudget ? 'bad' : tokenLevel === 'amber' ? 'warn' : 'ok',
            detail: `${tokenEstimate.toLocaleString()} / ${tokenLimit.toLocaleString()} (${String(tokenPct)}%)`,
          },
          {
            key: 'screen-share-safe',
            label: 'screen-share-safe',
            status: screenShareActive ? 'warn' : 'ok',
            detail: screenShareActive
              ? 'screen-share active — contents visible to viewers'
              : 'no display capture',
          },
          {
            key: 'injection-scrub',
            label: 'injection scrub',
            status: injectionDetected ? 'warn' : 'ok',
            detail: injectionDetected
              ? 'captured-page injection detected — wrapped in <context>'
              : 'no suspicious patterns',
          },
        ];
        // Always open by default so the user can see the safety chain
        // — earlier "collapsed when no issues" was too easy to miss
        // and made users doubt the feature was implemented.
        return <SafetyChainSummary checks={checks} defaultOpen />;
      })()}

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
            Paste mode
          </button>
          <button
            type="button"
            className={'pill ' + (mode === 'auto_send' ? 'on' : '')}
            disabled={!autoSendOptedIn}
            title={
              autoSendOptedIn
                ? `Auto-send into ${target}`
                : `Turn auto-send on for ${target} in Settings to enable this`
            }
            onClick={() => {
              if (autoSendOptedIn) setMode('auto_send');
            }}
          >
            {autoSendOptedIn ? null : <span className="icon-12">{Icons.lock}</span>} Auto-send
          </button>
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
