import { useState } from 'react';
import { Modal } from './Modal';
import { Icons } from './icons';

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
  readonly companionReachable?: boolean;
  readonly localRestApiDetected?: boolean;
  readonly onClose: () => void;
  readonly onPickVault: () => void;
  readonly onFinish: () => void;
}

export function Wizard({
  companionReachable = false,
  localRestApiDetected = false,
  onClose,
  onPickVault,
  onFinish,
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
          Open Sidetrack
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
      {step === 'welcome' ? <WelcomeStep /> : null}
      {step === 'companion' ? <CompanionStep companionReachable={companionReachable} /> : null}
      {step === 'vault' ? (
        <VaultStep onPick={onPickVault} localRestApiDetected={localRestApiDetected} />
      ) : null}
      {step === 'providers' ? <ProvidersStep /> : null}
      {step === 'done' ? <DoneStep /> : null}
    </Modal>
  );
}

function WelcomeStep() {
  return (
    <div className="wizard-step">
      <div className="wizard-display">Track your AI work without losing the thread.</div>
      <div className="wizard-lede ai-italic">
        Sidetrack watches your AI tabs, recovers what you lost, and lets you hand context to other
        models — without copy-paste fatigue.
      </div>
      <a className="wizard-skip mono">skip the tour →</a>
    </div>
  );
}

function CompanionStep({ companionReachable }: { readonly companionReachable: boolean }) {
  return (
    <div className="wizard-step">
      <div className="wizard-lede ai-italic">
        Pick how the companion connects. Without it, captures pause when Chrome is idle.
      </div>
      <div className="wizard-card-row single">
        <div className="wizard-card primary">
          <div className="wizard-card-tag mono">DEFAULT · ADR-0001</div>
          <div className="wizard-card-title">HTTP loopback</div>
          <code className="wizard-card-cmd mono">
            npx @sidetrack/companion --vault &lt;path&gt;
          </code>
          <div className="wizard-card-meta mono">
            port-based · no installer · lives independent of Chrome
          </div>
        </div>
      </div>
      <div className={'wizard-status ' + (companionReachable ? 'green' : 'amber')}>
        <span className={'dot ' + (companionReachable ? 'green' : 'amber')} />
        <span className="mono">
          {companionReachable ? 'Companion reachable on :7331' : 'Waiting for companion…'}
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
  onPick,
  localRestApiDetected,
}: {
  readonly onPick: () => void;
  readonly localRestApiDetected: boolean;
}) {
  return (
    <div className="wizard-step">
      <div className="wizard-lede ai-italic">Pick the folder where Sidetrack writes its vault.</div>
      <button type="button" className="wizard-folder-pick" onClick={onPick}>
        <span className="icon-12">{Icons.folder}</span>
        Choose folder…
      </button>
      <div className="wizard-folder-current mono">~/Documents/Sidetrack-vault</div>
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
