import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from '@playwright/test';

export interface ExtensionRuntime {
  context: BrowserContext;
  extensionId: string;
  close(): Promise<void>;
}

const defaultChromePath = (): string => {
  if (process.platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }
  if (process.platform === 'win32') {
    return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  }
  return '/usr/bin/google-chrome';
};

const findChromeForTesting = async (): Promise<string | null> => {
  const cacheRoot = path.resolve(process.cwd(), '.cache/chrome-for-testing/chrome');
  const executableNames = new Set([
    'Google Chrome for Testing',
    'chrome',
    'chrome.exe',
  ]);
  const walk = async (dir: string): Promise<string | null> => {
    let entries: Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>;
    try {
      entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      return null;
    }
    for (const entry of entries) {
      const candidate = path.join(dir, entry.name);
      if (entry.isFile() && executableNames.has(entry.name)) {
        return candidate;
      }
      if (entry.isDirectory()) {
        const nested = await walk(candidate);
        if (nested) {
          return nested;
        }
      }
    }
    return null;
  };
  return await walk(cacheRoot);
};

const readChromePath = async (): Promise<string> =>
  process.env.BAC_E2E_CHROME_PATH ?? (await findChromeForTesting()) ?? defaultChromePath();

const readExtensionPath = (): string =>
  process.env.BAC_EXTENSION_PATH ?? path.resolve(process.cwd(), '.output/chrome-mv3');

const extensionIdFromKey = (key: string): string => {
  const hash = createHash('sha256').update(Buffer.from(key, 'base64')).digest().subarray(0, 16);
  return Array.from(hash)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .replace(/[0-9a-f]/g, (char) => String.fromCharCode('a'.charCodeAt(0) + Number.parseInt(char, 16)));
};

const readExtensionId = async (extensionPath: string): Promise<string> => {
  const manifest = JSON.parse(
    await readFile(path.join(extensionPath, 'manifest.json'), 'utf8'),
  ) as { key?: string };
  if (!manifest.key) {
    throw new Error('Built manifest is missing a deterministic key for e2e.');
  }
  return extensionIdFromKey(manifest.key);
};

export const launchExtensionRuntime = async (): Promise<ExtensionRuntime> => {
  const extensionPath = readExtensionPath();
  const executablePath = await readChromePath();
  await access(extensionPath);
  await access(executablePath);

  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'bac-poc-e2e-'));
  const useHeadless = process.env.BAC_E2E_HEADLESS === '1';
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath,
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    viewport: {
      width: 1280,
      height: 900,
    },
    args: [
      ...(useHeadless ? ['--headless=new'] : []),
      '--no-first-run',
      '--no-default-browser-check',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  const extensionId = await readExtensionId(extensionPath);

  return {
    context,
    extensionId,
    async close() {
      await context.close();
      await rm(userDataDir, { recursive: true, force: true });
    },
  };
};

export const openSidepanelPage = async (
  context: BrowserContext,
  extensionId: string,
): Promise<Page> => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`, {
    waitUntil: 'domcontentloaded',
  });
  return page;
};

export const waitForPageUrl = async (
  context: BrowserContext,
  matcher: (url: string) => boolean,
  timeoutMs = 10_000,
): Promise<Page> => {
  const existing = context.pages().find((page) => matcher(page.url()));
  if (existing) {
    return existing;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = context.pages().find((candidate) => matcher(candidate.url()));
    if (page) {
      return page;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }

  throw new Error(`Timed out waiting for page URL. Open pages: ${context.pages().map((page) => page.url()).join(', ')}`);
};
