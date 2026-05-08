import { useEffect, useState } from 'react';

import { formatRelative } from '../../../src/util/time';
import { Icons } from './icons';

// Settings v2 — section components for the SettingsPanel. Each is
// self-contained and accepts pre-shaped props so the parent owns
// network IO. Backends:
//   - ServiceInstallSection → /v1/system/service-status + install (PR #77)
//   - ImportExportSection   → /v1/settings/export + import (PR #77)
//   - McpHostsSection       → extension-side mcpHost.registry (PR #78)
//   - BucketsSection        → /v1/buckets (PR #78)
//   - AppearanceSection     → local document attributes (no backend)

// ─────────────────────────────────────────────────────────────────────
// Theme + density toggles. Wires to data-theme + data-density on root.
// ─────────────────────────────────────────────────────────────────────

export type ThemeMode = 'auto' | 'light' | 'ink';
export type DensityMode = 'cozy' | 'compact';

interface AppearanceSectionProps {
  readonly theme: ThemeMode;
  readonly density: DensityMode;
  readonly onThemeChange: (mode: ThemeMode) => void;
  readonly onDensityChange: (mode: DensityMode) => void;
}

const THEME_LABELS: Record<ThemeMode, string> = {
  auto: 'Auto',
  light: 'Light',
  ink: 'Dark',
};

const DENSITY_LABELS: Record<DensityMode, string> = {
  cozy: 'Cozy',
  compact: 'Compact',
};

