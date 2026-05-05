import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import {
  bridgeKeyValidationCopy,
  validateBridgeKeyCandidate,
  type BridgeKeyValidationFailure,
} from '../../../src/companion/bridgeKeyValidation';

export type WizardStep = 'welcome' | 'vault' | 'companion' | 'providers' | 'done';

// Vault before Companion — the companion's npx command needs the
// vault path the user just picked, so we collect it first and
// interpolate the chosen path into the command shown to the user.
const STEP_ORDER: readonly WizardStep[] = ['welcome', 'vault', 'companion', 'providers', 'done'];

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
  readonly onSkip?: () => void;
  readonly onVaultPathChange?: (vaultPath: string) => void;
  readonly vaultPath?: string;
  /** Test the companion's `/v1/health` endpoint (no auth). Defaults to a fetch against `http://127.0.0.1:<port>/v1/health`. */
  readonly onPingCompanion?: () => Promise<CompanionPingResult>;
  /** Read clipboard contents. Defaults to `navigator.clipboard.readText()`. */
  readonly onReadClipboard?: () => Promise<string>;
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

export function Wizard({
  bridgeKey = '',
  companionReachable = false,
  connectionError = null,
  localRestApiDetected = false,
  port = 17_373,
  onClose,
  onFinish,
  onBridgeKeyChange,
  onSkip,
  onVaultPathChange,
  vaultPath = '',
  onPingCompanion,
  onReadClipboard,
}: WizardProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const [bridgeKeyFailure, setBridgeKeyFailure] = useState<BridgeKeyValidationFailure | null>(null);
  const step = STEP_ORDER[stepIndex] ?? 'welcome';

  useEffect(() => {
    if (connectionError !== null) {
      setStepIndex(STEP_ORDER.indexOf('companion'));
    }
  }, [connectionError]);

  const next = () => {
    if (step === 'companion') {
      const failure = validateBridgeKeyCandidate(bridgeKey);
      if (failure !== null) {
        setBridgeKeyFailure(failure);
        return;
      }
      setBridgeKeyFailure(null);
    }
    if (stepIndex < STEP_ORDER.length - 1) {
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
        {STEP_ORDER.map((s, idx) => (
          <span key={s} className={'dot' + (idx === stepIndex ? ' on' : '')} aria-hidden />
        ))}
      </div>
      <div className="spacer" />
      {stepIndex > 0 ? (
        <button type="button" className="btn btn-ghost" onClick={back}>
          Back
        </button>
      ) : null}
      {stepIndex < STEP_ORDER.length - 1 ? (
        <button type="button" className="btn btn-primary" onClick={next}>
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
      subtitle={`step ${String(stepIndex + 1)} of ${String(STEP_ORDER.length)} · ${STEP_LABEL[step]}`}
      width={580}
      onClose={onClose}
      footer={footer}
    >
      {step === 'welcome' ? <WelcomeStep onSkip={onSkip} /> : null}
      {step === 'companion' ? (
        <CompanionStep
          bridgeKey={bridgeKey}
          bridgeKeyFailure={bridgeKeyFailure}
          companionReachable={companionReachable}
          connectionError={connectionError}
          onBridgeKeyFailureClear={() => {
            setBridgeKeyFailure(null);
          }}
          onBridgeKeyChange={onBridgeKeyChange}
          onPingCompanion={onPingCompanion ?? (() => defaultPingCompanion(port))}
          onReadClipboard={onReadClipboard ?? defaultReadClipboard}
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

function WelcomeStep({ onSkip }: { readonly onSkip?: () => void }) {
  return (
    <div className="wizard-step">
      <div className="wizard-display">Track your AI work without losing the thread.</div>
      <div className="wizard-lede ai-italic">
        Sidetrack watches your AI tabs, recovers what you lost, and lets you hand context to other
        models — without copy-paste fatigue.
      </div>
      <p className="wizard-lede">
        You can use Sidetrack right now — everything is stored locally in your browser. The next
        steps are optional: connect a vault to sync across devices and persist beyond uninstall.
      </p>
      <button type="button" className="wizard-skip mono" onClick={onSkip}>
        Use Sidetrack without vault sync →
      </button>
    </div>
  );
}

function CompanionStep({
  bridgeKey,
  bridgeKeyFailure,
  companionReachable,
  connectionError,
  onBridgeKeyFailureClear,
  onBridgeKeyChange,
  onPingCompanion,
  onReadClipboard,
  port,
  vaultPath,
}: {
  readonly bridgeKey: string;
  readonly bridgeKeyFailure: BridgeKeyValidationFailure | null;
  readonly companionReachable: boolean;
  readonly connectionError: string | null;
  readonly onBridgeKeyFailureClear: () => void;
  readonly onBridgeKeyChange?: (bridgeKey: string) => void;
  readonly onPingCompanion: () => Promise<CompanionPingResult>;
  readonly onReadClipboard: () => Promise<string>;
  readonly port: number;
  readonly vaultPath: string;
}) {
  const commandPath = vaultPath.trim() || 'path';
  const bridgeKeyPath = `${commandPath.replace(/\/$/, '')}/_BAC/.config/bridge.key`;
  const [pingState, setPingState] = useState<'idle' | 'testing' | CompanionPingResult>('idle');
  const [clipboardError, setClipboardError] = useState<string | null>(null);
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
        Start the companion, then paste the bridge key it creates for this vault.
      </div>
      <div className="wizard-card-row single">
        <div className="wizard-card primary">
          <div className="wizard-card-title">HTTP loopback</div>
          <code className="wizard-card-cmd mono">
            npx @sidetrack/companion --vault {commandPath}
          </code>
          <div className="wizard-card-meta mono">Bridge key file: {bridgeKeyPath}</div>
        </div>
      </div>
      {__DEV__ ? (
        <div className="wizard-card-row single">
          <div className="wizard-card">
            <div className="wizard-card-title">Dev build — run from local worktree</div>
            <code className="wizard-card-cmd mono">
              node ~/Documents/playground/browser-ai-companion/.claude/worktrees/m1+foundation/packages/sidetrack-companion/dist/cli.js
              --vault {commandPath}
            </code>
            <div className="wizard-card-meta mono">
              The npm package isn&apos;t published yet, so the npx command above won&apos;t resolve.
              Run this directly against the built CLI.
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
      <div className="wizard-footnote mono">
        <em>
          The companion runs locally on your machine. The bridge key keeps the vault outside
          Chrome's profile so other extensions can't reach it.
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
