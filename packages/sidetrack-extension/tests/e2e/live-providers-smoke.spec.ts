import { expect, test, type Page } from '@playwright/test';

import { isRuntimeResponse, messageTypes } from '../../src/messages';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';

const SETUP_KEY = 'sidetrack:setupCompleted';

// Specific chat URLs the spec drives — these point at real
// conversations in the logged-in profile. Override per-provider via
// SIDETRACK_E2E_<NAME>_URL env vars when testing against different
// chats.
const providers = [
  {
    name: 'ChatGPT',
    url:
      process.env.SIDETRACK_E2E_CHATGPT_URL ??
      'https://chatgpt.com/c/69f0c125-3a04-832c-b858-02ab155e0264',
    expectedProvider: 'chatgpt',
    // Bare titles that mean we hit a landing page, not the chat — fail
    // the test if the captured title matches any of these (cookies
    // probably expired or chat URL is invalid).
    landingTitles: ['ChatGPT', 'Just a moment...', 'Sign in - ChatGPT'],
  },
  {
    name: 'Claude',
    url:
      process.env.SIDETRACK_E2E_CLAUDE_URL ??
      'https://claude.ai/chat/89195bc1-74a9-4b07-99de-ca7b4dec3465',
    expectedProvider: 'claude',
    landingTitles: ['Claude', 'Sign in - Claude'],
  },
  {
    name: 'Gemini',
    url: process.env.SIDETRACK_E2E_GEMINI_URL ?? 'https://gemini.google.com/app/76bd837104ab1990',
    expectedProvider: 'gemini',
    landingTitles: ['Google Gemini'],
  },
] as const;

const assertOk = (response: unknown): void => {
  if (!isRuntimeResponse(response)) {
    throw new Error('Background returned a non-Sidetrack response.');
  }
  if (!response.ok) {
    throw new Error(response.error);
  }
};

// Read-only smoke against real provider pages. Requires the profile
// at ~/.sidetrack-test-profile to be already logged in (run
// `npm run e2e:login` once and sign in to each provider). Will be
// SKIPPED automatically when SIDETRACK_USER_DATA_DIR is unset, so the
// throwaway-profile CI path stays green.
test.describe('live providers (logged-in profile)', () => {
  test.skip(
    () =>
      (process.env.SIDETRACK_USER_DATA_DIR === undefined ||
        process.env.SIDETRACK_USER_DATA_DIR.length === 0) &&
      (process.env.SIDETRACK_E2E_CDP_URL === undefined ||
        process.env.SIDETRACK_E2E_CDP_URL.length === 0),
    'requires SIDETRACK_USER_DATA_DIR or SIDETRACK_E2E_CDP_URL',
  );

  for (const provider of providers) {
    test(`captures the ${provider.name} landing page from a real chat`, async () => {
      let runtime: ExtensionRuntime | undefined;
      const openedPages: Page[] = [];
      try {
        runtime = await launchExtensionRuntime();
        const sidepanel = await runtime.context.newPage();
        openedPages.push(sidepanel);
        await sidepanel.goto(`chrome-extension://${runtime.extensionId}/sidepanel.html`, {
          waitUntil: 'domcontentloaded',
        });

        // Skip the wizard so the workboard mounts directly. Companion
        // is intentionally not configured — local-only mode is enough
        // for capture verification. Wipe sidetrack-prefixed storage
        // first so re-runs against the same Chrome session don't carry
        // over leftover threads / reminders / queue items (otherwise
        // the lifecycle pill flips to "Unread reply" on the second run).
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

        // Open the provider, give it a moment to settle, then capture
        // the active tab via the runtime message (mirrors what the
        // side panel's "Track current tab" button does).
        const providerPage = await runtime.context.newPage();
        openedPages.push(providerPage);
        await providerPage.goto(provider.url, { waitUntil: 'domcontentloaded' });
        // Real chat pages render asynchronously — give the DOM time to
        // settle before the content script reads it.
        await providerPage.waitForTimeout(5_000);
        await providerPage.bringToFront();

        const captureResponse = await runtime.sendRuntimeMessage(sidepanel, {
          type: messageTypes.captureCurrentTab,
        });
        assertOk(captureResponse);

        // Verify the captured thread shows up in the All threads view
        // with the right provider chip. Any title is OK — we're just
        // confirming the extractor produced *something* and the
        // provider-detection regex matched the URL.
        await sidepanel.bringToFront();
        const refresh = await runtime.sendRuntimeMessage(sidepanel, {
          type: messageTypes.getWorkboardState,
        });
        assertOk(refresh);
        await sidepanel.getByRole('tab', { name: 'All threads' }).click();
        await expect(
          sidepanel.locator(`.thread .provider.${provider.expectedProvider}`).first(),
        ).toBeVisible({ timeout: 10_000 });

        // Find the thread we just captured (most recent for this URL).
        const justCaptured = await sidepanel.evaluate((url) => {
          const storage = chrome.storage.local.get(['sidetrack.threads']);
          return storage.then((s) => {
            const threads = s['sidetrack.threads'] as {
              title: string;
              provider: string;
              threadUrl: string;
              lastTurnRole?: string;
              lastSeenAt: string;
            }[];
            return threads.find((t) => t.threadUrl === url) ?? null;
          });
        }, provider.url);

        if (justCaptured === null) {
          throw new Error(`No thread found for ${provider.url} after capture.`);
        }

        // Sanity: title must not be a bare landing-page title — that
        // would mean cookies expired or the chat URL is wrong, not
        // that the extractor is working.
        const isLanding = (provider.landingTitles as readonly string[]).includes(
          justCaptured.title,
        );
        if (isLanding) {
          throw new Error(
            `${provider.name} captured a landing-page title (${JSON.stringify(
              justCaptured.title,
            )}). Check that you're signed in and the chat URL is valid.`,
          );
        }

        // The chat ends in an assistant turn → lifecycle is either
        // "you-replied" ("You replied last", first capture for this URL)
        // or "unread-reply" ("Unread reply", subsequent captures because
        // the content script's own auto-capture beat us to it and a
        // reminder was created). Both prove the assistant turn was
        // detected.
        if (justCaptured.lastTurnRole === 'assistant') {
          await expect(
            sidepanel
              .locator('.thread')
              .filter({
                has: sidepanel.locator(`.provider.${provider.expectedProvider}`),
              })
              .first()
              .locator('.lifecycle-pill'),
          ).toContainText(/You replied last|Unread reply/, { timeout: 5_000 });
        }

        console.warn(
          `[live-${provider.expectedProvider}] captured title=${JSON.stringify(
            justCaptured.title,
          )} lastTurnRole=${justCaptured.lastTurnRole ?? '(none)'}`,
        );
      } finally {
        // Close any pages this test opened so the user's Chrome
        // doesn't accumulate dozens of tabs across runs.
        for (const page of openedPages) {
          await page.close().catch(() => undefined);
        }
        await runtime?.close();
      }
    });
  }
});
