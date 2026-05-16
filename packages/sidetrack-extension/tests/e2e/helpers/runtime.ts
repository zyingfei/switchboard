import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';

import {
  resolveManualBrowserMode,
  STEALTH_EXPERIMENT_WARNING,
  type ManualBrowserMode,
} from './manualBrowserMode';
import { launchStealthPersistentContext } from './stealth-runtime';

let stealthExperimentWarningPrinted = false;

// Sequential allocation for the optional CDP debug port. The recorder
// launches two browsers (Companion A + Companion B) in the same
// process; if both bind the SAME port the second launch silently fails
// to expose CDP at best, and at worst it aborts the launch entirely
// (AbortError surfaces from the wait-for-readiness path). Each launch
// gets baseEnvPort + cdpAllocationIndex.
let cdpAllocationIndex = 0;

// Helper for evaluations that must run in a context where the page's
// chrome.* extension APIs (chrome.runtime, chrome.storage, …) are
// bound. Default launch path uses stock Playwright, whose
// `page.evaluate` already runs in the page's main world, so this is
// the standard 2-arg call. (Earlier versions of this file passed a
// 3rd `false` arg targeting Patchright's `isolatedContext` overload —
// current Playwright versions reject the extra arg with `Too many
// arguments`. The stealth-experiment path uses Patchright via
// `launchStealthPersistentContext` and Patchright defaults to main-
// world bindings on extension pages, so the 2-arg call works on both
// runtimes.)
const evaluateInMainWorld = async <Arg, Result>(
  page: Page,
  pageFunction: (arg: Arg) => Result | Promise<Result>,
  arg: Arg,
): Promise<Result> =>
  // The cast routes Playwright's overload resolution to the
  // `(pageFunction, arg)` form regardless of whether `Arg` is
  // narrowed to `void` at the call site.
  await (page.evaluate as <A, R>(fn: (arg: A) => R | Promise<R>, arg: A) => Promise<R>)(
    pageFunction,
    arg,
  );

const isSidetrackExtensionWorker = (worker: Worker): boolean =>
  worker.url().startsWith('chrome-extension://') && worker.url().endsWith('/background.js');

// Resolve the current extension service worker. Used by the page-API
// helpers (seedStorage / sendRuntimeMessage / clearStorage) as a
// fallback when the senderPage's main world has no chrome.* binding
// (the Patchright stealth path). Waits briefly for the SW to wake.
const getExtensionServiceWorker = async (
  context: BrowserContext,
  extensionId: string,
): Promise<Worker> => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const worker = context
      .serviceWorkers()
      .find(
        (w) =>
          isSidetrackExtensionWorker(w) && w.url().includes(`chrome-extension://${extensionId}/`),
      );
    if (worker !== undefined) return worker;
    await wakeServiceWorker(context, extensionId).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `getExtensionServiceWorker: no extension SW for ${extensionId} after 4s polling.`,
  );
};

const expandHomeDir = (input: string): string =>
  input.startsWith('~')
    ? path.join(process.env.HOME ?? '', input.slice(1).replace(/^[/\\]/u, ''))
    : input;

export interface ExtensionRuntimeMetadata {
  readonly browserMode: ManualBrowserMode;
  readonly browserChannel: string;
  readonly cdpAttached: boolean;
  readonly patchrightLoaded: boolean;
  readonly headed: boolean;
}

