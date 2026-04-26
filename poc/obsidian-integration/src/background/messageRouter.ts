import type { ObsidianCoordinator } from './coordinator';
import { isObsidianPocRequest, type ObsidianPocResponse } from '../shared/messages';

export const createMessageRouter =
  (coordinator: ObsidianCoordinator) =>
  (
    message: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: ObsidianPocResponse) => void,
  ): boolean => {
    if (!isObsidianPocRequest(message)) {
      return false;
    }

    void (async () => {
      try {
        if (message.type === 'OBSIDIAN_GET_STATE') {
          sendResponse({ status: 'ok', state: await coordinator.getState() });
          return;
        }
        if (message.type === 'OBSIDIAN_CONNECT') {
          sendResponse({ status: 'ok', state: await coordinator.connect(message.connection) });
          return;
        }
        if (message.type === 'OBSIDIAN_RUN_THIN_SLICE') {
          sendResponse({ status: 'ok', state: await coordinator.runThinSlice(message.connection) });
          return;
        }
        if (message.type === 'OBSIDIAN_RESET') {
          sendResponse({ status: 'ok', state: await coordinator.reset() });
          return;
        }
        sendResponse({ status: 'error', reason: 'Unknown Obsidian POC message' });
      } catch (error) {
        sendResponse({
          status: 'error',
          reason: error instanceof Error ? error.message : 'Unknown background error',
        });
      }
    })();

    return true;
  };
