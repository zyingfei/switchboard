import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import {
  bridgeKeyValidationCopy,
  validateBridgeKeyCandidate,
  type BridgeKeyValidationFailure,
} from '../../../src/companion/bridgeKeyValidation';

export type WizardStep = 'welcome' | 'vault' | 'companion' | 'providers' | 'done';

// Local vs synced/remote. Local-only setups create a new vault on this
// machine, so we collect the folder path up front and interpolate it
// into the companion's bunx command. Synced/remote setups attach to a
// companion that is already running — the vault lives wherever that
// companion put it, so we skip the path question entirely and read
// `vaultRoot` back from `/v1/version` once connected.
export type WizardMode = 'local' | 'synced';

const LOCAL_STEPS: readonly WizardStep[] = ['welcome', 'vault', 'companion', 'providers', 'done'];
const SYNCED_STEPS: readonly WizardStep[] = ['welcome', 'companion', 'providers', 'done'];

const stepsForMode = (mode: WizardMode | null): readonly WizardStep[] =>
  mode === 'synced' ? SYNCED_STEPS : LOCAL_STEPS;

const STEP_LABEL: Record<WizardStep, string> = {
  welcome: 'Welcome',
  vault: 'Vault',
  companion: 'Companion',
  providers: 'Providers',
  done: 'Done',
};

export type CompanionPingResult = 'reachable' | 'unreachable';

export interface WizardProps {
  readonly bridgeKey?: string;
  readonly companionReachable?: boolean;
  readonly connectionError?: string | null;
  readonly localRestApiDetected?: boolean;
  readonly port?: number;
  readonly onClose: () => void;
  readonly onFinish: () => void;
  readonly onBridgeKeyChange?: (bridgeKey: string) => void;
  // Override the loopback port. The default 17373 fits the published
  // companion CLI, but tests / sandboxes / power users running a
  // custom port need this hook so they can finish onboarding without
  // hand-editing chrome.storage.
  readonly onPortChange?: (port: number) => void;
  readonly onSkip?: () => void;
  readonly onVaultPathChange?: (vaultPath: string) => void;
  readonly vaultPath?: string;
  /** Test the companion's `/v1/health` endpoint (no auth). Defaults to a fetch against `http://127.0.0.1:<port>/v1/health`. */
  readonly onPingCompanion?: () => Promise<CompanionPingResult>;
  /** Read clipboard contents. Defaults to `navigator.clipboard.readText()`. */
  readonly onReadClipboard?: () => Promise<string>;
  /**
   * Resolve the companion's vault root for synced/remote setups. Defaults
   * to a `GET /v1/version` against `http://127.0.0.1:<port>` — the path
   * the user would otherwise type by hand is reported by the server.
   */
  readonly onResolveVaultRoot?: () => Promise<string | null>;
}

const defaultPingCompanion = async (port: number): Promise<CompanionPingResult> => {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/v1/health`, { method: 'GET' });
    return response.ok ? 'reachable' : 'unreachable';
  } catch {
    return 'unreachable';
  }
};

const defaultReadClipboard = (): Promise<string> => navigator.clipboard.readText();

// `/v1/version` is unauthenticated + cheap; the bridge-key header is
// harmless on it. The companion answers `{ data: { vaultRoot, … } }`.
const defaultResolveVaultRoot = async (
  port: number,
  bridgeKey: string,
): Promise<string | null> => {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/v1/version`, {
      method: 'GET',
      headers: bridgeKey.length > 0 ? { 'x-bac-bridge-key': bridgeKey } : undefined,
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const root = (body as { data?: { vaultRoot?: unknown } } | null)?.data?.vaultRoot;
    return typeof root === 'string' && root.length > 0 ? root : null;
  } catch {
    return null;
  }
};

