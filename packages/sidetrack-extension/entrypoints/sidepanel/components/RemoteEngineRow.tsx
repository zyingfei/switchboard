import { useCallback, useEffect, useRef, useState } from 'react';

import {
  clearRemoteApiKey,
  maskApiKey,
  readRemoteConfig,
  remoteConfigReady,
  remoteHostOf,
  remotePrivacyDetail,
  remotePrivacyMarker,
  saveRemoteConfig,
  type RemoteEngineConfig,
} from '../../../src/sidepanel/nano/remoteConfig';
import { formatEngineLimits, remoteLimits } from '../../../src/sidepanel/nano/engineLimits';

// The OPTIONAL remote engine's configuration block, inside Health → Experiments.
//
// This is the one place in the product where a user can arrange for page text to
// leave the device, so the UI is built to make that impossible to do by accident
// and impossible to forget afterwards:
//
//   * The enable checkbox is OFF until the user ticks it, and ticking it alone
//     does nothing — routing also requires a key (remoteConfigReady).
//   * The key input is type="password", write-only. Once stored, the field is
//     cleared and only a MASK is shown ("sk-…abcd"); the key is never read back
//     into the DOM, so it cannot be shoulder-surfed, screenshotted from a
//     support session, or scraped out of the panel by a content script.
//   * "Clear key" wipes the secret AND flips the engine off — a user clearing
//     their key is asking to stop sending text out.
//   * Whenever the engine is armed (enabled + key) the block carries the
//     standing privacy marker naming the destination host.

export interface RemoteEngineRowProps {
  /** Called after any persisted change so the host re-probes engine availability. */
  readonly onChanged?: () => void;
}

export function RemoteEngineRow({ onChanged }: RemoteEngineRowProps = {}) {
  const [config, setConfig] = useState<RemoteEngineConfig | null>(null);
  // Draft fields. The key draft is write-only and never seeded from storage.
  const [baseUrlDraft, setBaseUrlDraft] = useState('');
  const [modelDraft, setModelDraft] = useState('');
  const [keyDraft, setKeyDraft] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    void (async () => {
      const loaded = await readRemoteConfig();
      if (!mountedRef.current) return;
      setConfig(loaded);
      setBaseUrlDraft(loaded.baseUrl);
      setModelDraft(loaded.model);
    })();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const persist = useCallback(
    async (patch: Partial<RemoteEngineConfig>): Promise<void> => {
      const next = await saveRemoteConfig(patch);
      if (!mountedRef.current) return;
      setConfig(next);
      onChanged?.();
    },
    [onChanged],
  );

  const saveFields = useCallback((): void => {
    const trimmedKey = keyDraft.trim();
    void persist({
      baseUrl: baseUrlDraft.trim(),
      model: modelDraft.trim(),
      // An empty draft leaves the stored key alone — saving the URL must not
      // silently wipe a key the field never shows.
      ...(trimmedKey.length === 0 ? {} : { apiKey: trimmedKey }),
    }).then(() => {
      if (!mountedRef.current) return;
      // Write-only: drop the draft the instant it is stored.
      setKeyDraft('');
      setNote('saved');
    });
  }, [persist, baseUrlDraft, modelDraft, keyDraft]);

  const clearKey = useCallback((): void => {
    void (async () => {
      const next = await clearRemoteApiKey();
      if (!mountedRef.current) return;
      setConfig(next);
      setKeyDraft('');
      setNote('key cleared — the remote engine is off');
      onChanged?.();
    })();
  }, [onChanged]);

  if (config === null) return null;

  const armed = remoteConfigReady(config);
  const host = remoteHostOf(config.baseUrl);
  const mask = maskApiKey(config.apiKey);

  return (
    <div className="sx-callout" data-testid="hp-remote-engine" style={{ marginTop: 8 }}>
      <strong>Remote engine (optional, off by default)</strong>
      <div className="mono" style={{ marginTop: 4 }}>
        Everything else in Sidetrack runs on this device. Turning this on sends the page or thread
        text you enrich to a provider you choose, with a key you supply.
      </div>
      <label style={{ display: 'block', marginTop: 6 }}>
        <input
          type="checkbox"
          checked={config.enabled}
          onChange={(e) => {
            void persist({ enabled: e.target.checked });
          }}
          data-testid="hp-remote-enable"
        />{' '}
        Enable the remote engine
        {config.enabled && mask.length === 0 ? ' — add a key below to use it' : ''}
      </label>
      <div style={{ marginTop: 6 }}>
        <label>
          Base URL{' '}
          <input
            type="text"
            value={baseUrlDraft}
            onChange={(e) => {
              setBaseUrlDraft(e.target.value);
            }}
            data-testid="hp-remote-base-url"
          />
        </label>
      </div>
      <div style={{ marginTop: 4 }}>
        <label>
          Model{' '}
          <input
            type="text"
            value={modelDraft}
            onChange={(e) => {
              setModelDraft(e.target.value);
            }}
            data-testid="hp-remote-model"
          />
        </label>
      </div>
      <div style={{ marginTop: 4 }}>
        <label>
          API key{' '}
          <input
            type="password"
            value={keyDraft}
            placeholder={mask.length === 0 ? 'sk-…' : 'replace the stored key'}
            onChange={(e) => {
              setKeyDraft(e.target.value);
            }}
            data-testid="hp-remote-key"
          />
        </label>
        {mask.length > 0 ? (
          <span className="mono" style={{ marginLeft: 8 }} data-testid="hp-remote-key-mask">
            stored: {mask}
          </span>
        ) : null}
      </div>
      <div style={{ marginTop: 6 }}>
        <button type="button" className="sx-btn" onClick={saveFields} data-testid="hp-remote-save">
          Save
        </button>
        {mask.length > 0 ? (
          <button
            type="button"
            className="sx-btn"
            style={{ marginLeft: 8 }}
            onClick={clearKey}
            data-testid="hp-remote-clear-key"
          >
            Clear key
          </button>
        ) : null}
        <span className="mono" style={{ marginLeft: 8 }} data-testid="hp-remote-limits">
          {formatEngineLimits(remoteLimits)}
        </span>
      </div>
      {note !== null ? (
        <div className="mono" data-testid="hp-remote-note">
          {note}
        </div>
      ) : null}
      {/* The standing marker: on screen for as long as the engine is armed. */}
      {armed ? (
        <div
          className="mono"
          role="note"
          title={remotePrivacyDetail(host)}
          data-testid="hp-remote-warning"
          style={{ marginTop: 6 }}
        >
          {remotePrivacyMarker(host)}
        </div>
      ) : null}
    </div>
  );
}
