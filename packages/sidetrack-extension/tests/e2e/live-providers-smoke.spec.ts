import { expect, test } from '@playwright/test';

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
  },
  {
    name: 'Claude',
    url:
      process.env.SIDETRACK_E2E_CLAUDE_URL ??
      'https://claude.ai/chat/89195bc1-74a9-4b07-99de-ca7b4dec3465',
    expectedProvider: 'claude',
  },
  {
    name: 'Gemini',
    url:
      process.env.SIDETRACK_E2E_GEMINI_URL ??
      'https://gemini.google.com/app/76bd837104ab1990',
    expectedProvider: 'gemini',
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
      try {
        runtime = await launchExtensionRuntime();
        const sidepanel = await runtime.context.newPage();
        await sidepanel.goto(`chrome-extension://${runtime.extensionId}/sidepanel.html`, {
          waitUntil: 'domcontentloaded',
        });

        // Skip the wizard so the workboard mounts directly. Companion
        // is intentionally not configured — local-only mode is enough
        // for capture verification.
        await runtime.seedStorage(sidepanel, { [SETUP_KEY]: true });
        await sidepanel.reload({ waitUntil: 'domcontentloaded' });
        await expect(sidepanel.getByRole('main', { name: 'Sidetrack workboard' })).toBeVisible();

        // Open the provider, give it a moment to settle, then capture
        // the active tab via the runtime message (mirrors what the
        // side panel's "Track current tab" button does).
        const providerPage = await runtime.context.newPage();
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

        // Diagnostic: print the captured title + last-turn-role so we
        // can spot regressions when extractors drift.
        const captured = await sidepanel.evaluate(async () => {
          const storage = await chrome.storage.local.get(['sidetrack.threads']);
          const threads = storage['sidetrack.threads'] as {
            title: string;
            provider: string;
            lastTurnRole?: string;
            lastSeenAt: string;
          }[];
          return threads.map((t) => ({
            title: t.title.slice(0, 80),
            provider: t.provider,
            lastTurnRole: t.lastTurnRole ?? '(none)',
          }));
        });
        console.warn(`[live-${provider.expectedProvider}] captured`, JSON.stringify(captured));
      } finally {
        await runtime?.close();
      }
    });
  }
});
