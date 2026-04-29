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

export interface LocalPreferences {
  readonly autoTrack: boolean;
  readonly vaultPath: string;
}

export interface ArchivedThreadRow {
  readonly bac_id: string;
  readonly title: string;
  readonly workstreamPath: string;
  readonly archivedAt: string;
  readonly providerLabel: string;
}

export interface SettingsPanelProps {
  readonly settings: SettingsValue | null;
  readonly localPreferences: LocalPreferences;
  readonly companionConfigured: boolean;
  readonly archivedThreads: readonly ArchivedThreadRow[];
  readonly busy: boolean;
  readonly error?: string | null;
  readonly onClose: () => void;
  readonly onSave: (next: {
    readonly autoSendOptIn: SettingsValue['autoSendOptIn'];
    readonly defaultPacketKind: SettingsPacketKind;
    readonly defaultDispatchTarget: SettingsTargetProvider;
    readonly screenShareSafeMode: boolean;
  }) => void;
  readonly onSaveLocalPreferences: (next: {
    readonly autoTrack?: boolean;
    readonly vaultPath?: string;
  }) => void;
  readonly onRestoreThread: (threadId: string) => void;
  readonly onDeleteThread: (threadId: string) => void;
  readonly onConnectCompanion?: () => void;
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

export function SettingsPanel({
  settings,
  localPreferences,
  companionConfigured,
  archivedThreads,
  busy,
  error,
  onClose,
  onSave,
  onSaveLocalPreferences,
  onRestoreThread,
  onDeleteThread,
  onConnectCompanion,
}: SettingsPanelProps) {
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
  const [draftAutoTrack, setDraftAutoTrack] = useState(localPreferences.autoTrack);
  const [draftVaultPath, setDraftVaultPath] = useState(localPreferences.vaultPath);

  const companionDirty =
    draftAutoSend.chatgpt !== initial.autoSendOptIn.chatgpt ||
    draftAutoSend.claude !== initial.autoSendOptIn.claude ||
    draftAutoSend.gemini !== initial.autoSendOptIn.gemini ||
    draftScreenShareSafe !== initial.screenShareSafeMode ||
    draftPacketKind !== initial.defaultPacketKind ||
    draftTarget !== initial.defaultDispatchTarget;
  const localDirty =
    draftAutoTrack !== localPreferences.autoTrack ||
    draftVaultPath.trim() !== localPreferences.vaultPath.trim();
  const dirty = companionDirty || localDirty;

  const handleToggleProvider = (provider: keyof SettingsValue['autoSendOptIn']) => {
    setDraftAutoSend({ ...draftAutoSend, [provider]: !draftAutoSend[provider] });
  };

  const handleSave = () => {
    if (!dirty || busy) {
      return;
    }
    if (companionDirty && companionConfigured) {
      onSave({
        autoSendOptIn: draftAutoSend,
        defaultPacketKind: draftPacketKind,
        defaultDispatchTarget: draftTarget,
        screenShareSafeMode: draftScreenShareSafe,
      });
    }
    if (localDirty) {
      onSaveLocalPreferences({
        ...(draftAutoTrack === localPreferences.autoTrack ? {} : { autoTrack: draftAutoTrack }),
        ...(draftVaultPath.trim() === localPreferences.vaultPath.trim()
          ? {}
          : { vaultPath: draftVaultPath.trim() }),
      });
    }
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
    <Modal
      title="Settings"
      subtitle="Companion-backed preferences"
      width={520}
      onClose={onClose}
      footer={footer}
    >
      <div className="settings-section">
        <h3 className="settings-section-title">Vault &amp; tracking</h3>
        <p className="settings-section-lede ai-italic">
          Without a vault, Sidetrack runs entirely in your browser's local storage. With a vault
          path configured, the companion writes a canonical Markdown record under
          <span className="mono"> _BAC/</span> so it survives reinstalls and is readable by other
          tools. Tracking-by-default keeps every detected AI thread; manual default keeps the panel
          quiet until you explicitly track something.
        </p>
        <label className="settings-text-row">
          <span>Vault path</span>
          <input
            type="text"
            className="mono"
            placeholder="~/Documents/Sidetrack-vault"
            value={draftVaultPath}
            disabled={busy}
            onChange={(event) => {
              setDraftVaultPath(event.target.value);
            }}
          />
        </label>
        <p className="settings-hint mono">
          The companion process picks up the vault path at startup. Edit here for the next session
          or after re-running the companion.
        </p>
        {!companionConfigured && onConnectCompanion !== undefined ? (
          <div className="settings-cta-row">
            <span className="mono">
              Currently <strong>local-only</strong> — captures stay in this browser.
            </span>
            <button
              type="button"
              className="btn btn-primary"
              onClick={onConnectCompanion}
              disabled={busy}
            >
              Connect companion →
            </button>
          </div>
        ) : null}
        <label className={'switch ' + (draftAutoTrack ? 'on' : '')}>
          <input
            type="checkbox"
            checked={draftAutoTrack}
            disabled={busy}
            onChange={() => {
              setDraftAutoTrack(!draftAutoTrack);
            }}
          />
          <span className="knob" />
          <span className="lbl">
            Auto-track detected AI threads
            <span className="desc mono">
              {draftAutoTrack
                ? 'on — every detected thread is tracked'
                : 'off — manual tracking only (default)'}
            </span>
          </span>
        </label>
      </div>

      <div className="settings-section">
        <h3 className="settings-section-title">Auto-send opt-in (§24.10)</h3>
        <p className="settings-section-lede ai-italic">
          Default is paste-mode for safety. Opt-in per provider only after you've reviewed how
          Sidetrack inserts into that chat. Opt-ins live in the vault, not the browser.
          {companionConfigured ? null : (
            <>
              {' '}
              <span className="mono">(disabled until a vault is configured)</span>
            </>
          )}
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

      <div className="settings-section">
        <h3 className="settings-section-title">Archived threads</h3>
        <p className="settings-section-lede ai-italic">
          Archive hides threads from the workboard. Restore brings one back as a manually-tracked
          thread; Delete removes it permanently — local-only state is wiped, vault data (if you have
          a companion) stays for audit.
        </p>
        {archivedThreads.length === 0 ? (
          <p className="settings-hint mono">No archived threads.</p>
        ) : (
          <ul className="settings-archive-list">
            {archivedThreads.map((row) => (
              <li key={row.bac_id} className="settings-archive-row">
                <div className="settings-archive-meta">
                  <div className="settings-archive-title">{row.title}</div>
                  <div className="settings-archive-sub mono">
                    {row.providerLabel} · {row.workstreamPath} · archived {row.archivedAt}
                  </div>
                </div>
                <div className="settings-archive-actions">
                  <button
                    type="button"
                    className="btn-link"
                    disabled={busy}
                    onClick={() => {
                      onRestoreThread(row.bac_id);
                    }}
                  >
                    Restore
                  </button>
                  <button
                    type="button"
                    className="btn-link archive"
                    disabled={busy}
                    onClick={() => {
                      onDeleteThread(row.bac_id);
                    }}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error !== null && error !== undefined ? (
        <div className="settings-error mono">{error}</div>
      ) : null}
    </Modal>
  );
}
