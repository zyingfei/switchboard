import { useState } from 'react';
import { Modal } from './Modal';

export type WizardStep = 'welcome' | 'companion' | 'vault' | 'providers' | 'done';

const STEP_ORDER: readonly WizardStep[] = ['welcome', 'companion', 'vault', 'providers', 'done'];

const STEP_LABEL: Record<WizardStep, string> = {
  welcome: 'Welcome',
  companion: 'Companion',
  vault: 'Vault',
  providers: 'Providers',
  done: 'Done',
};

export interface WizardProps {
  readonly bridgeKey?: string;
  readonly companionReachable?: boolean;
  readonly localRestApiDetected?: boolean;
  readonly onClose: () => void;
  readonly onFinish: () => void;
  readonly onBridgeKeyChange?: (bridgeKey: string) => void;
  readonly onSkip?: () => void;
  readonly onVaultPathChange?: (vaultPath: string) => void;
  readonly vaultPath?: string;
}

export function Wizard({
  bridgeKey = '',
  companionReachable = false,
  localRestApiDetected = false,
  onClose,
  onFinish,
  onBridgeKeyChange,
  onSkip,
  onVaultPathChange,
  vaultPath = '',
}: WizardProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const step = STEP_ORDER[stepIndex] ?? 'welcome';

  const next = () => {
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
          companionReachable={companionReachable}
          onBridgeKeyChange={onBridgeKeyChange}
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
      <button type="button" className="wizard-skip mono" onClick={onSkip}>
        Skip — I've already set this up
      </button>
    </div>
  );
}

function CompanionStep({
  bridgeKey,
  companionReachable,
  onBridgeKeyChange,
  vaultPath,
}: {
  readonly bridgeKey: string;
  readonly companionReachable: boolean;
  readonly onBridgeKeyChange?: (bridgeKey: string) => void;
  readonly vaultPath: string;
}) {
  const commandPath = vaultPath.trim() || 'path';
  const bridgeKeyPath = `${commandPath.replace(/\/$/, '')}/_BAC/.config/bridge.key`;

  return (
    <div className="wizard-step">
      <div className="wizard-lede ai-italic">
        Start the companion, then paste the bridge key it creates for this vault.
      </div>
      <div className="wizard-card-row single">
        <div className="wizard-card primary">
          <div className="wizard-card-tag mono">DEFAULT · ADR-0001</div>
          <div className="wizard-card-title">HTTP loopback</div>
          <code className="wizard-card-cmd mono">npx @sidetrack/companion --vault {commandPath}</code>
          <div className="wizard-card-meta mono">
            Bridge key file: {bridgeKeyPath}
          </div>
        </div>
      </div>
      <label>
        Bridge key
        <input
          onChange={(event) => {
            onBridgeKeyChange?.(event.target.value);
          }}
          placeholder="Paste the bridge key from the vault"
          type="password"
          value={bridgeKey}
        />
      </label>
      <div className={'wizard-status ' + (companionReachable ? 'green' : 'amber')}>
        <span className={'dot ' + (companionReachable ? 'green' : 'amber')} />
        <span className="mono">
          {companionReachable ? 'Companion reachable' : 'Waiting for companion...'}
        </span>
      </div>
      <div className="wizard-footnote mono">
        <em>
          Native Messaging considered and rejected for v1 — see ADR-0001 for the lifetime +
          multi-MCP-client reasoning.
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
      <div className="wizard-folder-current mono">
        Use this same path in the companion command.
      </div>
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
