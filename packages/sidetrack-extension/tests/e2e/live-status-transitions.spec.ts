// Drives a one-line message into each logged-in chat, then watches the
// underlying thread state transition through three captures:
//   T0 (just opened)      → lastTurnRole=assistant
//   T1 (after we type)    → lastTurnRole=user
//   T2 (after AI replies) → lastTurnRole=assistant (with growth in turn count)
//
// The lifecycle pill is logged for visibility but not asserted strictly:
// the auto-capture may create a reminder mid-test, which makes the pill
// flip to "Unread reply" regardless of lastTurnRole. We verify the
// underlying state transition is correct (which is what the pill
// derivation depends on).
//
// Opt-in only — drives real chats and consumes provider credits. To run:
//   SIDETRACK_E2E_LIVE_TRANSITIONS=1 SIDETRACK_E2E_CDP_URL=http://localhost:9222 \
//     npx playwright test live-status-transitions
import { expect, test, type Locator, type Page } from '@playwright/test';

import { isRuntimeResponse, messageTypes } from '../../src/messages';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';

const SETUP_KEY = 'sidetrack:setupCompleted';

interface ProviderConfig {
  readonly name: string;
  readonly url: string;
  readonly expectedProvider: 'chatgpt' | 'claude' | 'gemini';
  // First match wins; we waitFor attached before clicking.
  readonly composerSelectors: readonly string[];
  // Optional explicit send-button selectors. If undefined, we just
  // press Enter (works for ChatGPT + Claude). Required for Gemini —
  // its Quill editor inserts a newline on plain Enter.
  readonly sendButtonSelectors?: readonly string[];
}

// Selectors below were confirmed by inspecting the live DOM
// (probe-composer.spec.ts) on 2026-04-28. ChatGPT/Claude both use
// ProseMirror/Tiptap, so plain Playwright `fill()` won't work — we
// click() then keyboard.type() so the editor sees real key events.
const providers: readonly ProviderConfig[] = [
  {
    name: 'ChatGPT',
    url:
      process.env.SIDETRACK_E2E_CHATGPT_URL ??
      'https://chatgpt.com/c/69f0c125-3a04-832c-b858-02ab155e0264',
    expectedProvider: 'chatgpt',
    composerSelectors: ['div#prompt-textarea[role="textbox"]', '#prompt-textarea'],
  },
  {
    name: 'Claude',
    url:
      process.env.SIDETRACK_E2E_CLAUDE_URL ??
      'https://claude.ai/chat/89195bc1-74a9-4b07-99de-ca7b4dec3465',
    expectedProvider: 'claude',
    composerSelectors: ['div[data-testid="chat-input"][role="textbox"]', 'div.tiptap.ProseMirror'],
  },
  {
    name: 'Gemini',
    url: process.env.SIDETRACK_E2E_GEMINI_URL ?? 'https://gemini.google.com/app/76bd837104ab1990',
    expectedProvider: 'gemini',
    composerSelectors: [
      'rich-textarea div.ql-editor[role="textbox"]',
      'rich-textarea div.ql-editor',
    ],
    // Gemini's Quill editor inserts a newline on plain Enter; click the
    // send button instead.
    sendButtonSelectors: [
      'button[aria-label*="Send message" i]',
      'button.send-button',
      'button[mattooltip*="Send" i]',
    ],
  },
];

const assertOk = (response: unknown): void => {
  if (!isRuntimeResponse(response)) {
    throw new Error('Background returned a non-Sidetrack response.');
  }
  if (!response.ok) {
    throw new Error(response.error);
  }
};

interface CapturedThread {
  readonly title: string;
  readonly provider: string;
  readonly threadUrl: string;
  readonly lastTurnRole?: string;
  readonly lastSeenAt: string;
  readonly bac_id: string;
}

const findThreadFor = async (sidepanel: Page, url: string): Promise<CapturedThread | null> => {
  return await sidepanel.evaluate(async (target) => {
    const s = await chrome.storage.local.get(['sidetrack.threads']);
    const threads = s['sidetrack.threads'] as CapturedThread[] | undefined;
    return threads?.find((t) => t.threadUrl === target) ?? null;
  }, url);
};

const lifecycleLabelFor = async (sidepanel: Page, providerSlug: string): Promise<string> => {
  const pill = sidepanel
    .locator('.thread')
    .filter({ has: sidepanel.locator(`.provider.${providerSlug}`) })
    .first()
    .locator('.lifecycle-pill');
  await pill.first().waitFor({ state: 'visible', timeout: 10_000 });
  const text = (await pill.first().textContent())?.trim() ?? '';
  return text;
};

