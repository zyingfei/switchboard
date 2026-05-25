export const safeSendRuntimeMessage = (message: unknown): void => {
  if (typeof chrome === 'undefined' || chrome.runtime?.sendMessage === undefined) {
    return;
  }
  // After extension reload, content scripts still execute (the page
  // kept its DOM/timers) but `chrome.runtime.id` becomes undefined
  // and `chrome.runtime.sendMessage(...)` throws synchronously with
  // "Extension context invalidated." The `.catch()` only handles
  // promise rejections; the sync throw bubbles up and shows in
  // chrome://extensions errors. Guard with both the id check and a
  // try/catch.
  if (chrome.runtime.id === undefined) return;
  try {
    chrome.runtime.sendMessage(message).catch(() => undefined);
  } catch {
    // Extension context invalidated mid-call — content script will be
    // re-injected on the next page load; nothing useful to do here.
  }
};