export interface ExtensionRuntime {
  readonly context: BrowserContext;
  readonly extensionId: string;
  readonly extensionPath: string;
  // Resolved profile dir actually in use. Tests that exercise
  // SW-restart-with-storage-survival need this so the second
  // launchExtensionRuntime({ userDataDir }) can target the same
  // dir and pick up the chrome.storage written by the first run.
  readonly userDataDir: string;
  readonly sendRuntimeMessage: (senderPage: Page, message: unknown) => Promise<unknown>;
  readonly seedStorage: (senderPage: Page, values: Record<string, unknown>) => Promise<void>;
  readonly clearStorage: (senderPage: Page) => Promise<void>;
  readonly close: () => Promise<void>;
  readonly metadata?: ExtensionRuntimeMetadata;
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
    context.serviceWorkers().find(isSidetrackExtensionWorker);

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
    timeout: 0,
    predicate: isSidetrackExtensionWorker,
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

// Resolve the Sidetrack extension ID. Tries three sources in order:
//   1) the .output/cdp-extension-id file written by chrome-debug.mjs
//      when it first sees the worker register
//   2) CDP's HTTP /json/list (works while the worker is awake)
//   3) explicit error
const resolveExtensionId = async (cdpUrl: string): Promise<string> => {
  try {
    const idFile = path.join(packageRoot, '.output/cdp-extension-id');
    const fromFile = (await readFile(idFile, 'utf8')).trim();
    if (fromFile.length > 0) {
      return fromFile;
    }
  } catch {
    // No file; fall through to CDP query.
  }
  const listUrl = `${cdpUrl.replace(/\/+$/, '')}/json/list`;
  const response = await fetch(listUrl);
  if (!response.ok) {
    throw new Error(`CDP /json/list returned HTTP ${String(response.status)}`);
  }
  const targets = (await response.json()) as { type?: string; url?: string }[];
  const serviceWorkers = targets.filter(
    (t) => t.type === 'service_worker' && (t.url ?? '').startsWith('chrome-extension://'),
  );
  if (serviceWorkers.length > 0) {
    const swTarget = serviceWorkers.find((t) => (t.url ?? '').endsWith('/background.js'));
    if (swTarget === undefined) {
      throw new Error(
        `CDP reported extension service workers but none was Sidetrack's background.js. ` +
          `Targets: ${JSON.stringify(serviceWorkers.map((t) => t.url ?? ''))}`,
      );
    }
    const match = /^chrome-extension:\/\/([^/]+)\//u.exec(swTarget.url ?? '');
    if (match !== null) {
      return match[1];
    }
  }
  throw new Error(
    `Could not resolve the Sidetrack extension id. Make sure ` +
      `\`bun run e2e:chrome-debug\` is running, then re-run. ` +
      `Looked at .output/cdp-extension-id and ${listUrl}.`,
  );
};

// MV3 service workers go dormant after ~30s idle. Hit any URL on the
// extension's origin to wake it up before doing real work.
const wakeServiceWorker = async (context: BrowserContext, extensionId: string): Promise<void> => {
  const wakePage = await context.newPage();
  try {
    await wakePage.goto(`chrome-extension://${extensionId}/sidepanel.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 10_000,
    });
  } finally {
    await wakePage.close();
  }
};

const reloadExtensionFromDisk = async (
  context: BrowserContext,
  extensionId: string,
  previousWorker: Worker,
): Promise<Worker> => {
  // Try the service worker first — under Patchright's stealth main-world
  // binding `chrome` is sometimes scrubbed off extension pages, so the
  // page-evaluate path below throws `Cannot read properties of undefined`.
  // The SW always has chrome.runtime since it IS the runtime; calling
  // reload() there is the canonical MV3 path anyway.
  const swReloadOk = await previousWorker
    .evaluate(() => {
      chrome.runtime.reload();
    })
    .then(() => true)
    .catch(() => false);
  if (!swReloadOk) {
    const reloadPage = await context.newPage();
    try {
      await reloadPage.goto(`chrome-extension://${extensionId}/sidepanel.html`, {
        waitUntil: 'domcontentloaded',
        timeout: 10_000,
      });
      await evaluateInMainWorld(
        reloadPage,
        () => {
          if (typeof chrome === 'undefined' || chrome.runtime === undefined) {
            throw new Error('chrome.runtime not available in main world');
          }
          chrome.runtime.reload();
        },
        undefined,
      ).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        // Three classes of swallowed errors:
        //   1. The page tore down during reload (expected race).
        //   2. The execution context died (same).
        //   3. chrome.runtime isn't reachable from the page world (Patchright
        //      stealth). In that case the SW worker.evaluate() above already
        //      tried + failed; the post-loop wakeServiceWorker still recovers.
        if (
          !message.includes('Target page, context or browser has been closed') &&
          !message.includes('Execution context was destroyed') &&
          !message.includes('chrome.runtime not available') &&
          !message.includes("Cannot read properties of undefined (reading 'reload')")
        ) {
          throw error;
        }
      });
    } finally {
      await reloadPage.close().catch(() => undefined);
    }
  }

  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(250);
    const replacement = context
      .serviceWorkers()
      .find((worker) => isSidetrackExtensionWorker(worker) && worker !== previousWorker);
    if (replacement !== undefined) {
      return replacement;
    }
    if (attempt % 8 === 7) {
      await wakeServiceWorker(context, extensionId).catch(() => undefined);
    }
  }

  // Some Chromium builds keep the same Playwright Worker wrapper after
  // chrome.runtime.reload(); wake the origin and let the caller continue
  // with the visible worker rather than failing a manual recorder launch.
  await wakeServiceWorker(context, extensionId).catch(() => undefined);
  return await waitForExtensionWorker(context);
};