export function AppearanceSection({
  theme,
  density,
  onThemeChange,
  onDensityChange,
}: AppearanceSectionProps) {
  return (
    <div className="settings-sec-v2" id="sec-appearance">
      <div className="sec-h">Appearance</div>
      <div className="appearance-grid">
        <div>
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 10,
              color: 'var(--ink-3)',
              marginBottom: 4,
            }}
          >
            Theme
          </div>
          <div className="choice-group" role="radiogroup" aria-label="Theme">
            {(['auto', 'light', 'ink'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={theme === mode}
                className={theme === mode ? 'on' : ''}
                onClick={() => {
                  onThemeChange(mode);
                }}
              >
                {THEME_LABELS[mode]}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 10,
              color: 'var(--ink-3)',
              marginBottom: 4,
            }}
          >
            Density
          </div>
          <div className="choice-group" role="radiogroup" aria-label="Density">
            {(['cozy', 'compact'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={density === mode}
                className={density === mode ? 'on' : ''}
                onClick={() => {
                  onDensityChange(mode);
                }}
              >
                {DENSITY_LABELS[mode]}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Timeline observation — Settings → Timeline.
//
// Two independent controls:
//   1. The privacy gate (chrome.storage.local['sidetrack.timeline.enabled']).
//      Default OFF; flipping ON also fires the 'sidetrack.timeline.reinit'
//      runtime message so the SW's chrome.tabs listeners register without a
//      reload. Once on, the manifest's `tabs` permission is enough to
//      observe URL + title for every navigation — chat-provider AND
//      ambient pages.
//   2. The optional-host-permission grant. The manifest declares
//      optional_host_permissions: ['https://*/*', 'http://*/*']. URL +
//      title observation does NOT need this grant — the `tabs` permission
//      already covers it. The grant exists for future passes that need
//      deeper page access (content extraction, in-page actions). The
//      button calls chrome.permissions.request from a user-gesture
//      context so the grant is available when those features land,
//      without forcing the user back through Settings later.
// ─────────────────────────────────────────────────────────────────────

const TIMELINE_OPTIONAL_ORIGINS = ['https://*/*', 'http://*/*'] as const;

const readTimelinePrivacyGate = async (): Promise<boolean> => {
  const response = (await chrome.runtime.sendMessage({
    type: 'sidetrack.timeline.privacy.get',
  })) as { readonly ok?: boolean; readonly enabled?: unknown; readonly error?: string };
  if (response.ok !== true) throw new Error(response.error ?? 'privacy gate read failed');
  return response.enabled === true;
};

const writeTimelinePrivacyGate = async (enabled: boolean): Promise<void> => {
  const response = (await chrome.runtime.sendMessage({
    type: 'sidetrack.timeline.privacy.set',
    enabled,
  })) as { readonly ok?: boolean; readonly error?: string };
  if (response.ok !== true) throw new Error(response.error ?? 'privacy gate write failed');
};

const recordTimelinePermissionEvent = async (type: string): Promise<void> => {
  const response = (await chrome.runtime.sendMessage({ type })) as {
    readonly ok?: boolean;
    readonly error?: string;
  };
  if (response.ok !== true) throw new Error(response.error ?? 'privacy permission event failed');
};

const readChromePermissionsContains = async (): Promise<boolean> => {
  try {
    return await new Promise<boolean>((resolve) => {
      chrome.permissions.contains(
        { origins: [...TIMELINE_OPTIONAL_ORIGINS] },
        (granted) => {
          resolve(Boolean(granted));
        },
      );
    });
  } catch {
    return false;
  }
};

export function TimelineSection() {
  const [enabled, setEnabled] = useState<boolean>(false);
  const [hasPermission, setHasPermission] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Hydrate gate + permission state on mount. The gate read goes
  // through the background privacy projection bridge; the permission
  // read is async via chrome.permissions.contains.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const gateOpen = await readTimelinePrivacyGate();
        if (!cancelled) setEnabled(gateOpen);
      } catch {
        // Companion / chrome missing in a test harness — leave default false.
      }
      const granted = await readChromePermissionsContains();
      if (!cancelled) setHasPermission(granted);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleToggleEnabled = async (next: boolean): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      await writeTimelinePrivacyGate(next);
      setEnabled(next);
      setNotice(
        next
          ? 'Timeline observation enabled. URL + title for every navigation will land in the timeline projection.'
          : 'Timeline observation disabled.',
      );
    } catch (error) {
      setNotice(
        `Could not save timeline setting: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setBusy(false);
    }
  };

  const handleGrantPermission = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const granted = await new Promise<boolean>((resolve) => {
        chrome.permissions.request(
          { origins: [...TIMELINE_OPTIONAL_ORIGINS] },
          (g) => {
            resolve(Boolean(g));
          },
        );
      });
      setHasPermission(granted);
      if (granted) {
        await recordTimelinePermissionEvent('sidetrack.timeline.permission.granted').catch(() => undefined);
      }
      setNotice(
        granted
          ? 'Deeper page access granted. Future Sidetrack features (content extraction, in-page actions) will use this — URL/title observation already worked without it.'
          : 'Permission was not granted. Timeline observation continues to work for URL + title; the grant is only needed for deeper page features.',
      );
    } catch (error) {
      setNotice(
        `Permission request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setBusy(false);
    }
  };

  const handleRevokePermission = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const removed = await new Promise<boolean>((resolve) => {
        chrome.permissions.remove(
          { origins: [...TIMELINE_OPTIONAL_ORIGINS] },
          (r) => {
            resolve(Boolean(r));
          },
        );
      });
      if (removed) setHasPermission(false);
      if (removed) {
        await recordTimelinePermissionEvent('sidetrack.timeline.permission.revoked').catch(() => undefined);
      }
      setNotice(
        removed
          ? 'Deeper page access revoked. Timeline observation still records URL + title.'
          : 'Could not revoke; you may need to use chrome://extensions to remove host access.',
      );
    } catch (error) {
      setNotice(
        `Permission removal failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-sec-v2" id="sec-timeline" data-testid="settings-timeline-section">
      <div className="sec-h">Timeline observation</div>
      <p className="settings-section-lede ai-italic">
        When enabled, Sidetrack observes URL + title for every browser tab
        navigation and attributes each one to the active workstream — no
        page contents are captured. Default OFF, opt-in.
      </p>
      <label className={'switch ' + (enabled ? 'on' : '')}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          data-testid="settings-timeline-toggle"
          onChange={() => {
            void handleToggleEnabled(!enabled);
          }}
        />
        <span className="knob" />
        <span className="lbl">
          Observe browser activity
          <span className="desc mono">
            {enabled
              ? 'on — recording URL + title for every navigation'
              : 'off — no tab activity is recorded'}
          </span>
        </span>
      </label>
      <div className="settings-cta-row" style={{ marginTop: 8 }}>
        <span className="mono" data-testid="settings-timeline-permission-status">
          {hasPermission ? '✓ deeper page access granted' : 'deeper page access not granted (optional)'}
        </span>
        {hasPermission ? (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy}
            data-testid="settings-timeline-revoke-permission"
            onClick={() => {
              void handleRevokePermission();
            }}
          >
            Revoke
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            data-testid="settings-timeline-grant-permission"
            onClick={() => {
              void handleGrantPermission();
            }}
          >
            Allow deeper page access…
          </button>
        )}
      </div>
      {notice !== null ? (
        <div className="settings-hint mono" data-testid="settings-timeline-notice">
          {notice}
        </div>
      ) : null}
      <p className="settings-hint mono">
        URL + title observation works as soon as the toggle is on (the
        manifest's <code>tabs</code> permission covers it). Deeper access
        is optional — it lets future Sidetrack features (content
        extraction, in-page actions) work on ambient pages too. Active
        workstream is set by selecting one in the workboard; observed
        visits attach via <code>visit_in_workstream</code> in the
        Connections graph.
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Service-install consent — Settings → Run on startup.
// ─────────────────────────────────────────────────────────────────────

interface ServiceInstallSectionProps {
  readonly installed: boolean;
  readonly running: boolean;
  readonly onInstall: () => void;
  readonly onUninstall: () => void;
}

export function ServiceInstallSection({
  installed,
  running,
  onInstall,
  onUninstall,
}: ServiceInstallSectionProps) {
  const [consenting, setConsenting] = useState(false);
  return (
    <div className="settings-sec-v2" id="sec-svc">
      <div className="sec-h">Run on startup</div>
      <button
        type="button"
        className={'trust-row' + (installed ? ' on' : '')}
        onClick={() => {
          if (installed) {
            onUninstall();
          } else if (!consenting) {
            setConsenting(true);
          }
        }}
        aria-pressed={installed}
        style={{ width: '100%' }}
      >
        <span className="cb" />
        <div className="body">
          <div className="r1">
            <code>Launch companion at login</code>
          </div>
          <div className="r2">
            {installed
              ? `installed${running ? ' · running' : ' · stopped'}`
              : 'currently manual — captures pause when companion quits'}
          </div>
        </div>
        <span className="state">{installed ? 'installed' : 'off'}</span>
      </button>
      {consenting && !installed ? (
        <div className="consent-card">
          <div className="cc-head">
            {Icons.alert}
            <b>Confirm what gets installed</b>
          </div>
          <ul className="cc-list">
            <li>
              <code>~/Library/LaunchAgents/com.sidetrack.companion.plist</code>{' '}
              <span className="muted">(macOS)</span>
            </li>
            <li>
              <code>~/.config/systemd/user/sidetrack-companion.service</code>{' '}
              <span className="muted">(Linux)</span>
            </li>
            <li>
              <code>schtasks /tn SidetrackCompanion</code> <span className="muted">(Windows)</span>
            </li>
          </ul>
          <div className="cc-note">
            No admin/root required. Uses this local companion checkout and is removable from
            Settings.
          </div>
          <div className="cc-actions">
            <button
              type="button"
              className="settings-button"
              onClick={() => {
                setConsenting(false);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="settings-button settings-button-primary"
              onClick={() => {
                onInstall();
                setConsenting(false);
              }}
            >
              Install
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Settings import/export — Settings → Portability.
// ─────────────────────────────────────────────────────────────────────

export interface ImportDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
  readonly conflicts: number;
}

interface ImportExportSectionProps {
  readonly onExport: () => void;
  readonly onChooseImportFile: () => void;
  readonly diff: ImportDiff | null;
  readonly onCancelImport: () => void;
  readonly onApplyImport: () => void;
}

export function ImportExportSection({
  onExport,
  onChooseImportFile,
  diff,
  onCancelImport,
  onApplyImport,
}: ImportExportSectionProps) {
  return (
    <div className="settings-sec-v2" id="sec-port">
      <div className="sec-h">Portability</div>
      <div className="port-grid">
        <div className="port-card">
          <div className="t1">Export settings</div>
          <div className="t2">
            downloads <code>sidetrack-config.json</code> · no captures included
          </div>
          <button type="button" className="settings-button" onClick={onExport}>
            Download bundle
          </button>
        </div>
        <div className="port-card">
          <div className="t1">Import settings</div>
          <div className="t2">drop a config bundle · review diff before apply</div>
          <button type="button" className="settings-button" onClick={onChooseImportFile}>
            Choose file…
          </button>
        </div>
      </div>
      {diff !== null ? (
        <div className="diff-card">
          <div className="diff-head">
            <b>Import diff preview</b>
            <button
              type="button"
              className="close"
              onClick={onCancelImport}
              aria-label="Cancel import"
            >
              {Icons.close}
            </button>
          </div>
          <pre className="diff">
            {[
              ...diff.added.map((s) => `+ ${s}`),
              ...diff.removed.map((s) => `- ${s}`),
              ...diff.changed.map((s) => `~ ${s}`),
            ].join('\n')}
          </pre>
          <div className="diff-foot">
            <span className="muted">
              {String(diff.added.length + diff.removed.length + diff.changed.length)} change
              {diff.added.length + diff.removed.length + diff.changed.length === 1 ? '' : 's'}
              {' · '}
              {String(diff.conflicts)} conflict{diff.conflicts === 1 ? '' : 's'}
            </span>
            <button type="button" className="settings-button" onClick={onCancelImport}>
              Cancel
            </button>
            <button
              type="button"
              className="settings-button settings-button-primary"
              onClick={onApplyImport}
            >
              Apply
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// MCP-host trusted servers — Settings → MCP hosts.
// ─────────────────────────────────────────────────────────────────────

export interface McpHost {
  readonly id: string;
  readonly url: string;
  readonly tokenMasked: string;
  readonly role: string;
  readonly online: boolean;
  readonly checkedAt?: string;
}

interface McpHostsSectionProps {
  readonly hosts: readonly McpHost[];
  readonly onRemove: (id: string) => void;
  readonly onAdd: (input: { readonly url: string; readonly token: string }) => void;
}

export function McpHostsSection({ hosts, onRemove, onAdd }: McpHostsSectionProps) {
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  return (
    <div className="settings-sec-v2" id="sec-mcp">
      <div className="sec-h">MCP hosts</div>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 10.5,
          color: 'var(--ink-3)',
          marginBottom: 8,
        }}
      >
        servers Sidetrack will accept tool calls from
      </div>
      {hosts.map((h) => (
        <div key={h.id} className={'mcp-row' + (h.online ? '' : ' off')}>
          <span className={'hp-dot ' + (h.online ? 'green' : '')} />
          <code className="url">{h.url}</code>
          <span className="role">{h.role}</span>
          {h.checkedAt !== undefined ? (
            <span className="role">{formatRelative(h.checkedAt)}</span>
          ) : null}
          <code className="token">{h.tokenMasked}</code>
          <button
            type="button"
            className="bucket-x"
            onClick={() => {
              onRemove(h.id);
            }}
            aria-label={`Remove ${h.url}`}
          >
            {Icons.close}
          </button>
        </div>
      ))}
      <div className="mcp-add">
        <input
          className="mono"
          placeholder="http://localhost:port"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
          }}
        />
        <input
          className="mono"
          placeholder="bearer token"
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
          }}
        />
        <button
          type="button"
          className="settings-button"
          disabled={url.length === 0 || token.length === 0}
          onClick={() => {
            onAdd({ url, token });
            setUrl('');
            setToken('');
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Multi-vault bucket manager — Settings → Vaults & buckets.
// ─────────────────────────────────────────────────────────────────────

export interface VaultBucket {
  readonly id: string;
  readonly rule: string;
  readonly vaultPath: string;
  readonly isDefault: boolean;
}

interface BucketsSectionProps {
  readonly buckets: readonly VaultBucket[];
  readonly onRemove: (id: string) => void;
  readonly onAddBucket: (input: { readonly rule: string; readonly vaultPath: string }) => void;
}

export function BucketsSection({ buckets, onRemove, onAddBucket }: BucketsSectionProps) {
  const [adding, setAdding] = useState(false);
  const [rule, setRule] = useState('');
  const [vaultPath, setVaultPath] = useState('');
  return (
    <div className="settings-sec-v2" id="sec-vault">
      <div className="sec-h">Vaults &amp; buckets</div>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 10.5,
          color: 'var(--ink-3)',
          marginBottom: 8,
        }}
      >
        route captures by workstream / provider / url glob → vault
      </div>
      {buckets.map((b) => (
        <div key={b.id} className="bucket-row">
          <code className="bucket-rule">{b.rule}</code>
          <span className="bucket-arrow">→</span>
          <code className="bucket-vault">{b.vaultPath}</code>
          {!b.isDefault ? (
            <button
              type="button"
              className="bucket-x"
              onClick={() => {
                onRemove(b.id);
              }}
              aria-label="Remove bucket"
            >
              {Icons.close}
            </button>
          ) : null}
        </div>
      ))}
      {adding ? (
        <div className="mcp-add bucket-add">
          <input
            className="mono"
            placeholder="workstream:research"
            value={rule}
            onChange={(e) => {
              setRule(e.target.value);
            }}
          />
          <input
            className="mono"
            placeholder="~/Documents/Sidetrack-vault"
            value={vaultPath}
            onChange={(e) => {
              setVaultPath(e.target.value);
            }}
          />
          <button
            type="button"
            className="settings-button settings-button-primary"
            disabled={rule.trim().length === 0 || vaultPath.trim().length === 0}
            onClick={() => {
              onAddBucket({ rule: rule.trim(), vaultPath: vaultPath.trim() });
              setRule('');
              setVaultPath('');
              setAdding(false);
            }}
          >
            Save
          </button>
          <button
            type="button"
            className="settings-button"
            onClick={() => {
              setRule('');
              setVaultPath('');
              setAdding(false);
            }}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="settings-button"
          onClick={() => {
            setAdding(true);
          }}
          style={{ marginTop: 8 }}
        >
          {Icons.plus} Add bucket
        </button>
      )}
    </div>
  );
}
