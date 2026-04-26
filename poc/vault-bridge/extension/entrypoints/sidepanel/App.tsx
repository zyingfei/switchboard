import { useEffect, useState } from 'react';

import { bridgeMessages, sendBridgeMessage, type BridgeState } from '../../src/shared/messages';
import { loadVaultHandle, saveVaultHandle } from '../../src/vault/idb';
import { requestReadWritePermission } from '../../src/vault/fsAccess';

const initialState: BridgeState = {
  swStartedAt: '',
  runId: '',
  hasVaultHandle: false,
  permission: 'unknown',
  needsUserGrant: false,
  tickRunning: false,
  tickSequence: 0,
  observationPath: '_BAC/observations/run-<pending>.jsonl',
};

const permissionText = (state: BridgeState): string => {
  if (!state.hasVaultHandle) {
    return 'No vault selected';
  }
  if (state.needsUserGrant) {
    return `Needs grant (${state.permission})`;
  }
  return `Ready (${state.permission})`;
};

export default function App() {
  const [state, setState] = useState<BridgeState>(initialState);
  const [status, setStatus] = useState('Ready');
  const [busy, setBusy] = useState(false);

  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(true);
    setStatus(label);
    try {
      await action();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    const response = await sendBridgeMessage({ type: bridgeMessages.getState });
    setState(response.state);
    setStatus(response.ok ? 'Ready' : response.error);
  };

  const pickVault = async () => {
    if (!window.showDirectoryPicker) {
      throw new Error('showDirectoryPicker() is not available in this browser context.');
    }
    const handle = await window.showDirectoryPicker({
      id: 'bac-vault-bridge',
      mode: 'readwrite',
    });
    await saveVaultHandle(handle);
    const response = await sendBridgeMessage({ type: bridgeMessages.handleUpdated });
    setState(response.state);
    setStatus(response.ok ? `Vault selected: ${handle.name}` : response.error);
  };

  const grantStoredVault = async () => {
    const handle = await loadVaultHandle();
    if (!handle) {
      throw new Error('No stored vault handle to grant.');
    }
    const permission = await requestReadWritePermission(handle);
    if (permission !== 'granted') {
      throw new Error(`Permission is ${permission}.`);
    }
    await saveVaultHandle(handle);
    const response = await sendBridgeMessage({ type: bridgeMessages.handleUpdated });
    setState(response.state);
    setStatus(response.ok ? 'Vault permission granted' : response.error);
  };

  const writeEvent = async () => {
    const response = await sendBridgeMessage({ type: bridgeMessages.writeTestEvent });
    setState(response.state);
    setStatus(response.ok ? 'Wrote synthetic event' : response.error);
  };

  const startTick = async () => {
    const response = await sendBridgeMessage({ type: bridgeMessages.startTick });
    setState(response.state);
    setStatus(response.ok ? 'Started 1 Hz tick' : response.error);
  };

  const stopTick = async () => {
    const response = await sendBridgeMessage({ type: bridgeMessages.stopTick });
    setState(response.state);
    setStatus(response.ok ? 'Stopped tick' : response.error);
  };

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Feasibility POC</p>
          <h1>Vault Bridge</h1>
        </div>
        <span className={state.needsUserGrant ? 'status warning' : 'status'}>{permissionText(state)}</span>
      </header>

      <section className="panel">
        <div className="section-heading">
          <h2>Controls</h2>
          <span className="muted">{status}</span>
        </div>
        <div className="actions">
          <button className="button primary" disabled={busy} onClick={() => void run('Picking vault', pickVault)}>
            Pick vault folder
          </button>
          <button className="button" disabled={busy} onClick={() => void run('Writing event', writeEvent)}>
            Write test event
          </button>
          <button className="button" disabled={busy || state.tickRunning} onClick={() => void run('Starting tick', startTick)}>
            Start tick
          </button>
          <button className="button" disabled={busy || !state.tickRunning} onClick={() => void run('Stopping tick', stopTick)}>
            Stop tick
          </button>
          <button className="button quiet" disabled={busy} onClick={() => void run('Refreshing', refresh)}>
            Refresh
          </button>
        </div>
        {state.needsUserGrant ? (
          <button className="button primary" disabled={busy} onClick={() => void run('Granting vault permission', grantStoredVault)}>
            Grant stored vault
          </button>
        ) : null}
      </section>

      <section className="panel">
        <h2>Last write</h2>
        <dl className="summary">
          <div>
            <dt>SW started</dt>
            <dd>{state.swStartedAt || 'n/a'}</dd>
          </div>
          <div>
            <dt>Run log</dt>
            <dd>{state.observationPath}</dd>
          </div>
          <div>
            <dt>Event log</dt>
            <dd>{state.lastEventPath ?? '_BAC/events/<YYYY-MM-DD>.jsonl'}</dd>
          </div>
          <div>
            <dt>Tick count</dt>
            <dd>{state.tickSequence}</dd>
          </div>
          <div>
            <dt>Latency</dt>
            <dd>{state.lastWrite ? `${state.lastWrite.latencyMs} ms` : 'n/a'}</dd>
          </div>
          <div>
            <dt>Outcome</dt>
            <dd>{state.lastWrite ? (state.lastWrite.ok ? 'ok' : state.lastWrite.error) : state.lastError ?? 'n/a'}</dd>
          </div>
        </dl>
      </section>
    </main>
  );
}
