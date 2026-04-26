import { defineBackground } from 'wxt/utils/define-background';

import { appendJsonLine, eventLogName, queryReadWritePermission, WRITE_STRATEGY } from '../src/vault/fsAccess';
import { loadVaultHandle } from '../src/vault/idb';
import { bridgeMessages, isBridgeRequest, type BridgeResponse, type BridgeState, type WriteOutcome } from '../src/shared/messages';
import { buildSyntheticEvent, compactTimestamp, readErrorMessage } from '../src/shared/jsonl';

const startedAt = new Date();
const runId = compactTimestamp(startedAt);
const observationPath = `_BAC/observations/run-${runId}.jsonl`;

let vaultHandle: FileSystemDirectoryHandle | null = null;
let permission: BridgeState['permission'] = 'unknown';
let needsUserGrant = false;
let lastError: string | undefined;
let lastEventPath: string | undefined;
let lastWrite: WriteOutcome | undefined;
let sequenceNumber = 0;
let tickTimer: ReturnType<typeof setInterval> | undefined;
let hydratePromise: Promise<void> | null = null;

const browserVersion = (): string => navigator.userAgent;

const serviceWorkerState = (): string => {
  const swGlobal = globalThis as typeof globalThis & { registration?: ServiceWorkerRegistration };
  const activeState = swGlobal.registration?.active?.state;
  return activeState ? `service-worker:${activeState}` : 'service-worker:unknown';
};

const readState = (): BridgeState => ({
  swStartedAt: startedAt.toISOString(),
  runId,
  hasVaultHandle: vaultHandle !== null,
  permission,
  needsUserGrant,
  tickRunning: tickTimer !== undefined,
  tickSequence: sequenceNumber,
  observationPath,
  lastEventPath,
  lastWrite,
  lastError,
});

const hydrateHandle = async (): Promise<void> => {
  vaultHandle = await loadVaultHandle();
  if (!vaultHandle) {
    permission = 'unknown';
    needsUserGrant = false;
    return;
  }
  permission = await queryReadWritePermission(vaultHandle);
  needsUserGrant = permission !== 'granted';
};

const ensureHydrated = async (): Promise<void> => {
  hydratePromise ??= hydrateHandle().finally(() => {
    hydratePromise = null;
  });
  await hydratePromise;
};

const ensureWritableHandle = async (): Promise<FileSystemDirectoryHandle> => {
  await ensureHydrated();
  if (!vaultHandle) {
    throw new Error('No vault folder has been picked yet.');
  }
  permission = await queryReadWritePermission(vaultHandle);
  needsUserGrant = permission !== 'granted';
  if (permission !== 'granted') {
    throw new Error(`Vault folder permission is ${permission}; re-grant from the side panel.`);
  }
  return vaultHandle;
};

const writeObservation = async (outcome: WriteOutcome): Promise<void> => {
  if (!vaultHandle || permission !== 'granted') {
    return;
  }
  await appendJsonLine(vaultHandle, ['_BAC', 'observations'], `run-${runId}.jsonl`, outcome);
};

const writeSyntheticEvent = async (source: 'manual' | 'tick'): Promise<BridgeResponse> => {
  const started = performance.now();
  const at = new Date().toISOString();
  let outcome: WriteOutcome;
  try {
    const handle = await ensureWritableHandle();
    sequenceNumber += 1;
    const event = buildSyntheticEvent(sequenceNumber, source);
    const result = await appendJsonLine(handle, ['_BAC', 'events'], eventLogName(), event);
    lastEventPath = result.path;
    outcome = {
      at,
      latencyMs: Math.round((performance.now() - started) * 100) / 100,
      ok: true,
      kind: 'event',
      path: result.path,
      browserVersion: browserVersion(),
      serviceWorkerState: serviceWorkerState(),
      writeStrategy: result.strategy,
    };
    lastError = undefined;
  } catch (error) {
    outcome = {
      at,
      latencyMs: Math.round((performance.now() - started) * 100) / 100,
      ok: false,
      kind: 'event',
      browserVersion: browserVersion(),
      serviceWorkerState: serviceWorkerState(),
      writeStrategy: WRITE_STRATEGY,
      error: readErrorMessage(error),
    };
    lastError = outcome.error;
  }

  lastWrite = outcome;
  try {
    await writeObservation(outcome);
  } catch (error) {
    lastError = `Observation write failed: ${readErrorMessage(error)}`;
  }

  return outcome.ok ? { ok: true, state: readState() } : { ok: false, error: outcome.error ?? 'Write failed', state: readState() };
};

const startTick = async (): Promise<BridgeResponse> => {
  await ensureWritableHandle();
  if (!tickTimer) {
    tickTimer = setInterval(() => {
      void writeSyntheticEvent('tick');
    }, 1_000);
  }
  return { ok: true, state: readState() };
};

const stopTick = (): BridgeResponse => {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = undefined;
  }
  return { ok: true, state: readState() };
};

export default defineBackground(() => {
  void ensureHydrated().catch((error: unknown) => {
    lastError = readErrorMessage(error);
  });

  chrome.runtime.onInstalled.addListener(() => {
    void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
  });

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse: (response: BridgeResponse) => void) => {
    if (!isBridgeRequest(message)) {
      return false;
    }

    void (async () => {
      try {
        if (message.type === bridgeMessages.handleUpdated) {
          await hydrateHandle();
          sendResponse({ ok: true, state: readState() });
          return;
        }
        if (message.type === bridgeMessages.writeTestEvent) {
          sendResponse(await writeSyntheticEvent('manual'));
          return;
        }
        if (message.type === bridgeMessages.startTick) {
          sendResponse(await startTick());
          return;
        }
        if (message.type === bridgeMessages.stopTick) {
          sendResponse(stopTick());
          return;
        }
        await ensureHydrated();
        sendResponse({ ok: true, state: readState() });
      } catch (error) {
        lastError = readErrorMessage(error);
        sendResponse({ ok: false, error: lastError, state: readState() });
      }
    })();

    return true;
  });

  return { name: 'bac-vault-bridge-background' };
});
