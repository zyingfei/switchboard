import { defineContentScript } from 'wxt/utils/define-content-script';

import { captureVisibleConversation } from '../src/capture/extractors';
import { isProviderThreadUrl } from '../src/capture/providerDetection';
import { messageTypes, type ContentRequest, type ContentResponse } from '../src/messages';

const isContentRequest = (value: unknown): value is ContentRequest =>
  typeof value === 'object' &&
  value !== null &&
  'type' in value &&
  value.type === messageTypes.captureVisibleThread;

export default defineContentScript({
  matches: [
    'https://chatgpt.com/*',
    'https://chat.openai.com/*',
    'https://claude.ai/*',
    'https://gemini.google.com/*',
    'http://127.0.0.1/*',
    'http://localhost/*',
  ],
  runAt: 'document_idle',
  main() {
    let lastCaptureSignature = '';
    let debounceTimer: number | undefined;

    const createCapture = () =>
      captureVisibleConversation(document, {
        url: window.location.href,
        title: document.title,
      });

    const captureSignature = (capture: ReturnType<typeof createCapture>): string => {
      const lastTurn = capture.turns.at(-1);
      return `${capture.provider}:${capture.threadUrl}:${String(capture.turns.length)}:${lastTurn?.role ?? ''}:${lastTurn?.text.slice(0, 120) ?? ''}`;
    };

    const sendAutoCapture = () => {
      try {
        const capture = createCapture();
        if (capture.provider === 'unknown' || capture.turns.length === 0) {
          return;
        }
        // Stricter gate: auto-capture only fires on the provider's
        // actual chat-thread URL shape (e.g. claude.ai/chat/<id>),
        // never on landing / settings / docs pages like claude.ai/code.
        if (!isProviderThreadUrl(capture.provider, capture.threadUrl)) {
          return;
        }
        const signature = captureSignature(capture);
        if (signature === lastCaptureSignature) {
          return;
        }
        lastCaptureSignature = signature;
        void chrome.runtime.sendMessage({
          type: messageTypes.autoCapture,
          capture,
        });
      } catch {
        document.documentElement.setAttribute('data-sidetrack-provider-canary', 'failed');
      }
    };

    const scheduleAutoCapture = () => {
      if (debounceTimer !== undefined) {
        window.clearTimeout(debounceTimer);
      }
      debounceTimer = window.setTimeout(sendAutoCapture, 2_500);
    };

    const reportSelectorCanary = () => {
      try {
        const capture = createCapture();
        document.documentElement.setAttribute(
          'data-sidetrack-provider-canary',
          capture.selectorCanary ?? 'failed',
        );
        // Only report the canary for actual chat-thread URLs. Non-chat
        // pages on a known provider host (claude.ai/code, chatgpt.com
        // landing, etc.) trivially fail extraction — surfacing that as
        // "selectors may have drifted" is a false alarm that masks real
        // drift on actual chat pages.
        if (
          capture.provider === 'unknown' ||
          !isProviderThreadUrl(capture.provider, capture.threadUrl)
        ) {
          return;
        }
        void chrome.runtime.sendMessage({
          type: messageTypes.selectorCanary,
          report: {
            provider: capture.provider,
            url: capture.threadUrl,
            title: capture.title ?? capture.threadUrl,
            selectorCanary: capture.selectorCanary ?? 'failed',
            checkedAt: capture.capturedAt,
          },
        });
      } catch {
        document.documentElement.setAttribute('data-sidetrack-provider-canary', 'failed');
      }
    };

    chrome.runtime.onMessage.addListener(
      (message: unknown, _sender, sendResponse: (response: ContentResponse) => void) => {
        if (!isContentRequest(message)) {
          return undefined;
        }

        try {
          sendResponse({ ok: true, capture: createCapture() });
        } catch (error) {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : 'Visible conversation capture failed.',
          });
        }
        return true;
      },
    );

    window.setTimeout(reportSelectorCanary, 1_200);
    window.setTimeout(sendAutoCapture, 3_000);
    new MutationObserver(scheduleAutoCapture).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  },
});