export function Wizard({
  bridgeKey = '',
  companionReachable = false,
  connectionError = null,
  localRestApiDetected = false,
  port = 17_373,
  onClose,
  onFinish,
  onBridgeKeyChange,
  onPortChange,
  onSkip,
  onVaultPathChange,
  vaultPath = '',
  onPingCompanion,
  onReadClipboard,
  onResolveVaultRoot,
}: WizardProps) {
  const [mode, setMode] = useState<WizardMode | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [bridgeKeyFailure, setBridgeKeyFailure] = useState<BridgeKeyValidationFailure | null>(null);
  const steps = stepsForMode(mode);
  const step = steps[stepIndex] ?? 'welcome';

  useEffect(() => {
    if (connectionError !== null) {
      const companionIndex = stepsForMode(mode).indexOf('companion');
      if (companionIndex >= 0) setStepIndex(companionIndex);
    }
  }, [connectionError, mode]);

  const next = () => {
    // The Welcome step is a fork: pick a mode before advancing.
    if (step === 'welcome' && mode === null) {
      return;
    }
    if (step === 'companion') {
      const failure = validateBridgeKeyCandidate(bridgeKey);
      if (failure !== null) {
        setBridgeKeyFailure(failure);
        return;
      }
      setBridgeKeyFailure(null);
    }
    if (stepIndex < steps.length - 1) {
      setStepIndex(stepIndex + 1);
    }
  };
  const back = () => {
    if (stepIndex > 0) {
      setStepIndex(stepIndex - 1);
    }
  };

  const footer = (
    <>
      <div className="wizard-dots">
        {steps.map((s, idx) => (
          <span key={s} className={'dot' + (idx === stepIndex ? ' on' : '')} aria-hidden />
        ))}
      </div>
      <div className="spacer" />
      {stepIndex > 0 ? (
        <button type="button" className="btn btn-ghost" onClick={back}>
          Back
        </button>
      ) : null}
      {stepIndex < steps.length - 1 ? (
        <button
          type="button"
          className="btn btn-primary"
          disabled={step === 'welcome' && mode === null}
          onClick={next}
        >
          Next
        </button>
      ) : (
        <button type="button" className="btn btn-primary" onClick={onFinish}>
          Done
        </button>
      )}
    </>
  );

  return (
    <Modal
      title="Set up Sidetrack"
      subtitle={`step ${String(stepIndex + 1)} of ${String(steps.length)} · ${STEP_LABEL[step]}`}
      width={580}
      onClose={onClose}
      footer={footer}
    >
      {step === 'welcome' ? (
        <WelcomeStep mode={mode} onModeChange={setMode} onSkip={onSkip} />
      ) : null}
      {step === 'companion' ? (
        <CompanionStep
          mode={mode ?? 'local'}
          bridgeKey={bridgeKey}
          bridgeKeyFailure={bridgeKeyFailure}
          companionReachable={companionReachable}
          connectionError={connectionError}
          onBridgeKeyFailureClear={() => {
            setBridgeKeyFailure(null);
          }}
          onBridgeKeyChange={onBridgeKeyChange}
          onPortChange={onPortChange}
          onPingCompanion={onPingCompanion ?? (() => defaultPingCompanion(port))}
          onReadClipboard={onReadClipboard ?? defaultReadClipboard}
          onResolveVaultRoot={
            onResolveVaultRoot ?? (() => defaultResolveVaultRoot(port, bridgeKey))
          }
          onVaultPathChange={onVaultPathChange}
          port={port}
          vaultPath={vaultPath}
        />
      ) : null}
      {step === 'vault' ? (
        <VaultStep
          localRestApiDetected={localRestApiDetected}
          onVaultPathChange={onVaultPathChange}
          vaultPath={vaultPath}
        />
      ) : null}
      {step === 'providers' ? <ProvidersStep /> : null}
      {step === 'done' ? <DoneStep /> : null}
    </Modal>
  );
}

