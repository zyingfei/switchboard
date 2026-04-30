import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_LOCAL_CONFIG,
  preflightReasonText,
  runAutoSendDrain,
  type DrainPorts,
  type DrainQueueItem,
  type DrainThread,
  type DrainItemUpdate,
} from '../../src/companion/autoSendDrain';

const buildThread = (overrides: Partial<DrainThread> = {}): DrainThread => ({
  bac_id: 'bac_thread_1',
  provider: 'gemini',
  threadUrl: 'https://gemini.google.com/app/abc',
  autoSendEnabled: true,
  ...overrides,
});

const buildItem = (overrides: Partial<DrainQueueItem> = {}): DrainQueueItem => ({
  bac_id: 'bac_q_1',
  text: 'hi back',
  status: 'pending',
  targetId: 'bac_thread_1',
  createdAt: '2026-04-29T12:00:00.000Z',
  ...overrides,
});

interface FakeDrainState {
  thread?: DrainThread;
  items: DrainQueueItem[];
  config: typeof DEFAULT_LOCAL_CONFIG;
  tabLookup: { tabId?: number; reason?: string };
  sendQueue: ({ ok: true } | { ok: false; error: string })[];
  updates: { itemId: string; update: DrainItemUpdate }[];
  warnings: string[];
}

const buildFakePorts = (state: FakeDrainState): DrainPorts => ({
  readThread: vi.fn(() => Promise.resolve(state.thread)),
  readPendingItemsForThread: vi.fn((threadId: string) =>
    Promise.resolve(state.items.filter((i) => i.targetId === threadId)),
  ),
  readCompanionConfig: vi.fn(() => Promise.resolve(state.config)),
  findTabForThread: vi.fn(() => Promise.resolve(state.tabLookup)),
  sendItemToTab: vi.fn(() => Promise.resolve(state.sendQueue.shift() ?? { ok: true })),
  updateQueueItem: vi.fn((itemId: string, update: DrainItemUpdate) => {
    state.updates.push({ itemId, update });
    // Reflect into items so subsequent reads see status=done.
    state.items = state.items.map((i) => {
      if (i.bac_id !== itemId) {
        return i;
      }
      return {
        ...i,
        status: update.status === 'done' ? 'done' : i.status,
      };
    });
    return Promise.resolve();
  }),
  logWarning: (msg) => state.warnings.push(msg),
});

const baseState = (overrides: Partial<FakeDrainState> = {}): FakeDrainState => ({
  thread: buildThread(),
  items: [],
  config: DEFAULT_LOCAL_CONFIG,
  tabLookup: { tabId: 42 },
  sendQueue: [],
  updates: [],
  warnings: [],
  ...overrides,
});

describe('runAutoSendDrain — gates', () => {
  it('returns thread-off when the thread does not exist', async () => {
    const state = baseState({ thread: undefined });
    const outcome = await runAutoSendDrain('bac_thread_missing', buildFakePorts(state));
    expect(outcome.mutated).toBe(false);
    expect(outcome.stoppedReason).toBe('thread-off');
    expect(state.updates).toEqual([]);
  });

  it('returns thread-off when autoSendEnabled is false', async () => {
    const state = baseState({
      thread: buildThread({ autoSendEnabled: false }),
      items: [buildItem()],
    });
    const outcome = await runAutoSendDrain('bac_thread_1', buildFakePorts(state));
    expect(outcome.mutated).toBe(false);
    expect(outcome.stoppedReason).toBe('thread-off');
    expect(state.updates).toEqual([]);
  });

  it('returns no-pending when there are no eligible items', async () => {
    const state = baseState({ items: [] });
    const outcome = await runAutoSendDrain('bac_thread_1', buildFakePorts(state));
    expect(outcome.mutated).toBe(false);
    expect(outcome.stoppedReason).toBe('no-pending');
  });

  it('skips items with status=done (already drained)', async () => {
    const state = baseState({
      items: [buildItem({ status: 'done' })],
    });
    const outcome = await runAutoSendDrain('bac_thread_1', buildFakePorts(state));
    expect(outcome.stoppedReason).toBe('no-pending');
  });
});

describe('runAutoSendDrain — preflight', () => {
  it('sets lastError + stops when provider is opted out', async () => {
    const state = baseState({
      items: [buildItem()],
      config: {
        autoSendOptIn: { chatgpt: true, claude: true, gemini: false },
        screenShareSafeMode: false,
      },
    });
    const ports = buildFakePorts(state);
    const outcome = await runAutoSendDrain('bac_thread_1', ports);
    expect(outcome.mutated).toBe(true);
    expect(outcome.stoppedReason).toBe('preflight');
    expect(outcome.itemsSent).toBe(0);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]?.update.lastError).toContain('not opted in');
    // Drain must NOT have called the sender.
    expect(ports.sendItemToTab).not.toHaveBeenCalled();
  });

  it('sets lastError + stops when screen-share-safe mode is on', async () => {
    const state = baseState({
      items: [buildItem()],
      config: {
        autoSendOptIn: DEFAULT_LOCAL_CONFIG.autoSendOptIn,
        screenShareSafeMode: true,
      },
    });
    const outcome = await runAutoSendDrain('bac_thread_1', buildFakePorts(state));
    expect(outcome.stoppedReason).toBe('preflight');
    expect(state.updates[0]?.update.lastError).toContain('Screen-share-safe');
  });
});

