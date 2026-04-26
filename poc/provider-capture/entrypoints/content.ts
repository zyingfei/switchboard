import { defineContentScript } from 'wxt/utils/define-content-script';
import { captureVisibleConversation } from '../src/capture/extractors';
import { providerMessages, type ProviderResponse } from '../src/shared/messages';

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
    const canaryLoadId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const canaryRetryDelays = [1_200, 3_200, 6_000];

    const createCapture = () =>
      captureVisibleConversation(document, {
        url: window.location.href,
        title: document.title,
      });

    if (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost') {
      document.documentElement.setAttribute('data-bac-provider-capture', 'ready');
      const dispatchResult = (type: string, detail: unknown) => {
        window.dispatchEvent(new CustomEvent(type, { detail }));
      };

      window.addEventListener('bac-provider-capture-request', () => {
        void (async () => {
          try {
            const capture = createCapture();
            const response = (await chrome.runtime.sendMessage({
              type: providerMessages.storeCapture,
              capture,
            })) as ProviderResponse;
            dispatchResult('bac-provider-capture-result', response);
          } catch (error) {
            dispatchResult('bac-provider-capture-result', {
              ok: false,
              error: error instanceof Error ? error.message : 'Bridge capture failed.',
            });
          }
        })();
      });

      window.addEventListener('bac-provider-state-request', () => {
        void (async () => {
          const response = (await chrome.runtime.sendMessage({
            type: providerMessages.getState,
          })) as ProviderResponse;
          dispatchResult('bac-provider-state-result', response);
        })();
      });

      window.addEventListener('bac-provider-reset-request', () => {
        void (async () => {
          const response = (await chrome.runtime.sendMessage({
            type: providerMessages.reset,
          })) as ProviderResponse;
          dispatchResult('bac-provider-reset-result', response);
        })();
      });
    }

    const reportSelectorCanary = (attempt: number) => {
      try {
        const capture = createCapture();
        document.documentElement.setAttribute('data-bac-provider-canary', capture.selectorCanary);
        void chrome.runtime.sendMessage({
          type: providerMessages.reportSelectorCanary,
          report: {
            provider: capture.provider,
            url: capture.url,
            title: capture.title,
            selectorCanary: capture.selectorCanary,
            checkedAt: capture.capturedAt,
            loadId: canaryLoadId,
          },
        });

        const shouldRetry =
          (capture.provider === 'chatgpt' || capture.provider === 'claude' || capture.provider === 'gemini') &&
          capture.selectorCanary !== 'passed' &&
          attempt < canaryRetryDelays.length - 1;
        if (shouldRetry) {
          window.setTimeout(() => reportSelectorCanary(attempt + 1), canaryRetryDelays[attempt + 1] - canaryRetryDelays[attempt]);
        }
      } catch {
        document.documentElement.setAttribute('data-bac-provider-canary', 'failed');
        if (attempt < canaryRetryDelays.length - 1) {
          window.setTimeout(() => reportSelectorCanary(attempt + 1), canaryRetryDelays[attempt + 1] - canaryRetryDelays[attempt]);
        }
      }
    };

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse: (response: ProviderResponse) => void) => {
      if (message?.type !== providerMessages.captureVisibleThread) {
        return undefined;
      }

      try {
        sendResponse({
          ok: true,
          capture: createCapture(),
        });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : 'Visible conversation capture failed.',
        });
      }
      return true;
    });

    window.setTimeout(() => reportSelectorCanary(0), canaryRetryDelays[0]);
  },
});
