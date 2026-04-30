import { useEffect, useMemo, useRef, useState } from 'react';
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

export interface ComposedPacket {
  readonly kind: PacketKind;
  readonly template: ResearchTemplate | null;
  readonly target: DispatchTarget;
  readonly title: string;
  readonly body: string;
  readonly scopeLabel: string;
  readonly sourceThreadId?: string;
  readonly workstreamId?: string;
  readonly tokenEstimate: number;
  readonly redactedItems: readonly { readonly kind: string; readonly count: number }[];
}

export interface PacketComposerTurn {
  readonly role: 'user' | 'assistant' | 'system' | 'unknown';
  readonly text: string;
  readonly capturedAt?: string;
}

export interface PacketComposerScope {
  readonly label: string;
  readonly meta?: string;
  readonly sourceThreadId?: string;
  readonly workstreamId?: string;
  readonly threadUrl?: string;
  readonly providerLabel?: string;
  // Recent turns from the source thread, oldest → newest. The composer's
  // "Include last N turns" picker walks from the end of this list.
  readonly availableTurns?: readonly PacketComposerTurn[];
}

export interface PacketComposerProps {
  readonly defaultKind?: PacketKind;
  readonly defaultTemplate?: ResearchTemplate;
  readonly defaultTitle?: string;
  readonly defaultBody?: string;
  readonly scope?: PacketComposerScope;
  readonly tokenLimit?: number;
  readonly redactedItems?: readonly { readonly kind: string; readonly count: number }[];
  readonly onCancel: () => void;
  readonly onCopy: (packet: ComposedPacket) => void;
  readonly onSave: (packet: ComposedPacket) => void;
  readonly onDispatch: (packet: ComposedPacket) => void;
}

const KIND_LABELS: Record<PacketKind, string> = {
  context_pack: 'Context Pack',
  research_packet: 'Research Packet',
  coding_agent_packet: 'Coding Agent Packet',
  notebook_export: 'Notebook Export',
};

