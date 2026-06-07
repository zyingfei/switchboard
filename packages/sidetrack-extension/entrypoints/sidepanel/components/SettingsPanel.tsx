import { useEffect, useRef, useState } from 'react';
import type { WorkstreamNode } from '../../../src/workboard';
import { parsePairingString } from '../../../src/companion/pairingString';
import { CollectorsSection } from './CollectorsSection';
import type { CollectorStatus } from './CollectorsSection';
import { Modal } from './Modal';
import {
  AppearanceSection,
  BucketsSection,
  ImportExportSection,
  McpHostsSection,
  ServiceInstallSection,
  TimelineSection,
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
  readonly captureEnabled: boolean;
  readonly autoTrack: boolean;
  readonly vaultPath: string;
  readonly notifyOnQueueComplete: boolean;
  readonly pageEvidenceAutoExtractEnabled: boolean;
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
    readonly captureEnabled?: boolean;
    readonly autoTrack?: boolean;
    readonly vaultPath?: string;
    readonly notifyOnQueueComplete?: boolean;
    readonly pageEvidenceAutoExtractEnabled?: boolean;
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
  readonly collectors?: readonly CollectorStatus[];
  readonly onCollectorReplay?: (id: string) => Promise<void>;
  // Save edits to the loopback connection (port + bridge key). Wires
  // straight into the App.tsx debounced settings auto-save. Optional
  // so legacy embeddings of this panel keep working in read-only
  // mode; when undefined the section renders without input fields.
  readonly onSaveCompanionConnection?: (next: {
    readonly port: number;
    readonly bridgeKey: string;
  }) => void;
  // Scroll a named section into view when the panel opens — e.g. a
  // "Fix connection" banner deep-links to 'companion-connection' so the
  // user lands on the field to change instead of hunting for it.
  readonly scrollToId?: string | null;
  // Vault root the connected companion reports via /v1/version — the
  // source of truth for "where am I actually writing", distinct from the
  // editable next-launch path. null/undefined when not connected.
  readonly companionVaultRoot?: string | null;
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

interface SyncStatus {
  readonly replicaId: string;
  readonly seq: number;
  readonly relay?: {
    readonly mode: 'local' | 'remote';
    readonly url: string;
  };
}

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
  collectors = [],
  onCollectorReplay = async () => undefined,
  onSaveCompanionConnection,
  scrollToId,
  companionVaultRoot,
}: SettingsPanelProps) {
  // Deep-link scroll: when opened with a target section id, bring it
  // into view once it has mounted. Guard with a ref so we scroll once
  // per target, not on every re-render.
  const scrolledForRef = useRef<string | null>(null);
  useEffect(() => {
    if (scrollToId === undefined || scrollToId === null) {
      scrolledForRef.current = null;
      return undefined;
    }
    if (scrolledForRef.current === scrollToId) return undefined;
    const handle = window.setTimeout(() => {
      const el = document.getElementById(scrollToId);
      if (el !== null) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        scrolledForRef.current = scrollToId;
      }
    }, 60);
    return () => {
      window.clearTimeout(handle);
    };
  }, [scrollToId]);
  // Helper for companion-backed sections. Returns null on missing
  // config so callers can fall back gracefully.
  const callCompanion = async (path: string, init?: RequestInit): Promise<Response | null> => {
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
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
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

  const refreshSyncStatus = async (): Promise<void> => {
    const healthResponse = await callCompanion('/v1/system/health');
    if (!healthResponse?.ok) {
      setSyncStatus(null);
      return;
    }
    try {
      const body = (await healthResponse.json()) as {
        readonly data?: {
          readonly sync?: {
            readonly replicaId?: unknown;
            readonly seq?: unknown;
            readonly relay?: {
              readonly mode?: unknown;
              readonly url?: unknown;
            };
          };
        };
      };
      const sync = body.data?.sync;
      if (
        sync === undefined ||
        typeof sync.replicaId !== 'string' ||
        typeof sync.seq !== 'number'
      ) {
        setSyncStatus(null);
        return;
      }
      const relay: SyncStatus['relay'] =
        sync.relay !== undefined &&
        (sync.relay.mode === 'local' || sync.relay.mode === 'remote') &&
        typeof sync.relay.url === 'string'
          ? { mode: sync.relay.mode, url: sync.relay.url }
          : undefined;
      setSyncStatus({
        replicaId: sync.replicaId,
        seq: sync.seq,
        ...(relay === undefined ? {} : { relay }),
      });
    } catch {
      setSyncStatus(null);
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
              server.bearerToken !== undefined ? server.bearerToken.slice(0, 4) + '••••' : '—',
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
      await refreshSyncStatus();
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- cancelled is mutated by the cleanup closure
      if (cancelled) return;
      const bucketsResponse = await callCompanion('/v1/buckets');
      if (bucketsResponse?.ok) {
        try {
          const body: unknown = await bucketsResponse.json();
          const items = (body as { readonly data?: { readonly items?: readonly unknown[] } }).data
            ?.items;
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
  // Companion connection drafts. Mirror the wizard pattern: keep the
  // input local until the user blurs / hits Enter, then commit so the
  // App-level debounced save isn't fired per keystroke.
  const [draftCompanionPort, setDraftCompanionPort] = useState<string>(
    typeof companionPort === 'number' ? String(companionPort) : '',
  );
  const [draftBridgeKey, setDraftBridgeKey] = useState<string>(bridgeKey ?? '');
  useEffect(() => {
    setDraftCompanionPort(typeof companionPort === 'number' ? String(companionPort) : '');
  }, [companionPort]);
  useEffect(() => {
    setDraftBridgeKey(bridgeKey ?? '');
  }, [bridgeKey]);
  const [companionTestState, setCompanionTestState] = useState<
    'idle' | 'testing' | 'reachable' | 'unauthorized' | 'unreachable'
  >('idle');
  const companionConnDirty =
    Number.parseInt(draftCompanionPort, 10) !== companionPort ||
    draftBridgeKey !== (bridgeKey ?? '');

  const handleCompanionConnSave = (): void => {
    const portNum = Number.parseInt(draftCompanionPort, 10);
    if (!Number.isFinite(portNum) || portNum <= 0 || portNum > 65_535) return;
    if (draftBridgeKey.trim().length === 0) return;
    onSaveCompanionConnection?.({ port: portNum, bridgeKey: draftBridgeKey });
  };

  // #2 — let the user load the bridge key from the file instead of
  // catting it in a terminal. The file-select IS the user gesture, so
  // it stays secure (no auto-served key over loopback).
  const bridgeKeyFileRef = useRef<HTMLInputElement | null>(null);
  const handleBridgeKeyFile = async (file: File): Promise<void> => {
    // bridge.key is a single-line text file; trim the trailing newline so
    // the value matches exactly what the companion compares against.
    const text = (await file.text()).trim();
    if (text.length === 0) return;
    setDraftBridgeKey(text);
    setCompanionTestState('idle');
  };

  // #3 — one-paste pairing. The companion prints st-pair://<port>/<key>
  // (and writes pair.txt); parsing it fills BOTH fields and saves, so the
  // user never separately hunts the port and cats the key.
  const [pairingDraft, setPairingDraft] = useState('');
  const [pairingError, setPairingError] = useState<string | null>(null);
  const handlePairingApply = (): void => {
    const parsed = parsePairingString(pairingDraft);
    if (parsed === null) {
      setPairingError('Not a pairing string — expected st-pair://<port>/<key>.');
      return;
    }
    setPairingError(null);
    setDraftCompanionPort(String(parsed.port));
    setDraftBridgeKey(parsed.bridgeKey);
    setCompanionTestState('idle');
    onSaveCompanionConnection?.({ port: parsed.port, bridgeKey: parsed.bridgeKey });
    setPairingDraft('');
  };

  const handleCompanionTest = async (): Promise<void> => {
    const portNum = Number.parseInt(draftCompanionPort, 10);
    if (!Number.isFinite(portNum) || portNum <= 0 || portNum > 65_535) {
      setCompanionTestState('unreachable');
      return;
    }
    setCompanionTestState('testing');
    try {
      const headers: Record<string, string> = {};
      if (draftBridgeKey.trim().length > 0) {
        headers['x-bac-bridge-key'] = draftBridgeKey.trim();
      }
      const response = await fetch(`http://127.0.0.1:${String(portNum)}/v1/system/health`, {
        headers,
      });
      if (response.ok) setCompanionTestState('reachable');
      else if (response.status === 401) setCompanionTestState('unauthorized');
      else setCompanionTestState('unreachable');
    } catch {
      setCompanionTestState('unreachable');
    }
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
  // Capture mode (autoTrack) lives in the side-panel toolbar now;
  // Settings only describes it. Unused-locals reference here is
  // intentional so removing the prop later is a single-spot edit.
  void localPreferences.autoTrack;
  const [draftVaultPath, setDraftVaultPath] = useState(localPreferences.vaultPath);
  const [draftNotifyOnQueueComplete, setDraftNotifyOnQueueComplete] = useState(
    localPreferences.notifyOnQueueComplete,
  );
  const [draftPageEvidenceAutoExtractEnabled, setDraftPageEvidenceAutoExtractEnabled] = useState(
    localPreferences.pageEvidenceAutoExtractEnabled,
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
    draftNotifyOnQueueComplete !== localPreferences.notifyOnQueueComplete ||
    draftPageEvidenceAutoExtractEnabled !== localPreferences.pageEvidenceAutoExtractEnabled;
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
        ...(draftPageEvidenceAutoExtractEnabled === localPreferences.pageEvidenceAutoExtractEnabled
          ? {}
          : { pageEvidenceAutoExtractEnabled: draftPageEvidenceAutoExtractEnabled }),
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
      {onSaveCompanionConnection !== undefined ? (
        <div className="settings-section" id="companion-connection">
          <h3 className="settings-section-title">Connection</h3>
          <div className="settings-conn-status">
            <span
              className={
                'sp-status-dot ' +
                (companionVaultRoot !== null && companionVaultRoot !== undefined
                  ? 'green'
                  : companionConfigured
                    ? 'red'
                    : 'amber')
              }
              aria-hidden
            />
            <span className="mono">
              {companionVaultRoot !== null && companionVaultRoot !== undefined
                ? `connected · ${companionVaultRoot}`
                : companionConfigured
                  ? 'configured, but the companion isn’t responding on this port'
                  : 'local-only — no companion paired yet'}
            </span>
          </div>
          <p className="settings-section-lede ai-italic">
            Pair in one paste: start the companion, then paste the{' '}
            <span className="mono">st-pair://…</span> string it prints (also saved to{' '}
            <span className="mono">_BAC/.config/pair.txt</span>). Or set the port + key by hand below.
          </p>
          <label className="settings-text-row">
            <span>Pairing string</span>
            <input
              type="text"
              className="mono"
              placeholder="st-pair://17373/…"
              value={pairingDraft}
              disabled={busy}
              onChange={(event) => {
                setPairingDraft(event.target.value);
                setPairingError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') handlePairingApply();
              }}
              aria-label="Pairing string"
            />
          </label>
          <div className="settings-keyfile-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || pairingDraft.trim().length === 0}
              onClick={handlePairingApply}
            >
              Pair
            </button>
            {pairingError !== null ? (
              <span className="settings-companion-status red mono">{pairingError}</span>
            ) : (
              <span className="settings-hint mono">fills the port + key below and connects</span>
            )}
          </div>
          <div className="settings-conn-divider" aria-hidden />
          <label className="settings-text-row">
            <span>Port</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={65535}
              className="mono"
              value={draftCompanionPort}
              disabled={busy}
              onChange={(event) => {
                setDraftCompanionPort(event.target.value);
                setCompanionTestState('idle');
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  handleCompanionConnSave();
                }
              }}
              aria-label="Companion port"
            />
          </label>
          <label className="settings-text-row">
            <span>Bridge key</span>
            <input
              type="password"
              autoComplete="off"
              className="mono"
              placeholder="Paste from _BAC/.config/bridge.key"
              value={draftBridgeKey}
              disabled={busy}
              onChange={(event) => {
                setDraftBridgeKey(event.target.value);
                setCompanionTestState('idle');
              }}
              aria-label="Bridge key"
            />
          </label>
          <div className="settings-keyfile-row">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => {
                bridgeKeyFileRef.current?.click();
              }}
            >
              Load key from file…
            </button>
            <input
              ref={bridgeKeyFileRef}
              type="file"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file !== undefined) void handleBridgeKeyFile(file);
              }}
            />
            <span className="settings-hint mono">
              pick <span className="mono">_BAC/.config/bridge.key</span> — no terminal needed
            </span>
          </div>
          <div className="settings-cta-row">
            <span
              className={
                'mono settings-companion-status ' +
                (companionTestState === 'reachable'
                  ? 'green'
                  : companionTestState === 'testing'
                    ? 'amber'
                    : companionTestState === 'unauthorized' || companionTestState === 'unreachable'
                      ? 'red'
                      : 'neutral')
              }
            >
              {companionTestState === 'reachable'
                ? '✓ companion responded'
                : companionTestState === 'testing'
                  ? 'testing…'
                  : companionTestState === 'unauthorized'
                    ? '✗ bridge key rejected (401)'
                    : companionTestState === 'unreachable'
                      ? '✗ no response on this port'
                      : companionConnDirty
                        ? 'unsaved changes'
                        : 'idle'}
            </span>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy || companionTestState === 'testing'}
              onClick={() => {
                void handleCompanionTest();
              }}
            >
              Test
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !companionConnDirty}
              onClick={handleCompanionConnSave}
            >
              Save connection
            </button>
          </div>
        </div>
      ) : null}

      <div className="settings-section">
        <h3 className="settings-section-title">Vault</h3>
        {companionConfigured ? (
          <>
            <p className="settings-section-lede ai-italic">
              The companion is connected and writing to the vault below. Captures, dispatches, and
              reviews land as Markdown + JSON under <span className="mono">_BAC/</span> so they
              survive reinstalls and are readable by other tools.
            </p>
            <div className="settings-vault-status">
              <div className="settings-vault-status-row">
                <span className="settings-vault-status-label mono">vault</span>
                <code className="settings-vault-status-value">
                  {companionVaultRoot ?? (draftVaultPath.length > 0 ? draftVaultPath : '—')}
                </code>
                {companionVaultRoot !== null && companionVaultRoot !== undefined ? (
                  <span className="settings-hint mono">live · reported by companion</span>
                ) : null}
              </div>
              {(companionVaultRoot ?? draftVaultPath).length > 0 ? (
                <div className="settings-vault-status-row">
                  <span className="settings-vault-status-label mono">bridge key</span>
                  <code className="settings-vault-status-value">
                    {(companionVaultRoot ?? draftVaultPath).replace(/\/$/u, '')}/_BAC/.config/bridge.key
                  </code>
                  <button
                    type="button"
                    className="btn-link sp-status-pill-btn"
                    title="Copy the bridge-key file path"
                    onClick={() => {
                      void navigator.clipboard.writeText(
                        `${(companionVaultRoot ?? draftVaultPath).replace(/\/$/u, '')}/_BAC/.config/bridge.key`,
                      );
                    }}
                  >
                    copy path
                  </button>
                </div>
              ) : null}
            </div>
            <p className="settings-hint mono">
              Need the key? Use “Load key from file…” under Companion connection above, or open the
              path shown here — no terminal required. The editable vault path below sets the vault for
              the NEXT companion launch; the running process keeps its current path.
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
      </div>

      <div className="settings-section">
        <h3 className="settings-section-title">Capture</h3>
        <p className="settings-section-lede ai-italic">
          What Sidetrack records. These mirror the toolbar controls — the{' '}
          <span className="mono">eye</span> (capture on/off) and the auto/manual toggle.
        </p>
        <label className={'switch ' + (localPreferences.captureEnabled ? 'on' : '')}>
          <input
            type="checkbox"
            checked={localPreferences.captureEnabled}
            disabled={busy}
            onChange={() => {
              onSaveLocalPreferences({ captureEnabled: !localPreferences.captureEnabled });
            }}
          />
          <span className="knob" />
          <span className="lbl">
            Capture
            <span className="desc mono">
              {localPreferences.captureEnabled
                ? 'on — recording chat threads, page text, timeline, engagement'
                : 'paused — nothing is recorded anywhere'}
            </span>
          </span>
        </label>
        <label
          className={'switch ' + (localPreferences.autoTrack ? 'on' : '')}
          style={{ marginTop: 8 }}
        >
          <input
            type="checkbox"
            checked={localPreferences.autoTrack}
            disabled={busy || !localPreferences.captureEnabled}
            onChange={() => {
              onSaveLocalPreferences({ autoTrack: !localPreferences.autoTrack });
            }}
          />
          <span className="knob" />
          <span className="lbl">
            Auto-track new threads
            <span className="desc mono">
              {localPreferences.autoTrack
                ? 'on — refresh tracked threads on every new turn'
                : 'off — capture only when you click a row'}
            </span>
          </span>
        </label>
      </div>

      <div className="settings-section">
        <h3 className="settings-section-title">Sync</h3>
        {companionConfigured ? (
          <>
            <div className="settings-vault-status">
              <div className="settings-vault-status-row">
                <span className="settings-vault-status-label mono">replica</span>
                <code className="settings-vault-status-value">
                  {syncStatus === null ? 'checking…' : syncStatus.replicaId}
                </code>
              </div>
              <div className="settings-vault-status-row">
                <span className="settings-vault-status-label mono">event seq</span>
                <code className="settings-vault-status-value">
                  {syncStatus === null ? '—' : String(syncStatus.seq)}
                </code>
              </div>
              <div className="settings-vault-status-row">
                <span className="settings-vault-status-label mono">relay</span>
                <code className="settings-vault-status-value">
                  {syncStatus?.relay === undefined
                    ? 'off'
                    : `${syncStatus.relay.mode}: ${syncStatus.relay.url}`}
                </code>
              </div>
            </div>
            {syncStatus?.relay === undefined ? (
              <p className="settings-hint mono">
                Local alpha: restart the companion with <code>--sync-relay-local 18443</code>.
                Sidetrack will reuse <code>_BAC/.config/sync-rendezvous.secret</code> for the sync
                group.
              </p>
            ) : (
              <p className="settings-hint mono">
                Relay frames are encrypted locally; the relay only routes opaque events.
              </p>
            )}
          </>
        ) : (
          <p className="settings-section-lede ai-italic">
            Sync is available after the side panel is connected to a companion.
          </p>
        )}
      </div>

      <div className="settings-section">
        <h3 className="settings-section-title">Auto-send per provider</h3>
        <p className="settings-section-lede ai-italic">
          Auto-send opens the AI's tab and types the packet for you. AI providers default to on;
          turn one off and Sidetrack falls back to copying the packet so you can paste it yourself.
          Settings live in the vault, not the browser.
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
        <label
          className={'switch ' + (draftPageEvidenceAutoExtractEnabled ? 'on' : '')}
          style={{ marginTop: 8 }}
        >
          <input
            type="checkbox"
            checked={draftPageEvidenceAutoExtractEnabled}
            disabled={busy}
            onChange={() => {
              setDraftPageEvidenceAutoExtractEnabled(!draftPageEvidenceAutoExtractEnabled);
            }}
          />
          <span className="knob" />
          <span className="lbl">
            Capture page evidence after focus
            <span className="desc mono">
              {draftPageEvidenceAutoExtractEnabled
                ? 'features-only capture after 5s focused'
                : 'off — new pages stay metadata-only'}
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
      <TimelineSection />
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
          void callCompanion('/v1/system/uninstall-service', { method: 'POST' }).then(() =>
            refreshServiceStatus(),
          );
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
      <CollectorsSection collectors={collectors} onReplay={onCollectorReplay} />
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

      {settingsNotice !== null ? <div className="settings-hint mono">{settingsNotice}</div> : null}
      {error !== null && error !== undefined ? (
        <div className="settings-error mono">{error}</div>
      ) : null}
    </Modal>
  );
}