describe('runAutoSendDrain — tab resolution', () => {
  it('sets lastError + stops when no chat tab is open', async () => {
    const state = baseState({
      items: [buildItem()],
      tabLookup: { reason: 'Open the chat tab; auto-send needs the conversation visible to type into.' },
    });
    const ports = buildFakePorts(state);
    const outcome = await runAutoSendDrain('bac_thread_1', ports);
    expect(outcome.stoppedReason).toBe('no-tab');
    expect(state.updates[0]?.update.lastError).toContain('Open the chat tab');
    expect(ports.sendItemToTab).not.toHaveBeenCalled();
  });

  it('uses generic message if tabLookup.reason is missing', async () => {
    const state = baseState({
      items: [buildItem()],
      tabLookup: {},
    });
    const outcome = await runAutoSendDrain('bac_thread_1', buildFakePorts(state));
    expect(outcome.stoppedReason).toBe('no-tab');
    expect(state.updates[0]?.update.lastError).toContain('No chat tab is open');
  });
});

describe('runAutoSendDrain — content-script send', () => {
  it('marks done + clears lastError on success', async () => {
    const state = baseState({
      items: [buildItem()],
      sendQueue: [{ ok: true }],
    });
    const outcome = await runAutoSendDrain('bac_thread_1', buildFakePorts(state));
    expect(outcome.mutated).toBe(true);
    expect(outcome.itemsSent).toBe(1);
    expect(outcome.stoppedReason).toBe('completed');
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]?.update).toEqual({ status: 'done', lastError: null });
  });

  it('sets lastError + stops on content-script failure', async () => {
    const state = baseState({
      items: [buildItem()],
      sendQueue: [{ ok: false, error: 'AI did not finish responding within the timeout.' }],
    });
    const outcome = await runAutoSendDrain('bac_thread_1', buildFakePorts(state));
    expect(outcome.stoppedReason).toBe('send-failed');
    expect(state.updates[0]?.update.lastError).toContain('AI did not finish');
  });
});

describe('runAutoSendDrain — multi-item sequencing', () => {
  it('drains items in chronological order on the happy path', async () => {
    const state = baseState({
      items: [
        buildItem({ bac_id: 'q1', text: 'first', createdAt: '2026-04-29T12:00:00.000Z' }),
        buildItem({ bac_id: 'q2', text: 'second', createdAt: '2026-04-29T12:01:00.000Z' }),
        buildItem({ bac_id: 'q3', text: 'third', createdAt: '2026-04-29T12:02:00.000Z' }),
      ],
      sendQueue: [{ ok: true }, { ok: true }, { ok: true }],
    });
    const ports = buildFakePorts(state);
    const outcome = await runAutoSendDrain('bac_thread_1', ports);
    expect(outcome.itemsSent).toBe(3);
    expect(outcome.stoppedReason).toBe('completed');
    expect(state.updates.map((u) => u.itemId)).toEqual(['q1', 'q2', 'q3']);
  });

  it('processes oldest items first regardless of array order', async () => {
    const state = baseState({
      items: [
        buildItem({ bac_id: 'newer', text: 'new', createdAt: '2026-04-29T12:05:00.000Z' }),
        buildItem({ bac_id: 'older', text: 'old', createdAt: '2026-04-29T12:00:00.000Z' }),
      ],
      sendQueue: [{ ok: true }, { ok: true }],
    });
    const outcome = await runAutoSendDrain('bac_thread_1', buildFakePorts(state));
    expect(outcome.itemsSent).toBe(2);
    expect(state.updates.map((u) => u.itemId)).toEqual(['older', 'newer']);
  });

  it('stops mid-drain on first failure; later items left pending', async () => {
    const state = baseState({
      items: [
        buildItem({ bac_id: 'q1', createdAt: '2026-04-29T12:00:00.000Z' }),
        buildItem({ bac_id: 'q2', createdAt: '2026-04-29T12:01:00.000Z' }),
        buildItem({ bac_id: 'q3', createdAt: '2026-04-29T12:02:00.000Z' }),
      ],
      sendQueue: [
        { ok: true },
        { ok: false, error: 'Composer not found in DOM.' },
        { ok: true }, // never reached
      ],
    });
    const outcome = await runAutoSendDrain('bac_thread_1', buildFakePorts(state));
    expect(outcome.itemsSent).toBe(1);
    expect(outcome.stoppedReason).toBe('send-failed');
    expect(state.updates.map((u) => u.itemId)).toEqual(['q1', 'q2']);
    expect(state.updates[0]?.update).toEqual({ status: 'done', lastError: null });
    expect(state.updates[1]?.update.lastError).toContain('Composer not found');
    // q3 must NOT have been touched.
    expect(state.updates.find((u) => u.itemId === 'q3')).toBeUndefined();
  });
});

describe('preflightReasonText', () => {
  it('produces a user-readable line for each reason', () => {
    expect(preflightReasonText('thread-toggle-off')).toContain('Auto-send is off');
    expect(preflightReasonText('provider-opt-out')).toContain('not opted in');
    expect(preflightReasonText('screen-share-safe')).toContain('Screen-share-safe');
    expect(preflightReasonText('token-budget')).toContain('token budget');
    expect(preflightReasonText('unsupported-provider')).toContain('does not support');
  });
});
