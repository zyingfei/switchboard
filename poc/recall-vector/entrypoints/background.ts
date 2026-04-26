import { defineBackground } from 'wxt/utils/define-background';
import { createRecallCoordinator } from '../src/background/coordinator';
import { createMessageRouter } from '../src/background/messageRouter';

export default defineBackground(() => {
  const routeMessage = createMessageRouter(createRecallCoordinator());

  chrome.runtime.onInstalled.addListener(() => {
    void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
  });

  chrome.runtime.onMessage.addListener(routeMessage);

  return { name: 'bac-recall-vector-poc-background' };
});
