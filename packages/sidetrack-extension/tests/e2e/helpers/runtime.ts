import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';

export interface ExtensionRuntime {
  readonly context: BrowserContext;
  readonly extensionId: string;
  readonly extensionPath: string;
  readonly sendRuntimeMessage: (senderPage: Page, message: unknown) => Promise<unknown>;
  readonly seedStorage: (senderPage: Page, values: Record<string, unknown>) => Promise<void>;
  readonly close: () => Promise<void>;
}

const packageRoot = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));

const readExtensionPath = (): string =>
  process.env.SIDETRACK_EXTENSION_PATH ?? path.join(packageRoot, '.output/chrome-mv3');

const extensionIdFromWorker = (worker: Worker): string => {
  const match = /^chrome-extension:\/\/([^/]+)\//u.exec(worker.url());
  const extensionId = match?.[1];
  if (extensionId === undefined) {
    throw new Error(`Could not derive extension id from service worker URL: ${worker.url()}`);
  }
  return extensionId;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitForExtensionWorker = async (context: BrowserContext): Promise<Worker> => {
  const findWorker = (): Worker | undefined =>
    context.serviceWorkers().find((worker) => worker.url().startsWith('chrome-extension://'));

  const existing = findWorker();
  if (existing !== undefined) {
    return existing;
  }

  // Open a placeholder page so Chrome has a UI to attach to — Chrome
  // stable on macOS sometimes defers MV3 service-worker registration
  // until at least one page has rendered.
  await context.newPage().then((page) => page.goto('about:blank').catch(() => undefined));

  // Race the event listener and a polling fallback. Chrome stable +
  // Playwright doesn't reliably emit the 'serviceworker' event for
  // --load-extension MV3 workers, but the worker DOES eventually
  // appear in context.serviceWorkers().
  const eventWait = context.waitForEvent('serviceworker', {
    timeout: 45_000,
    predicate: (worker) => worker.url().startsWith('chrome-extension://'),
  });
  const pollWait = (async (): Promise<Worker> => {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      await sleep(500);
      const found = findWorker();
      if (found !== undefined) {
        return found;
      }
      if (attempt % 10 === 9) {
        const allWorkers = context.serviceWorkers().map((w) => w.url());
        // eslint-disable-next-line no-console
        console.warn(
          `[runtime] still waiting for ext worker, attempt ${String(attempt + 1)}/90, ` +
            `current workers: ${allWorkers.length === 0 ? '<none>' : JSON.stringify(allWorkers)}`,
        );
      }
    }
    throw new Error(
      'Extension service worker never appeared in context.serviceWorkers() after 45s.',
    );
  })();
  return await Promise.race([eventWait, pollWait]);
};

// Attach to a Chrome that was started outside Playwright (via
// scripts/chrome-debug.mjs) — gives real Chrome cookies + reliable
// MV3 service-worker registration without us having to manage the
// browser process.
const attachOverCdp = async (cdpUrl: string): Promise<ExtensionRuntime> => {
  const browser = await chromium.connectOverCDP(cdpUrl);
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    throw new Error(`Chrome at ${cdpUrl} has no browser contexts.`);
  }
  const context = contexts[0];
  const worker = await waitForExtensionWorker(context);
  const extensionId = extensionIdFromWorker(worker);
  const extensionPath = readExtensionPath();

  return {
    context,
    extensionId,
    extensionPath,
    async sendRuntimeMessage(senderPage: Page, message: unknown) {
      return await senderPage.evaluate(async (runtimeMessage) => {
        const response = (await chrome.runtime.sendMessage(runtimeMessage)) as unknown;
        return response;
      }, message);
    },
    async seedStorage(senderPage: Page, values: Record<string, unknown>) {
      await senderPage.evaluate(async (vals) => {
        await chrome.storage.local.set(vals);
      }, values);
    },
    async close() {
      // Don't close the user's Chrome, just detach Playwright.
      await browser.close();
    },
  };
};

export const launchExtensionRuntime = async (): Promise<ExtensionRuntime> => {
  const cdpUrl = process.env.SIDETRACK_E2E_CDP_URL;
  if (cdpUrl !== undefined && cdpUrl.length > 0) {
    return await attachOverCdp(cdpUrl);
  }
  const extensionPath = readExtensionPath();
  // SIDETRACK_USER_DATA_DIR lets the dev pin a long-lived profile (e.g.
  // ~/.sidetrack-test-profile) so logins to chatgpt.com / claude.ai /
  // gemini.google.com survive across runs. When unset, every run gets a
  // fresh tmpdir profile that's wiped on close.
  const persistentDir = process.env.SIDETRACK_USER_DATA_DIR;
  const userDataDir =
    persistentDir !== undefined && persistentDir.length > 0
      ? (await mkdir(persistentDir, { recursive: true }), persistentDir)
      : await mkdtemp(path.join(tmpdir(), 'sidetrack-extension-e2e-profile-'));
  const cleanupOnClose = persistentDir === undefined || persistentDir.length === 0;
  const headless = process.env.SIDETRACK_E2E_HEADLESS !== '0';
  // Use Chrome stable when a persistent profile is requested (the
  // login-test-profile script uses Chrome to bypass Google's OAuth
  // automation block, and the same profile must be opened with the
  // same browser to read its cookies). Default to Playwright's
  // Chromium for the throwaway-profile path.
  const channel = process.env.SIDETRACK_E2E_BROWSER ?? (cleanupOnClose ? 'chromium' : 'chrome');

  const context = await chromium
    .launchPersistentContext(userDataDir, {
      channel,
      headless,
      ignoreDefaultArgs: ['--disable-extensions', '--enable-automation'],
      viewport: {
        width: 1280,
        height: 900,
      },
      args: [
        ...(headless ? ['--headless=new'] : []),
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-blink-features=AutomationControlled',
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('ProcessSingleton')) {
        throw new Error(
          `Could not lock the user-data dir at ${userDataDir}. ` +
            `Another Chrome process (likely the one started by ` +
            `\`npm run e2e:login\`) still holds it. Close that window ` +
            `(Cmd-Q on the login window) and re-run.`,
        );
      }
      throw error;
    });
  const worker = await waitForExtensionWorker(context);
  const extensionId = extensionIdFromWorker(worker);

  return {
    context,
    extensionId,
    extensionPath,
    async sendRuntimeMessage(senderPage: Page, message: unknown) {
      return await senderPage.evaluate(async (runtimeMessage) => {
        const response = (await chrome.runtime.sendMessage(runtimeMessage)) as unknown;
        return response;
      }, message);
    },
    async seedStorage(senderPage: Page, values: Record<string, unknown>) {
      await senderPage.evaluate(async (vals) => {
        await chrome.storage.local.set(vals);
      }, values);
    },
    async close() {
      try {
        await context.close();
      } finally {
        if (cleanupOnClose) {
          await rm(userDataDir, { recursive: true, force: true });
        }
      }
    },
  };
};
