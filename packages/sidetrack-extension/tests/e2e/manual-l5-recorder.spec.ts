// Manual full-browser recorder — NOT a CI test.
//
// Two entry points (both run in stealth mode):
//   e2e:recorder        Reuse existing vault as-is
//   e2e:recorder:fresh  Archive any existing vault to
//                       <path>.backup-<iso>, start fresh
//
// One-liner from repo root:
//   git pull && npm --prefix packages/sidetrack-extension run e2e:recorder \
//     2>&1 | tee /tmp/sidetrack-recorder.log
//
// The browser stays open until stdin advances the prompts:
//   1. first Enter after recording starts: drain Sidetrack + write artifacts
//   2. second Enter: close browsers and companion processes
//
// Defaults (override individually via env):
//   SIDETRACK_USER_DATA_DIR=~/.sidetrack-test-profile  (browser profile — sticky)
//   SIDETRACK_VAULT_DIR=~/.sidetrack-vault             (companion vault — sticky)
//   SIDETRACK_VAULT_FRESH=1                            (archive + restart fresh)
// The legacy SIDETRACK_MANUAL_L5_VAULT_DIR is still honoured for back-compat.

import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readdir, rename, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { generateRendezvousSecret } from '../../../sidetrack-companion/src/sync/relayCrypto';
import { startTestCompanion, type TestCompanion } from './helpers/companion';
import { resolveManualBrowserMode } from './helpers/manualBrowserMode';
import { ManualRecorder } from './helpers/manualRecorder';
import { startTestRelay, type TestRelay } from './helpers/relay';
import { launchExtensionRuntime, type ExtensionRuntime } from './helpers/runtime';
import { SETTINGS_KEY, SETUP_KEY } from './helpers/sidepanel';

type FlowKey = 'security' | 'switchboard';

interface VisitLink {
  readonly flow: FlowKey;
  readonly title: string;
  readonly url: string;
  readonly note: string;
}

interface ConnectionsEnvelope {
  readonly data?: {
    readonly snapshot?: {
      readonly nodes?: readonly {
        readonly id?: string;
        readonly kind?: string;
        readonly label?: string;
      }[];
      readonly edges?: readonly {
        readonly id?: string;
        readonly kind?: string;
        readonly fromNodeId?: string;
        readonly toNodeId?: string;
      }[];
    };
  };
}

const RECORDER_HOST_PERMISSIONS = ['https://*/*', 'http://*/*'] as const;
const PROFILE_ENV = 'SIDETRACK_USER_DATA_DIR';
const DEFAULT_PROFILE = '~/.sidetrack-test-profile';

const VISIT_LINKS: readonly VisitLink[] = [
  {
    flow: 'security',
    title: 'HN: copy-fail discussion',
    url: 'https://news.ycombinator.com/item?id=47952181',
    note: 'Start here, then use page links where possible.',
  },
  {
    flow: 'security',
    title: 'xint.io: copy-fail across Linux distributions',
    url: 'https://xint.io/blog/copy-fail-linux-distributions',
    note: 'Read through, then continue to copy.fail and the GitHub exploit link.',
  },
  {
    flow: 'security',
    title: 'Google: Linux crypto subsystem',
    url: 'https://www.google.com/search?q=Linux+crypto+subsystem',
    note: 'Search context for the Linux crypto subsystem.',
  },
  {
    flow: 'security',
    title: 'ChatGPT: copy-fail analysis thread',
    url: 'https://chatgpt.com/c/69fb9815-41f8-8329-a790-edfa4b914dfd',
    note: 'Logged-in profile may be needed.',
  },
  {
    flow: 'security',
    title: 'copy.fail landing page',
    url: 'https://copy.fail/',
    note: 'Copy a useful snippet from this page.',
  },
  {
    flow: 'security',
    title: 'GitHub: copy_fail_exp.py',
    url: 'https://github.com/theori-io/copy-fail-CVE-2026-31431/blob/main/copy_fail_exp.py',
    note: 'Paste the copy.fail snippet into a coding-agent prompt/input if available.',
  },
  {
    flow: 'switchboard',
    title: 'GitHub: zyingfei/switchboard',
    url: 'https://github.com/zyingfei/switchboard',
    note: 'Start Switchboard PR review flow here.',
  },
  {
    flow: 'switchboard',
    title: 'GitHub: Switchboard PRs',
    url: 'https://github.com/zyingfei/switchboard/pulls',
    note: 'Review open PR list.',
  },
  {
    flow: 'switchboard',
    title: 'ChatGPT: Switchboard project thread',
    url: 'https://chatgpt.com/g/g-p-69ec077b42948191a1fd309d64a860ae-switchboard/c/69fd259a-83b0-8326-a4d9-c4c1b76a5986',
    note: 'Logged-in profile may be needed.',
  },
  {
    flow: 'switchboard',
    title: 'ChatGPT: sibling analysis thread',
    url: 'https://chatgpt.com/g/g-p-69ec077b42948191a1fd309d64a860ae/c/69fcb926-3a98-8328-bbe4-baee4da7fbef',
    note: 'Parallel ChatGPT analysis.',
  },
  {
    flow: 'switchboard',
    title: 'YouTube: ambient context',
    url: 'https://www.youtube.com/watch?v=rY44ViY45q8',
    note: 'Keep Switchboard workstream active before opening this ambient visit.',
  },
  {
    flow: 'switchboard',
    title: 'Gemini: Switchboard analysis',
    url: 'https://gemini.google.com/app/7a97310e824ccad4?hl=en-US',
    note: 'Logged-in profile may be needed.',
  },
] as const;