// Attach to a Chrome that was started outside Playwright (via
// scripts/chrome-debug.mjs) — gives real Chrome cookies + reliable
// MV3 service-worker registration without us having to manage the
// browser process.
const attachOverCdp = async (cdpUrl: string): Promise<ExtensionRuntime> => {
  const extensionId = await resolveExtensionId(cdpUrl);
  const browser = await chromium.connectOverCDP(cdpUrl);
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    throw new Error(`Chrome at ${cdpUrl} has no browser contexts.`);
  }
  const context = contexts[0];
  // Wake the worker before any test code runs — MV3 workers go
  // dormant after ~30s and our message handler won't respond.
  await wakeServiceWorker(context, extensionId);
  const extensionPath = readExtensionPath();

  return {
    context,
    extensionId,
    extensionPath,
    // CDP attach path: profile is owned by an external Chrome
    // process (typically the live login profile). Empty string
    // signals "not under our control" so SW-restart tests skip
    // this path.
    userDataDir: '',
    metadata: {
      browserMode: 'normal-chrome-manual',
      browserChannel: 'cdp',
      cdpAttached: true,
      patchrightLoaded: false,
      headed: true,
    },
    async sendRuntimeMessage(senderPage: Page, message: unknown) {
      return await evaluateInMainWorld(
        senderPage,
        async (runtimeMessage) => {
          const response = (await chrome.runtime.sendMessage(runtimeMessage)) as unknown;
          return response;
        },
        message,
      );
    },
    async seedStorage(senderPage: Page, values: Record<string, unknown>) {
      // Wait briefly for chrome.storage to become available — under stealth /
      // CFT launches the extension service worker can register a beat after
      // the sidepanel page hits domcontentloaded. Force main-world evaluation
      // so patchright doesn't run the probe in an isolated context where
      // chrome.* extension APIs aren't bound.
      const diagnostic = await evaluateInMainWorld(
        senderPage,
        async ({ vals, retries, intervalMs }) => {
          const c = (
            globalThis as unknown as {
              chrome?: { storage?: { local?: { set?: (v: unknown) => Promise<void> } } };
            }
          ).chrome;
          const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
          for (let i = 0; i < retries; i += 1) {
            const setFn = c?.storage?.local?.set;
            if (typeof setFn === 'function') {
              await setFn.call(c?.storage?.local, vals);
              return { ok: true } as const;
            }
            await sleep(intervalMs);
          }
          const chromeKeys = c === undefined ? [] : Object.keys(c).sort();
          const runtimeKeys =
            (c as { runtime?: object }).runtime === undefined
              ? []
              : Object.keys((c as { runtime: object }).runtime).sort();
          const runtimeIdGetter = (c as { runtime?: { id?: string } }).runtime?.id ?? '<undefined>';
          return {
            ok: false,
            url: location.href,
            chromePresent: c !== undefined,
            storagePresent: c?.storage !== undefined,
            localPresent: c?.storage?.local !== undefined,
            chromeKeys,
            runtimeKeys,
            runtimeId: runtimeIdGetter,
          } as const;
        },
        { vals: values, retries: 50, intervalMs: 100 },
      );
      if (!diagnostic.ok) {
        throw new Error(
          `seedStorage: chrome.storage.local.set unavailable after 5s polling.\n` +
            `  url=${diagnostic.url}\n` +
            `  chromePresent=${String(diagnostic.chromePresent)}\n` +
            `  storagePresent=${String(diagnostic.storagePresent)}\n` +
            `  localPresent=${String(diagnostic.localPresent)}\n` +
            `  chrome keys (first 20): ${diagnostic.chromeKeys.slice(0, 20).join(', ')}\n` +
            `  chrome.runtime keys (first 20): ${diagnostic.runtimeKeys.slice(0, 20).join(', ')}\n` +
            `  chrome.runtime.id: ${diagnostic.runtimeId}`,
        );
      }
    },
    async clearStorage(senderPage: Page) {
      // Wipe chrome.storage.local + .session so cached projections from
      // a prior run don't leak in. Uses the same main-world retry shape
      // as seedStorage because chrome.* binding can lag the panel load.
      await evaluateInMainWorld(
        senderPage,
        async ({ retries, intervalMs }) => {
          const c = (
            globalThis as unknown as {
              chrome?: {
                storage?: {
                  local?: { clear?: () => Promise<void> };
                  session?: { clear?: () => Promise<void> };
                };
              };
            }
          ).chrome;
          const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
          for (let i = 0; i < retries; i += 1) {
            const clearLocal = c?.storage?.local?.clear;
            if (typeof clearLocal === 'function') {
              await clearLocal.call(c?.storage?.local);
              const clearSession = c?.storage?.session?.clear;
              if (typeof clearSession === 'function') {
                await clearSession.call(c?.storage?.session);
              }
              return;
            }
            await sleep(intervalMs);
          }
        },
        { retries: 50, intervalMs: 100 },
      );
    },
    async close() {
      // Don't close the user's Chrome AND don't call browser.close()
      // — for CDP-attached browsers, close() can race with subsequent
      // attaches in the same test run and break "no browser contexts"
      // on tests #2+. Just let the WebSocket idle; Node exit cleans up.
    },
  };
};

