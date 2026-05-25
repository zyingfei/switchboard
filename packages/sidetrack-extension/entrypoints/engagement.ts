import { defineContentScript } from 'wxt/utils/define-content-script';

import { createEngagementAggregator } from '../src/content/engagement/aggregator';
import { attachCopyPasteLineage } from '../src/content/engagement/copy-paste';
import { scrollRatioForDocument, throttle } from '../src/content/engagement/scroll';
import {
  engagementVisitIdForLocation,
  isDocumentVisible,
  isWindowFocused,
} from '../src/content/engagement/visibility';
import { safeSendRuntimeMessage } from '../src/content/inject';

const SUB_EMIT_MS = 30_000;
const ATTENTION_GATE_EMIT_MS = 5_000;

export const startEngagementTracking = (): void => {
  const visitId = engagementVisitIdForLocation(window.location);
  const aggregator = createEngagementAggregator({
    visitId,
    now: () => Date.now(),
    visible: isDocumentVisible(document),
    focused: isWindowFocused(document),
  });

  let finalized = false;
  let attentionGateEmitted = false;
  const emit = (final: boolean): void => {
    if (finalized && final) return;
    if (final) finalized = true;
    safeSendRuntimeMessage(aggregator.snapshot(final));
  };
  const emitAttentionGateSnapshot = (): void => {
    if (finalized || attentionGateEmitted) return;
    const snapshot = aggregator.snapshot(false);
    const focusedWindowMs = snapshot.dimensions.engagement.focusedWindowMs;
    if (focusedWindowMs >= ATTENTION_GATE_EMIT_MS) {
      attentionGateEmitted = true;
      safeSendRuntimeMessage(snapshot);
      return;
    }
    window.setTimeout(
      emitAttentionGateSnapshot,
      Math.max(1_000, ATTENTION_GATE_EMIT_MS - focusedWindowMs),
    );
  };

  document.addEventListener('visibilitychange', () => {
    const visible = isDocumentVisible(document);
    aggregator.setVisible(visible);
    if (!visible) emit(true);
  });
  window.addEventListener('focus', () => {
    aggregator.setFocused(true);
  });
  window.addEventListener('blur', () => {
    aggregator.setFocused(false);
  });
  document.addEventListener(
    'scroll',
    throttle(() => {
      aggregator.recordScroll(scrollRatioForDocument(document));
    }, 1_000),
    { passive: true },
  );
  document.addEventListener('copy', () => {
    aggregator.recordCopy();
  });
  document.addEventListener('paste', () => {
    aggregator.recordPaste();
  });
  attachCopyPasteLineage({
    visitId,
    send: safeSendRuntimeMessage,
    location: window.location,
    selection: () => window.getSelection(),
  });
  window.addEventListener('pagehide', () => {
    emit(true);
  });
  window.addEventListener('beforeunload', () => {
    emit(true);
  });
  // Guard chrome.runtime.onMessage.addListener — when the extension
  // reloads, content scripts on existing tabs become orphaned. Any
  // touch of chrome.runtime can throw "Extension context invalidated".
  // try/catch + chrome.runtime.id presence check make startup
  // resilient. Subsequent uses are in safeSendRuntimeMessage which has
  // its own guard.
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.id !== undefined) {
      chrome.runtime.onMessage.addListener(
        (message: unknown, _sender, sendResponse) => {
          if (
            typeof message === 'object' &&
            message !== null &&
            (message as { type?: unknown }).type === 'sidetrack.engagement.idle'
          ) {
            aggregator.setIdle((message as { idle?: unknown }).idle === true);
            sendResponse({ ok: true });
            return undefined;
          }
          if (
            typeof message === 'object' &&
            message !== null &&
            (message as { type?: unknown }).type === 'sidetrack.engagement.force-finalize'
          ) {
            emit(true);
            sendResponse({ ok: true });
          }
          return undefined;
        },
      );
    }
  } catch {
    // Extension context invalidated mid-registration — drop the
    // listener. The script's emit() path uses safeSendRuntimeMessage
    // which has its own guard, so the periodic timer keeps firing
    // harmlessly.
  }

  window.setInterval(() => {
    emit(false);
  }, SUB_EMIT_MS);
  window.setTimeout(emitAttentionGateSnapshot, ATTENTION_GATE_EMIT_MS);
};

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  registration: 'runtime',
  main() {
    // Wrap so any sync throw from `startEngagementTracking` (e.g. an
    // "Extension context invalidated" thrown by `chrome.runtime` on
    // an orphaned content script) is swallowed locally instead of
    // bubbling up to WXT's content-script wrapper, which re-throws
    // and shows the error in chrome://extensions. The script's own
    // emit-via-safeSendRuntimeMessage path already no-ops on
    // invalidated context, so swallowing is correct: nothing useful
    // for the script to do once the SW is gone.
    try {
      startEngagementTracking();
    } catch {
      // intentional: orphaned context cannot recover here
    }
  },
});
