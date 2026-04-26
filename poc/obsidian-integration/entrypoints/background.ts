import { defineBackground } from 'wxt/utils/define-background';
import { createObsidianCoordinator } from '../src/background/coordinator';
import { createMessageRouter } from '../src/background/messageRouter';

export default defineBackground(() => {
  const routeMessage = createMessageRouter(createObsidianCoordinator());

  chrome.runtime.onInstalled.addListener(() => {
    void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
  });

  chrome.runtime.onMessage.addListener(routeMessage);

  return { name: 'bac-obsidian-integration-poc-background' };
});
