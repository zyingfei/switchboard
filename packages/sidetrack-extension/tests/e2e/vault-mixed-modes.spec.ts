// Synthetic e2e for vault-mode transitions during a session.
// Companion HTTP mocked via Playwright route.fulfill so we can flip
// between "reachable" and "unreachable" mid-test.
//
// Three cases covered:
// 1. Local-only (no companion configured) — autoCapture lands locally,
//    no HTTP attempted, no queue growth.
// 2. Connected but unreachable — autoCapture queues to
//    sidetrack.captureQueue and ALSO writes the local thread row.
// 3. Reconnect — next captureCurrentTab triggers replayQueuedCaptures
//    which drains the queue.
import { expect, test, type BrowserContext, type Route } from '@playwright/test';

import { messageTypes } from '../../src/messages';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import {
  SETTINGS_KEY,
  THREADS_KEY,
  WORKSTREAMS_KEY,
  assertOk,
  seedAndOpenSidepanel,
} from './helpers/sidepanel';

const QUEUE_KEY = 'sidetrack.captureQueue';

const now = '2026-04-29T12:00:00.000Z';
const port = 17_373;
const bridgeKey = 'vault_mixed_bridge_key_012345678901234567890123456';
const threadUrl = 'https://claude.ai/chat/vault-mixed-thread';

const ws = (id: string, title: string) => ({
  bac_id: id,
  revision: `rev_${id}`,
  title,
  children: [] as string[],
  tags: [] as string[],
  checklist: [] as unknown[],
  privacy: 'shared' as const,
  updatedAt: now,
});

const turns = [
  { role: 'user' as const, text: 'plan the offline test', ordinal: 0, capturedAt: now },
  { role: 'assistant' as const, text: 'queue offline, drain online', ordinal: 1, capturedAt: now },
] as const;

const connectedSettings = {
  companion: { port, bridgeKey },
  autoTrack: false,
  siteToggles: { chatgpt: true, claude: true, gemini: true },
};

const fulfillJson = (route: Route, status: number, body: unknown): Promise<void> =>
  route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: `${JSON.stringify(body)}\n`,
  });

interface CompanionMock {
  reachable: boolean;
  appendEventCalls: number;
}

const attachToggleableMock = async (
  context: BrowserContext,
  state: CompanionMock,
): Promise<void> => {
  await context.route(`http://127.0.0.1:${String(port)}/v1/**`, async (route) => {
    if (!state.reachable) {
      await route.abort('failed');
      return;
    }
    const url = new URL(route.request().url());
    const auth = await route.request().headerValue('x-bac-bridge-key');
    if (auth !== bridgeKey) {
      await fulfillJson(route, 401, { detail: 'Bridge key invalid.' });
      return;
    }
    if (route.request().method() === 'GET' && url.pathname === '/v1/status') {
      await fulfillJson(route, 200, {
        data: { companion: 'running', vault: 'connected', requestId: 'mixed-status' },
      });
      return;
    }
    if (route.request().method() === 'POST' && url.pathname === '/v1/events') {
      state.appendEventCalls += 1;
      // parseMutationResult in src/companion/client.ts requires
      // bac_id + revision + requestId — all three must be strings or
      // the client throws and sendToCompanion's catch enqueues the
      // event into the replay queue.
      await fulfillJson(route, 200, {
        data: {
          revision: `rev_event_${String(state.appendEventCalls)}`,
          bac_id: `bac_event_${String(state.appendEventCalls)}`,
          requestId: `req_event_${String(state.appendEventCalls)}`,
        },
      });
      return;
    }
    if (route.request().method() === 'POST' && url.pathname === '/v1/threads') {
      await fulfillJson(route, 200, {
        data: {
          revision: `rev_thread_${String(state.appendEventCalls)}`,
          bac_id: `bac_thread_${String(state.appendEventCalls)}`,
          requestId: `req_thread_${String(state.appendEventCalls)}`,
        },
      });
      return;
    }
    if (route.request().method() === 'POST' && url.pathname === '/v1/reminders') {
      await fulfillJson(route, 200, {
        data: {
          revision: 'rev_reminder',
          bac_id: 'bac_reminder_x',
          requestId: `req_reminder_${String(state.appendEventCalls)}`,
        },
      });
      return;
    }
    if (route.request().method() === 'GET' && url.pathname === '/v1/settings') {
      await fulfillJson(route, 200, {
        data: {
          revision: 'rev_mixed_settings',
          autoSendOptIn: { chatgpt: false, claude: false, gemini: false },
          defaultPacketKind: 'research',
          defaultDispatchTarget: 'claude',
          screenShareSafeMode: false,
        },
      });
      return;
    }
    await fulfillJson(route, 404, {
      detail: `Unhandled mock route: ${route.request().method()} ${url.pathname}`,
    });
  });
};