export interface LaunchOptions {
  // Force the throwaway-tmpdir launch path even when SIDETRACK_E2E_CDP_URL
  // is set. Synthetic specs use this so they don't write into the user's
  // real Chrome profile when running mixed with live specs.
  readonly forceLocalProfile?: boolean;
  // Reuse a specific user-data dir instead of creating a new tmpdir.
  // Tests that exercise SW restart / browser-restart-with-storage
  // pre-create a dir, run launchExtensionRuntime() against it, close,
  // then launch() again with the same dir to assert chrome.storage
  // survives. Caller is responsible for rm()'ing the dir afterwards
  // — `close()` does NOT delete it when this option is set.
  readonly userDataDir?: string;
  // Test-only host-permission widening. Some e2e stories need
  // chrome.scripting.executeScript on real-shaped public domains, but
  // production keeps those hosts optional. The local-launch path copies
  // the built extension into a temp dir and amends manifest.json before
  // Chrome loads it.
  readonly extraHostPermissions?: readonly string[];
  // Manual-only browser-launcher routing. Defaults to
  // 'persistent-playwright-manual' which is the historical
  // chromium.launchPersistentContext path. 'persistent-playwright-stealth-experiment'
  // routes through patchright (loaded lazily) for diagnostics on owned/staging
  // pages; never used to evade third-party bot detection.
  readonly browserMode?: ManualBrowserMode;
}

const extensionPathWithExtraHostPermissions = async (
  baseExtensionPath: string,
  extraHostPermissions: readonly string[] | undefined,
  options: { readonly stableCacheDir?: string } = {},
): Promise<{ readonly extensionPath: string; readonly cleanupPath?: string }> => {
  if (extraHostPermissions === undefined || extraHostPermissions.length === 0) {
    return { extensionPath: baseExtensionPath };
  }
  // When stableCacheDir is provided, write to that path so Chrome derives
  // the same extension ID across runs — chrome.storage.local (where the
  // side panel keeps workstreams under sidetrack.workstreams) is keyed
  // by extension ID. Without a stable load path Chrome mints a fresh ID
  // per run, which orphans the prior ID's storage and the user's
  // workstreams effectively disappear.
  if (options.stableCacheDir !== undefined && options.stableCacheDir.length > 0) {
    const extensionPath = options.stableCacheDir;
    await rm(extensionPath, { recursive: true, force: true });
    await mkdir(extensionPath, { recursive: true });
    await cp(baseExtensionPath, extensionPath, { recursive: true });
    const manifestPath = path.join(extensionPath, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    const existing = Array.isArray(manifest.host_permissions)
      ? manifest.host_permissions.filter((value): value is string => typeof value === 'string')
      : [];
    manifest.host_permissions = [...new Set([...existing, ...extraHostPermissions])];
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    // No cleanupPath — the dir is meant to stay across runs.
    return { extensionPath };
  }
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'sidetrack-extension-e2e-hosts-'));
  const extensionPath = path.join(tempRoot, 'chrome-mv3');
  await cp(baseExtensionPath, extensionPath, { recursive: true });
  const manifestPath = path.join(extensionPath, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  const existing = Array.isArray(manifest.host_permissions)
    ? manifest.host_permissions.filter((value): value is string => typeof value === 'string')
    : [];
  manifest.host_permissions = [...new Set([...existing, ...extraHostPermissions])];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { extensionPath, cleanupPath: tempRoot };
};