const expandTilde = (input: string): string =>
  input.startsWith('~') ? path.join(homedir(), input.slice(1).replace(/^[/\\]/u, '')) : input;

const isoStamp = (): string => new Date().toISOString().replace(/[:.]/gu, '-');

const waitForEnter = async (label: string): Promise<void> => {
  // eslint-disable-next-line no-console
  console.log(label);
  process.stdin.resume();
  await new Promise<void>((resolve) => {
    process.stdin.once('data', () => {
      resolve();
    });
  });
};

const vaultHasData = async (vaultRoot: string): Promise<boolean> => {
  // Sidetrack writes vault state under `<vaultRoot>/_BAC/`. Presence is
  // a good-enough proxy for "this directory has prior recording data".
  try {
    await access(path.join(vaultRoot, '_BAC'));
    return true;
  } catch {
    return false;
  }
};

// Vault resolution is non-interactive. Two npm entry points:
//   e2e:recorder        — reuse the existing vault as-is (companion
//                         starts with all prior workstreams + history).
//   e2e:recorder:fresh  — sets SIDETRACK_VAULT_FRESH=1, which archives
//                         any existing vault to <path>.backup-<iso>
//                         and starts fresh at the canonical path.
// The interactive "press n" prompt was unreliable under Playwright's
// stdin handling — separate scripts are simpler and never wedge.
const resolveVaultRoot = async (defaultPath: string): Promise<string> => {
  const resolved = expandTilde(defaultPath);
  const wantsFresh = process.env.SIDETRACK_VAULT_FRESH === '1';
  if (wantsFresh && (await vaultHasData(resolved))) {
    const backup = `${resolved}.backup-${isoStamp()}`;
    await rename(resolved, backup);
    // eslint-disable-next-line no-console
    console.log(`[recorder] Archived previous vault to ${backup}`);
  }
  // eslint-disable-next-line no-console
  console.log(
    wantsFresh
      ? `[recorder] Starting fresh vault at ${resolved}`
      : (await vaultHasData(resolved))
        ? `[recorder] Reusing existing vault at ${resolved}`
        : `[recorder] Using vault: ${resolved} (no prior data)`,
  );
  return resolved;
};

const withTimeout = async <T>(
  label: string,
  task: Promise<T>,
  timeoutMs = 10_000,
): Promise<T | { readonly timeout: true; readonly label: string; readonly timeoutMs: number }> =>
  await Promise.race([
    task,
    new Promise<{ readonly timeout: true; readonly label: string; readonly timeoutMs: number }>(
      (resolve) => {
        setTimeout(() => {
          resolve({ timeout: true, label, timeoutMs });
        }, timeoutMs);
      },
    ),
  ]);

const apiGet = async (comp: TestCompanion, requestPath: string): Promise<unknown> => {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, 10_000);
  try {
    const res = await fetch(`http://127.0.0.1:${String(comp.port)}${requestPath}`, {
      headers: { 'x-bac-bridge-key': comp.bridgeKey },
      signal: controller.signal,
    });
    if (!res.ok)
      throw new Error(`GET ${requestPath} failed: ${String(res.status)} ${await res.text()}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
};

const apiPost = async (
  comp: TestCompanion,
  requestPath: string,
  body: unknown,
): Promise<unknown> => {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, 10_000);
  try {
    const res = await fetch(`http://127.0.0.1:${String(comp.port)}${requestPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bac-bridge-key': comp.bridgeKey,
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok)
      throw new Error(`POST ${requestPath} failed: ${String(res.status)} ${await res.text()}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
};

// Resolve the build's git identity for the recorder banner. The
// recorder runs from a working tree, so showing branch + short SHA +
// dirty marker lets the operator confirm which code the running
// companion + extension are built from — load-bearing when fixes
// land on a feature branch and the operator wants to verify them
// without a `git log` round-trip.
interface VersionInfo {
  readonly branch: string;
  readonly commit: string;
  readonly dirty: boolean;
}

const readVersionInfo = (): VersionInfo => {
  const gitTrim = (args: string): string => {
    try {
      return execSync(`git ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .trim();
    } catch {
      return '';
    }
  };
  const branch = gitTrim('symbolic-ref --short HEAD') || 'detached';
  const commit = gitTrim('rev-parse --short HEAD') || 'unknown';
  const dirty = gitTrim('status --porcelain --untracked-files=no').length > 0;
  return { branch, commit, dirty };
};

