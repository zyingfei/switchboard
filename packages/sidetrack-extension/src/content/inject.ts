export const safeSendRuntimeMessage = (message: unknown): void => {
  if (typeof chrome === 'undefined' || chrome.runtime?.sendMessage === undefined) {
    return;
  }
  chrome.runtime.sendMessage(message).catch(() => undefined);
};
