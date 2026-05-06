import { useEffect, useState } from 'react';
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
import {
  addServer as mcpHostAddServer,
  listConfiguredServers as mcpHostListServers,
  removeServer as mcpHostRemoveServer,
} from '../../../src/mcpHost/registry';
import { probeServer } from '../../../src/mcpHost/probe';

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
  readonly notifyOnQueueComplete: boolean;
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
    readonly notifyOnQueueComplete?: boolean;
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
  // Companion connection — required for service install / import-export /
  // bucket sections to talk to the live HTTP endpoints. Without these,
  // those sections degrade to local-only state with TODO logging.
  readonly companionPort?: number | null;
  readonly bridgeKey?: string | null;
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
  companionPort,
  bridgeKey,
}: SettingsPanelProps) {
  // Helper for companion-backed sections. Returns null on missing
  // config so callers can fall back gracefully.
  const callCompanion = async (
    path: string,
    init?: RequestInit,
  ): Promise<Response | null> => {
    if (
      companionPort === undefined ||
      companionPort === null ||
      bridgeKey === undefined ||
      bridgeKey === null
    ) {
      return null;
    }
    try {
      const headers = new Headers(init?.headers);
      headers.set('x-bac-bridge-key', bridgeKey);
      return await fetch(`http://127.0.0.1:${String(companionPort)}${path}`, {
        ...init,
        headers,
      });
    } catch {
      return null;
    }
  };
  const [serviceInstalled, setServiceInstalled] = useState(false);
  const [serviceRunning, setServiceRunning] = useState(false);
  const [importDiff, setImportDiff] = useState<ImportDiff | null>(null);
  const [pendingImportPayload, setPendingImportPayload] = useState<string | null>(null);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);
  const [mcpHosts, setMcpHosts] = useState<readonly McpHost[]>([]);
  const [buckets, setBuckets] = useState<readonly VaultBucket[]>([
    {
      id: 'default',
      rule: '* (default)',
      vaultPath: localPreferences.vaultPath || '~/Documents/Sidetrack-vault',
      isDefault: true,
    },
  ]);

  const refreshServiceStatus = async (): Promise<void> => {
    const svcResponse = await callCompanion('/v1/system/service-status');
    if (svcResponse?.ok) {
      try {
        const body = (await svcResponse.json()) as {
          readonly data?: { readonly installed?: boolean; readonly running?: boolean };
        };
        const installed = body.data?.installed;
        const running = body.data?.running;
        if (typeof installed === 'boolean') {
          setServiceInstalled(installed);
        }
        if (typeof running === 'boolean') {
          setServiceRunning(running);
        }
      } catch {
        // ignore
      }
    }
  };

  // Hydrate MCP-host list from chrome.storage on mount. Falls back to
  // empty list when chrome.storage isn't available (jsdom unit tests).
  useEffect(() => {
    let cancelled = false;
    const hydrate = async (): Promise<void> => {
      try {
        const servers = await mcpHostListServers();
        if (cancelled) return;
        const baseHosts = servers.map((server) => ({
          server,
          host: {
            id: server.id,
            url: server.url,
            tokenMasked:
              server.bearerToken !== undefined
                ? server.bearerToken.slice(0, 4) + '••••'
                : '—',
            role: server.transport,
            online: false,
          },
        }));
        setMcpHosts(baseHosts.map((item) => item.host));
        const probed = await Promise.all(
          baseHosts.map(async ({ server, host }) => ({
            ...host,
            ...(await probeServer(server)),
          })),
        );
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- cancelled is mutated by the cleanup closure
        if (!cancelled) {
          setMcpHosts(probed);
        }
      } catch {
        // chrome.storage missing or empty — leave list empty
      }
    };
    void hydrate();
    const intervalId = window.setInterval(() => {
      void hydrate();
    }, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  // Hydrate service-install state and bucket list from companion.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await refreshServiceStatus();
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- cancelled is mutated by the cleanup closure
      if (cancelled) return;
      const bucketsResponse = await callCompanion('/v1/buckets');
      if (bucketsResponse?.ok) {
        try {
          const body: unknown = await bucketsResponse.json();
          const items = (
            body as { readonly data?: { readonly items?: readonly unknown[] } }
          ).data?.items;
          if (Array.isArray(items) && items.length > 0) {
            const validBuckets = items.flatMap((raw) => {
              if (typeof raw !== 'object' || raw === null) return [];
              const r = raw as {
                readonly id?: unknown;
                readonly label?: unknown;
                readonly vaultRoot?: unknown;
              };
              if (
                typeof r.id !== 'string' ||
                typeof r.label !== 'string' ||
                typeof r.vaultRoot !== 'string'
              ) {
                return [];
              }
              return [
                {
                  id: r.id,
                  rule: r.label,
                  vaultPath: r.vaultRoot,
                  isDefault: r.id === 'default',
                },
              ];
            });
            if (validBuckets.length > 0) {
              setBuckets(validBuckets);
            }
          }
        } catch {
          // ignore
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companionPort, bridgeKey]);
  const initial: SettingsValue = settings ?? {
    // AI providers default to auto-send on. The user can flip individual
    // providers off here; coding-agent / export targets always use
    // paste mode (auto-send doesn't apply) so they aren't represented.
    autoSendOptIn: { chatgpt: true, claude: true, gemini: true },
    defaultPacketKind: 'research',
    defaultDispatchTarget: 'claude',
    screenShareSafeMode: false,
    revision: '0',
  };
  const [draftAutoSend, setDraftAutoSend] = useState(initial.autoSendOptIn);
  // The Settings UI for screenShareSafeMode was removed (the top-bar
  // toggle is the canonical control), but we keep the draft state
  // pinned to the existing companion value so save() doesn't flip
  // it. Read-only here; mutation lives in the top bar.
  const [draftScreenShareSafe] = useState(initial.screenShareSafeMode);
  const [draftPacketKind, setDraftPacketKind] = useState<SettingsPacketKind>(
    initial.defaultPacketKind,
  );
  const [draftTarget, setDraftTarget] = useState<SettingsTargetProvider>(
    initial.defaultDispatchTarget,
  );
  // autoTrack is no longer surfaced in Settings — tracking mode
  // is per-thread now (see thread-row overflow menu). The local
  // preference still lives in storage for migration safety; we
  // never display or mutate it here.
  void localPreferences.autoTrack;
  const [draftVaultPath, setDraftVaultPath] = useState(localPreferences.vaultPath);
  const [draftNotifyOnQueueComplete, setDraftNotifyOnQueueComplete] = useState(
    localPreferences.notifyOnQueueComplete,
  );

  const companionDirty =
    draftAutoSend.chatgpt !== initial.autoSendOptIn.chatgpt ||
    draftAutoSend.claude !== initial.autoSendOptIn.claude ||
    draftAutoSend.gemini !== initial.autoSendOptIn.gemini ||
    draftScreenShareSafe !== initial.screenShareSafeMode ||
    draftPacketKind !== initial.defaultPacketKind ||
    draftTarget !== initial.defaultDispatchTarget;
  const localDirty =
    draftVaultPath.trim() !== localPreferences.vaultPath.trim() ||
    draftNotifyOnQueueComplete !== localPreferences.notifyOnQueueComplete;
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
        ...(draftVaultPath.trim() === localPreferences.vaultPath.trim()
          ? {}
          : { vaultPath: draftVaultPath.trim() }),
        ...(draftNotifyOnQueueComplete === localPreferences.notifyOnQueueComplete
          ? {}
          : { notifyOnQueueComplete: draftNotifyOnQueueComplete }),
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
        <p className="settings-section-lede ai-italic">
          Tracking mode is now per-thread. Open a thread row's overflow menu (⋯) to flip
          between <span className="mono">auto</span> (Sidetrack refreshes the thread on every
          new message) and <span className="mono">manual</span> (no auto-refresh — capture on
          demand using the row's capture button).
        </p>
      </div>

      <div className="settings-section">
        <h3 className="settings-section-title">Auto-send per provider</h3>
        <p className="settings-section-lede ai-italic">
          Auto-send opens the AI's tab and types the packet for you. AI providers default to on;
          turn one off and Sidetrack falls back to copying the packet so you can paste it
          yourself. Settings live in the vault, not the browser.
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
        <label
          className={'switch ' + (draftNotifyOnQueueComplete ? 'on' : '')}
          style={{ marginTop: 8 }}
        >
          <input
            type="checkbox"
            checked={draftNotifyOnQueueComplete}
            disabled={busy}
            onChange={() => {
              setDraftNotifyOnQueueComplete(!draftNotifyOnQueueComplete);
            }}
          />
          <span className="knob" />
          <span className="lbl">
            Notify when the queue finishes
            <span className="desc mono">
              {draftNotifyOnQueueComplete
                ? 'system toast when the last item ships'
                : 'silent — check the side panel'}
            </span>
          </span>
        </label>
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
          setServiceInstalled(true);
          void callCompanion('/v1/system/install-service', { method: 'POST' })
            .then((resp) => {
              if (!resp?.ok) {
                setServiceInstalled(false);
              }
            })
            .then(() => refreshServiceStatus());
        }}
        onUninstall={() => {
          setServiceInstalled(false);
          void callCompanion('/v1/system/uninstall-service', { method: 'POST' });
        }}
      />
      <ImportExportSection
        onExport={() => {
          void (async () => {
            const resp = await callCompanion('/v1/settings/export');
            if (!resp?.ok) return;
            const blob = await resp.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `sidetrack-config-${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          })();
        }}
        onChooseImportFile={() => {
          // Open a file picker; on selection, POST to /v1/settings/import
          // with dryRun=true to fetch the diff preview before applying.
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = 'application/json';
          input.onchange = () => {
            const file = input.files?.[0];
            if (file === undefined) return;
            void (async () => {
              const text = await file.text();
              const resp = await callCompanion('/v1/settings/import?dryRun=true', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: text,
              });
              if (!resp?.ok) {
                // Fall back to a synthetic diff so the user still sees the surface.
                setPendingImportPayload(null);
                setImportDiff({
                  added: ['(companion unreachable — preview unavailable)'],
                  removed: [],
                  changed: [],
                  conflicts: 0,
                });
                return;
              }
              try {
                const body = (await resp.json()) as {
                  readonly data?: {
                    readonly added?: readonly string[];
                    readonly removed?: readonly string[];
                    readonly changed?: readonly string[];
                    readonly conflicts?: number;
                  };
                };
                setPendingImportPayload(text);
                setImportDiff({
                  added: body.data?.added ?? [],
                  removed: body.data?.removed ?? [],
                  changed: body.data?.changed ?? [],
                  conflicts: body.data?.conflicts ?? 0,
                });
              } catch {
                setPendingImportPayload(text);
                setImportDiff({
                  added: [],
                  removed: [],
                  changed: [],
                  conflicts: 0,
                });
              }
            })();
          };
          input.click();
        }}
        diff={importDiff}
        onCancelImport={() => {
          setImportDiff(null);
          setPendingImportPayload(null);
        }}
        onApplyImport={() => {
          if (pendingImportPayload === null) {
            return;
          }
          void (async () => {
            const resp = await callCompanion('/v1/settings/import', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: pendingImportPayload,
            });
            if (!resp?.ok) {
              setSettingsNotice('Import failed — the preview is still open.');
              return;
            }
            try {
              const body = (await resp.json()) as {
                readonly data?: { readonly applied?: number; readonly skipped?: number };
              };
              setSettingsNotice(
                `Import applied: ${String(body.data?.applied ?? 0)} applied, ${String(
                  body.data?.skipped ?? 0,
                )} skipped.`,
              );
            } catch {
              setSettingsNotice('Import applied.');
            }
            setImportDiff(null);
            setPendingImportPayload(null);
          })();
        }}
      />
      <McpHostsSection
        hosts={mcpHosts}
        onRemove={(id) => {
          setMcpHosts((prev) => prev.filter((h) => h.id !== id));
          void mcpHostRemoveServer(id).catch(() => undefined);
        }}
        onAdd={(input) => {
          const id = `h${String(Date.now())}`;
          const server = {
            id,
            url: input.url,
            transport: 'http' as const,
            bearerToken: input.token,
          };
          setMcpHosts((prev) => [
            ...prev,
            {
              id,
              url: input.url,
              tokenMasked: input.token.slice(0, 4) + '••••',
              role: 'http',
              online: false,
            },
          ]);
          void mcpHostAddServer(server).catch(() => undefined);
          void probeServer(server)
            .then((probe) => {
              setMcpHosts((prev) =>
                prev.map((host) => (host.id === id ? { ...host, ...probe } : host)),
              );
            })
            .catch(() => undefined);
        }}
      />
      <BucketsSection
        buckets={buckets}
        onRemove={(id) => {
          const next = buckets.filter((b) => b.id !== id);
          setBuckets(next);
          void callCompanion('/v1/buckets', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              buckets: next.map((b) => ({
                id: b.id,
                label: b.rule,
                vaultRoot: b.vaultPath,
                matchers: [],
              })),
            }),
          });
        }}
        onAddBucket={(input) => {
          const id = `b${String(Date.now())}`;
          const next = [
            ...buckets,
            {
              id,
              rule: input.rule,
              vaultPath: input.vaultPath,
              isDefault: false,
            },
          ];
          setBuckets(next);
          void callCompanion('/v1/buckets', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              buckets: next.map((b) => ({
                id: b.id,
                label: b.rule,
                vaultRoot: b.vaultPath,
                matchers: [],
              })),
            }),
          });
        }}
      />

      {settingsNotice !== null ? (
        <div className="settings-hint mono">{settingsNotice}</div>
      ) : null}
      {error !== null && error !== undefined ? (
        <div className="settings-error mono">{error}</div>
      ) : null}
    </Modal>
  );
}
