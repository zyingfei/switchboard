import { expect, test, type Page } from '@playwright/test';

import { isProviderThreadUrl } from '../../src/capture/providerDetection';
import { isRuntimeResponse, messageTypes } from '../../src/messages';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import { startProviderFixtureServer, type FixtureServer } from './helpers/fixtures';
import { SETUP_KEY } from './helpers/sidepanel';

const providers = [
  {
    name: 'ChatGPT',
    homeUrl: 'https://chatgpt.com/',
    envUrl: process.env.SIDETRACK_E2E_CHATGPT_URL,
    threadLinkSelector: 'a[href^="/c/"], a[href*="/c/"]',
    expectedProvider: 'chatgpt',
  },
  {
    name: 'Claude',
    homeUrl: 'https://claude.ai/',
    envUrl: process.env.SIDETRACK_E2E_CLAUDE_URL,
    threadLinkSelector: 'a[href^="/chat/"], a[href*="/chat/"]',
    expectedProvider: 'claude',
  },
  {
    name: 'Gemini',
    homeUrl: 'https://gemini.google.com/app',
    envUrl: process.env.SIDETRACK_E2E_GEMINI_URL,
    threadLinkSelector: 'a[href^="/app/"]:not([href="/app"]), a[href*="/app/"]',
    expectedProvider: 'gemini',
  },
] as const;

type SidetrackStorage = Record<string, unknown>;

const assertOk = (response: unknown): void => {
  if (!isRuntimeResponse(response)) {
    throw new Error('Background returned a non-Sidetrack response.');
  }
  if (!response.ok) {
    throw new Error(response.error);
  }
};

const readSidetrackStorage = async (page: Page): Promise<SidetrackStorage> => {
  return await page.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return Object.fromEntries(Object.entries(all).filter(([key]) => key.startsWith('sidetrack')));
  });
};

const replaceSidetrackStorage = async (page: Page, values: SidetrackStorage): Promise<void> => {
  await page.evaluate(async (nextValues) => {
    const all = await chrome.storage.local.get(null);
    const toRemove = Object.keys(all).filter((key) => key.startsWith('sidetrack'));
    if (toRemove.length > 0) {
      await chrome.storage.local.remove(toRemove);
    }
    if (Object.keys(nextValues).length > 0) {
      await chrome.storage.local.set(nextValues);
    }
  }, values);
};

const focusTabForCapture = async (sidepanel: Page, targetUrl: string): Promise<void> => {
  await sidepanel.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => candidate.url === url);
    if (tab === undefined) {
      throw new Error(`Could not find a Chrome tab for ${url}.`);
    }
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tab.id, { active: true });
  }, targetUrl);

  await expect
    .poll(
      async () =>
        await sidepanel.evaluate(async () => {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          return tab.url;
        }),
      { timeout: 5_000 },
    )
    .toBe(targetUrl);
};

const captureVisibleTab = async (
  runtime: ExtensionRuntime,
  sidepanel: Page,
  tab: Page,
): Promise<void> => {
  const targetUrl = tab.url();
  if (targetUrl.length === 0 || targetUrl === 'about:blank') {
    throw new Error('Cannot capture a provider tab before it has navigated to a URL.');
  }
  await focusTabForCapture(sidepanel, targetUrl);
  const response = await runtime.sendRuntimeMessage(sidepanel, {
    type: messageTypes.captureCurrentTab,
  });
  assertOk(response);
  await sidepanel.bringToFront();
};

const openProviderThread = async (
  page: Page,
  provider: (typeof providers)[number],
): Promise<string> => {
  const preferredUrl = provider.envUrl ?? provider.homeUrl;
  await page.goto(preferredUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5_000);
  if (isProviderThreadUrl(provider.expectedProvider, page.url())) {
    return page.url();
  }

  await page.goto(provider.homeUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5_000);
  const threadLink = page.locator(provider.threadLinkSelector).first();
  const href = await threadLink.getAttribute('href', { timeout: 15_000 });
  if (href === null || href.length === 0) {
    throw new Error(`${provider.name} recent-thread link did not expose an href.`);
  }
  await page.goto(new URL(href, provider.homeUrl).toString(), { waitUntil: 'domcontentloaded' });
  await expect
    .poll(() => isProviderThreadUrl(provider.expectedProvider, page.url()), { timeout: 15_000 })
    .toBe(true);
  await page.waitForTimeout(5_000);
  return page.url();
};