test.describe('vault mixed modes (synthetic)', () => {
  test('local-only mode: autoCapture lands locally, no companion HTTP attempted', async () => {
    let runtime: ExtensionRuntime | undefined;
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const state: CompanionMock = { reachable: true, appendEventCalls: 0 };
      await attachToggleableMock(runtime.context, state);

      // No SETTINGS_KEY seeded → companion is local-only (bridgeKey empty).
      const page = await seedAndOpenSidepanel(runtime, {
        [WORKSTREAMS_KEY]: [ws('bac_ws_local', 'Local-only suite')],
        [THREADS_KEY]: [],
      });
      await page.getByRole('tab', { name: 'All threads' }).click();

      const response = await runtime.sendRuntimeMessage(page, {
        type: messageTypes.autoCapture,
        capture: {
          provider: 'claude',
          threadUrl,
          title: 'Vault local-only thread',
          capturedAt: now,
          turns,
        },
      });
      assertOk(response);

      // Thread row visible — capture landed locally.
      await expect(page.getByText('Vault local-only thread')).toBeVisible();

      // Queue stays empty (we never tried to POST).
      const queueLen = await page.evaluate(async (key) => {
        const all = await chrome.storage.local.get([key]);
        return ((all[key] ?? []) as unknown[]).length;
      }, QUEUE_KEY);
      expect(queueLen).toBe(0);

      // Most importantly: the companion route was never hit.
      expect(state.appendEventCalls).toBe(0);
    } finally {
      await runtime?.close();
    }
  });

  test('connected but unreachable: capture lands in BOTH local storage and the replay queue', async () => {
    let runtime: ExtensionRuntime | undefined;
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const state: CompanionMock = { reachable: false, appendEventCalls: 0 };
      await attachToggleableMock(runtime.context, state);

      const page = await seedAndOpenSidepanel(runtime, {
        [SETTINGS_KEY]: connectedSettings,
        [WORKSTREAMS_KEY]: [ws('bac_ws_mixed', 'Mixed mode suite')],
        [THREADS_KEY]: [],
      });
      await page.getByRole('tab', { name: 'All threads' }).click();

      // Companion is unreachable. Fire an autoCapture — the response
      // will have ok=false (assertCompanionReachable throws on the
      // route.abort) but the local-fallback inside storeCaptureEvent
      // still ran. Don't assertOk; assert on storage side-effects only
      // (the side panel is allowed to stay stale on a disconnected
      // capture — broadcastWorkboardChanged is skipped in that path).
      await runtime.sendRuntimeMessage(page, {
        type: messageTypes.autoCapture,
        capture: {
          provider: 'claude',
          threadUrl,
          title: 'Queued during outage',
          capturedAt: now,
          turns,
        },
      });

      // Local thread + queue both updated even though the UI didn't refresh.
      const offlineState = await page.evaluate(
        async (keys) => {
          const all = await chrome.storage.local.get(keys);
          const threads = (all['sidetrack.threads'] ?? []) as { title: string }[];
          const queue = (all['sidetrack.captureQueue'] ?? []) as { event: { title?: string } }[];
          return {
            threadTitles: threads.map((t) => t.title),
            queueLength: queue.length,
            queueTitles: queue.map((q) => q.event.title ?? '(none)'),
          };
        },
        ['sidetrack.threads', 'sidetrack.captureQueue'],
      );
      expect(offlineState.threadTitles).toContain('Queued during outage');
      expect(offlineState.queueLength).toBeGreaterThanOrEqual(1);
      expect(offlineState.queueTitles).toContain('Queued during outage');

    } finally {
      await runtime?.close();
    }
  });

  test('reconnect drains the queue: offline-queued capture POSTs to /v1/events on next online request', async () => {
    let runtime: ExtensionRuntime | undefined;
    try {
      runtime = await launchExtensionRuntime({ forceLocalProfile: true });
      const state: CompanionMock = { reachable: false, appendEventCalls: 0 };
      await attachToggleableMock(runtime.context, state);

      const page = await seedAndOpenSidepanel(runtime, {
        [SETTINGS_KEY]: connectedSettings,
        [WORKSTREAMS_KEY]: [ws('bac_ws_drain', 'Drain suite')],
        [THREADS_KEY]: [],
      });
      await page.getByRole('tab', { name: 'All threads' }).click();

      // Phase 1: offline. autoCapture lands in queue.
      await runtime.sendRuntimeMessage(page, {
        type: messageTypes.autoCapture,
        capture: {
          provider: 'claude',
          threadUrl,
          title: 'Queued during outage',
          capturedAt: now,
          turns,
        },
      });
      const phase1 = await page.evaluate(async (key) => {
        const all = await chrome.storage.local.get([key]);
        return ((all[key] ?? []) as unknown[]).length;
      }, QUEUE_KEY);
      expect(phase1).toBe(1);
      // No /v1/events POSTs while offline (route.abort'd).
      expect(state.appendEventCalls).toBe(0);

      // Phase 2: companion comes back online.
      state.reachable = true;

      // Trigger replayQueuedCaptures via getWorkboardState — the
      // simplest withCompanionStatus path that doesn't queue a NEW
      // capture (so we can isolate drain behaviour from store
      // behaviour).
      await runtime.sendRuntimeMessage(page, {
        type: messageTypes.getWorkboardState,
      });

      // Drain happened: at least 1 /v1/events POST fired (the queued
      // event), and the queue is now empty.
      await expect
        .poll(
          async () =>
            page.evaluate(async (key) => {
              const all = await chrome.storage.local.get([key]);
              return ((all[key] ?? []) as unknown[]).length;
            }, QUEUE_KEY),
          { timeout: 10_000 },
        )
        .toBe(0);
      expect(state.appendEventCalls).toBeGreaterThanOrEqual(1);
    } finally {
      await runtime?.close();
    }
  });
});
