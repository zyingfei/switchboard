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
  readonly mcpAuthBearer?: string;
  // Probed status of the companion-managed MCP child. When the
  // child is unreachable, the modal warns the user before they
  // try to generate a token.
  readonly mcpHealth?: { readonly reachable: boolean; readonly checkedAt: string };
  // Inputs for the Codex MCP config snippets in the "Configure
  // agent" section. All optional — when missing, the modal renders
  // placeholders the user can fill in.
  readonly vaultRoot?: string;
  readonly bridgeKey?: string;
  readonly companionPort?: number;
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

// Codex MCP config snippets the user can paste into ~/.codex/config.toml.
// Streamable HTTP is preferred when the companion manages the MCP
// child (loopback bearer auth + lifecycle linked to companion);
// stdio is the fallback when the user starts sidetrack-mcp by hand.
const buildCodexHttpConfigSnippet = (mcpEndpoint: string): string =>
  [
    '[mcp_servers.sidetrack]',
    `url = "${mcpEndpoint}"`,
    'bearer_token_env_var = "SIDETRACK_MCP_AUTH_KEY"',
    'startup_timeout_sec = 20',
    'tool_timeout_sec = 180',
    'enabled = true',
  ].join('\n');

const buildCodexStdioConfigSnippet = (
  vaultRoot: string | undefined,
  companionPort: number,
): string =>
  [
    '[mcp_servers.sidetrack]',
    'command = "node"',
    'args = [',
    '  "<ABS-PATH>/sidetrack-mcp/dist/cli.js",',
    `  "--vault", "${vaultRoot ?? '<ABS-VAULT-PATH>'}",`,
    `  "--companion-url", "http://127.0.0.1:${String(companionPort)}",`,
    '  "--bridge-key", "${SIDETRACK_BRIDGE_KEY}"',
    ']',
    'startup_timeout_sec = 20',
    'tool_timeout_sec = 180',
    'enabled = true',
  ].join('\n');

const buildCodexCliCommand = (
  vaultRoot: string | undefined,
  companionPort: number,
): string =>
  [
    'codex mcp add sidetrack \\',
    '  --env SIDETRACK_BRIDGE_KEY="$SIDETRACK_BRIDGE_KEY" \\',
    '  -- node <ABS-PATH>/sidetrack-mcp/dist/cli.js \\',
    `    --vault ${vaultRoot ?? '<ABS-VAULT-PATH>'} \\`,
    `    --companion-url http://127.0.0.1:${String(companionPort)} \\`,
    '    --bridge-key "$SIDETRACK_BRIDGE_KEY"',
  ].join('\n');

export function CodingAttach({
  defaultWorkstreamId,
  workstreams,
  companionAvailable,
  mcpEndpoint = 'http://127.0.0.1:8721/mcp',
  mcpAuthBearer,
  mcpHealth,
  vaultRoot,
  bridgeKey,
  companionPort = 17_373,
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

  const [snippetCopied, setSnippetCopied] = useState<string | null>(null);
  const copySnippet = async (key: string, value: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setSnippetCopied(key);
      setTimeout(() => {
        setSnippetCopied((current) => (current === key ? null : current));
      }, 1500);
    } catch {
      // Clipboard refused (focus / permissions) — leave the
      // textarea visible so the user can copy by hand.
    }
  };

  const httpSnippet = buildCodexHttpConfigSnippet(mcpEndpoint);
  const stdioSnippet = buildCodexStdioConfigSnippet(vaultRoot, companionPort);
  const cliCommand = buildCodexCliCommand(vaultRoot, companionPort);
  const exportEnvHint =
    mcpAuthBearer === undefined
      ? '# Set SIDETRACK_BRIDGE_KEY in your shell first.'
      : `# In your shell:\nexport SIDETRACK_BRIDGE_KEY=${bridgeKey ?? '<bridge-key>'}\nexport SIDETRACK_MCP_AUTH_KEY=${mcpAuthBearer}`;

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

      {mcpHealth !== undefined && !mcpHealth.reachable ? (
        <div className="banner warning">
          Companion-managed MCP server is not responding (last checked{' '}
          {new Date(mcpHealth.checkedAt).toLocaleTimeString()}). Restart the companion with{' '}
          <code>--mcp-port</code> or run sidetrack-mcp by hand.
        </div>
      ) : null}

      <details className="coding-handoff-config">
        <summary className="mono">1. Configure Sidetrack MCP in your coding agent</summary>
        <div className="coding-handoff-config-body">
          <p className="muted">
            One-time setup. Streamable HTTP is recommended when the companion manages the MCP
            child (this side panel reads its auth key from <code>/v1/status</code>). Stdio is
            the fallback when you start <code>sidetrack-mcp</code> by hand.
          </p>
          <pre className="mono coding-handoff-prompt">{exportEnvHint}</pre>

          <div className="coding-handoff-snippet">
            <div className="coding-handoff-snippet-head mono">
              <span>Codex Streamable HTTP — append to ~/.codex/config.toml</span>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  void copySnippet('http', httpSnippet);
                }}
              >
                {snippetCopied === 'http' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <pre className="mono coding-handoff-prompt">{httpSnippet}</pre>
          </div>

          <div className="coding-handoff-snippet">
            <div className="coding-handoff-snippet-head mono">
              <span>Codex stdio — append to ~/.codex/config.toml</span>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  void copySnippet('stdio', stdioSnippet);
                }}
              >
                {snippetCopied === 'stdio' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <pre className="mono coding-handoff-prompt">{stdioSnippet}</pre>
          </div>

          <div className="coding-handoff-snippet">
            <div className="coding-handoff-snippet-head mono">
              <span>codex mcp add — single shell command</span>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  void copySnippet('cli', cliCommand);
                }}
              >
                {snippetCopied === 'cli' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <pre className="mono coding-handoff-prompt">{cliCommand}</pre>
          </div>

          <p className="muted">
            Restart Codex if you changed config. After that, generating a token below gives
            you the one-line attach instruction to paste into the agent — no more boilerplate.
          </p>
        </div>
      </details>

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