test.describe('live requirements BDD (signed-in Chrome profile)', () => {
  test.skip(
    () =>
      process.env.SIDETRACK_E2E_LIVE_REQUIREMENTS === undefined ||
      process.env.SIDETRACK_E2E_LIVE_REQUIREMENTS.length === 0,
    'opt-in: requires SIDETRACK_E2E_LIVE_REQUIREMENTS=1',
  );
  test.skip(
    () =>
      (process.env.SIDETRACK_USER_DATA_DIR === undefined ||
        process.env.SIDETRACK_USER_DATA_DIR.length === 0) &&
      (process.env.SIDETRACK_E2E_CDP_URL === undefined ||
        process.env.SIDETRACK_E2E_CDP_URL.length === 0),
    'requires SIDETRACK_USER_DATA_DIR or SIDETRACK_E2E_CDP_URL',
  );

  test('Scenario: signed-in AI tabs become active work the user can recognize', async () => {
    test.setTimeout(180_000);
    let runtime: ExtensionRuntime | undefined;
    let sidepanel: Page | undefined;
    let fixtureServer: FixtureServer | undefined;
    let originalStorage: SidetrackStorage | undefined;
    const capturedProviderUrls = new Map<(typeof providers)[number]['name'], string>();
    const opened: Page[] = [];

    try {
      await test.step('Given the user has a signed-in Chrome test session with Sidetrack loaded', async () => {
        runtime = await launchExtensionRuntime();
        sidepanel = await runtime.context.newPage();
        opened.push(sidepanel);
        await sidepanel.goto(`chrome-extension://${runtime.extensionId}/sidepanel.html`, {
          waitUntil: 'domcontentloaded',
        });
        originalStorage = await readSidetrackStorage(sidepanel);
        await replaceSidetrackStorage(sidepanel, { [SETUP_KEY]: true });
        await sidepanel.reload({ waitUntil: 'domcontentloaded' });
        await expect(sidepanel.getByRole('main', { name: 'Sidetrack workboard' })).toBeVisible();
      });

      await test.step('When the user tracks ChatGPT, Claude, Gemini, and one ordinary research page', async () => {
        if (runtime === undefined || sidepanel === undefined) {
          throw new Error('Runtime was not launched.');
        }

        for (const provider of providers) {
          const providerPage = await runtime.context.newPage();
          opened.push(providerPage);
          const providerUrl = await openProviderThread(providerPage, provider);
          capturedProviderUrls.set(provider.name, providerUrl);
          await captureVisibleTab(runtime, sidepanel, providerPage);
        }

        fixtureServer = await startProviderFixtureServer();
        const researchPage = await runtime.context.newPage();
        opened.push(researchPage);
        await researchPage.goto(
          `${fixtureServer.origin}/chatgpt-research-frame.html?sidetrack=requirements-bdd`,
          {
            waitUntil: 'domcontentloaded',
          },
        );
        await captureVisibleTab(runtime, sidepanel, researchPage);
      });

      await test.step('Then All threads shows recognizable active work instead of login or landing pages', async () => {
        if (runtime === undefined || sidepanel === undefined) {
          throw new Error('Runtime was not launched.');
        }

        const refresh = await runtime.sendRuntimeMessage(sidepanel, {
          type: messageTypes.getWorkboardState,
        });
        assertOk(refresh);
        await sidepanel.getByRole('tab', { name: 'All threads' }).click();

        for (const provider of providers) {
          const providerUrl = capturedProviderUrls.get(provider.name);
          if (providerUrl === undefined) {
            throw new Error(`No captured URL recorded for ${provider.name}.`);
          }
          await expect(
            sidepanel.locator(`.thread .provider.${provider.expectedProvider}`).first(),
          ).toBeVisible({ timeout: 10_000 });

          const captured = await sidepanel.evaluate((url) => {
            return chrome.storage.local.get(['sidetrack.threads']).then((storage) => {
              const threads = storage['sidetrack.threads'] as
                | readonly {
                    readonly title: string;
                    readonly threadId?: string;
                    readonly provider: string;
                    readonly threadUrl: string;
                  }[]
                | undefined;
              return threads?.find((thread) => thread.threadUrl === url) ?? null;
            });
          }, providerUrl);

          if (captured === null) {
            throw new Error(`No captured thread found for ${provider.name} at ${providerUrl}.`);
          }
          if (!isProviderThreadUrl(provider.expectedProvider, captured.threadUrl)) {
            throw new Error(`${provider.name} captured a non-thread URL: ${captured.threadUrl}.`);
          }
          if (captured.threadId === undefined || captured.threadId.length === 0) {
            throw new Error(`${provider.name} capture did not preserve the provider thread id.`);
          }
        }

        await expect(sidepanel.getByText(/Analytical Due Diligence/u)).toBeVisible({
          timeout: 10_000,
        });
      });
    } finally {
      if (sidepanel !== undefined && originalStorage !== undefined) {
        await replaceSidetrackStorage(sidepanel, originalStorage);
      }
      for (const page of opened) {
        await page.close().catch(() => undefined);
      }
      await runtime?.close();
      await fixtureServer?.close();
    }
  });
});
