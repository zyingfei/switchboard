import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';

export interface ExtensionRuntime {
  readonly context: BrowserContext;
  readonly extensionId: string;
  readonly extensionPath: string;
  readonly sendRuntimeMessage: (senderPage: Page, message: unknown) => Promise<unknown>;
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
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'sidetrack-extension-e2e-profile-'));
  const headless = process.env.SIDETRACK_E2E_HEADLESS !== '0';

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless,
    ignoreDefaultArgs: ['--disable-extensions'],
    viewport: {
      width: 1280,
      height: 900,
    },
    args: [
      ...(headless ? ['--headless=new'] : []),
      '--no-first-run',
      '--no-default-browser-check',
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
    async close() {
      try {
        await context.close();
      } finally {
        await rm(userDataDir, { recursive: true, force: true });
      }
    },
  };
};
