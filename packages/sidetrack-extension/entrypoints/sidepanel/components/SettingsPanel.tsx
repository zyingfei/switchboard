import { useState } from 'react';
import type { WorkstreamNode } from '../../../src/workboard';
import { Modal } from './Modal';
import {
  AppearanceSection,
  BucketsSection,
  ImportExportSection,
  McpHostsSection,
  ServiceInstallSection,
} from './SettingsV2Sections';
import type {
  DensityMode,
  ImportDiff,
  McpHost,
  ThemeMode,
  VaultBucket,
} from './SettingsV2Sections';

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
  readonly workstreams: readonly WorkstreamNode[];
  readonly screenShareMode: boolean;
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
  readonly onBulkUpdateWorkstreamPrivacy: () => void;
  readonly onToggleWorkstreamSensitive: (workstream: WorkstreamNode, sensitive: boolean) => void;
  readonly onSetScreenShareMode: (enabled: boolean) => void;
  // v2 design pass — appearance + portability + multi-vault + MCP host
  // sections. All optional (additive). Backends:
  //   - theme/density: local document attributes (no network)
  //   - service install: /v1/system/service-status (PR #77, on main)
  //   - import/export: /v1/settings/{export,import} (PR #77, on main)
  //   - mcp hosts: extension-side mcpHost.registry (PR #78, pending)
  //   - buckets: /v1/buckets (PR #78, pending)
  readonly theme?: ThemeMode;
  readonly density?: DensityMode;
  readonly onThemeChange?: (mode: ThemeMode) => void;
  readonly onDensityChange?: (mode: DensityMode) => void;
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
  workstreams,
  screenShareMode,
  busy,
  error,
  onClose,
  onSave,
  onSaveLocalPreferences,
  onRestoreThread,
  onDeleteThread,
  onConnectCompanion,
  onBulkUpdateWorkstreamPrivacy,
  onToggleWorkstreamSensitive,
  onSetScreenShareMode,
  theme,
  density,
  onThemeChange,
  onDensityChange,
}: SettingsPanelProps) {
  const [serviceInstalled, setServiceInstalled] = useState(false);
  const [serviceRunning] = useState(true);
  const [importDiff, setImportDiff] = useState<ImportDiff | null>(null);
  const [mcpHosts, setMcpHosts] = useState<readonly McpHost[]>([
    {
      id: 'h1',
      url: 'http://localhost:7331',
      tokenMasked: 'sb_localhost',
      role: 'self',
      online: true,
    },
    {
      id: 'h2',
      url: 'http://localhost:6277',
      tokenMasked: 'cc_••••••2f0',
      role: 'claude-code',
      online: true,
    },
  ]);
  const [buckets, setBuckets] = useState<readonly VaultBucket[]>([
    {
      id: 'default',
      rule: '* (default)',
      vaultPath: localPreferences.vaultPath || '~/Documents/Sidetrack-vault',
      isDefault: true,
    },
  ]);
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
  const privateWorkstreams = workstreams.filter((workstream) => workstream.privacy === 'private');

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
        {companionConfigured ? (
          <>
            <p className="settings-section-lede ai-italic">
              The companion is connected and writing to the vault below. Captures, dispatches,
              and reviews land as Markdown + JSON under <span className="mono">_BAC/</span> so
              they survive reinstalls and are readable by other tools.
            </p>
            <div className="settings-vault-status">
              <div className="settings-vault-status-row">
                <span className="settings-vault-status-label mono">vault</span>
                <code className="settings-vault-status-value">
                  {draftVaultPath.length > 0 ? draftVaultPath : '(unknown — restart companion)'}
                </code>
              </div>
              {draftVaultPath.length > 0 ? (
                <div className="settings-vault-status-row">
                  <span className="settings-vault-status-label mono">bridge key</span>
                  <code className="settings-vault-status-value">
                    {draftVaultPath.replace(/\/$/, '')}/_BAC/.config/bridge.key
                  </code>
                </div>
              ) : null}
            </div>
            <p className="settings-hint mono">
              Lost the key? Run <code>cat &lt;bridge key path&gt;</code> in your terminal — the
              file is the canonical store. The vault path can be edited below for the NEXT
              companion launch (the running process keeps its current path).
            </p>
          </>
        ) : (
          <p className="settings-section-lede ai-italic">
            Sidetrack is running <strong>local-only</strong> — captures stay in this browser's
            storage. Configure a vault to get a Markdown + JSON record under{' '}
            <span className="mono">_BAC/</span> that survives reinstalls.
          </p>
        )}
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
        {!companionConfigured && onConnectCompanion !== undefined ? (
          <div className="settings-cta-row">
            <span className="mono">
              Connect the companion to enable Send / Review and vault sync.
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
        <h3 className="settings-section-title">Workstream privacy</h3>
        <p className="settings-section-lede ai-italic">
          Private workstreams always mask thread titles. Sensitive workstreams only mask when
          screenshare mode is on.
        </p>
        <label className={'switch ' + (screenShareMode ? 'on' : '')}>
          <input
            type="checkbox"
            checked={screenShareMode}
            disabled={busy}
            onChange={() => {
              onSetScreenShareMode(!screenShareMode);
            }}
          />
          <span className="knob" />
          <span className="lbl">
            Screenshare mode
            <span className="desc mono">{screenShareMode ? 'masking sensitive rows' : 'off'}</span>
          </span>
        </label>
        <div className="settings-privacy-actions">
          <span className="settings-hint mono">
            {String(privateWorkstreams.length)} private workstream
            {privateWorkstreams.length === 1 ? '' : 's'}
          </span>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy || privateWorkstreams.length === 0}
            onClick={() => {
              if (
                window.confirm(
                  `Mark ${String(privateWorkstreams.length)} private workstream${
                    privateWorkstreams.length === 1 ? '' : 's'
                  } as shared? Thread titles in those workstreams will be unmasked.`,
                )
              ) {
                onBulkUpdateWorkstreamPrivacy();
              }
            }}
          >
            Mark all workstreams as shared ({String(privateWorkstreams.length)})
          </button>
        </div>
        {workstreams.length === 0 ? (
          <p className="settings-hint mono">No workstreams yet.</p>
        ) : (
          <ul className="settings-workstream-list">
            {workstreams.map((workstream) => (
              <li key={workstream.bac_id} className="settings-workstream-row">
                <div>
                  <div className="settings-workstream-title">{workstream.title}</div>
                  <div className="settings-workstream-sub mono">
                    {workstream.privacy}
                    {workstream.screenShareSensitive === true ? ' · screenshare sensitive' : ''}
                  </div>
                </div>
                <label className="settings-mini-check mono">
                  <input
                    type="checkbox"
                    checked={workstream.screenShareSensitive === true}
                    disabled={busy || workstream.privacy === 'private'}
                    onChange={() => {
                      onToggleWorkstreamSensitive(
                        workstream,
                        workstream.screenShareSensitive !== true,
                      );
                    }}
                  />
                  Sensitive
                </label>
              </li>
            ))}
          </ul>
        )}
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

      {/* v2 design — appearance + service install + portability + MCP + buckets.
          Each is opt-in: AppearanceSection only renders when the parent
          provides theme/density wiring. */}
      {theme !== undefined &&
      density !== undefined &&
      onThemeChange !== undefined &&
      onDensityChange !== undefined ? (
        <AppearanceSection
          theme={theme}
          density={density}
          onThemeChange={onThemeChange}
          onDensityChange={onDensityChange}
        />
      ) : null}
      <ServiceInstallSection
        installed={serviceInstalled}
        running={serviceRunning}
        onInstall={() => {
          // TODO(PR-#77 wiring): POST /v1/system/install-service via companion
          setServiceInstalled(true);
        }}
        onUninstall={() => {
          // TODO(PR-#77 wiring): POST /v1/system/uninstall-service
          setServiceInstalled(false);
        }}
      />
      <ImportExportSection
        onExport={() => {
          // TODO(PR-#77 wiring): GET /v1/settings/export → trigger download
        }}
        onChooseImportFile={() => {
          // Stub diff so the user can see the diff card. Real wiring
          // POSTs the file to /v1/settings/import?dryRun=true.
          setImportDiff({
            added: ['provider.gemini.auto-send  false → true'],
            removed: [],
            changed: ['vault.path  ~/Documents/Sidetrack-vault'],
            conflicts: 0,
          });
        }}
        diff={importDiff}
        onCancelImport={() => {
          setImportDiff(null);
        }}
        onApplyImport={() => {
          // TODO(PR-#77 wiring): POST /v1/settings/import (commit)
          setImportDiff(null);
        }}
      />
      <McpHostsSection
        hosts={mcpHosts}
        onRemove={(id) => {
          setMcpHosts((prev) => prev.filter((h) => h.id !== id));
        }}
        onAdd={(input) => {
          // TODO(PR-#78 wiring): persist via mcpHost.registry
          setMcpHosts((prev) => [
            ...prev,
            {
              id: `h${String(Date.now())}`,
              url: input.url,
              tokenMasked: input.token.slice(0, 4) + '••••',
              role: 'unknown',
              online: false,
            },
          ]);
        }}
      />
      <BucketsSection
        buckets={buckets}
        onRemove={(id) => {
          setBuckets((prev) => prev.filter((b) => b.id !== id));
        }}
        onAddBucket={() => {
          // TODO(PR-#78 wiring): open a bucket-create dialog and PUT /v1/buckets
          setBuckets((prev) => [
            ...prev,
            {
              id: `b${String(Date.now())}`,
              rule: 'workstream:new-bucket',
              vaultPath: '~/Documents/new-vault',
              isDefault: false,
            },
          ]);
        }}
      />

      {error !== null && error !== undefined ? (
        <div className="settings-error mono">{error}</div>
      ) : null}
    </Modal>
  );
}