const openPrivacyGate = async (comp: TestCompanion, gate: string): Promise<void> => {
  await apiPost(comp, '/v1/privacy/events', {
    type: 'privacy.gate.flipped',
    payload: {
      payloadVersion: 1,
      gate,
      state: 'open',
      actor: 'user',
      reason: 'manual-recorder',
    },
  });
};

const openRecorderSidepanel = async (
  runtime: ExtensionRuntime,
  comp: TestCompanion,
): Promise<Page> => {
  const page = await runtime.context.newPage();
  await page.goto(`chrome-extension://${runtime.extensionId}/sidepanel.html`, {
    waitUntil: 'domcontentloaded',
  });
  // When the operator picked `e2e:recorder:fresh`, the companion vault
  // was already moved to backup. But the extension caches its
  // projections (workstreams, active workstream id, tab sessions, …)
  // in chrome.storage.local under the browser profile — that profile
  // is sticky across runs so the cache survives. Wipe it now, before
  // the panel seeds, so the user sees a truly empty slate.
  // Uses runtime.clearStorage so the evaluate runs in the main world
  // (patchright's default isolated context can't see chrome.*).
  if (process.env.SIDETRACK_VAULT_FRESH === '1') {
    await runtime.clearStorage(page);
    // eslint-disable-next-line no-console
    console.log('[recorder] Cleared chrome.storage.local for fresh-vault run');
  }
  // Seed only what's needed to pair the side panel with the spawned
  // companion. Workstreams + activeWorkstreamId stay un-seeded so the
  // recording is fully organic — the user creates / picks workstreams
  // through the panel UI like they would in production.
  await runtime.seedStorage(page, {
    [SETUP_KEY]: true,
    [SETTINGS_KEY]: {
      companion: { port: comp.port, bridgeKey: comp.bridgeKey },
      autoTrack: true,
      siteToggles: { chatgpt: true, claude: true, gemini: true, codex: true },
      notifyOnQueueComplete: true,
    },
    'sidetrack.timeline.enabled': true,
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('main', { name: 'Sidetrack workboard' })).toBeVisible({
    timeout: 30_000,
  });
  return page;
};

const reinitializeTimeline = async (runtime: ExtensionRuntime, panel: Page): Promise<void> => {
  const result = (await runtime.sendRuntimeMessage(panel, {
    type: 'sidetrack.timeline.reinit',
  })) as { readonly ok?: boolean; readonly error?: string } | null;
  if (result?.ok !== true) {
    throw new Error(result?.error ?? 'timeline reinit failed');
  }
  const gateChanged = (await runtime.sendRuntimeMessage(panel, {
    type: 'sidetrack.privacy.gateChanged',
  })) as { readonly ok?: boolean; readonly error?: string } | null;
  if (gateChanged?.ok !== true) {
    throw new Error(gateChanged?.error ?? 'privacy gateChanged failed');
  }
};

const grantDeeperPageAccessIfNeeded = async (panel: Page): Promise<void> => {
  await panel.getByRole('button', { name: 'Settings' }).click();
  const timelineSection = panel.getByTestId('settings-timeline-section');
  await expect(timelineSection).toBeVisible({ timeout: 10_000 });
  await timelineSection.scrollIntoViewIfNeeded();
  const grantButton = panel.getByTestId('settings-timeline-grant-permission');
  if (await grantButton.isVisible().catch(() => false)) {
    await grantButton.click();
  }
  await panel.locator('button.btn.btn-ghost', { hasText: 'Close' }).click();
};

// Stage 5 follow-up — periodically dump the SW dev.diag stash to
// disk during long-running recorder sessions. Lets the operator
// (or me) inspect `wiring.lastOnUpdated` / `observer.lastDecision` /
// `contentTitleSink.hits` post-hoc without opening the SW DevTools.
//
// The dumper triggers a `sidetrack.dev.diag` message (which writes
// the stash to chrome.storage.session via the SW handler), then
// reads the stash and writes a per-tick file under
// <artifactsDir>/sw-diag/<isoTimestamp>.json.
const dumpSwDiagOnce = async (
  runtime: ExtensionRuntime,
  panel: Page,
  outDir: string,
  label: string,
): Promise<void> => {
  // The SW's `sidetrack.dev.diag` handler responds with
  // `{ok, diagnostics}` AND stashes a copy in chrome.storage.session.
  // First try the direct response (works when the SW message port
  // stays open). If that returns null (port closed mid-flight, common
  // under stealth Chromium), fall back to the session-storage stash.
  let response: unknown = null;
  try {
    response = await runtime.sendRuntimeMessage(panel, {
      type: 'sidetrack.dev.diag',
    });
  } catch {
    response = null;
  }
  let stash: unknown = response;
  const responseHasDiagnostics =
    typeof stash === 'object' &&
    stash !== null &&
    (stash as { diagnostics?: unknown }).diagnostics !== undefined;
  if (!responseHasDiagnostics) {
    // Give chrome.storage.session a beat to settle after the dev.diag
    // handler's async stash write.
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      stash = await (
        panel as unknown as {
          evaluate: (fn: () => Promise<unknown>) => Promise<unknown>;
        }
      ).evaluate(async () => {
        const c = (globalThis as unknown as { chrome?: typeof chrome }).chrome;
        if (c === undefined) return null;
        try {
          const sessionStorage = (c.storage as { readonly session?: typeof c.storage.local })
            .session;
          if (sessionStorage === undefined) return null;
          const got = await sessionStorage.get('sidetrack.dev.diag');
          return got['sidetrack.dev.diag'] ?? null;
        } catch {
          return null;
        }
      });
    } catch {
      stash = null;
    }
  }
  // Also pull the engagement journal from session storage so the
  // artifact gives a full picture of what the engagement subsystem
  // did between dumps. Same evaluate pattern; tolerates missing
  // storage.session.
  let engagementDiag: unknown = null;
  try {
    engagementDiag = await (
      panel as unknown as { evaluate: (fn: () => Promise<unknown>) => Promise<unknown> }
    ).evaluate(async () => {
      const c = (globalThis as unknown as { chrome?: typeof chrome }).chrome;
      if (c === undefined) return null;
      try {
        const sessionStorage = (c.storage as { readonly session?: typeof c.storage.local }).session;
        if (sessionStorage === undefined) return null;
        const got = await sessionStorage.get('sidetrack.engagement.diag');
        return got['sidetrack.engagement.diag'] ?? null;
      } catch {
        return null;
      }
    });
  } catch {
    engagementDiag = null;
  }
  // Also inspect what the side panel sees from chrome.scripting (is the
  // engagement script registered?) and chrome.permissions (does the
  // browser still report host access?) so the artifact captures the
  // full state in one place.
  let extensionState: unknown = null;
  try {
    extensionState = await (
      panel as unknown as { evaluate: (fn: () => Promise<unknown>) => Promise<unknown> }
    ).evaluate(async () => {
      const c = (globalThis as unknown as { chrome?: typeof chrome }).chrome;
      if (c === undefined) return null;
      try {
        const registrations = await c.scripting.getRegisteredContentScripts({
          ids: ['sidetrack-engagement'],
        });
        const hostPermission = await new Promise<boolean>((resolve) => {
          c.permissions.contains({ origins: ['https://*/*', 'http://*/*'] }, (g) => {
            resolve(Boolean(g));
          });
        });
        const tabs = await c.tabs.query({ url: ['https://*/*', 'http://*/*'] });
        return {
          engagementRegistrations: registrations,
          hostPermission,
          httpTabCount: tabs.length,
          sampleTabs: tabs.slice(0, 3).map((t) => ({ id: t.id ?? null, url: t.url?.slice(0, 80) ?? null })),
        };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    });
  } catch {
    extensionState = null;
  }
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  await writeFile(
    path.join(outDir, `${stamp}-${label}.json`),
    `${JSON.stringify({ swDiag: stash, engagementDiag, extensionState }, null, 2)}\n`,
    'utf8',
  );
};

const startPeriodicSwDiagDump = (
  runtimes: readonly { readonly label: string; readonly runtime: ExtensionRuntime; readonly panel: Page }[],
  outDir: string,
  intervalMs: number,
): { readonly stop: () => Promise<void> } => {
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    for (const { label, runtime, panel } of runtimes) {
      try {
        await dumpSwDiagOnce(runtime, panel, outDir, label);
      } catch {
        // Periodic best-effort — never fail the recorder on a dump miss.
      }
    }
  };
  // First tick immediately so the operator gets an early snapshot.
  void tick();
  const handle = setInterval(() => {
    void tick();
  }, intervalMs);
  return {
    stop: () => {
      stopped = true;
      clearInterval(handle);
      return Promise.resolve();
    },
  };
};

