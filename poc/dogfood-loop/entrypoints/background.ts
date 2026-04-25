import { defineBackground } from 'wxt/utils/define-background';
import { createWorkflowCoordinator } from '../src/background/coordinator';
import { createMessageRouter } from '../src/background/messageRouter';
import { createMockChatPortRegistry } from '../src/background/mockChatPorts';
import { createIndexedDbGraphStore } from '../src/graph/store';

export default defineBackground(() => {
  const store = createIndexedDbGraphStore();
  const mockChatPorts = createMockChatPortRegistry();
  const coordinator = createWorkflowCoordinator(store, {
    mockChatTransport: {
      async sendMessage(tabId, message) {
        return await mockChatPorts.sendMessage(tabId, message);
      },
      async getTab(tabId) {
        return await chrome.tabs.get(tabId);
      },
    },
  });
  const routeMessage = createMessageRouter(coordinator);

  chrome.runtime.onInstalled.addListener(() => {
    void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
  });

  chrome.runtime.onMessage.addListener(routeMessage);
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'mock-chat') {
      mockChatPorts.bind(port);
    }
  });

  return { name: 'browser-ai-companion-poc-background' };
});