const KIND_HELP: Record<PacketKind, string> = {
  context_pack:
    'Generic context bundle. Use when handing a thread to another AI for "catch me up".',
  research_packet: 'Targeted research ask. Pick a sub-template for the framing.',
  coding_agent_packet:
    'For Claude Code / Codex / Cursor — file-aware handoff with acceptance criteria.',
  notebook_export: 'Markdown export with frontmatter, ready for Obsidian / Notion.',
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

// Group targets so the user sees three intent lanes instead of one
// flat strip of nine pills:
//   1. AI providers (web chats) — drives a real dispatch
//   2. Coding agents (CLI tools) — also a dispatch, different surface
//   3. Export sinks (Notebook / Markdown) — produces a file, not a chat
// Tier sub-pills (GPT Pro / Deep Research) nest under their parent
// provider in the AI lane.
interface ProviderTargetGroup {
  readonly id: DispatchTarget;
  readonly label: string;
  readonly variants?: readonly { readonly id: DispatchTarget; readonly label: string }[];
}
const SEND_TO_AI_TARGETS: readonly ProviderTargetGroup[] = [
  {
    id: 'gpt_pro',
    label: 'GPT',
    variants: [
      { id: 'gpt_pro', label: 'Pro' },
      { id: 'deep_research', label: 'Deep Research' },
    ],
  },
  { id: 'claude', label: 'Claude' },
  { id: 'gemini', label: 'Gemini' },
];
const SEND_TO_CODING_TARGETS: readonly DispatchTarget[] = ['codex', 'claude_code', 'cursor'];
const EXPORT_AS_TARGETS: readonly DispatchTarget[] = ['notebook', 'markdown'];

// True if the chosen target represents a "send" (AI / coding) action.
// Notebook / Markdown are file exports, not dispatches.
const isExportTarget = (t: DispatchTarget): boolean =>
  t === 'notebook' || t === 'markdown';

const FALLBACK_BODY = `# Context Pack

## Scope
…

## Recent context
…

## Open questions
…`;

const DEFAULT_SCOPE: PacketComposerScope = {
  label: 'Workstream: Sidetrack / MVP PRD',
  meta: '3 threads · 2 queued · 1 closed',
};

const TURN_TEXT_CAP = 1200;

const renderTurnBlock = (turn: PacketComposerTurn): string => {
  const roleHeader = turn.role === 'assistant' ? '### Assistant' : '### User';
  const text =
    turn.text.length > TURN_TEXT_CAP ? `${turn.text.slice(0, TURN_TEXT_CAP)}…` : turn.text;
  return `${roleHeader}\n${text}`;
};

const renderTurnsMarkdown = (turns: readonly PacketComposerTurn[], count: number): string => {
  if (count <= 0 || turns.length === 0) {
    return '_No turns included._';
  }
  const slice = turns.slice(Math.max(0, turns.length - count));
  return slice.map(renderTurnBlock).join('\n\n');
};

const threadInfoLine = (scope: PacketComposerScope): string => {
  const provider = scope.providerLabel ?? 'AI thread';
  if (scope.threadUrl !== undefined) {
    return `${provider} · ${scope.threadUrl}`;
  }
  return provider;
};

const buildContextPack = (title: string, scope: PacketComposerScope, turnsMd: string): string =>
  `# Context Pack: ${title}

## Scope
${threadInfoLine(scope)}

## Recent thread context
${turnsMd}

## Open questions
…`;

const buildResearchPacket = (
  title: string,
  template: ResearchTemplate,
  scope: PacketComposerScope,
  turnsMd: string,
): string => {
  const head = `# Research request: ${title}\n\n## Source\n${threadInfoLine(scope)}`;
  const ctx = `## Recent context\n${turnsMd}`;
  if (template === 'web_to_ai_checklist') {
    return `${head}

## Pre-flight checklist for the receiving AI
- [ ] Verify the conclusion against the original source
- [ ] Note any framework versions / dates the source assumes
- [ ] Flag if the question has shifted since first ask
- [ ] Distinguish what was asserted vs cited

${ctx}

## Ask
…`;
  }
  if (template === 'resume_tech_stack') {
    return `# Tech-stack extraction: ${title}

## Source
${threadInfoLine(scope)}

${ctx}

## Goal
Pull the technologies, frameworks, and tools mentioned above.
Output as a comma-separated list grouped by category
(frontend / backend / ops / data / ml).`;
  }
  if (template === 'latest_developments_radar') {
    return `# What's new since: ${title}

## Baseline understanding (from source thread)
${turnsMd}

## Ask
Surface developments, releases, breaking changes, or new tools
in this space published in the last 30 days. Cite sources.`;
  }
  return `${head}

${ctx}

## Ask
…`;
};

const buildCodingAgentPacket = (
  title: string,
  scope: PacketComposerScope,
  turnsMd: string,
): string =>
  `# Coding handoff: ${title}

## Source thread
${threadInfoLine(scope)}

## Recent context
${turnsMd}

## Files / modules involved
…

## Acceptance criteria
- [ ] …
- [ ] …

## Constraints
- Do not modify unrelated files.
- Run the existing test suite before reporting done.`;

const buildNotebookExport = (
  title: string,
  scope: PacketComposerScope,
  turnsMd: string,
): string => {
  const today = new Date().toISOString().slice(0, 10);
  return `---
title: ${title}
created: ${today}
source: ${scope.threadUrl ?? '(unknown)'}
provider: ${scope.providerLabel ?? '(unknown)'}
---

# ${title}

${turnsMd}`;
};

const buildBody = (
  kind: PacketKind,
  template: ResearchTemplate,
  scope: PacketComposerScope,
  title: string,
  includeTurnCount: number,
): string => {
  const turnsMd = renderTurnsMarkdown(scope.availableTurns ?? [], includeTurnCount);
  if (kind === 'context_pack') return buildContextPack(title, scope, turnsMd);
  if (kind === 'coding_agent_packet') return buildCodingAgentPacket(title, scope, turnsMd);
  if (kind === 'notebook_export') return buildNotebookExport(title, scope, turnsMd);
  return buildResearchPacket(title, template, scope, turnsMd);
};

// Quick char/4 heuristic for the live composer count. The
// authoritative number is the cl100k count the companion computes on
// dispatch (see safety/tokenBudget.ts) — we don't ship the full BPE
// table to the side panel just to render a live preview number.
const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export function PacketComposer({
  defaultKind = 'research_packet',
  defaultTemplate = 'web_to_ai_checklist',
  defaultTitle,
  defaultBody,
  scope = DEFAULT_SCOPE,
  tokenLimit = 200_000,
  redactedItems = [],
  onCancel,
  onCopy,
  onSave,
  onDispatch,
}: PacketComposerProps) {
  const [kind, setKind] = useState<PacketKind>(defaultKind);
  const [template, setTemplate] = useState<ResearchTemplate>(defaultTemplate);
  const [target, setTarget] = useState<DispatchTarget | null>(null);
  // Title is owned by Scope — a packet about a thread is named after
  // the thread. Click the scope label to rename inline.
  const initialTitle = defaultTitle ?? scope.label.replace(/^Workstream:\s*/i, '').trim();
  const [title, setTitle] = useState(initialTitle);
  const [scopeEditing, setScopeEditing] = useState(false);
  // Split-button menu state for the secondary footer actions
  // (Copy to clipboard / Save to vault). Closed by default; only
  // opens when the user clicks the caret.
  const [secondaryMenuOpen, setSecondaryMenuOpen] = useState(false);

  const availableTurns = scope.availableTurns ?? [];
  const maxTurns = availableTurns.length;
  const [includeTurnCount, setIncludeTurnCount] = useState(Math.min(maxTurns, 4));
  // Stop auto-rebuilding the body once the user has hand-edited it.
  const [bodyManuallyEdited, setBodyManuallyEdited] = useState(defaultBody !== undefined);
  const [body, setBody] = useState(
    defaultBody ??
      (maxTurns > 0
        ? buildBody(defaultKind, defaultTemplate, scope, initialTitle, Math.min(maxTurns, 4))
        : FALLBACK_BODY),
  );

  // Keep includeTurnCount in range when the available-turns prop changes.
  const lastMaxRef = useRef(maxTurns);
  useEffect(() => {
    if (maxTurns !== lastMaxRef.current) {
      lastMaxRef.current = maxTurns;
      setIncludeTurnCount((current) => Math.min(current, maxTurns));
    }
  }, [maxTurns]);

  // Rebuild body from kind/template/turns/title until the user types into
  // the textarea — at that point we lock in their edits. We intentionally
  // depend on flattened scope fields (not the scope object itself) since
  // its identity churns every render.
  const scopeKey = `${scope.threadUrl ?? ''}::${scope.providerLabel ?? ''}::${scope.label}::${String(maxTurns)}`;
  const bodyTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (bodyManuallyEdited) return;
    setBody(buildBody(kind, template, scope, title.trim() || initialTitle, includeTurnCount));
    // Reset scroll to the top of the textarea so the user sees the
    // beginning of the regenerated template, not whatever line their
    // previous body was scrolled to. Without this, switching from
    // Context Pack → Research Packet often shows a single mid-body
    // line ("Key-share wallet") and looks like the body was wiped.
    if (bodyTextareaRef.current !== null) {
      bodyTextareaRef.current.scrollTop = 0;
    }
  }, [bodyManuallyEdited, kind, template, title, initialTitle, includeTurnCount, scope, scopeKey]);

  const tokenEstimate = useMemo(() => estimateTokens(body), [body]);
  const tokenPct = Math.round((tokenEstimate / tokenLimit) * 100);
  const tokenLevel: 'green' | 'amber' | 'over' =
    tokenPct < 80 ? 'green' : tokenPct < 100 ? 'amber' : 'over';

  const buildPacket = (selectedTarget: DispatchTarget): ComposedPacket => ({
    kind,
    template: kind === 'research_packet' ? template : null,
    target: selectedTarget,
    title: title.trim().length > 0 ? title.trim() : initialTitle,
    body,
    scopeLabel: scope.label,
    tokenEstimate,
    redactedItems,
    ...(scope.sourceThreadId !== undefined ? { sourceThreadId: scope.sourceThreadId } : {}),
    ...(scope.workstreamId !== undefined ? { workstreamId: scope.workstreamId } : {}),
  });

  // Copy + Save are target-independent — they operate on the body,
  // not the destination. Only Dispatch needs a target. Use a
  // stable fallback (markdown) for the packet's `target` field on
  // the secondary actions so downstream consumers always have a
  // value, but never demand the user pick one to copy/save.
  const handleCopy = () => {
    onCopy(buildPacket(target ?? 'markdown'));
    setSecondaryMenuOpen(false);
  };
  const handleSave = () => {
    onSave(buildPacket(target ?? 'markdown'));
    setSecondaryMenuOpen(false);
  };
  const handleDispatch = () => {
    if (target === null) return;
    onDispatch(buildPacket(target));
  };

  return (
    <Modal title="New packet" subtitle="Compose, preview, dispatch" width={780} onClose={onCancel}>
      <div className="composer-row">
        <label>Packet kind</label>
        <div className="pill-row">
          {(Object.keys(KIND_LABELS) as readonly PacketKind[]).map((k) => (
            <button
              key={k}
              type="button"
              className={'pill ' + (kind === k ? 'on' : '')}
              title={KIND_HELP[k]}
              onClick={() => {
                setKind(k);
              }}
            >
              {KIND_LABELS[k]}
            </button>
          ))}
        </div>
        <p className="composer-help mono">{KIND_HELP[kind]}</p>
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

      {/* Scope owns the packet name. Click the label to rename
          inline — the underlying scope.label keeps showing the
          source thread / workstream identity. */}
      <div className="composer-row">
        <label>Scope</label>
        <div className="composer-scope">
          <div className="scope-pick">
            <span className="scope-icon">{Icons.folder}</span>
            {scopeEditing ? (
              <input
                type="text"
                autoFocus
                className="packet-title-input"
                value={title}
                placeholder={initialTitle}
                onChange={(e) => {
                  setTitle(e.target.value);
                }}
                onBlur={() => {
                  setScopeEditing(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === 'Escape') {
                    setScopeEditing(false);
                  }
                }}
              />
            ) : (
              <button
                type="button"
                className="scope-label-btn"
                title="Click to rename this packet"
                onClick={() => {
                  setScopeEditing(true);
                }}
              >
                {title.trim().length > 0 ? title : initialTitle}
              </button>
            )}
            {scope.meta !== undefined ? (
              <span className="scope-meta mono">{scope.meta}</span>
            ) : null}
          </div>
          <div className="scope-options">
            <label className="slider-row">
              <span>Include last</span>
              <input
                type="range"
                min={0}
                max={Math.max(0, maxTurns)}
                value={includeTurnCount}
                disabled={maxTurns === 0}
                onChange={(e) => {
                  setIncludeTurnCount(Number(e.target.value));
                }}
              />
              <span className="mono">
                {String(includeTurnCount)} / {String(maxTurns)} turn
                {maxTurns === 1 ? '' : 's'}
              </span>
            </label>
            {bodyManuallyEdited ? (
              <button
                type="button"
                className="btn-link mono"
                onClick={() => {
                  setBodyManuallyEdited(false);
                }}
              >
                Reset body to template
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {/* Target now in two lanes — "Send to AI" (chat + coding agents)
          drives a real Dispatch; "Export as" produces a file. The
          footer's Dispatch button reads the lane to know whether to
          ship to a chat or write a file. */}
      <div className="composer-row">
        <label>Send to AI</label>
        <div className="pill-row pill-row-grouped">
          {SEND_TO_AI_TARGETS.map((group) => {
            const groupActive =
              group.id === target ||
              (group.variants?.some((v) => v.id === target) ?? false);
            const isVariantSelected = group.variants?.some((v) => v.id === target) ?? false;
            return (
              <span
                key={group.id}
                className={'pill-group' + (groupActive ? ' on' : '')}
              >
                <button
                  type="button"
                  className={'pill ' + (groupActive ? 'on' : '')}
                  onClick={() => {
                    setTarget(group.id);
                  }}
                >
                  {group.label}
                </button>
                {group.variants !== undefined && groupActive
                  ? group.variants.map((v) => (
                      <button
                        key={v.id}
                        type="button"
                        className={'pill pill-variant ' + (target === v.id ? 'on' : '')}
                        onClick={() => {
                          setTarget(v.id);
                        }}
                      >
                        {v.label}
                      </button>
                    ))
                  : null}
                {/* Hide the variant-only highlight when nothing is
                    selected so the parent pill doesn't read as active
                    on its own. */}
                {group.id === target && isVariantSelected ? null : null}
              </span>
            );
          })}
          {SEND_TO_CODING_TARGETS.map((t) => (
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

      <div className="composer-row">
        <label>Or export as</label>
        <div className="pill-row">
          {EXPORT_AS_TARGETS.map((t) => (
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
        <div className="preview-head mono">
          packet body {bodyManuallyEdited ? '· manually edited' : '· auto from template'}
        </div>
        <textarea
          ref={bodyTextareaRef}
          className="preview-body mono packet-body-input"
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            if (!bodyManuallyEdited) setBodyManuallyEdited(true);
          }}
          rows={16}
        />
      </div>

      <div className="composer-footer-meta">
        <div className={'token-pill ' + tokenLevel}>
          <span className="mono">
            {tokenEstimate.toLocaleString()} / {tokenLimit.toLocaleString()} tokens
          </span>
          <span className="mono">({tokenPct}%)</span>
        </div>
        {/* Only render the redaction line when something was actually
            redacted. Status-quo confirmations are noise. */}
        {redactedItems.length > 0 ? (
          <div className="redaction-summary">
            <em>
              Redacted {redactedItems.reduce((sum, r) => sum + r.count, 0)} items:{' '}
              {redactedItems.map((r) => `${String(r.count)} ${r.kind}`).join(', ')}
            </em>
            <button type="button" className="reveal-link mono">
              [reveal]
            </button>
          </div>
        ) : null}
      </div>

      {/* Footer: Cancel on the left, primary Dispatch on the right
          with a split-button caret for Copy / Save (target-independent
          escape hatches). 95% of the time the user wants Dispatch. */}
      <div className="modal-foot">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <div className="spacer" />
        <div className="split-button">
          <button
            type="button"
            className="btn btn-primary split-button-main"
            disabled={target === null}
            title={
              target === null
                ? 'Pick a Send-to-AI target or an Export sink first'
                : `Dispatch this packet to ${TARGET_LABELS[target]}`
            }
            onClick={handleDispatch}
          >
            <span className="icon-12">{Icons.send}</span>{' '}
            {target !== null && isExportTarget(target) ? 'Export' : 'Dispatch'}
          </button>
          <button
            type="button"
            className="btn btn-primary split-button-caret"
            aria-label="More packet actions"
            aria-expanded={secondaryMenuOpen}
            onClick={() => {
              setSecondaryMenuOpen(!secondaryMenuOpen);
            }}
          >
            ▾
          </button>
          {secondaryMenuOpen ? (
            <div className="split-button-menu" role="menu">
              <button
                type="button"
                className="split-button-menu-item"
                role="menuitem"
                onClick={handleCopy}
              >
                <span className="icon-12">{Icons.copy}</span> Copy to clipboard
              </button>
              <button
                type="button"
                className="split-button-menu-item"
                role="menuitem"
                onClick={handleSave}
              >
                Save to vault
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
