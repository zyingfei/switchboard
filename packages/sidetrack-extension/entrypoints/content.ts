import { defineContentScript } from 'wxt/utils/define-content-script';

import { captureVisibleConversation } from '../src/capture/extractors';
import { detectProviderFromUrl, isProviderThreadUrl } from '../src/capture/providerDetection';
import { messageTypes, type ContentRequest, type ContentResponse } from '../src/messages';

// Per-provider composer + send-button + AI-done selectors. Sourced
// from `tests/e2e/live-status-transitions.spec.ts` which proved each
// of these works against the real DOM. Keep in sync.
interface ProviderDriverConfig {
  readonly composer: readonly string[];
  // Click this to submit the typed message. Empty array → press Enter
  // on the composer instead.
  readonly sendButton: readonly string[];
  // While present-and-visible, the AI is still streaming. Drain
  // proceeds to the next item only after this disappears.
  readonly stopButton: readonly string[];
}

const PROVIDER_DRIVERS: Record<'chatgpt' | 'claude' | 'gemini', ProviderDriverConfig> = {
  chatgpt: {
    composer: ['div#prompt-textarea[role="textbox"]', '#prompt-textarea'],
    sendButton: [],
    stopButton: ['button[data-testid="stop-button"]', 'button[aria-label*="Stop" i]'],
  },
  claude: {
    composer: ['div[data-testid="chat-input"][role="textbox"]', 'div.tiptap.ProseMirror'],
    sendButton: [],
    stopButton: ['button[aria-label*="Stop" i]'],
  },
  gemini: {
    composer: [
      'rich-textarea div.ql-editor[role="textbox"]',
      'rich-textarea div.ql-editor',
    ],
    sendButton: ['button[aria-label*="Send message" i]', 'button.send-button'],
    stopButton: ['button[aria-label*="Stop" i]'],
  },
};

const findFirstElement = (selectors: readonly string[]): Element | null => {
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (element !== null) {
      return element;
    }
  }
  return null;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const waitFor = async (
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 250,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await sleep(intervalMs);
  }
  return false;
};

const isStopButtonActive = (driver: ProviderDriverConfig): boolean => {
  for (const selector of driver.stopButton) {
    const button = document.querySelector(selector);
    if (button !== null && (button as HTMLElement).offsetParent !== null) {
      return true;
    }
  }
  return false;
};

interface AutoSendResult {
  readonly ok: boolean;
  readonly error?: string;
}

const driveAutoSend = async (
  text: string,
  perItemTimeoutMs: number,
): Promise<AutoSendResult> => {
  const provider = detectProviderFromUrl(window.location.href);
  if (provider === 'unknown') {
    return { ok: false, error: 'Not on a supported provider page.' };
  }
  if (!isProviderThreadUrl(provider, window.location.href)) {
    return { ok: false, error: 'Current page is not a chat thread.' };
  }
  const driver = PROVIDER_DRIVERS[provider];
  const composerEl = findFirstElement(driver.composer);
  if (!(composerEl instanceof HTMLElement)) {
    return { ok: false, error: 'Composer not found in DOM.' };
  }
  const composer = composerEl;

  // Reject if the AI is still streaming a previous reply — caller
  // should retry after waiting.
  if (isStopButtonActive(driver)) {
    return { ok: false, error: 'AI is still responding to a previous message.' };
  }

  // Focus + paste via execCommand which is the most reliable way to
  // inject text into ProseMirror / Tiptap / Quill (direct
  // composer.textContent= fights the editor's own change tracking).
  composer.focus();
  await sleep(80);
  // execCommand is formally deprecated but it remains the only
  // reliable way to insert text into ProseMirror / Tiptap / Quill
  // editors so they fire their own input events and update internal
  // state. Direct .textContent or InputEvent dispatch fights the
  // editor's change tracking. Eslint warns; suppressing.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  document.execCommand('insertText', false, text);
  await sleep(120);

  // Submit. Most editors need an explicit Enter; Gemini etc. need a
  // button click because Enter inserts a newline.
  if (driver.sendButton.length > 0) {
    const sendButton = findFirstElement(driver.sendButton);
    if (!(sendButton instanceof HTMLElement)) {
      return { ok: false, error: 'Send button not found in DOM.' };
    }
    sendButton.click();
  } else {
    composer.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
  }

  // Wait for the AI to start responding (stop button appears) then
  // for it to finish (stop button disappears). The "started" check
  // has a short window — providers usually show the stop button
  // within ~1s of submit.
  await waitFor(() => isStopButtonActive(driver), 5_000, 200);
  // Now wait for completion. The per-item timeout is the upper bound.
  const settled = await waitFor(() => !isStopButtonActive(driver), perItemTimeoutMs, 500);
  if (!settled) {
    return { ok: false, error: 'AI did not finish responding within the timeout.' };
  }
  return { ok: true };
};

interface AutoSendItemMessage {
  readonly type: typeof messageTypes.autoSendItem;
  readonly text: string;
  readonly perItemTimeoutMs?: number;
}

const isAutoSendItemMessage = (value: unknown): value is AutoSendItemMessage =>
  typeof value === 'object' &&
  value !== null &&
  'type' in value &&
  value.type === messageTypes.autoSendItem &&
  'text' in value &&
  typeof (value as { text: unknown }).text === 'string';

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
      (
        message: unknown,
        _sender,
        sendResponse: (response: ContentResponse | AutoSendResult) => void,
      ) => {
        if (isContentRequest(message)) {
          try {
            sendResponse({ ok: true, capture: createCapture() });
          } catch (error) {
            sendResponse({
              ok: false,
              error: error instanceof Error ? error.message : 'Visible conversation capture failed.',
            });
          }
          return true;
        }
        if (isAutoSendItemMessage(message)) {
          const perItemTimeoutMs = message.perItemTimeoutMs ?? 90_000;
          driveAutoSend(message.text, perItemTimeoutMs)
            .then((result) => {
              sendResponse(result);
            })
            .catch((error: unknown) => {
              sendResponse({
                ok: false,
                error: error instanceof Error ? error.message : 'auto-send failed.',
              });
            });
          return true;
        }
        return undefined;
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
