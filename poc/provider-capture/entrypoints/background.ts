import { defineBackground } from 'wxt/utils/define-background';
import { captureActiveTab, createMessageRouter } from '../src/background/messageRouter';
import { openWorkspace } from '../src/background/workspace';
import { providerLabels } from '../src/capture/model';

export default defineBackground(() => {
  const syncActionBehavior = () =>
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => undefined);

  chrome.runtime.onInstalled.addListener(() => {
    void syncActionBehavior();
  });
  void syncActionBehavior();

  chrome.runtime.onMessage.addListener(createMessageRouter());
  chrome.action.onClicked.addListener(() => {
    void openWorkspace();
  });
  chrome.commands.onCommand.addListener((command) => {
    if (command !== 'capture-active-tab') {
      return;
    }

    void captureActiveTab().then(async (response) => {
      if (!response.ok || !('capture' in response) || !response.capture) {
        await chrome.action.setBadgeText({ text: 'ERR' });
        await chrome.action.setBadgeBackgroundColor({ color: '#a6422b' });
        return;
      }

      const label = providerLabels[response.capture.provider].slice(0, 4).toUpperCase();
      await chrome.action.setBadgeText({ text: label });
      await chrome.action.setBadgeBackgroundColor({ color: '#1b6a70' });
    });
  });

  return { name: 'bac-provider-capture-background' };
});