function WelcomeStep({
  mode,
  onModeChange,
  onSkip,
}: {
  readonly mode: WizardMode | null;
  readonly onModeChange: (mode: WizardMode) => void;
  readonly onSkip?: () => void;
}) {
  return (
    <div className="wizard-step">
      <div className="wizard-display">Track your AI work without losing the thread.</div>
      <div className="wizard-lede ai-italic">
        Sidetrack watches your AI tabs, recovers what you lost, and lets you hand context to other
        models — without copy-paste fatigue.
      </div>
      <p className="wizard-lede">
        Connect a vault to sync across devices and persist beyond uninstall. Pick how this browser
        reaches it:
      </p>
      <div className="wizard-choice-row">
        <button
          type="button"
          className={'wizard-choice' + (mode === 'local' ? ' on' : '')}
          aria-pressed={mode === 'local'}
          onClick={() => {
            onModeChange('local');
          }}
        >
          <div className="wizard-card-title">Local vault</div>
          <div className="wizard-card-meta">
            Set up a new vault on this machine. You&apos;ll choose a folder and start the companion.
          </div>
        </button>
        <button
          type="button"
          className={'wizard-choice' + (mode === 'synced' ? ' on' : '')}
          aria-pressed={mode === 'synced'}
          onClick={() => {
            onModeChange('synced');
          }}
        >
          <div className="wizard-card-title">Synced / remote</div>
          <div className="wizard-card-meta">
            Connect to a companion that&apos;s already running. The vault path comes from the
            companion.
          </div>
        </button>
      </div>
      <button type="button" className="wizard-skip mono" onClick={onSkip}>
        Use Sidetrack without vault sync →
      </button>
    </div>
  );
}

