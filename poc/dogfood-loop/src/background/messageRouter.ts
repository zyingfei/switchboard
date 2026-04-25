import type { WorkflowCoordinator } from './coordinator';
import { isPocRequest, type PocResponse } from '../shared/messages';

export const createMessageRouter =
  (coordinator: WorkflowCoordinator) =>
  (
    message: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: PocResponse) => void,
  ): boolean => {
    if (!isPocRequest(message)) {
      return false;
    }

    void (async () => {
      try {
        if (message.type === 'MOCK_CHAT_TURN' || message.type === 'MOCK_CHAT_DONE') {
          await coordinator.recordMockChatMessage(message);
          sendResponse({ status: 'ok' });
          return;
        }
        if (message.type === 'POC_GET_STATE') {
          sendResponse({ status: 'ok', state: await coordinator.getState() });
          return;
        }
        if (message.type === 'POC_SAVE_NOTE') {
          sendResponse({ status: 'ok', state: await coordinator.saveNote(message.content) });
          return;
        }
        if (message.type === 'POC_FORK') {
          sendResponse({
            status: 'ok',
            state: await coordinator.forkToProviders(message.providers, message.noteContent, message.autoSend),
          });
          return;
        }
        if (message.type === 'POC_OPEN_THREAD_FIXTURES') {
          sendResponse({ status: 'ok', state: await coordinator.openThreadFixtures() });
          return;
        }
        if (message.type === 'POC_REFRESH_THREAD_REGISTRY') {
          sendResponse({ status: 'ok', state: await coordinator.refreshThreadRegistry() });
          return;
        }
        if (message.type === 'POC_ADOPT_ACTIVE_TAB') {
          sendResponse({ status: 'ok', state: await coordinator.adoptActiveTab() });
          return;
        }
        if (message.type === 'POC_BUILD_VAULT_PROJECTION') {
          sendResponse({ status: 'ok', state: await coordinator.buildVaultProjection() });
          return;
        }
        if (message.type === 'POC_BUILD_CONTEXT_PACK') {
          sendResponse({ status: 'ok', state: await coordinator.buildContextPack() });
          return;
        }
        if (message.type === 'POC_CHECK_DEJA_VU') {
          sendResponse({ status: 'ok', state: await coordinator.checkDejaVu(message.probeText) });
          return;
        }
        if (message.type === 'POC_MCP_SMOKE') {
          sendResponse({ status: 'ok', state: await coordinator.runMcpSmoke() });
          return;
        }
        if (message.type === 'POC_BUILD_PATCH') {
          sendResponse({ status: 'ok', state: await coordinator.buildPatch(message.mode) });
          return;
        }
        if (message.type === 'POC_ACCEPT_PATCH') {
          sendResponse({ status: 'ok', state: await coordinator.acceptPatch() });
          return;
        }
        if (message.type === 'POC_REJECT_PATCH') {
          sendResponse({ status: 'ok', state: await coordinator.rejectPatch() });
          return;
        }
        if (message.type === 'POC_FOCUS_TAB') {
          await coordinator.focusTab(message.tabId);
          sendResponse({ status: 'ok' });
          return;
        }
        if (message.type === 'POC_RESET') {
          sendResponse({ status: 'ok', state: await coordinator.reset() });
          return;
        }
        sendResponse({ status: 'error', reason: 'Unknown POC message' });
      } catch (error) {
        sendResponse({
          status: 'error',
          reason: error instanceof Error ? error.message : 'Unknown background error',
        });
      }
    })();

    return true;
  };
