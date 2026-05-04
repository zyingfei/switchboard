// Pure orchestrator for the §24.10 auto-send drain. Takes injected
// ports for everything that touches chrome.* / network so it can be
// unit-tested without a browser. Background.ts wires real
// implementations; tests wire fakes.
//
// Flow per item:
//   1. evaluateAutoSendPreflight against the four ship-blocking gates
//      (toggle, provider opt-in, screen-share-safe, token budget).
//   2. Resolve the chat tab (snapshot tabId → URL match fallback).
//   3. Send the wrapped text to the content script; await its
//      ok / error response.
//   4. On success: status='done', lastError cleared.
//      On failure: lastError set, drain stops on first failure.
//
// The drain stops on the first failure intentionally — the next
// items would likely hit the same gate and shipping them all into
// the chat with the same error doesn't help anyone.

import { evaluateAutoSendPreflight, type PreflightBlockedReason } from '../safety/preflight';
import type { ProviderId } from './model';

export interface DrainQueueItem {
  readonly bac_id: string;
  readonly text: string;
  readonly status: 'pending' | 'done' | 'dismissed';
  readonly targetId?: string;
  readonly createdAt: string;
  readonly sortOrder?: number;
}

const compareQueueItems = (a: DrainQueueItem, b: DrainQueueItem): number => {
  if (a.sortOrder !== undefined && b.sortOrder !== undefined) {
    return a.sortOrder - b.sortOrder;
  }
  if (a.sortOrder !== undefined) return -1;
  if (b.sortOrder !== undefined) return 1;
  return a.createdAt.localeCompare(b.createdAt);
};

export interface DrainThread {
  readonly bac_id: string;
  readonly provider: ProviderId;
  readonly threadUrl: string;
  readonly autoSendEnabled?: boolean;
}

export interface DrainCompanionConfig {
  readonly autoSendOptIn: {
    readonly chatgpt: boolean;
    readonly claude: boolean;
    readonly gemini: boolean;
  };
  readonly screenShareSafeMode: boolean;
}

export interface DrainTabLookup {
  readonly tabId?: number;
  readonly reason?: string;
}

export interface DrainSendResult {
  readonly ok: boolean;
  readonly error?: string;
}

export interface DrainItemUpdate {
  readonly status?: 'pending' | 'done';
  // null = clear the field, string = set, undefined = leave alone.
  readonly lastError?: string | null;
  // null = clear the field, value = set, undefined = leave alone.
  readonly progress?: 'typing' | 'waiting' | null;
}

export interface DrainPorts {
  readonly readThread: (threadId: string) => Promise<DrainThread | undefined>;
  readonly readPendingItemsForThread: (threadId: string) => Promise<readonly DrainQueueItem[]>;
  readonly readCompanionConfig: () => Promise<DrainCompanionConfig>;
  readonly findTabForThread: (thread: DrainThread) => Promise<DrainTabLookup>;
  readonly sendItemToTab: (tabId: number, text: string, itemId: string) => Promise<DrainSendResult>;
  readonly updateQueueItem: (itemId: string, update: DrainItemUpdate) => Promise<void>;
  readonly logWarning?: (message: string) => void;
}

// Default fallback when the companion isn't configured: per-thread
// toggle is the consent. Exported so callers can build the same
// shape without re-declaring it.
export const DEFAULT_LOCAL_CONFIG: DrainCompanionConfig = {
  autoSendOptIn: { chatgpt: true, claude: true, gemini: true },
  screenShareSafeMode: false,
};

export const preflightReasonText = (reason: PreflightBlockedReason): string => {
  switch (reason) {
    case 'thread-toggle-off':
      return 'Auto-send is off for this thread.';
    case 'provider-opt-out':
      return 'This provider is not opted in for auto-send (Settings → Auto-send).';
    case 'screen-share-safe':
      return 'Screen-share-safe mode is on; auto-send is paused.';
    case 'token-budget':
      return 'This item exceeds the auto-send token budget.';
    case 'unsupported-provider':
      return 'Auto-send does not support this provider.';
  }
};

export interface DrainOutcome {
  // True when at least one queue item was mutated (status changed
  // or lastError set/cleared). Caller broadcasts a workboard refresh
  // when this is true.
  readonly mutated: boolean;
  // For introspection / tests. Populated even on no-op runs.
  readonly itemsConsidered: number;
  readonly itemsSent: number;
  readonly stoppedReason?:
    | 'thread-off'
    | 'no-pending'
    | 'preflight'
    | 'no-tab'
    | 'send-failed'
    | 'completed';
}

export const runAutoSendDrain = async (
  threadId: string,
  ports: DrainPorts,
): Promise<DrainOutcome> => {
  const log = (message: string) => ports.logWarning?.(message);

  const thread = await ports.readThread(threadId);
  if (thread?.autoSendEnabled !== true) {
    return { mutated: false, itemsConsidered: 0, itemsSent: 0, stoppedReason: 'thread-off' };
  }

  const config = await ports.readCompanionConfig();
  const tabLookup = await ports.findTabForThread(thread);

  const pending = (await ports.readPendingItemsForThread(threadId))
    .filter((item) => item.status === 'pending')
    .slice()
    .sort(compareQueueItems);

  if (pending.length === 0) {
    return { mutated: false, itemsConsidered: 0, itemsSent: 0, stoppedReason: 'no-pending' };
  }

  let mutated = false;
  let sent = 0;

  for (const item of pending) {
    const verdict = evaluateAutoSendPreflight({
      text: item.text,
      provider: thread.provider,
      threadAutoSendEnabled: true,
      autoSendOptIn: config.autoSendOptIn,
      screenShareSafeMode: config.screenShareSafeMode,
    });
    if (!verdict.ok) {
      const reason = preflightReasonText(verdict.blockedBy ?? 'unsupported-provider');
      log(`[autoSend] preflight blocked for ${item.bac_id}: ${reason}`);
      await ports.updateQueueItem(item.bac_id, { lastError: reason, progress: null });
      return {
        mutated: true,
        itemsConsidered: pending.length,
        itemsSent: sent,
        stoppedReason: 'preflight',
      };
    }
    if (tabLookup.tabId === undefined) {
      const reason = tabLookup.reason ?? 'No chat tab is open for this thread.';
      log(`[autoSend] ${reason} (${thread.threadUrl})`);
      await ports.updateQueueItem(item.bac_id, { lastError: reason, progress: null });
      return {
        mutated: true,
        itemsConsidered: pending.length,
        itemsSent: sent,
        stoppedReason: 'no-tab',
      };
    }
    await ports.updateQueueItem(item.bac_id, { progress: 'typing', lastError: null });
    mutated = true;
    const result = await ports.sendItemToTab(tabLookup.tabId, verdict.text, item.bac_id);
    if (!result.ok) {
      const reason = result.error ?? 'Content script send failed.';
      log(`[autoSend] send failed for ${item.bac_id}: ${reason}`);
      await ports.updateQueueItem(item.bac_id, { lastError: reason, progress: null });
      return {
        mutated: true,
        itemsConsidered: pending.length,
        itemsSent: sent,
        stoppedReason: 'send-failed',
      };
    }
    await ports.updateQueueItem(item.bac_id, { status: 'done', lastError: null, progress: null });
    mutated = true;
    sent += 1;
  }
  return {
    mutated,
    itemsConsidered: pending.length,
    itemsSent: sent,
    stoppedReason: 'completed',
  };
};
