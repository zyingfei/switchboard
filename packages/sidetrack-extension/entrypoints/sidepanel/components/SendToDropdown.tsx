import { useEffect, useRef } from 'react';

// One-tap dispatch picker for the thread row's "Send to" action.
// Replaces the multi-step composer for the 70% case where the user
// just wants to forward a thread to another AI / coding agent /
// export sink. Picking a target fires onPick with the target id —
// the host (App.tsx) builds the packet with smart defaults and
// routes through DispatchConfirm or downloads (for export targets).
//
// "Customize first..." opens the existing PacketComposer for the
// long-tail cases that genuinely need template tweaks.

export type SendToTarget =
  | 'gpt_pro'
  | 'claude'
  | 'gemini'
  | 'claude_code'
  | 'codex'
  | 'cursor'
  | 'markdown'
  | 'notebook';

export interface SendToDropdownProps {
  // The user's last dispatch target for this thread, if any. Shown
  // first under the "Recent" heading with a checkmark.
  readonly recentTarget?: SendToTarget;
  readonly onPick: (target: SendToTarget) => void;
  readonly onCustomize: () => void;
  readonly onClose: () => void;
}

const AI_PROVIDERS: readonly { readonly id: SendToTarget; readonly label: string }[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'gpt_pro', label: 'GPT' },
  { id: 'gemini', label: 'Gemini' },
];

const CODING_AGENTS: readonly { readonly id: SendToTarget; readonly label: string }[] = [
  { id: 'claude_code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'cursor', label: 'Cursor' },
];

const EXPORTS: readonly { readonly id: SendToTarget; readonly label: string }[] = [
  { id: 'markdown', label: 'Markdown (.md)' },
  { id: 'notebook', label: 'Notebook (.md)' },
];

const TARGET_LABELS: Record<SendToTarget, string> = {
  gpt_pro: 'GPT',
  claude: 'Claude',
  gemini: 'Gemini',
  claude_code: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  markdown: 'Markdown',
  notebook: 'Notebook',
};

export function SendToDropdown({
  recentTarget,
  onPick,
  onCustomize,
  onClose,
}: SendToDropdownProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close on click-outside or Escape.
  useEffect(() => {
    const onDoc = (event: MouseEvent) => {
      if (rootRef.current === null) {
        return;
      }
      const target = event.target;
      if (target instanceof Node && !rootRef.current.contains(target)) {
        onClose();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    // Defer one tick so the click that opened the menu doesn't
    // immediately close it.
    const handle = window.setTimeout(() => {
      document.addEventListener('mousedown', onDoc);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      window.clearTimeout(handle);
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const renderRow = (
    target: SendToTarget,
    label: string,
    extra?: string,
  ): React.JSX.Element => (
    <button
      key={target}
      type="button"
      className="send-to-item"
      onClick={() => {
        onPick(target);
      }}
    >
      <span className="send-to-item-label">{label}</span>
      {extra !== undefined ? <span className="send-to-item-extra mono">{extra}</span> : null}
    </button>
  );

  return (
    <div ref={rootRef} className="send-to-menu" role="menu">
      {recentTarget !== undefined ? (
        <>
          <div className="send-to-section-head mono">Recent</div>
          {renderRow(recentTarget, '✓ ' + TARGET_LABELS[recentTarget], 'last target')}
          <div className="send-to-divider" />
        </>
      ) : null}
      <div className="send-to-section-head mono">Ask another AI</div>
      {AI_PROVIDERS.map((p) => renderRow(p.id, p.label))}
      <div className="send-to-divider" />
      <div className="send-to-section-head mono">Hand to coding agent</div>
      {CODING_AGENTS.map((p) => renderRow(p.id, p.label))}
      <div className="send-to-divider" />
      <div className="send-to-section-head mono">Export as file</div>
      {EXPORTS.map((p) => renderRow(p.id, p.label))}
      <div className="send-to-divider" />
      <button
        type="button"
        className="send-to-item send-to-customize"
        onClick={() => {
          onCustomize();
        }}
      >
        <span className="send-to-item-label">Customize first…</span>
      </button>
    </div>
  );
}
