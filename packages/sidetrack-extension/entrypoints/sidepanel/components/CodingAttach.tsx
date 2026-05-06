import { useEffect, useRef, useState } from 'react';

import type { CodingAttachTokenRecord } from '../../../src/companion/model';
import type { CodingSession } from '../../../src/workboard';
import { Modal } from './Modal';

export type CodingTool = CodingSession['tool'];

export interface CodingAttachProps {
  readonly defaultWorkstreamId?: string;
  readonly workstreams: readonly { readonly bac_id: string; readonly path: string }[];
  readonly companionAvailable: boolean;
  readonly mcpEndpoint?: string;
  // Optional bearer key for the Streamable HTTP MCP server. When set,
  // the agent prompt instructs the agent to send
  // `Authorization: Bearer <key>` on every MCP request. Loopback-only
  // companions can leave this undefined and rely on the loopback gate.
  readonly mcpAuthBearer?: string;
  readonly onCancel: () => void;
  readonly onAttached: (session: CodingSession) => void;
  readonly onCreateToken: (request: {
    readonly workstreamId?: string;
  }) => Promise<CodingAttachTokenRecord>;
  readonly onPoll: (token: string) => Promise<readonly CodingSession[]>;
}

interface PendingAttach {
  readonly token: string;
  readonly expiresAt: string;
  readonly workstreamId?: string;
}

// Phase 5: collapsed attach prompt. Capable agents auto-discover
// Sidetrack tools via tools/list and read the workstream context
// resource via sidetrack://workstream/<id>/context. The prior 18-line
// flow + verbose instructions front-loaded a contract the agent
// didn't read; a 3-line core (endpoint + bearer + token) plus an
// optional workstream resource hint conveys everything modern MCP
// clients need.
const buildAgentPrompt = (
  token: string,
  workstreamId: string | undefined,
  mcpEndpoint: string,
  mcpAuthBearer: string | undefined,
): string =>
  [
    `sidetrack_mcp: ${mcpEndpoint}`,
    ...(mcpAuthBearer === undefined ? [] : [`sidetrack_mcp_auth: Bearer ${mcpAuthBearer}`]),
    `sidetrack_attach_token: ${token}`,
    ...(workstreamId === undefined
      ? []
      : [`sidetrack_workstream_id: ${workstreamId}`]),
    '',
    'Use the Sidetrack MCP server above. Call sidetrack.session.attach with the attach token, then continue with my task using Sidetrack tools when useful.',
  ].join('\n');

export function CodingAttach({
  defaultWorkstreamId,
  workstreams,
  companionAvailable,
  mcpEndpoint = 'http://127.0.0.1:8721/mcp',
  mcpAuthBearer,
  onCancel,
  onAttached,
  onCreateToken,
  onPoll,
}: CodingAttachProps) {
  const [workstreamId, setWorkstreamId] = useState(defaultWorkstreamId ?? '');
  const [pending, setPending] = useState<PendingAttach | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [expired, setExpired] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const expiryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (pollTimer.current !== null) {
        clearInterval(pollTimer.current);
      }
      if (expiryTimer.current !== null) {
        clearTimeout(expiryTimer.current);
      }
    },
    [],
  );

  const stopPolling = () => {
    if (pollTimer.current !== null) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
    if (expiryTimer.current !== null) {
      clearTimeout(expiryTimer.current);
      expiryTimer.current = null;
    }
  };

  const startHandoff = () => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    setExpired(false);
    setCopied(false);
    void (async () => {
      try {
        const record = await onCreateToken(workstreamId === '' ? {} : { workstreamId });
        const token = record.token;
        const prompt = buildAgentPrompt(token, record.workstreamId, mcpEndpoint, mcpAuthBearer);
        try {
          await navigator.clipboard.writeText(prompt);
          setCopied(true);
        } catch {
          // Clipboard refused (focus / permissions); the prompt block below
          // still shows the text for manual copy.
        }
        setPending({
          token,
          expiresAt: record.expiresAt,
          ...(record.workstreamId === undefined ? {} : { workstreamId: record.workstreamId }),
        });
        const expiresMs = Math.max(1000, Date.parse(record.expiresAt) - Date.now());
        expiryTimer.current = setTimeout(() => {
          setExpired(true);
          stopPolling();
        }, expiresMs);
        pollTimer.current = setInterval(() => {
          void (async () => {
            try {
              const sessions = await onPoll(token);
              if (sessions.length > 0) {
                stopPolling();
                onAttached(sessions[0]);
              }
            } catch {
              // Transient — keep polling. The expiry timer is the upper bound.
            }
          })();
        }, 2000);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not create attach token.');
      } finally {
        setBusy(false);
      }
    })();
  };

  const cancel = () => {
    stopPolling();
    onCancel();
  };

  const reset = () => {
    stopPolling();
    setPending(null);
    setExpired(false);
    setCopied(false);
    setError(null);
  };

  const promptText =
    pending === null
      ? ''
      : buildAgentPrompt(pending.token, pending.workstreamId, mcpEndpoint, mcpAuthBearer);

  return (
    <Modal
      title="Attach coding session"
      subtitle="Hand a one-time token to your coding agent — it registers itself via MCP."
      width={560}
      onClose={cancel}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={cancel}>
            {pending === null ? 'Cancel' : 'Close'}
          </button>
          <div className="spacer" />
          {pending === null ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={!companionAvailable || busy}
              onClick={startHandoff}
            >
              {busy ? 'Generating…' : 'Generate prompt'}
            </button>
          ) : expired ? (
            <button type="button" className="btn btn-primary" onClick={reset}>
              Generate new token
            </button>
          ) : (
            <span className="muted mono" aria-live="polite">
              Waiting for your agent to register…
            </span>
          )}
        </>
      }
    >
      {!companionAvailable ? (
        <div className="banner warning">
          Coding-session attach needs the companion. Configure a vault path and bridge key in
          Settings, then try again.
        </div>
      ) : null}

      <div className="composer-row">
        <label>Workstream</label>
        <select
          value={workstreamId}
          onChange={(event) => {
            setWorkstreamId(event.target.value);
          }}
          disabled={pending !== null}
        >
          <option value="">— Inbox (no workstream) —</option>
          {workstreams.map((workstream) => (
            <option key={workstream.bac_id} value={workstream.bac_id}>
              {workstream.path}
            </option>
          ))}
        </select>
      </div>

      {pending === null ? (
        <p className="muted">
          Click "Generate prompt" to mint a 5-minute attach token. We'll copy a ready-to-paste
          prompt to your clipboard — paste it into your coding agent (Claude Code, Codex CLI,
          Cursor) and the agent will fill in cwd, branch, sessionId from its own runtime.
        </p>
      ) : (
        <div className="coding-handoff">
          <p className="muted">
            Paste this into your coding agent.{' '}
            {copied ? (
              <span className="mono signal">(copied to clipboard)</span>
            ) : (
              <span className="mono">(copy manually if your clipboard refused focus)</span>
            )}
          </p>
          <pre className="mono coding-handoff-prompt">{promptText}</pre>
          <div className="coding-handoff-meta mono">
            Token: {pending.token} · expires {new Date(pending.expiresAt).toLocaleTimeString()}
          </div>
          {expired ? (
            <div className="banner warning">Token expired. Generate a new one and re-paste.</div>
          ) : null}
        </div>
      )}

      {error === null ? null : <div className="banner danger">{error}</div>}
    </Modal>
  );
}
