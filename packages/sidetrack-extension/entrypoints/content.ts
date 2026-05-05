import { defineContentScript } from 'wxt/utils/define-content-script';

import { findAnchor, serializeAnchor } from '../src/annotation/anchors';
import { createAnnotationClient } from '../src/annotation/client';
import { captureVisibleConversation } from '../src/capture/extractors';
import { detectProviderFromUrl, isProviderThreadUrl } from '../src/capture/providerDetection';
import { providerConfigs } from '../src/capture/providerConfigs';
import {
  messageTypes,
  type ContentRequest,
  type ContentResponse,
  type RecallQueryResponse,
} from '../src/messages';
import {
  mountAnnotationOverlay,
  mountDejaVuPopover,
  mountReviewSelectionChip,
  type DejaVuItem,
  type RestoredAnchor,
} from '../src/contentOverlays';
import type { RankedItem } from '../src/companion/recallClient';

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
    composer: ['rich-textarea div.ql-editor[role="textbox"]', 'rich-textarea div.ql-editor'],
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
  itemId: string | undefined,
  text: string,
  perItemTimeoutMs: number,
): Promise<AutoSendResult> => {
  const provider = detectProviderFromUrl(window.location.href);
  if (provider === 'unknown') {
    return { ok: false, error: 'Not on a supported provider page.' };
  }
  if (provider === 'codex') {
    return { ok: false, error: 'Auto-send does not support Codex sessions yet.' };
  }
  // Composer presence — not URL shape — gates auto-send. The new-chat
  // landing page (e.g. https://gemini.google.com/app, the bare ChatGPT
  // root) shows a composer that becomes a thread on submit; the
  // dispatchAutoSendInNewTab flow relies on this. isProviderThreadUrl
  // is the right gate for *capture* (we don't want a "thread" record
  // for the landing page), not for typing.
  const driver = PROVIDER_DRIVERS[provider];
  // Wait up to 15s for the composer to mount. Provider SPAs hydrate
  // their editor (Quill / ProseMirror / Tiptap) lazily after the
  // first `tabs.onUpdated` complete event, especially on first load
  // of /app or a brand-new chat. Bailing immediately on a missing
  // composer was the root cause of dispatch-into-new-tab no-ops.
  await waitFor(() => findFirstElement(driver.composer) !== null, 15_000, 200);
  const composerEl = findFirstElement(driver.composer);
  if (!(composerEl instanceof HTMLElement)) {
    return { ok: false, error: 'Composer not found in DOM (timed out after 15s).' };
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
  const started = await waitFor(() => isStopButtonActive(driver), 5_000, 200);
  if (started && itemId !== undefined) {
    void chrome.runtime.sendMessage({
      type: messageTypes.autoSendInterimReport,
      itemId,
      phase: 'waiting',
    });
  }
  // Now wait for completion. The per-item timeout is the upper bound.
  const settled = await waitFor(() => !isStopButtonActive(driver), perItemTimeoutMs, 500);
  if (!settled) {
    return { ok: false, error: 'AI did not finish responding within the timeout.' };
  }
  return { ok: true };
};

interface AutoSendItemMessage {
  readonly type: typeof messageTypes.autoSendItem;
  readonly itemId?: string;
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

    // Live in-page annotation set. Initially populated from the
     // companion's persisted list on page load; appended to
     // optimistically when the user saves a new comment so the
     // margin marker shows up without requiring a page reload.
    const liveAnchors: RestoredAnchor[] = [];

    const restoreAnnotations = async (): Promise<void> => {
      try {
        const client = await createAnnotationClient();
        if (client === undefined) {
          return;
        }
        const annotations = await client.listAnnotationsForUrl(window.location.href);
        for (const annotation of annotations) {
          const range = findAnchor(document.documentElement, annotation.anchor);
          if (range !== null) {
            liveAnchors.push({ id: annotation.bac_id, rect: range.getBoundingClientRect() });
          }
        }
        if (liveAnchors.length > 0) {
          mountAnnotationOverlay(liveAnchors);
        }
      } catch {
        // Restore is best-effort and must never disturb the host page.
      }
    };

    const addLiveAnnotation = (id: string, range: Range): void => {
      // Optimistic mount: drop in the marker at the user's selection
      // immediately so they get visible feedback that their save took
      // effect. The companion's persisted record syncs on next page
      // load (mountAnnotationOverlay clears + re-renders).
      liveAnchors.push({ id, rect: range.getBoundingClientRect() });
      mountAnnotationOverlay(liveAnchors);
    };

    // Déjà-vu pop-on-highlight — debounced selection listener that
    // queries the companion's recall index and surfaces matching prior
    // threads above the selection. Soft-fails on every error path so
    // the host page stays unaffected.
    let dejaVuDebounceTimer: number | undefined;
    let dejaVuMounted: { close: () => void } | null = null;
    let reviewChipMounted: { close: () => void } | null = null;
    const dejaVuMutedUrls = new Set<string>();
    const DEJA_VU_MUTED_URLS_KEY = 'dejaVuMutedUrls';
    const SELECTION_MIN_CHARS = 18;

    const hydrateDejaVuMuteState = async (): Promise<void> => {
      try {
        const result = await chrome.storage.session.get({ [DEJA_VU_MUTED_URLS_KEY]: [] });
        const urls = result[DEJA_VU_MUTED_URLS_KEY];
        if (Array.isArray(urls)) {
          dejaVuMutedUrls.clear();
          for (const url of urls) {
            if (typeof url === 'string') {
              dejaVuMutedUrls.add(url);
            }
          }
        }
      } catch {
        // Session storage may be unavailable in tests; mute stays in-memory.
      }
    };

    const muteDejaVuForCurrentUrl = async (): Promise<void> => {
      dejaVuMutedUrls.add(window.location.href);
      try {
        await chrome.storage.session.set({
          [DEJA_VU_MUTED_URLS_KEY]: Array.from(dejaVuMutedUrls),
        });
      } catch {
        // In-memory mute still applies for this content-script instance.
      }
    };

    void hydrateDejaVuMuteState();

    const closeDejaVu = (): void => {
      dejaVuMounted?.close();
      dejaVuMounted = null;
    };

    const closeReviewChip = (): void => {
      reviewChipMounted?.close();
      reviewChipMounted = null;
    };

    // Selection-anchored review chip. Fires when the user highlights
    // text inside an extracted turn element (provider config's
    // directSources). The chip lets the user attach a comment that
    // gets staged into a per-thread review draft on the background
    // side, which the side panel surfaces and ultimately sends as a
    // follow-up. Selection on non-turn elements (sidebar, header,
    // composer) is ignored.
    const turnSelectorForCurrentProvider = (): string | null => {
      const provider = detectProviderFromUrl(window.location.href);
      if (provider === 'unknown') return null;
      const config = providerConfigs[provider];
      const direct = config.directSources.map((source) => source.selector).filter((s) => s.length > 0);
      if (direct.length === 0) return null;
      return direct.join(', ');
    };

    const selectionInsideTurn = (selection: Selection): boolean => {
      const turnSelector = turnSelectorForCurrentProvider();
      if (turnSelector === null) return false;
      const anchor = selection.anchorNode;
      if (anchor === null) return false;
      const element = anchor instanceof Element ? anchor : anchor.parentElement;
      if (element === null) return false;
      try {
        return element.closest(turnSelector) !== null;
      } catch {
        return false;
      }
    };

    const offerReviewChip = (selection: Selection, anchorRect: DOMRect): void => {
      const provider = detectProviderFromUrl(window.location.href);
      if (provider === 'unknown') return;
      if (!isProviderThreadUrl(provider, window.location.href)) return;
      const range = selection.getRangeAt(0);
      const quote = selection.toString();
      let serialized;
      try {
        serialized = serializeAnchor(range);
      } catch {
        return;
      }
      const threadUrl = window.location.href;
      closeReviewChip();
      reviewChipMounted = mountReviewSelectionChip({
        anchorRect,
        quote,
        onSave: async (comment) => {
          await chrome.runtime.sendMessage({
            type: messageTypes.appendReviewDraftSpan,
            threadUrl,
            anchor: serialized,
            quote,
            comment,
            capturedAt: new Date().toISOString(),
          });
          // Optimistic in-page marker — gives the user instant visual
          // confirmation their note saved without waiting for a page
          // reload. The id is local-only; on next page load the
          // companion's persisted annotation list takes over.
          addLiveAnnotation(`local-${String(Date.now())}`, range);
        },
        onDismiss: () => {
          reviewChipMounted = null;
        },
        onDejaVu: () => {
          reviewChipMounted = null;
          // Force the popover to mount even on empty results so the
          // user gets explicit "no matches" feedback when they
          // explicitly invoked Déjà-vu.
          void fetchDejaVu(quote.trim(), anchorRect, true);
        },
      });
    };

    const fetchDejaVu = async (
      text: string,
      anchorRect: DOMRect,
      // When `force` is true, always mount the popover (even on empty
      // results) so the user gets explicit "no matches" feedback.
      // The default automatic path stays implicit — only mounts on
      // hits — so we don't pop empty cards on every selection.
      force = false,
    ): Promise<void> => {
      if (!force && dejaVuMutedUrls.has(window.location.href)) return;
      try {
        // Route through the background SW. A direct fetch from this
        // content script to http://127.0.0.1 is silently blocked by
        // Chrome's mixed-content policy on HTTPS chat pages
        // (chatgpt.com, claude.ai, etc.) — even with host_permissions
        // — and the resulting "Failed to fetch" was caught by the
        // outer try/catch and rendered as an empty popover. The SW's
        // chrome-extension:// origin bypasses the block.
        const response: Omit<RecallQueryResponse, 'items'> & {
          readonly items: readonly RankedItem[];
        } = await chrome.runtime.sendMessage({
          type: messageTypes.recallQuery,
          q: text,
          limit: 5,
          currentUrl: window.location.href,
        });
        if (!response.ok) {
          // Surface the failure in the console so future regressions
          // are visible to anyone with devtools open. The popover
          // keeps showing the empty state — a noisy alert here would
          // be worse than silence.
          console.warn('[sidetrack] recall query failed:', response.error);
          if (!force) return;
        }
        const results = response.items;
        if (results.length === 0 && !force) return;
        closeDejaVu();
        dejaVuMounted = mountDejaVuPopover({
          items: results.map((r: RankedItem): DejaVuItem => ({
            id: r.id,
            title: r.title ?? `thread ${r.threadId.slice(0, 12)}`,
            snippet: r.snippet ?? '',
            score: r.score,
            relativeWhen: r.capturedAt,
            // Provider is derived from the matched thread's URL when
            // we have it (different chat → different provider chip);
            // we fall back to the current page's provider for legacy
            // results that don't carry a threadUrl yet.
            provider: detectProviderFromUrl(r.threadUrl ?? window.location.href),
            // Jump must go to the MATCHED thread, not the current
            // page. Setting threadUrl to window.location.href here
            // was a copy-paste leftover that made every Jump a no-op
            // (focus-in-side-panel for the page you're already on).
            ...(r.threadUrl === undefined ? {} : { threadUrl: r.threadUrl }),
            bacId: r.threadId,
          })),
          anchorRect,
          onJump: (item) => {
            if (item.threadUrl !== undefined) {
              void chrome.runtime.sendMessage({
                type: messageTypes.focusThreadInSidePanel,
                threadUrl: item.threadUrl,
                // Pass the matched thread's bac_id + title + last-seen
                // through to the side panel. Lets the focus handler
                // render a synthetic card for recall results that
                // aren't in the local thread cache yet (e.g. captured
                // on another device, vault-only).
                ...(item.bacId === undefined ? {} : { bacId: item.bacId }),
                title: item.title,
                lastSeenAt: item.relativeWhen,
              });
            }
            closeDejaVu();
          },
          onMute: () => {
            void muteDejaVuForCurrentUrl();
            closeDejaVu();
          },
          onDismiss: () => {
            dejaVuMounted = null;
          },
        });
      } catch {
        // Silent — recall is best-effort
      }
    };

    const onSelectionChange = (): void => {
      if (dejaVuDebounceTimer !== undefined) {
        window.clearTimeout(dejaVuDebounceTimer);
      }
      dejaVuDebounceTimer = window.setTimeout(() => {
        const selection = window.getSelection();
        if (selection === null || selection.rangeCount === 0) {
          return;
        }
        const text = selection.toString().trim();
        // Chip min: 3 chars (was 18). The 18-char floor was meant
        // to prevent the auto-fire popover from spamming on tiny
        // selections, but it also blocked the chip — so a user
        // selecting a single phrase couldn't even see "+ Comment"
        // or "Déjà-vu". The auto-fire popover keeps the higher
        // floor inside fetchDejaVu; the chip surfaces at 3+ chars.
        if (text.length < 3) {
          return;
        }
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;
        // Show the review-comment chip when the selection lives
        // inside an extracted turn (provider directSource selectors).
        // Déjà-vu still fires for non-turn selections (e.g. composer
        // drafts) so recall keeps working everywhere.
        if (selectionInsideTurn(selection)) {
          offerReviewChip(selection, rect);
        }
        // Auto-fire the popover only at the original min — the
        // explicit Déjà-vu chip works regardless.
        if (text.length >= SELECTION_MIN_CHARS) {
          void fetchDejaVu(text, rect);
        }
      }, 400);
    };

    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('mousedown', (event) => {
      // Click outside the popover dismisses it. Inside-pop clicks bubble
      // to the popover's own listeners (jump / close button).
      const target = event.target;
      if (target instanceof Element) {
        if (
          dejaVuMounted !== null &&
          target.closest('.sidetrack-deja-pop') === null
        ) {
          closeDejaVu();
        }
        if (
          reviewChipMounted !== null &&
          target.closest('.sidetrack-rv-chip, .sidetrack-rv-pop') === null
        ) {
          closeReviewChip();
        }
      }
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
        // Conversation may still be rendering — Gemini's Angular shell
        // can take >1.2s to mount user-query / model-response elements
        // on a fresh nav. Don't flag a transient zero-turn capture as
        // selector drift; the mutation observer will fire an auto-
        // capture once the DOM settles, recording an accurate canary.
        if (capture.turns.length === 0) {
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
              error:
                error instanceof Error ? error.message : 'Visible conversation capture failed.',
            });
          }
          return true;
        }
        if (isAutoSendItemMessage(message)) {
          const perItemTimeoutMs = message.perItemTimeoutMs ?? 90_000;
          driveAutoSend(message.itemId, message.text, perItemTimeoutMs)
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
    window.setTimeout(() => {
      void restoreAnnotations();
    }, 1_500);
    window.setTimeout(sendAutoCapture, 3_000);
    new MutationObserver(scheduleAutoCapture).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    // Note: an earlier iteration injected a Shadow-DOM floating
    // "↗ Sidetrack" button into the host page. The user preferred
    // a side-panel-side find icon instead — see
    // entrypoints/sidepanel/App.tsx for the new affordance. The
    // chat-side button is gone; messageTypes.focusThreadInSidePanel
    // stays in the wire protocol because the side panel reuses it
    // for its own internal focus broadcast.
  },
});
