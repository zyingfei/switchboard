import { useEffect, useState } from 'react';

import { formatRelative } from '../../../src/util/time';
import { Icons } from './icons';
import { TIMELINE_ENABLED_KEY } from '../../../src/timeline/wiring';

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
// Two coupled controls:
//   1. The privacy gate (chrome.storage.local['sidetrack.timeline.enabled']).
//      Default OFF; flipping ON also fires the 'sidetrack.timeline.reinit'
//      runtime message so the SW's chrome.tabs listeners register without a
//      reload.
//   2. The host-permission grant. The manifest declares
//      optional_host_permissions: ['https://*/*', 'http://*/*']; without
//      that grant the timeline observer can read URLs only for chat-
//      provider hosts (host_permissions). Granting the optional pair lets
//      ambient browsing (HN / blog / search / GitHub / video) participate
//      in active-workstream attribution. The button calls
//      chrome.permissions.request from a user-gesture context.
// ─────────────────────────────────────────────────────────────────────

const TIMELINE_OPTIONAL_ORIGINS = ['https://*/*', 'http://*/*'] as const;

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

  // Hydrate gate + permission state on mount. The gate read is async via
  // chrome.storage.local; the permission read is async via
  // chrome.permissions.contains.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const got = await chrome.storage.local.get(TIMELINE_ENABLED_KEY);
        if (!cancelled) setEnabled(got[TIMELINE_ENABLED_KEY] === true);
      } catch {
        // chrome.storage missing in a test harness — leave default false.
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
      await chrome.storage.local.set({ [TIMELINE_ENABLED_KEY]: next });
      setEnabled(next);
      // Tell the SW to (re-)init wiring so the gate flip takes effect
      // without a reload. The handler is idempotent — flipping off
      // can leave the listener registered (no observation lands while
      // the gate is false; the wiring's emit closure consults the gate
      // each time).
      try {
        await chrome.runtime.sendMessage({ type: 'sidetrack.timeline.reinit' });
      } catch {
        // SW may be dormant; the next event-driven boot picks up the
        // gate. Not blocking.
      }
      setNotice(
        next
          ? hasPermission
            ? 'Timeline observation enabled.'
            : 'Timeline enabled. Grant URL access below to observe ambient pages.'
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
      setNotice(
        granted
          ? 'URL access granted — ambient pages will be observed when timeline is enabled.'
          : 'Permission was not granted; the observer can still see chat-provider hosts.',
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
      setNotice(
        removed
          ? 'URL access revoked. Ambient pages will no longer be observed.'
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
        When enabled, Sidetrack observes the URLs you visit and attributes
        them to the active workstream — no captures, just titles + URLs in
        the local timeline projection. Default OFF, opt-in.
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
              ? hasPermission
                ? 'on — observing chat + ambient pages'
                : 'on — observing chat-provider pages only (grant URL access for ambient)'
              : 'off — no tab activity is recorded'}
          </span>
        </span>
      </label>
      <div className="settings-cta-row" style={{ marginTop: 8 }}>
        <span className="mono" data-testid="settings-timeline-permission-status">
          {hasPermission ? '✓ URL access granted' : 'URL access not granted'}
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
            Revoke URL access
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
            Grant URL access…
          </button>
        )}
      </div>
      {notice !== null ? (
        <div className="settings-hint mono" data-testid="settings-timeline-notice">
          {notice}
        </div>
      ) : null}
      <p className="settings-hint mono">
        Active workstream is set by selecting one in the workboard;
        observed visits will attach to it via{' '}
        <code>visit_in_workstream</code> in the Connections graph.
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
