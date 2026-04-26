import { useEffect, useState } from 'react';

import {
  localBridgeMessages,
  sendLocalBridgeMessage,
  type BridgeSettings,
  type BridgeState,
  type TransportKind,
} from '../../src/shared/messages';

const initialState: BridgeState = {
  configured: false,
  connected: false,
  queueCount: 0,
  droppedCount: 0,
};

const readBridgeKey = async (handle: FileSystemDirectoryHandle): Promise<string> => {
  const bac = await handle.getDirectoryHandle('_BAC');
  const config = await bac.getDirectoryHandle('.config');
  const file = await config.getFileHandle('bridge.key');
  return (await (await file.getFile()).text()).trim();
};

const badgeText = (state: BridgeState): string => {
  if (!state.configured) {
    return 'Not configured';
  }
  if (state.connected) {
    return state.queueCount > 0 ? `Connected / queued ${state.queueCount}` : 'Connected';
  }
  return `Disconnected / queued ${state.queueCount}`;
};

export default function App() {
  const [state, setState] = useState<BridgeState>(initialState);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Ready');
  const [port, setPort] = useState('17875');
  const [transport, setTransport] = useState<TransportKind>('http');
  const [manualKey, setManualKey] = useState('');

  const apply = (okLabel: string, response: Awaited<ReturnType<typeof sendLocalBridgeMessage>>) => {
    setState(response.state);
    setStatus(response.ok ? okLabel : response.error);
  };

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

  const configure = async (key: string) => {
    const settings: BridgeSettings = {
      transport,
      port: Number.parseInt(port, 10),
      key: key || undefined,
    };
    const response = await sendLocalBridgeMessage({ type: localBridgeMessages.configure, settings });
    apply('Configured companion', response);
  };

  const pickVault = async () => {
    if (!window.showDirectoryPicker) {
      throw new Error('showDirectoryPicker() is unavailable in this browser context.');
    }
    const handle = await window.showDirectoryPicker({
      id: 'bac-local-bridge-vault',
      mode: 'read',
    });
    const key = await readBridgeKey(handle);
    setManualKey(key);
    await configure(key);
  };

  const configureManualKey = async () => {
    if (transport === 'http' && !manualKey.trim()) {
      throw new Error('Paste a bridge key first.');
    }
    await configure(manualKey.trim());
  };

  const simpleAction = async (
    type:
      | typeof localBridgeMessages.getState
      | typeof localBridgeMessages.writeTestEvent
      | typeof localBridgeMessages.startTick
      | typeof localBridgeMessages.stopTick
      | typeof localBridgeMessages.drainQueue,
    label: string,
  ) => {
    const response = await sendLocalBridgeMessage({ type });
    apply(label, response);
  };

  useEffect(() => {
    void simpleAction(localBridgeMessages.getState, 'Ready');
    const timer = window.setInterval(() => {
      void simpleAction(localBridgeMessages.getState, 'Ready').catch(() => undefined);
    }, 3_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Companion POC</p>
          <h1>Local Bridge</h1>
        </div>
        <span className={state.connected ? 'status good' : 'status warning'}>{badgeText(state)}</span>
      </header>

      <section className="panel">
        <div className="section-heading">
          <h2>Connection</h2>
          <span className="muted">{status}</span>
        </div>
        <label>
          Transport
          <select value={transport} onChange={(event) => setTransport(event.target.value as TransportKind)}>
            <option value="http">HTTP localhost</option>
            <option value="nativeMessaging">Native Messaging</option>
          </select>
        </label>
        <label>
          Port
          <input value={port} onChange={(event) => setPort(event.target.value)} />
        </label>
        <label>
          Bridge key
          <input value={manualKey} onChange={(event) => setManualKey(event.target.value)} />
        </label>
        <div className="actions">
          <button className="button primary" disabled={busy} onClick={() => void run('Reading bridge key', pickVault)}>
            Pick vault folder
          </button>
          <button className="button" disabled={busy} onClick={() => void run('Configuring key', configureManualKey)}>
            Use pasted key
          </button>
          <button className="button" disabled={busy} onClick={() => void run('Refreshing', () => simpleAction(localBridgeMessages.getState, 'Ready'))}>
            Refresh
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="section-heading">
          <h2>Controls</h2>
          <span className="muted">Queued {state.queueCount}</span>
        </div>
        <div className="actions">
          <button className="button" disabled={busy} onClick={() => void run('Writing event', () => simpleAction(localBridgeMessages.writeTestEvent, 'Synthetic event sent'))}>
            Write test event
          </button>
          <button className="button" disabled={busy} onClick={() => void run('Draining queue', () => simpleAction(localBridgeMessages.drainQueue, 'Queue drained'))}>
            Drain queue
          </button>
          <button className="button" disabled={busy || state.companion?.tickRunning} onClick={() => void run('Starting companion tick', () => simpleAction(localBridgeMessages.startTick, 'Companion tick started'))}>
            Start tick
          </button>
          <button className="button" disabled={busy || !state.companion?.tickRunning} onClick={() => void run('Stopping companion tick', () => simpleAction(localBridgeMessages.stopTick, 'Companion tick stopped'))}>
            Stop tick
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>State</h2>
        <dl className="summary">
          <div>
            <dt>Queue</dt>
            <dd>{state.queueCount} queued / {state.droppedCount} dropped</dd>
          </div>
          <div>
            <dt>Companion</dt>
            <dd>{state.connected ? `${state.companion?.transport} ${state.companion?.runId}` : state.lastError ?? 'offline'}</dd>
          </div>
          <div>
            <dt>Vault</dt>
            <dd>{state.companion?.vaultPath ?? 'n/a'}</dd>
          </div>
          <div>
            <dt>Tick</dt>
            <dd>{state.companion ? `${state.companion.tickRunning ? 'running' : 'stopped'} / ${state.companion.tickSequence}` : 'n/a'}</dd>
          </div>
          <div>
            <dt>Last write</dt>
            <dd>{state.companion?.lastWrite ? `${state.companion.lastWrite.ok ? 'ok' : 'error'} ${state.companion.lastWrite.latencyMs} ms` : state.lastAction ?? 'n/a'}</dd>
          </div>
        </dl>
      </section>
    </main>
  );
}
