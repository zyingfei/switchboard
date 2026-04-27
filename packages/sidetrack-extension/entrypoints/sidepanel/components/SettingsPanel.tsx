import { useState } from 'react';
import { Modal } from './Modal';

export type SettingsPacketKind = 'research' | 'review' | 'coding' | 'note' | 'other';
export type SettingsTargetProvider =
  | 'chatgpt'
  | 'claude'
  | 'gemini'
  | 'codex'
  | 'claude_code'
  | 'cursor'
  | 'other';

export interface SettingsValue {
  readonly autoSendOptIn: {
    readonly chatgpt: boolean;
    readonly claude: boolean;
    readonly gemini: boolean;
  };
  readonly defaultPacketKind: SettingsPacketKind;
  readonly defaultDispatchTarget: SettingsTargetProvider;
  readonly screenShareSafeMode: boolean;
  readonly revision: string;
}

export interface SettingsPanelProps {
  readonly settings: SettingsValue | null;
  readonly busy: boolean;
  readonly error?: string | null;
  readonly onClose: () => void;
  readonly onSave: (next: {
    readonly autoSendOptIn: SettingsValue['autoSendOptIn'];
    readonly defaultPacketKind: SettingsPacketKind;
    readonly defaultDispatchTarget: SettingsTargetProvider;
    readonly screenShareSafeMode: boolean;
  }) => void;
}

const PROVIDER_LABELS: Record<keyof SettingsValue['autoSendOptIn'], string> = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  gemini: 'Gemini',
};

const PACKET_KIND_LABELS: Record<SettingsPacketKind, string> = {
  research: 'Research',
  review: 'Review',
  coding: 'Coding',
  note: 'Note',
  other: 'Other',
};

const TARGET_LABELS: Record<SettingsTargetProvider, string> = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  gemini: 'Gemini',
  codex: 'Codex CLI',
  claude_code: 'Claude Code',
  cursor: 'Cursor',
  other: 'Other',
};

export function SettingsPanel({ settings, busy, error, onClose, onSave }: SettingsPanelProps) {
  const initial: SettingsValue = settings ?? {
    autoSendOptIn: { chatgpt: false, claude: false, gemini: false },
    defaultPacketKind: 'research',
    defaultDispatchTarget: 'claude',
    screenShareSafeMode: false,
    revision: '0',
  };
  const [draftAutoSend, setDraftAutoSend] = useState(initial.autoSendOptIn);
  const [draftScreenShareSafe, setDraftScreenShareSafe] = useState(initial.screenShareSafeMode);
  const [draftPacketKind, setDraftPacketKind] = useState<SettingsPacketKind>(
    initial.defaultPacketKind,
  );
  const [draftTarget, setDraftTarget] = useState<SettingsTargetProvider>(
    initial.defaultDispatchTarget,
  );

  const dirty =
    draftAutoSend.chatgpt !== initial.autoSendOptIn.chatgpt ||
    draftAutoSend.claude !== initial.autoSendOptIn.claude ||
    draftAutoSend.gemini !== initial.autoSendOptIn.gemini ||
    draftScreenShareSafe !== initial.screenShareSafeMode ||
    draftPacketKind !== initial.defaultPacketKind ||
    draftTarget !== initial.defaultDispatchTarget;

  const handleToggleProvider = (provider: keyof SettingsValue['autoSendOptIn']) => {
    setDraftAutoSend({ ...draftAutoSend, [provider]: !draftAutoSend[provider] });
  };

  const handleSave = () => {
    if (!dirty || busy) {
      return;
    }
    onSave({
      autoSendOptIn: draftAutoSend,
      defaultPacketKind: draftPacketKind,
      defaultDispatchTarget: draftTarget,
      screenShareSafeMode: draftScreenShareSafe,
    });
  };

  const footer = (
    <>
      <div className="spacer" />
      <button type="button" className="btn btn-ghost" onClick={onClose}>
        Close
      </button>
      <button
        type="button"
        className="btn btn-primary"
        disabled={!dirty || busy}
        onClick={handleSave}
      >
        {busy ? 'Saving…' : 'Save'}
      </button>
    </>
  );

  return (
    <Modal title="Settings" subtitle="Companion-backed preferences" width={520} onClose={onClose} footer={footer}>
      <div className="settings-section">
        <h3 className="settings-section-title">Auto-send opt-in (§24.10)</h3>
        <p className="settings-section-lede ai-italic">
          Default is paste-mode for safety. Opt-in per provider only after you've reviewed how
          Sidetrack inserts into that chat. Opt-ins live in the vault, not the browser.
        </p>
        {(Object.keys(PROVIDER_LABELS) as readonly (keyof SettingsValue['autoSendOptIn'])[]).map(
          (provider) => (
            <label key={provider} className={'switch ' + (draftAutoSend[provider] ? 'on' : '')}>
              <input
                type="checkbox"
                checked={draftAutoSend[provider]}
                disabled={busy}
                onChange={() => {
                  handleToggleProvider(provider);
                }}
              />
              <span className="knob" />
              <span className="lbl">
                {PROVIDER_LABELS[provider]}
                <span className="desc mono">
                  {draftAutoSend[provider] ? 'auto-send enabled' : 'paste mode (default)'}
                </span>
              </span>
            </label>
          ),
        )}
      </div>

      <div className="settings-section">
        <h3 className="settings-section-title">Composer defaults</h3>
        <p className="settings-section-lede ai-italic">
          Pre-fill the packet kind and target when you open Send to… on a thread. You can still
          change them per packet.
        </p>
        <label className="settings-select-row">
          <span>Default packet kind</span>
          <select
            disabled={busy}
            value={draftPacketKind}
            onChange={(event) => {
              setDraftPacketKind(event.target.value as SettingsPacketKind);
            }}
          >
            {(Object.keys(PACKET_KIND_LABELS) as readonly SettingsPacketKind[]).map((kind) => (
              <option key={kind} value={kind}>
                {PACKET_KIND_LABELS[kind]}
              </option>
            ))}
          </select>
        </label>
        <label className="settings-select-row">
          <span>Default dispatch target</span>
          <select
            disabled={busy}
            value={draftTarget}
            onChange={(event) => {
              setDraftTarget(event.target.value as SettingsTargetProvider);
            }}
          >
            {(Object.keys(TARGET_LABELS) as readonly SettingsTargetProvider[]).map((target) => (
              <option key={target} value={target}>
                {TARGET_LABELS[target]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="settings-section">
        <h3 className="settings-section-title">Screen-share-safe mode</h3>
        <p className="settings-section-lede ai-italic">
          When on, Sidetrack masks sensitive previews (private workstream titles, packet bodies) in
          the side panel — useful when you might be screen-sharing.
        </p>
        <label className={'switch ' + (draftScreenShareSafe ? 'on' : '')}>
          <input
            type="checkbox"
            checked={draftScreenShareSafe}
            disabled={busy}
            onChange={() => {
              setDraftScreenShareSafe(!draftScreenShareSafe);
            }}
          />
          <span className="knob" />
          <span className="lbl">
            Mask previews
            <span className="desc mono">
              {draftScreenShareSafe ? 'on — masking active' : 'off'}
            </span>
          </span>
        </label>
      </div>

      {error !== null && error !== undefined ? (
        <div className="settings-error mono">{error}</div>
      ) : null}
    </Modal>
  );
}