function CompanionStep({
  mode,
  bridgeKey,
  bridgeKeyFailure,
  companionReachable,
  connectionError,
  onBridgeKeyFailureClear,
  onBridgeKeyChange,
  onPortChange,
  onPingCompanion,
  onReadClipboard,
  onResolveVaultRoot,
  onVaultPathChange,
  port,
  vaultPath,
}: {
  readonly mode: WizardMode;
  readonly bridgeKey: string;
  readonly bridgeKeyFailure: BridgeKeyValidationFailure | null;
  readonly companionReachable: boolean;
  readonly connectionError: string | null;
  readonly onBridgeKeyFailureClear: () => void;
  readonly onBridgeKeyChange?: (bridgeKey: string) => void;
  readonly onPortChange?: (port: number) => void;
  readonly onPingCompanion: () => Promise<CompanionPingResult>;
  readonly onReadClipboard: () => Promise<string>;
  readonly onResolveVaultRoot: () => Promise<string | null>;
  readonly onVaultPathChange?: (vaultPath: string) => void;
  readonly port: number;
  readonly vaultPath: string;
}) {
  const synced = mode === 'synced';
  const commandPath = vaultPath.trim() || 'path';
  const bridgeKeyPath = `${commandPath.replace(/\/$/, '')}/_BAC/.config/bridge.key`;
  const [pingState, setPingState] = useState<'idle' | 'testing' | CompanionPingResult>('idle');
  const [clipboardError, setClipboardError] = useState<string | null>(null);
  // Vault root reported by the companion (synced mode) — the path the
  // user would otherwise type by hand. Resolved after a reachable ping.
  const [resolvedVaultRoot, setResolvedVaultRoot] = useState<string | null>(null);
  // Port edits stay local to this step until the user blurs the
  // input (or hits Enter); committing on every keystroke would fire
  // the auto-save debounce + chrome.storage write per character.
  const [portDraft, setPortDraft] = useState<string>(String(port));
  useEffect(() => {
    setPortDraft(String(port));
  }, [port]);
  const [showAdvanced, setShowAdvanced] = useState(port !== 17_373);
  const commitPort = (raw: string): void => {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0 || n > 65_535) {
      setPortDraft(String(port));
      return;
    }
    if (n !== port) onPortChange?.(n);
  };
  const validationError =
    connectionError ??
    (bridgeKeyFailure === null ? null : bridgeKeyValidationCopy[bridgeKeyFailure]);

  const ambientReachable =
    pingState === 'reachable' || (pingState === 'idle' && companionReachable);
  const showAmber = !ambientReachable && pingState !== 'unreachable';

  const handleTestConnection = () => {
    setPingState('testing');
    void onPingCompanion()
      .then((result) => {
        setPingState(result);
        // Synced/remote: the moment the companion answers, ask it where
        // its vault lives so the user never types the path.
        if (result === 'reachable' && synced) {
          void onResolveVaultRoot()
            .then((root) => {
              if (root !== null) {
                setResolvedVaultRoot(root);
                onVaultPathChange?.(root);
              }
            })
            .catch(() => undefined);
        }
      })
      .catch(() => {
        setPingState('unreachable');
      });
  };

  const handlePasteFromClipboard = () => {
    setClipboardError(null);
    void onReadClipboard()
      .then((value) => {
        const trimmed = value.trim();
        const failure = validateBridgeKeyCandidate(trimmed);
        if (failure !== null) {
          setClipboardError(bridgeKeyValidationCopy[failure]);
          return;
        }
        onBridgeKeyFailureClear();
        onBridgeKeyChange?.(trimmed);
      })
      .catch(() => {
        setClipboardError('Could not read clipboard — paste manually below.');
      });
  };

  const statusClass = ambientReachable ? 'green' : showAmber ? 'amber' : 'red';
  const statusLabel =
    pingState === 'testing'
      ? 'Testing companion at 127.0.0.1:' + String(port) + '…'
      : ambientReachable
        ? 'Companion reachable on port ' + String(port)
        : pingState === 'unreachable'
          ? 'Cannot reach companion on port ' + String(port)
          : 'Waiting for companion…';

  return (
    <div className="wizard-step">
      <div className="wizard-lede ai-italic">
        {synced
          ? 'Connect to a companion that is already running, then paste the bridge key for its vault.'
          : 'Start the companion, then paste the bridge key it creates for this vault.'}
      </div>
      {synced ? null : (
        <div className="wizard-card-row single">
          <div className="wizard-card primary">
            <div className="wizard-card-title">HTTP loopback</div>
            <code className="wizard-card-cmd mono">
              bunx @sidetrack/companion --vault {commandPath}
            </code>
            <div className="wizard-card-meta mono">Bridge key file: {bridgeKeyPath}</div>
          </div>
        </div>
      )}
      {!synced && __DEV__ ? (
        <div className="wizard-card-row single">
          <div className="wizard-card">
            <div className="wizard-card-title">Dev build — run from local worktree</div>
            <code className="wizard-card-cmd mono">
              bun
              ~/Documents/playground/browser-ai-companion/.claude/worktrees/m1+foundation/packages/sidetrack-companion/dist/cli.js
              --vault {commandPath}
            </code>
            <div className="wizard-card-meta mono">
              The Bun package isn&apos;t published yet, so the bunx command above won&apos;t
              resolve. Run this directly against the built CLI.
            </div>
          </div>
        </div>
      ) : null}
      <div className={'wizard-status ' + statusClass}>
        <span className={'dot ' + statusClass} />
        <span className="mono">{statusLabel}</span>
        <button
          type="button"
          className="btn btn-ghost wizard-test-btn"
          disabled={pingState === 'testing'}
          onClick={handleTestConnection}
        >
          {pingState === 'testing' ? 'Testing…' : 'Test connection'}
        </button>
      </div>
      {synced && resolvedVaultRoot !== null ? (
        <div className="wizard-card">
          <div className="wizard-card-title">Vault</div>
          <div className="wizard-card-meta mono">{resolvedVaultRoot}</div>
          <div className="wizard-card-meta mono">
            Reported by the companion — no need to enter it by hand.
          </div>
        </div>
      ) : null}
      <label>
        Bridge key
        <input
          onChange={(event) => {
            onBridgeKeyFailureClear();
            onBridgeKeyChange?.(event.target.value);
          }}
          placeholder="Paste the bridge key from the vault"
          type="password"
          value={bridgeKey}
        />
      </label>
      <div className="wizard-bridge-actions">
        <button type="button" className="btn btn-ghost mono" onClick={handlePasteFromClipboard}>
          Paste from clipboard
        </button>
        {clipboardError !== null ? (
          <span className="wizard-clipboard-error mono">{clipboardError}</span>
        ) : null}
      </div>
      {validationError !== null ? (
        <div className="wizard-bridge-error mono" role="alert">
          {validationError}
        </div>
      ) : null}
      <div className="wizard-advanced">
        <button
          type="button"
          className="wizard-advanced-toggle mono"
          aria-expanded={showAdvanced}
          onClick={() => {
            setShowAdvanced((prev) => !prev);
          }}
        >
          {showAdvanced ? '▾' : '▸'} Advanced — port
        </button>
        {showAdvanced ? (
          <label className="wizard-advanced-row">
            <span>Port</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={65535}
              value={portDraft}
              onChange={(event) => {
                setPortDraft(event.target.value);
              }}
              onBlur={(event) => {
                commitPort(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  commitPort(event.currentTarget.value);
                }
              }}
              aria-label="Companion port"
            />
            <span className="wizard-advanced-hint mono">
              default 17373 — change only if your companion was started with --port
            </span>
          </label>
        ) : null}
      </div>
      <div className="wizard-footnote mono">
        <em>
          {synced
            ? 'The bridge key keeps the vault outside Chrome’s profile so other extensions can’t reach it.'
            : 'The companion runs locally on your machine. The bridge key keeps the vault outside Chrome’s profile so other extensions can’t reach it.'}
        </em>
      </div>
    </div>
  );
}

