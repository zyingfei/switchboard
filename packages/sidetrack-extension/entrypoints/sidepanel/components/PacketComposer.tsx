import { useState } from 'react';
import { Modal } from './Modal';
import { Icons } from './icons';

export type PacketKind =
  | 'context_pack'
  | 'research_packet'
  | 'coding_agent_packet'
  | 'notebook_export';
export type ResearchTemplate =
  | 'web_to_ai_checklist'
  | 'resume_tech_stack'
  | 'latest_developments_radar'
  | 'custom';
export type DispatchTarget =
  | 'gpt_pro'
  | 'deep_research'
  | 'claude'
  | 'gemini'
  | 'codex'
  | 'claude_code'
  | 'cursor'
  | 'notebook'
  | 'markdown';

export interface PacketComposerProps {
  readonly defaultKind?: PacketKind;
  readonly defaultTemplate?: ResearchTemplate;
  readonly onCancel: () => void;
  readonly onCopy: () => void;
  readonly onSave: () => void;
  readonly onDispatch: () => void;
}

const KIND_LABELS: Record<PacketKind, string> = {
  context_pack: 'Context Pack',
  research_packet: 'Research Packet',
  coding_agent_packet: 'Coding Agent Packet',
  notebook_export: 'Notebook Export',
};

const TEMPLATE_LABELS: Record<ResearchTemplate, string> = {
  web_to_ai_checklist: 'Web-to-AI checklist',
  resume_tech_stack: 'Resume → tech-stack',
  latest_developments_radar: 'Latest developments radar',
  custom: 'Custom',
};

const TARGET_LABELS: Record<DispatchTarget, string> = {
  gpt_pro: 'GPT Pro',
  deep_research: 'Deep Research',
  claude: 'Claude',
  gemini: 'Gemini',
  codex: 'Codex',
  claude_code: 'Claude Code',
  cursor: 'Cursor',
  notebook: 'Notebook',
  markdown: 'Markdown',
};

export function PacketComposer({
  defaultKind = 'research_packet',
  defaultTemplate = 'web_to_ai_checklist',
  onCancel,
  onCopy,
  onSave,
  onDispatch,
}: PacketComposerProps) {
  const [kind, setKind] = useState<PacketKind>(defaultKind);
  const [template, setTemplate] = useState<ResearchTemplate>(defaultTemplate);
  const [target, setTarget] = useState<DispatchTarget | null>(null);
  const [linkDepth, setLinkDepth] = useState(1);

  // Stub data — actual scope picker, redaction summary, token estimate wired by Codex
  const tokenEstimate = 4200;
  const tokenLimit = 200_000;
  const tokenPct = Math.round((tokenEstimate / tokenLimit) * 100);
  const tokenLevel: 'green' | 'amber' | 'over' =
    tokenPct < 80 ? 'green' : tokenPct < 100 ? 'amber' : 'over';

  const redactedItems = [
    { kind: 'GitHub token', count: 1 },
    { kind: 'Email', count: 1 },
  ];

  return (
    <Modal title="New packet" subtitle="Compose, preview, dispatch" width={620} onClose={onCancel}>
      <div className="composer-row">
        <label>Packet kind</label>
        <div className="pill-row">
          {(Object.keys(KIND_LABELS) as readonly PacketKind[]).map((k) => (
            <button
              key={k}
              type="button"
              className={'pill ' + (kind === k ? 'on' : '')}
              onClick={() => {
                setKind(k);
              }}
            >
              {KIND_LABELS[k]}
            </button>
          ))}
        </div>
      </div>

      {kind === 'research_packet' ? (
        <div className="composer-row">
          <label>Template</label>
          <div className="pill-row">
            {(Object.keys(TEMPLATE_LABELS) as readonly ResearchTemplate[]).map((t) => (
              <button
                key={t}
                type="button"
                className={'pill ' + (template === t ? 'on' : '')}
                onClick={() => {
                  setTemplate(t);
                }}
              >
                {TEMPLATE_LABELS[t]}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="composer-row">
        <label>Scope</label>
        <div className="composer-scope">
          <div className="scope-pick">
            <span className="scope-icon">{Icons.folder}</span>
            <span>
              Workstream: <em>Sidetrack / MVP PRD</em>
            </span>
            <span className="scope-meta mono">3 threads · 2 queued · 1 closed</span>
          </div>
          <div className="scope-options">
            <label className="check-row">
              <input type="checkbox" defaultChecked />
              <span>Include queued asks</span>
            </label>
            <label className="slider-row">
              <span>Link depth</span>
              <input
                type="range"
                min={0}
                max={2}
                value={linkDepth}
                onChange={(e) => {
                  setLinkDepth(Number(e.target.value));
                }}
              />
              <span className="mono">{linkDepth}</span>
            </label>
          </div>
        </div>
      </div>

      <div className="composer-row">
        <label>Target</label>
        <div className="pill-row">
          {(Object.keys(TARGET_LABELS) as readonly DispatchTarget[]).map((t) => (
            <button
              key={t}
              type="button"
              className={'pill ' + (target === t ? 'on' : '')}
              onClick={() => {
                setTarget(t);
              }}
            >
              {TARGET_LABELS[t]}
            </button>
          ))}
        </div>
      </div>

      <div className="composer-preview">
        <div className="preview-head mono">live preview</div>
        <pre className="preview-body mono">
          {`# Context Pack: Sidetrack / MVP PRD

## Goal
…

## Active decisions
- [[Companion install path — HTTP loopback]]
- [[Per-workstream privacy flag]]

## Relevant threads
- claude · "Side-panel state machine review"
- chatgpt · "PRD §24.10 wording"

## Sources
…

## Open questions
…`}
        </pre>
      </div>

      <div className="composer-footer-meta">
        <div className={'token-pill ' + tokenLevel}>
          <span className="mono">
            {tokenEstimate.toLocaleString()} / {tokenLimit.toLocaleString()} tokens
          </span>
          <span className="mono">({tokenPct}%)</span>
        </div>
        <div className="redaction-summary">
          <em>
            Redacted {redactedItems.reduce((sum, r) => sum + r.count, 0)} items:{' '}
            {redactedItems.map((r) => `${String(r.count)} ${r.kind}`).join(', ')}
          </em>
          <button type="button" className="reveal-link mono">
            [reveal]
          </button>
        </div>
      </div>

      <div className="modal-foot">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCopy}>
          <span className="icon-12">{Icons.copy}</span> Copy to clipboard
        </button>
        <button type="button" className="btn btn-ghost" onClick={onSave}>
          Save to vault
        </button>
        <div className="spacer" />
        <button
          type="button"
          className="btn btn-primary"
          disabled={target === null}
          onClick={onDispatch}
        >
          <span className="icon-12">{Icons.send}</span> Dispatch
        </button>
      </div>
    </Modal>
  );
}
