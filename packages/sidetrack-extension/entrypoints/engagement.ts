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

export const startEngagementTracking = (): void => {
  const visitId = engagementVisitIdForLocation(window.location);
  const aggregator = createEngagementAggregator({
    visitId,
    now: () => Date.now(),
    visible: isDocumentVisible(document),
    focused: isWindowFocused(document),
  });

  let finalized = false;
  const emit = (final: boolean): void => {
    if (finalized && final) return;
    if (final) finalized = true;
    safeSendRuntimeMessage(aggregator.snapshot(final));
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
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
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
  });

  window.setInterval(() => {
    emit(false);
  }, SUB_EMIT_MS);
};

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  registration: 'runtime',
  main() {
    startEngagementTracking();
  },
});