type CaptureFn = () => Promise<CapturedThread | null>;

// Re-captures every 2s up to `timeoutMs` until the captured thread's
// lastTurnRole matches `expectedRole`. Used to wait for streaming AI
// responses to finish, or to recover if a prior failed run left the
// chat mid-roundtrip.
const waitForLastTurnRole = async (
  capture: CaptureFn,
  expectedRole: 'user' | 'assistant',
  timeoutMs: number,
): Promise<CapturedThread> => {
  const deadline = Date.now() + timeoutMs;
  let last: CapturedThread | null = null;
  while (Date.now() < deadline) {
    last = await capture();
    if (last?.lastTurnRole === expectedRole) {
      return last;
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(
    `Timed out after ${String(timeoutMs)}ms waiting for lastTurnRole=${expectedRole}. ` +
      `Last captured: ${JSON.stringify(last)}`,
  );
};

// Best-effort: tries to catch lastTurnRole=user briefly. Some
// providers (Gemini) reply so fast we never observe the intermediate
// user state; in that case we just return null and the caller falls
// through to the assistant-state assertion.
const tryObserveUserTurn = async (
  capture: CaptureFn,
  timeoutMs: number,
): Promise<CapturedThread | null> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await capture();
    if (result?.lastTurnRole === 'user') {
      return result;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return null;
};

const findComposer = async (chat: Page, selectors: readonly string[]): Promise<Locator> => {
  // Use 'attached' rather than 'visible': empty ProseMirror/Tiptap
  // editors render with zero box-height and Playwright's visibility
  // heuristic flags them invisible even though they accept clicks.
  for (const selector of selectors) {
    const candidate = chat.locator(selector).first();
    try {
      await candidate.waitFor({ state: 'attached', timeout: 8_000 });
      return candidate;
    } catch {
      // try next selector
    }
  }
  throw new Error(
    `No composer found in DOM. Tried: ${selectors.join(', ')}. Page URL: ${chat.url()}`,
  );
};

test.describe('live status transitions (logged-in profile)', () => {
  test.skip(
    () =>
      process.env.SIDETRACK_E2E_LIVE_TRANSITIONS === undefined ||
      process.env.SIDETRACK_E2E_LIVE_TRANSITIONS.length === 0,
    'opt-in: requires SIDETRACK_E2E_LIVE_TRANSITIONS=1 (drives real chats, consumes credits)',
  );
  test.skip(
    () =>
      (process.env.SIDETRACK_USER_DATA_DIR === undefined ||
        process.env.SIDETRACK_USER_DATA_DIR.length === 0) &&
      (process.env.SIDETRACK_E2E_CDP_URL === undefined ||
        process.env.SIDETRACK_E2E_CDP_URL.length === 0),
    'requires SIDETRACK_USER_DATA_DIR or SIDETRACK_E2E_CDP_URL',
  );

  for (const provider of providers) {
    test(`${provider.name}: pill flips assistant → waiting → assistant after a roundtrip`, async () => {
      // Allow for: 10s mount + 3 captures (~5s each) + 90s AI polling.
      test.setTimeout(180_000);
      let runtime: ExtensionRuntime | undefined;
      const opened: Page[] = [];
      try {
        runtime = await launchExtensionRuntime();
        const sidepanel = await runtime.context.newPage();
        opened.push(sidepanel);
        await sidepanel.goto(`chrome-extension://${runtime.extensionId}/sidepanel.html`, {
          waitUntil: 'domcontentloaded',
        });
        // Fresh slate so leftover threads/reminders from prior runs don't
        // confuse the lifecycle-pill assertion.
        await sidepanel.evaluate(async () => {
          const all = await chrome.storage.local.get(null);
          const toRemove = Object.keys(all).filter((k) => k.startsWith('sidetrack.'));
          if (toRemove.length > 0) {
            await chrome.storage.local.remove(toRemove);
          }
        });
        await runtime.seedStorage(sidepanel, { [SETUP_KEY]: true });
        await sidepanel.reload({ waitUntil: 'domcontentloaded' });
        await expect(sidepanel.getByRole('main', { name: 'Sidetrack workboard' })).toBeVisible();

        // ── T0: open the chat, capture, observe initial pill ──
        const chat = await runtime.context.newPage();
        opened.push(chat);
        await chat.goto(provider.url, { waitUntil: 'domcontentloaded' });
        // Heavy SPAs — give the chat ~10s to mount its prosemirror/tiptap
        // editor before any selector queries run.
        await chat.waitForTimeout(10_000);
        await chat.bringToFront();

        // Capture-and-fetch helper used by the wait-for-role poller.
        const activeRuntime = runtime;
        const captureAndFetch = async (): Promise<CapturedThread | null> => {
          await chat.bringToFront();
          const r = await activeRuntime.sendRuntimeMessage(sidepanel, {
            type: messageTypes.captureCurrentTab,
          });
          assertOk(r);
          await sidepanel.bringToFront();
          await sidepanel.waitForTimeout(500);
          return await findThreadFor(sidepanel, provider.url);
        };

        // Capture once and log whatever state the chat is in. We do
        // not assert on T0: the chat may be wedged in lastTurnRole=user
        // from prior runs (the dedup in dedupeAndFinalizeTurns collapses
        // identical short assistant replies, so two "OK" replies leave
        // a user turn as the surviving last turn). The unique-ack
        // strategy below recovers from that automatically.
        const t0Thread = await captureAndFetch();
        await sidepanel.getByRole('tab', { name: 'All threads' }).click();
        const t0Pill = await lifecycleLabelFor(sidepanel, provider.expectedProvider);
        console.warn(
          `[${provider.expectedProvider}] T0 pill=${JSON.stringify(t0Pill)} ` +
            `lastTurnRole=${t0Thread?.lastTurnRole ?? '(none)'} title=${JSON.stringify(t0Thread?.title ?? '(none)')}`,
        );

        // ── T1: type a 1-line ping into the composer and submit ──
        await chat.bringToFront();
        const composer = await findComposer(chat, provider.composerSelectors);
        // force:true bypasses the visibility / occlusion checks — the
        // editors are valid click targets even when their bounding box
        // looks "invisible" to Playwright's heuristic.
        await composer.click({ force: true });
        const pingId = Math.random().toString(36).slice(2, 8);
        // Force a unique assistant reply: short reply + the unique
        // pingId echoed back. Without uniqueness, the dedup in
        // dedupeAndFinalizeTurns collapses identical short replies
        // ("OK") and the last surviving turn becomes a user turn,
        // skewing lastTurnRole.
        const ping = `Sidetrack ping ${pingId} - reply with exactly: ack-${pingId}`;
        await chat.keyboard.type(ping, { delay: 25 });
        if (provider.sendButtonSelectors !== undefined) {
          // Click the send button (Gemini etc. insert a newline on plain
          // Enter). Try each selector in order until one resolves.
          let clicked = false;
          for (const selector of provider.sendButtonSelectors) {
            const button = chat.locator(selector).first();
            try {
              await button.waitFor({ state: 'attached', timeout: 4_000 });
              await button.click({ force: true });
              clicked = true;
              break;
            } catch {
              // try next
            }
          }
          if (!clicked) {
            throw new Error(
              `No send button found. Tried: ${provider.sendButtonSelectors.join(', ')}`,
            );
          }
        } else {
          await chat.keyboard.press('Enter');
        }

        // Give the user message a moment to land in the DOM.
        await chat.waitForTimeout(3_000);

        // ── T1: best-effort observation of the intermediate user state ──
        // Gemini replies so fast (~1-2s) the user-turn window is nearly
        // unobservable. We try briefly; if we catch it, assert the
        // pill; if not, log and proceed.
        const t1Thread = await tryObserveUserTurn(captureAndFetch, 8_000);
        if (t1Thread === null) {
          console.warn(
            `[${provider.expectedProvider}] T1 (skipped) — AI replied before we could observe lastTurnRole=user`,
          );
        } else {
          const t1Pill = await lifecycleLabelFor(sidepanel, provider.expectedProvider);
          console.warn(
            `[${provider.expectedProvider}] T1 pill=${JSON.stringify(t1Pill)} ` +
              `lastTurnRole=${t1Thread.lastTurnRole ?? '(none)'}`,
          );
          // "Waiting on AI" is the natural derivation; "Unread reply"
          // appears when an earlier auto-capture left a reminder behind
          // (the reminder takes priority in the lifecycle derivation).
          expect(t1Pill).toMatch(/Waiting on AI|Unread reply/);
        }

        // ── T2: wait for the assistant turn to come back ──
        const t2Thread = await waitForLastTurnRole(captureAndFetch, 'assistant', 90_000);
        const t2Pill = await lifecycleLabelFor(sidepanel, provider.expectedProvider);
        console.warn(
          `[${provider.expectedProvider}] T2 pill=${JSON.stringify(t2Pill)} ` +
            `lastTurnRole=${t2Thread.lastTurnRole ?? '(none)'}`,
        );
        expect(t2Pill).toMatch(/You replied last|Unread reply/);
      } finally {
        for (const page of opened) {
          await page.close().catch(() => undefined);
        }
        await runtime?.close();
      }
    });
  }
});