export const launchExtensionRuntime = async (
  options: LaunchOptions = {},
): Promise<ExtensionRuntime> => {
  const modeConfig = resolveManualBrowserMode({
    requestedMode: options.browserMode,
    env: process.env,
    defaultMode: 'persistent-playwright-manual',
  });
  const cdpUrl = process.env.SIDETRACK_E2E_CDP_URL;
  if (
    cdpUrl !== undefined &&
    cdpUrl.length > 0 &&
    options.forceLocalProfile !== true &&
    !modeConfig.stealthExperiment
  ) {
    return await attachOverCdp(cdpUrl);
  }
  if (cdpUrl !== undefined && cdpUrl.length > 0 && modeConfig.stealthExperiment) {
    console.warn(
      '[runtime] SIDETRACK_E2E_CDP_URL ignored for stealth experiment; using a Sidetrack-owned test profile.',
    );
  }
  // Under stealth/manual recording, use a stable cache dir for the
  // host-permission-widened extension copy. Same path → same extension
  // ID → chrome.storage (workstreams) survives across runs.
  const stableExtensionCacheDir =
    modeConfig.stealthExperiment && options.userDataDir === undefined
      ? expandHomeDir('~/.sidetrack-stealth-extension')
      : undefined;
  const extensionForLaunch = await extensionPathWithExtraHostPermissions(
    readExtensionPath(),
    options.extraHostPermissions,
    stableExtensionCacheDir === undefined ? {} : { stableCacheDir: stableExtensionCacheDir },
  );
  const extensionPath = extensionForLaunch.extensionPath;
  // SIDETRACK_USER_DATA_DIR lets the dev pin a long-lived profile (e.g.
  // ~/.sidetrack-test-profile) so logins to chatgpt.com / claude.ai /
  // gemini.google.com survive across runs. When unset, every run gets a
  // fresh tmpdir profile that's wiped on close. Stealth experiment mode
  // uses a Sidetrack-owned default dir under $HOME so manual logins
  // survive without mixing with the user's actual Chrome profile
  // (Patchright's Chromium can't cleanly load the unpacked MV3
  // extension into a profile that was last used by Chrome stable).
  const stealthDefaultDir = expandHomeDir('~/.sidetrack-stealth-profile');
  const persistentDir = modeConfig.stealthExperiment
    ? (process.env.SIDETRACK_STEALTH_USER_DATA_DIR ?? stealthDefaultDir)
    : process.env.SIDETRACK_USER_DATA_DIR;
  const callerDir = options.userDataDir;
  const userDataDir =
    callerDir !== undefined && callerDir.length > 0
      ? (await mkdir(callerDir, { recursive: true }), callerDir)
      : persistentDir !== undefined && persistentDir.length > 0
        ? (await mkdir(persistentDir, { recursive: true }), persistentDir)
        : await mkdtemp(path.join(tmpdir(), 'sidetrack-extension-e2e-profile-'));
  // Caller-supplied dirs are managed by the caller (so they can do
  // close → re-launch). Env-supplied long-lived profiles persist
  // across runs. Only the auto-mkdtemp path cleans up on close.
  const cleanupOnClose =
    (callerDir === undefined || callerDir.length === 0) &&
    (persistentDir === undefined || persistentDir.length === 0);
  const headless = process.env.SIDETRACK_E2E_HEADLESS !== '0';
  if (modeConfig.stealthExperiment && headless) {
    throw new Error('Stealth experiment mode is headed/manual only; set SIDETRACK_E2E_HEADLESS=0.');
  }
  // Use Chrome stable when a persistent profile is requested (the
  // login-test-profile script uses Chrome to bypass Google's OAuth
  // automation block, and the same profile must be opened with the
  // same browser to read its cookies). Default to Playwright's
  // Chromium for the throwaway-profile path. Stealth experiment
  // mode forces patchright Chromium so its CDP-mask is in effect.
  const channel =
    process.env.SIDETRACK_E2E_BROWSER ??
    (modeConfig.stealthExperiment ? 'chromium' : cleanupOnClose ? 'chromium' : 'chrome');
  // Optional CDP exposure so an operator can attach Playwright /
  // chromium.connectOverCDP and inspect the live recorder session.
  // Set SIDETRACK_E2E_CDP_DEBUG_PORT=9223 (or any free port) to enable.
  // Defeats stealth — only use for debugging.
  //
  // The recorder launches two browsers (A + B) in the same process;
  // they can't share a port. Allocate sequentially: A gets the base
  // port, B gets base+1, etc. The console.warn line below makes the
  // actual port for THIS browser visible so the operator knows which
  // CDP endpoint maps to which browser.
  const baseCdpPort = (process.env.SIDETRACK_E2E_CDP_DEBUG_PORT ?? '').trim();
  const cdpDebugPort = (() => {
    if (baseCdpPort.length === 0) return '';
    const base = Number.parseInt(baseCdpPort, 10);
    if (!Number.isFinite(base) || base <= 0) return '';
    const allocated = base + cdpAllocationIndex;
    cdpAllocationIndex += 1;
    return String(allocated);
  })();
  const launchArgs = [
    ...(headless ? ['--headless=new'] : []),
    '--no-first-run',
    '--no-default-browser-check',
    ...(modeConfig.stealthExperiment ? [] : ['--disable-blink-features=AutomationControlled']),
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    ...(cdpDebugPort.length > 0
      ? [`--remote-debugging-port=${cdpDebugPort}`, '--remote-allow-origins=*']
      : []),
  ];
  if (cdpDebugPort.length > 0) {
    console.warn(
      `[recorder] CDP debug port enabled at http://localhost:${cdpDebugPort} — attach via chromium.connectOverCDP`,
    );
  }
  const launchOptions = {
    channel,
    headless,
    ignoreDefaultArgs: ['--disable-extensions', '--enable-automation'],
    viewport: modeConfig.stealthExperiment ? null : { width: 1280, height: 900 },
    args: launchArgs,
  };
  if (modeConfig.stealthExperiment && !stealthExperimentWarningPrinted) {
    stealthExperimentWarningPrinted = true;
    console.warn(STEALTH_EXPERIMENT_WARNING);
  }
  const launchPromise = modeConfig.stealthExperiment
    ? launchStealthPersistentContext({ userDataDir, options: launchOptions })
    : chromium
        .launchPersistentContext(userDataDir, launchOptions)
        .then((context) => ({ context, patchrightLoaded: false }));
  const launched = await launchPromise.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('ProcessSingleton')) {
      throw new Error(
        `Could not lock the user-data dir at ${userDataDir}. ` +
          `Another Chrome process (likely the one started by ` +
          `\`bun run e2e:login\`) still holds it. Close that window ` +
          `(Cmd-Q on the login window) and re-run.`,
      );
    }
    throw error;
  });
  const { context, patchrightLoaded } = launched;
  const worker = await waitForExtensionWorker(context);
  const extensionId = extensionIdFromWorker(worker);
  if (stableExtensionCacheDir !== undefined) {
    console.warn(
      '[runtime] Reloading stable stealth extension from disk so Chrome does not reuse a stale MV3 service worker.',
    );
    await reloadExtensionFromDisk(context, extensionId, worker);
  }

  return {
    context,
    extensionId,
    extensionPath,
    userDataDir,
    metadata: {
      browserMode: modeConfig.mode,
      browserChannel: channel,
      cdpAttached: false,
      patchrightLoaded,
      headed: !headless,
    },
    async sendRuntimeMessage(senderPage: Page, message: unknown) {
      // Try the page first (normal Playwright path, extension chrome
      // is bound to the main world on chrome-extension:// pages).
      // Under Patchright stealth the page's chrome is the web chrome
      // (csi/loadTimes only) and chrome.runtime is undefined — fall
      // back to a SW-driven path that sidesteps the SW→SW sendMessage
      // loop (Chrome doesn't deliver chrome.runtime.sendMessage to the
      // sender's own context, so SW.evaluate(sendMessage) gets no
      // responder).
      const pageResult = await evaluateInMainWorld(
        senderPage,
        async (runtimeMessage) => {
          const c = (globalThis as { chrome?: { runtime?: { sendMessage?: unknown } } }).chrome;
          if (c?.runtime?.sendMessage === undefined) {
            return { ok: false } as const;
          }
          const response = (await chrome.runtime.sendMessage(runtimeMessage)) as unknown;
          return { ok: true, response } as const;
        },
        message,
      ).catch(() => ({ ok: false }) as const);
      if (pageResult.ok) return pageResult.response;
      // Fallback: invoke the SW's chrome.runtime.onMessage listener
      // directly via the `__sidetrackTestDispatchMessage` test hook
      // (registered in background.ts alongside the listener). Chrome
      // doesn't deliver chrome.runtime.sendMessage to the sender's own
      // context, and chrome.scripting.executeScript refuses to inject
      // into chrome-extension:// pages, so the test hook is the only
      // way to reach SW message handlers from worker.evaluate.
      const sw = await getExtensionServiceWorker(context, extensionId);
      return await sw.evaluate(async (msg: unknown) => {
        const hook = (
          globalThis as unknown as {
            __sidetrackTestDispatchMessage?: (m: unknown) => Promise<unknown>;
          }
        ).__sidetrackTestDispatchMessage;
        if (hook === undefined) {
          throw new Error(
            'sendRuntimeMessage: __sidetrackTestDispatchMessage not installed on SW globalThis — rebuild the extension.',
          );
        }
        return await hook(msg);
      }, message);
    },
    async seedStorage(senderPage: Page, values: Record<string, unknown>) {
      const pageOk = await evaluateInMainWorld(
        senderPage,
        async ({ vals, retries, intervalMs }) => {
          const c = (
            globalThis as unknown as {
              chrome?: { storage?: { local?: { set?: (v: unknown) => Promise<void> } } };
            }
          ).chrome;
          const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
          for (let i = 0; i < retries; i += 1) {
            const setFn = c?.storage?.local?.set;
            if (typeof setFn === 'function') {
              await setFn.call(c?.storage?.local, vals);
              return true;
            }
            await sleep(intervalMs);
          }
          return false;
        },
        { vals: values, retries: 10, intervalMs: 100 },
      ).catch(() => false);
      if (pageOk) return;
      // Patchright stealth: chrome.* not on the page world. Seed via
      // the extension service worker — it owns chrome.storage.local
      // directly.
      const sw = await getExtensionServiceWorker(context, extensionId);
      await sw.evaluate(async (vals: Record<string, unknown>) => {
        await chrome.storage.local.set(vals);
      }, values);
    },
    async clearStorage(senderPage: Page) {
      const pageOk = await evaluateInMainWorld(
        senderPage,
        async ({ retries, intervalMs }) => {
          const c = (
            globalThis as unknown as {
              chrome?: {
                storage?: {
                  local?: { clear?: () => Promise<void> };
                  session?: { clear?: () => Promise<void> };
                };
              };
            }
          ).chrome;
          const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
          for (let i = 0; i < retries; i += 1) {
            const clearLocal = c?.storage?.local?.clear;
            if (typeof clearLocal === 'function') {
              await clearLocal.call(c?.storage?.local);
              const clearSession = c?.storage?.session?.clear;
              if (typeof clearSession === 'function') {
                await clearSession.call(c?.storage?.session);
              }
              return true;
            }
            await sleep(intervalMs);
          }
          return false;
        },
        { retries: 10, intervalMs: 100 },
      ).catch(() => false);
      if (pageOk) return;
      const sw = await getExtensionServiceWorker(context, extensionId);
      await sw.evaluate(async () => {
        await chrome.storage.local.clear();
        if (chrome.storage.session !== undefined) {
          await chrome.storage.session.clear();
        }
      });
    },
    async close() {
      try {
        await context.close();
      } finally {
        if (cleanupOnClose) {
          await rm(userDataDir, { recursive: true, force: true });
        }
        if (extensionForLaunch.cleanupPath !== undefined) {
          await rm(extensionForLaunch.cleanupPath, { recursive: true, force: true });
        }
      }
    },
  };
};
