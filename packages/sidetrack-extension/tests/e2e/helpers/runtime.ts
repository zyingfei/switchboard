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

const waitForExtensionWorker = async (context: BrowserContext): Promise<Worker> => {
  const existing = context
    .serviceWorkers()
    .find((worker) => worker.url().startsWith('chrome-extension://'));
  if (existing !== undefined) {
    return existing;
  }

  return await context.waitForEvent('serviceworker', {
    timeout: 15_000,
    predicate: (worker) => worker.url().startsWith('chrome-extension://'),
  });
};

export const launchExtensionRuntime = async (): Promise<ExtensionRuntime> => {
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

  const context = await chromium.launchPersistentContext(userDataDir, {
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