function VaultStep({
  localRestApiDetected,
  onVaultPathChange,
  vaultPath,
}: {
  readonly localRestApiDetected: boolean;
  readonly onVaultPathChange?: (vaultPath: string) => void;
  readonly vaultPath: string;
}) {
  return (
    <div className="wizard-step">
      <div className="wizard-lede ai-italic">
        Type the folder path Sidetrack should use for its local vault.
      </div>
      <label>
        Vault path
        <input
          onChange={(event) => {
            onVaultPathChange?.(event.target.value);
          }}
          placeholder="/Users/you/Documents/Sidetrack-vault"
          value={vaultPath}
        />
      </label>
      <div className="wizard-folder-current mono">Use this same path in the companion command.</div>
      <div className={'wizard-status ' + (localRestApiDetected ? 'green' : 'neutral')}>
        <span className={'dot ' + (localRestApiDetected ? 'green' : '')} />
        <span className="mono">
          {localRestApiDetected
            ? 'Local REST API plugin detected — surgical PATCH enabled'
            : 'Local REST API plugin not detected — using plain filesystem (you can install later)'}
        </span>
      </div>
    </div>
  );
}

function ProvidersStep() {
  const providers = [
    { key: 'chatgpt', name: 'ChatGPT', host: 'chat.openai.com, chatgpt.com', enabled: true },
    { key: 'claude', name: 'Claude', host: 'claude.ai', enabled: true },
    { key: 'gemini', name: 'Gemini', host: 'gemini.google.com', enabled: true },
  ];
  return (
    <div className="wizard-step">
      <div className="wizard-lede ai-italic">
        Auto-track which providers? You can disable any per-site later.
      </div>
      {providers.map((provider) => (
        <label key={provider.key} className="switch on">
          <span className="knob" />
          <span className="lbl">
            {provider.name}
            <span className="desc mono">{provider.host}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

function DoneStep() {
  return (
    <div className="wizard-step center">
      <div className="wizard-done-glyph">✓</div>
      <div className="wizard-done-title">You're set up.</div>
      <div className="wizard-done-sub ai-italic">
        Open any AI chat tab to start tracking. The side panel is pinned to your toolbar.
      </div>
    </div>
  );
}
