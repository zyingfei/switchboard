import { defineContentScript } from 'wxt/utils/define-content-script';

// Pushes document.title changes to the SW the instant they happen.
//
// The timeline observer relies on `tab.title` to populate the
// projection's `latestTitle`, but stealth Chromium / patchright can
// silently block Chrome from propagating document.title changes into
// `tab.title`. The SW never sees the real title — the URL-shaped fake
// title sticks around in the Inbox + Current-tab card.
//
// Content scripts read `document.title` directly off the page DOM with
// no `chrome.tabs` round-trip. This script matches every http(s) page
// and reports the title on load + every subsequent change. It is
// intentionally tiny so it doesn't add noticeable load cost; the only
// thing it does is post a runtime message.

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  // run_at: document_end so document.title is parsed but the page
  // hasn't run its own JS yet. The MutationObserver picks up later
  // JS-driven title changes.
  runAt: 'document_end',
  main() {
    let lastTitle = '';
    const post = (title: string): void => {
      if (title.length === 0 || title === lastTitle) return;
      lastTitle = title;
      try {
        void chrome.runtime
          .sendMessage({
            type: 'sidetrack.timeline.titleObserved',
            url: window.location.href,
            title,
          })
          .catch(() => undefined);
      } catch {
        // Extension context invalidated (panel restart, etc.) — silent.
      }
    };

    // Initial pass — covers the common case where the page set its
    // title in <title> at parse time.
    post(document.title);

    // Catch later changes (SPAs, async title sets).
    const head = document.head ?? document.documentElement;
    const observer = new MutationObserver(() => {
      post(document.title);
    });
    observer.observe(head, { childList: true, subtree: true, characterData: true });

    // Belt-and-braces: poll for 30 s after load. Some pages set title
    // outside the <head> subtree (e.g. via direct `document.title =`
    // assignment from inline scripts) and the MutationObserver above
    // may miss them depending on where the assignment lands.
    let polls = 0;
    const intervalId = window.setInterval(() => {
      polls += 1;
      post(document.title);
      if (polls >= 30) {
        window.clearInterval(intervalId);
      }
    }, 1_000);
  },
});
