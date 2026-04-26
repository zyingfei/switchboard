import { defineBackground } from 'wxt/utils/define-background';

import { createCompanionClient } from '../src/companion/client';
import { drainQueue, enqueueCapture, readDroppedCount, readQueue } from '../src/companion/queue';
import { loadSettings, publicSettings, saveSettings } from '../src/companion/status';
import {
  buildSyntheticEvent,
  isLocalBridgeRequest,
  localBridgeMessages,
  type BridgeSettings,
  type BridgeState,
  type CompanionStatus,
  type LocalBridgeResponse,
} from '../src/shared/messages';

let lastError: string | undefined;
let lastAction: string | undefined;

const readErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const checkCompanion = async (settings: BridgeSettings | null): Promise<CompanionStatus | undefined> => {
  if (!settings) {
    return undefined;
  }
  return await createCompanionClient(settings).status();
};

const readState = async (): Promise<BridgeState> => {
  const settings = await loadSettings();
  let queue = await readQueue();
  let companion: CompanionStatus | undefined;
  let connected = false;
  try {
    companion = await checkCompanion(settings);
    connected = companion !== undefined;
    if (connected) {
      lastError = undefined;
      if (settings && queue.length > 0) {
        await drainConfiguredQueue(settings);
        queue = await readQueue();
        companion = await checkCompanion(settings);
        lastAction = 'Auto-drained queue';
      }
    }
  } catch (error) {
    lastError = readErrorMessage(error);
  }
  return {
    configured: settings !== null,
    connected,
    queueCount: queue.length,
    droppedCount: await readDroppedCount(),
    settings: publicSettings(settings),
    companion,
    lastError,
    lastAction,
  };
};

const drainConfiguredQueue = async (settings: BridgeSettings): Promise<void> => {
  const client = createCompanionClient(settings);
  await drainQueue(async (event) => {
    await client.writeEvent(event);
  });
};

const enqueueAndDrain = async (): Promise<void> => {
  const settings = await loadSettings();
  const sequenceNumber = Date.now();
  await enqueueCapture(buildSyntheticEvent(sequenceNumber, 'manual'));
  if (!settings) {
    throw new Error('Companion is not configured yet.');
  }
  await drainConfiguredQueue(settings);
};

const runCompanionCommand = async (
  command: 'startTick' | 'stopTick',
): Promise<void> => {
  const settings = await loadSettings();
  if (!settings) {
    throw new Error('Companion is not configured yet.');
  }
  const client = createCompanionClient(settings);
  if (command === 'startTick') {
    await client.startTick();
    return;
  }
  await client.stopTick();
};

export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(() => {
    void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
  });

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse: (response: LocalBridgeResponse) => void) => {
    if (!isLocalBridgeRequest(message)) {
      return false;
    }

    void (async () => {
      try {
        if (message.type === localBridgeMessages.configure) {
          await saveSettings(message.settings);
          lastAction = 'Configured companion';
          const state = await readState();
          sendResponse({ ok: true, state });
          return;
        }
        if (message.type === localBridgeMessages.writeTestEvent) {
          await enqueueAndDrain();
          lastAction = 'Queued and drained synthetic event';
          const state = await readState();
          sendResponse({ ok: true, state });
          return;
        }
        if (message.type === localBridgeMessages.startTick) {
          await runCompanionCommand('startTick');
          lastAction = 'Started companion tick';
          const state = await readState();
          sendResponse({ ok: true, state });
          return;
        }
        if (message.type === localBridgeMessages.stopTick) {
          await runCompanionCommand('stopTick');
          lastAction = 'Stopped companion tick';
          const state = await readState();
          sendResponse({ ok: true, state });
          return;
        }
        if (message.type === localBridgeMessages.drainQueue) {
          const settings = await loadSettings();
          if (!settings) {
            throw new Error('Companion is not configured yet.');
          }
          await drainConfiguredQueue(settings);
          lastAction = 'Drained queue';
          const state = await readState();
          sendResponse({ ok: true, state });
          return;
        }
        const state = await readState();
        sendResponse({ ok: true, state });
      } catch (error) {
        lastError = readErrorMessage(error);
        const state = await readState();
        sendResponse({ ok: false, error: lastError, state });
      }
    })();

    return true;
  });

  return { name: 'bac-local-bridge-background' };
});