const drainRuntime = async (
  runtime: ExtensionRuntime,
  panel: Page,
): Promise<{
  readonly timeline: unknown;
  readonly edgeEvents: unknown;
}> => {
  const timeline = await withTimeout(
    'sidetrack.timeline.force-drain',
    runtime.sendRuntimeMessage(panel, {
      type: 'sidetrack.timeline.force-drain',
    }),
    15_000,
  );
  const edgeEvents = await withTimeout(
    'sidetrack.edge-events.force-drain',
    runtime.sendRuntimeMessage(panel, {
      type: 'sidetrack.edge-events.force-drain',
    }),
    15_000,
  );
  return { timeline, edgeEvents };
};

const writeJson = async (filePath: string, value: unknown): Promise<void> => {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const createLaunchpad = async (
  artifactsDir: string,
  input: {
    readonly browserPanelUrl: string;
    readonly reviewerPanelUrl: string;
  },
): Promise<string> => {
  const linkSections = (flow: FlowKey): string =>
    VISIT_LINKS.filter((link) => link.flow === flow)
      .map(
        (link) => `
          <li>
            <a href="${link.url}" target="_blank" rel="noreferrer" data-open-live-link>${link.title}</a>
            <small>${link.note}</small>
          </li>`,
      )
      .join('\n');

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Sidetrack manual recorder launchpad</title>
  <style>
    body { font: 15px/1.45 system-ui, sans-serif; margin: 32px; max-width: 1120px; }
    header { display: flex; align-items: baseline; gap: 16px; border-bottom: 1px solid #ddd; }
    h1 { font-size: 24px; margin: 0 0 12px; }
    h2 { font-size: 18px; margin: 28px 0 8px; }
    ol, ul { padding-left: 24px; }
    li { margin: 8px 0; }
    a { color: #0b57d0; }
    small { display: block; color: #555; margin-top: 2px; }
    code { background: #f4f4f4; padding: 2px 5px; border-radius: 4px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; }
    #lp-status {
      margin-top: 12px;
      padding: 8px 12px;
      background: #fff8c5;
      border: 1px solid #d4a72c;
      border-radius: 4px;
      font-family: ui-monospace, monospace;
      font-size: 13px;
      display: none;
    }
    #lp-status.lp-ok { background: #dafbe1; border-color: #1a7f37; }
    #lp-status.lp-fail { background: #ffebe9; border-color: #cf222e; }
  </style>
</head>
<body>
  <header>
    <h1>Sidetrack manual recorder</h1>
    <span>Artifacts are written locally under <code>${artifactsDir}</code>.</span>
  </header>
  <div id="lp-status"></div>
  <h2>Before clicking links</h2>
  <ol>
    <li>Open the Browser A side panel and create whatever workstreams you want for this session — they persist across reruns now, so reuse last session's if you'd like.</li>
    <li>Pick the active workstream pill that matches what you're about to research before clicking the launchpad links below.</li>
    <li>Browser A panel: <a href="${input.browserPanelUrl}" target="_blank" rel="noreferrer" data-open-live-link>${input.browserPanelUrl}</a>.</li>
    <li>Reviewer panel: <a href="${input.reviewerPanelUrl}" target="_blank" rel="noreferrer" data-open-live-link>${input.reviewerPanelUrl}</a>.</li>
  </ol>
  <div class="grid">
    <section>
      <h2>Flow A: security research</h2>
      <ul>${linkSections('security')}</ul>
    </section>
    <section>
      <h2>Flow B: Switchboard PR review</h2>
      <ul>${linkSections('switchboard')}</ul>
    </section>
  </div>
  <script>
    // Plain <a target="_blank"> from a file:// opener under stealth/CFT
    // leaves the new tab spinning on about:blank because the popup
    // inherits the file:// opener and cross-origin navigation gets blocked.
    // Programmatic window.open() with opener detached sidesteps the issue.
    const status = document.getElementById('lp-status');
    const setStatus = (msg, kind) => {
      if (!status) return;
      status.textContent = '[launchpad] ' + msg;
      status.className = kind ? 'lp-' + kind : '';
      status.style.display = 'block';
    };
    setStatus('inline script ready; click any link to test handler', 'ok');
    document.addEventListener('click', (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element
        ? event.target.closest('a[data-open-live-link]')
        : null;
      if (!(target instanceof HTMLAnchorElement)) {
        setStatus('click ignored (target=' + (event.target instanceof Element ? event.target.tagName : 'non-element') + ')');
        return;
      }
      event.preventDefault();
      setStatus('opening: ' + target.href);
      const opened = window.open(target.href, '_blank');
      if (opened === null) {
        setStatus('window.open returned null; falling back to in-place navigation', 'fail');
        window.location.href = target.href;
        return;
      }
      try {
        opened.opener = null;
      } catch (e) {
        setStatus('opener detach threw: ' + (e instanceof Error ? e.message : String(e)), 'fail');
      }
      opened.focus();
      setStatus('opened new tab for ' + target.href, 'ok');
    });
  </script>
</body>
</html>
`;
  const launchpadPath = path.join(artifactsDir, 'launchpad.html');
  await writeFile(launchpadPath, html, 'utf8');
  return `file://${launchpadPath}`;
};

const dumpCompanionState = async (
  artifactsDir: string,
  label: string,
  comp: TestCompanion,
): Promise<void> => {
  const targetDir = path.join(artifactsDir, 'companion', label);
  await mkdir(targetDir, { recursive: true });
  const endpoints = [
    '/v1/timeline',
    '/v1/connections',
    '/v1/feedback/projection',
    '/v1/privacy/projection',
    '/v1/collectors',
    '/v1/dispatches',
  ] as const;
  for (const endpoint of endpoints) {
    const file = endpoint.replace(/^\/v1\//u, '').replace(/[^a-z0-9]+/giu, '-');
    const value = await apiGet(comp, endpoint).catch((error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
    }));
    await writeJson(path.join(targetDir, `${file}.json`), value);
  }
};

const renderConnectionsForReview = async (
  panel: Page,
  workstreamId: string,
  artifactsDir: string,
  label: string,
): Promise<void> => {
  await panel.getByRole('tab', { name: 'Connections' }).click();
  await expect(panel.getByTestId('connections-view')).toBeVisible({ timeout: 20_000 });
  const input = panel.getByTestId('connections-anchor-input');
  await input.click();
  await input.fill(`workstream:${workstreamId}`);
  await input.press('Enter');
  await panel.getByTestId('connections-hops-select').selectOption('3');
  await panel.getByTestId('connections-view').screenshot({
    path: path.join(artifactsDir, `${label}-connections.png`),
  });
};

interface CompanionWorkstream {
  readonly bac_id: string;
  readonly title: string;
}

const listUserWorkstreams = async (comp: TestCompanion): Promise<readonly CompanionWorkstream[]> => {
  const url = `http://127.0.0.1:${String(comp.port)}/v1/workstreams/projections`;
  const response = await fetch(url, { headers: { 'x-bac-bridge-key': comp.bridgeKey } });
  if (!response.ok) return [];
  const body = (await response.json()) as {
    readonly data?: readonly {
      readonly bac_id?: unknown;
      readonly deleted?: unknown;
      readonly record?: { readonly status?: unknown; readonly value?: { readonly title?: unknown } };
    }[];
  };
  const data = body.data ?? [];
  return data.flatMap((item) => {
    if (item.deleted === true) return [];
    if (typeof item.bac_id !== 'string') return [];
    const value =
      item.record?.status === 'resolved' ? (item.record as { value?: { title?: unknown } }).value : undefined;
    const title = typeof value?.title === 'string' ? value.title : item.bac_id;
    return [{ bac_id: item.bac_id, title }];
  });
};

const waitForConnections = async (
  comp: TestCompanion,
  predicate: (env: ConnectionsEnvelope) => boolean,
  timeoutMs = 60_000,
): Promise<ConnectionsEnvelope> => {
  const started = Date.now();
  let latest: ConnectionsEnvelope = {};
  while (Date.now() - started < timeoutMs) {
    latest = (await apiGet(comp, '/v1/connections')) as ConnectionsEnvelope;
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return latest;
};

test.describe('manual full-browser recorder', () => {
  test('records user-driven real-page activity for manual review', async () => {
    test.setTimeout(0);
    process.env.SIDETRACK_E2E_HEADLESS = '0';

    const modeConfig = resolveManualBrowserMode({
      env: process.env,
      defaultMode: 'persistent-playwright-manual',
    });
    const profileDir = expandTilde(process.env[PROFILE_ENV] ?? DEFAULT_PROFILE);
    const artifactsDir = path.join(tmpdir(), 'sidetrack-recorder', isoStamp());
    await mkdir(artifactsDir, { recursive: true });

    let relay: TestRelay | undefined;
    let companionA: TestCompanion | undefined;
    let companionB: TestCompanion | undefined;
    let runtimeA: ExtensionRuntime | undefined;
    let runtimeB: ExtensionRuntime | undefined;
    try {
      relay = await startTestRelay({});
      const secret = generateRendezvousSecret().toString('base64url');
      // Persist Companion A's vault across reruns so workstreams +
      // connections + threads the user creates in one session survive
      // the next run. Default lives under $HOME alongside the browser
      // profile (~/.sidetrack-test-profile) so paths stay stable across
      // updates. The recorder prompts the user when the default vault
      // already has data — keep using it, or start a fresh timestamped
      // vault — so old test-stage names don't bleed into new sessions.
      // Reviewer companion B stays ephemeral.
      const vaultEnvOverride =
        process.env.SIDETRACK_VAULT_DIR ?? process.env.SIDETRACK_MANUAL_L5_VAULT_DIR;
      const persistentVaultRoot =
        vaultEnvOverride !== undefined && vaultEnvOverride.length > 0
          ? expandTilde(vaultEnvOverride)
          : await resolveVaultRoot('~/.sidetrack-vault');
      companionA = await startTestCompanion({
        syncRelay: relay.url,
        syncRendezvousSecret: secret,
        vaultDir: persistentVaultRoot,
      });
      companionB = await startTestCompanion({
        syncRelay: relay.url,
        syncRendezvousSecret: secret,
      });

      // Stealth experiment uses a Sidetrack-owned dir (resolved inside
      // launchExtensionRuntime) so Patchright's Chromium can cleanly
      // load the unpacked MV3 extension; mixing stealth Chromium with
      // the user's pinned Chrome login profile leaves chrome.storage
      // unreachable on the sidepanel page.
      const runtimeAOptions = modeConfig.stealthExperiment
        ? {}
        : { userDataDir: profileDir };
      runtimeA = await launchExtensionRuntime({
        ...runtimeAOptions,
        extraHostPermissions: RECORDER_HOST_PERMISSIONS,
        browserMode: modeConfig.mode,
      });
      const reviewerProfile = await mkdtemp(path.join(tmpdir(), 'sidetrack-recorder-reviewer-'));
      runtimeB = await launchExtensionRuntime({
        userDataDir: reviewerProfile,
        extraHostPermissions: RECORDER_HOST_PERMISSIONS,
        browserMode: modeConfig.mode,
      });

      // Patchright's _evaluateOnNewDocument is a no-op so addInitScript
      // doesn't actually inject; exposeBinding crashes Network.setCacheDisabled
      // on closed sessions under stealth. The 'page-main-world' path skips
      // both — installs hooks per page via main-world evaluate and polls a
      // queue.
      const recorder = new ManualRecorder(runtimeA.context, artifactsDir, {
        eventHookInjection: modeConfig.stealthExperiment
          ? 'page-main-world'
          : 'context-init-script',
      });
      await recorder.install();

      await openPrivacyGate(companionA, 'timeline');
      await openPrivacyGate(companionA, 'engagement');
      await openPrivacyGate(companionB, 'timeline');
      await openPrivacyGate(companionB, 'engagement');

      // No pre-seeded workstreams. The user creates whatever workstreams
      // they want via the side panel during the session; the persistent
      // companion vault keeps them across reruns. Post-record analysis
      // discovers what's there organically (see below).
      const panelA = await openRecorderSidepanel(runtimeA, companionA);
      const panelB = await openRecorderSidepanel(runtimeB, companionB);
      await reinitializeTimeline(runtimeA, panelA);
      await reinitializeTimeline(runtimeB, panelB);
      await grantDeeperPageAccessIfNeeded(panelA).catch((error: unknown) => {
        console.warn(
          `[manual-l5] permission auto-grant did not complete: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

      await recorder.record({
        kind: 'manual-session-ready',
        payload: {
          artifactsDir,
          profileDir,
          companionA: {
            port: companionA.port,
            vaultPath: companionA.vaultPath,
          },
          companionB: {
            port: companionB.port,
            vaultPath: companionB.vaultPath,
          },
        },
      });

      const launchpadUrl = await createLaunchpad(artifactsDir, {
        browserPanelUrl: `chrome-extension://${runtimeA.extensionId}/sidepanel.html`,
        reviewerPanelUrl: `chrome-extension://${runtimeB.extensionId}/sidepanel.html`,
      });
      const launchpad = await runtimeA.context.newPage();
      await launchpad.goto(launchpadUrl, { waitUntil: 'domcontentloaded' });
      await launchpad.bringToFront();

      const version = readVersionInfo();
      const versionLine = `${version.branch} @ ${version.commit}${version.dirty ? ' (dirty working tree)' : ''}`;
      const banner = `
================================================================
 SIDETRACK MANUAL RECORDER READY
================================================================

 Version          : ${versionLine}

 Browser A profile: ${profileDir}
 Browser A panel  : chrome-extension://${runtimeA.extensionId}/sidepanel.html
 Reviewer panel   : chrome-extension://${runtimeB.extensionId}/sidepanel.html

 Companion A
   URL            : http://127.0.0.1:${String(companionA.port)}
   Bridge key     : ${companionA.bridgeKey}
   Vault          : ${companionA.vaultPath}
 Companion B
   URL            : http://127.0.0.1:${String(companionB.port)}
   Bridge key     : ${companionB.bridgeKey}
   Vault          : ${companionB.vaultPath}
 Artifacts        : ${artifactsDir}

 Quick curl recipe (Companion A):
   curl -s -H 'x-bac-bridge-key: ${companionA.bridgeKey}' \\
     http://127.0.0.1:${String(companionA.port)}/v1/workstreams/projections | jq

 Manual steps:
   1. In the Browser A side panel, create the workstreams you want for
      this session (or reuse last session's — the companion vault is
      persistent now). Pick the active workstream pill before doing
      research that should land in it.
   2. Use the launchpad tab to click links. Cmd-click or middle-click
      if you want a link to open in a new tab.
   3. Switch the active workstream pill any time the focus of your
      research shifts.
   4. For dispatch flows, copy a useful snippet from a source page
      and paste it into a GitHub / coding-agent input if the page
      offers one. The recorder logs copy/paste excerpts.
   5. Tell Codex "done" when finished. The harness stops the recorder,
      drains Sidetrack, dumps connections/timeline state, and reports
      whatever workstreams + dispatches you actually created.

No video is recorded. Artifacts are JSONL events, page text/html
dumps, visible screenshots, and companion/plugin result JSON.
================================================================
`;
      // eslint-disable-next-line no-console
      console.log(banner);

      // Stage 5 follow-up — dump SW dev.diag every 20 s to
      // `<artifactsDir>/sw-diag/<iso>-{A,B}.json` so the recorder
      // session leaves behind enough evidence to diagnose
      // capture/title-sink/observer issues post-hoc.
      const swDiagDumper = startPeriodicSwDiagDump(
        [
          { label: 'A', runtime: runtimeA, panel: panelA },
          { label: 'B', runtime: runtimeB, panel: panelB },
        ],
        path.join(artifactsDir, 'sw-diag'),
        20_000,
      );
      try {
        await waitForEnter('[manual-l5] Waiting. Send Enter after the user says done...');
      } finally {
        await swDiagDumper.stop();
      }

      await recorder.snapshotAll('manual-finished');
      await recorder.writeSummary();
      const drainA = await drainRuntime(runtimeA, panelA);
      const drainB = await drainRuntime(runtimeB, panelB);
      await writeJson(path.join(artifactsDir, 'drain-results.json'), { A: drainA, B: drainB });

      // Discover whatever workstreams the user actually created during the
      // recording (organic data, not pre-seeded test fixtures). If none —
      // skip the workstream-scoped review steps without failing.
      const userWorkstreams = await listUserWorkstreams(companionA);
      if (userWorkstreams.length === 0) {
        // eslint-disable-next-line no-console
        console.log(
          '[manual-l5] no workstreams found on Companion A; skipping workstream-scoped post-actions.',
        );
      }

      // Wait briefly for relay to mirror whatever happened to companion B.
      // Doesn't assert any specific edge — that depends on what the user
      // actually did during the session.
      await waitForConnections(
        companionB,
        (env) => (env.data?.snapshot?.edges ?? []).length > 0,
        20_000,
      ).catch(() => undefined);

      await dumpCompanionState(artifactsDir, 'browser-a', companionA);
      await dumpCompanionState(artifactsDir, 'reviewer-b', companionB);
      for (const ws of userWorkstreams) {
        await renderConnectionsForReview(
          panelB,
          ws.bac_id,
          artifactsDir,
          ws.title.replaceAll(/[^a-z0-9]+/giu, '-').toLowerCase().slice(0, 32) || ws.bac_id,
        ).catch(() => undefined);
      }
      await recorder.snapshotPage(panelA, 'panel-a-final');
      await recorder.snapshotPage(panelB, 'panel-b-final');
      const summaryPath = path.join(artifactsDir, 'activity-summary.md');
      const files = await readdir(artifactsDir);
      // eslint-disable-next-line no-console
      console.log(`
================================================================
 SIDETRACK MANUAL RECORDER DUMPED ARTIFACTS
================================================================

 Summary:   ${summaryPath}
 Artifacts: ${artifactsDir}
 Top-level: ${files.join(', ')}

The browser is still open for review. Codex can now read the
summary and confirm the observed activity list with the user.

Send Enter a second time to close browsers and stop companions.
================================================================
`);

      await waitForEnter('[manual-l5] Waiting to close. Send Enter when review is complete...');
    } finally {
      await runtimeB?.close();
      await runtimeA?.close();
      await companionB?.close();
      await companionA?.close();
      await relay?.close();
    }
  });
});
