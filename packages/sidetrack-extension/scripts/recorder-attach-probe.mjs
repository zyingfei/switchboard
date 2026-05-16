// Attach to the user's running recorder via CDP, read the engagement
// journal + inbox state, browse HN slowly, then read state again.
// Non-destructive: never closes existing tabs, only opens new ones.
//
// Requires the recorder to have been launched with:
//   SIDETRACK_E2E_CDP_DEBUG_PORT=9223 bun run --cwd packages/sidetrack-extension e2e:recorder

import { chromium } from 'playwright';

const cdpUrl = process.env.SIDETRACK_E2E_CDP_URL ?? 'http://localhost:9223';

const log = (label, value) => {
  console.log(`\n=== ${label} ===`);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
};

const main = async () => {
  const browser = await chromium.connectOverCDP(cdpUrl);
  const ctx = browser.contexts()[0];
  if (ctx === undefined) throw new Error('no browser context');

  const sw = ctx.serviceWorkers()[0];
  if (sw === undefined) throw new Error('no SW — is the recorder still running?');
  const extensionId = sw.url().match(/chrome-extension:\/\/([^/]+)/)?.[1];
  log('extension id', extensionId);

  // Find the existing side panel page (don't open a duplicate).
  const allPages = ctx.pages();
  log(
    'open pages',
    allPages.map((p) => p.url().slice(0, 100)),
  );

  let panel = allPages.find((p) => p.url().includes(`${extensionId}/sidepanel.html`));
  if (panel === undefined) {
    log('side panel not open — opening one', 'opening...');
    panel = await ctx.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await panel.waitForTimeout(2000);
  } else {
    log('using existing side panel', panel.url());
  }

  // Probe 1: build info + engagement journal + inbox state
  const initial = await panel.evaluate(async () => {
    const manifest = chrome.runtime.getManifest();
    const diag = await chrome.runtime
      .sendMessage({ type: 'sidetrack.dev.diag' })
      .catch((e) => ({ error: e?.message ?? String(e) }));
    const session = await chrome.storage.session.get('sidetrack.engagement.diag').catch(() => ({}));
    const regs = await chrome.scripting
      .getRegisteredContentScripts({ ids: ['sidetrack-engagement'] })
      .catch(() => []);
    const perm = await new Promise((r) => {
      chrome.permissions.contains({ origins: ['https://*/*', 'http://*/*'] }, (g) => r(Boolean(g)));
    });
    const httpTabs = await chrome.tabs.query({ url: ['https://*/*', 'http://*/*'] });
    return {
      manifestVersion: manifest.version,
      buildSha: (globalThis.__BUILD_INFO__ ?? {}).sha ?? null,
      engagementJournal: diag?.diagnostics?.engagement ?? null,
      engagementJournalFromSession: session['sidetrack.engagement.diag'] ?? null,
      registrations: regs,
      hostPermission: perm,
      httpTabCount: httpTabs.length,
      sampleTabs: httpTabs.slice(0, 5).map((t) => ({
        id: t.id,
        active: t.active,
        url: t.url?.slice(0, 80) ?? null,
      })),
    };
  });
  log('initial probe', initial);

  // Open HN in a NEW tab so we don't disturb the user's open tabs.
  const hn = await ctx.newPage();
  log('opening HN slowly...', 'navigating');
  await hn
    .goto('https://news.ycombinator.com/', { waitUntil: 'domcontentloaded' })
    .catch(() => undefined);
  log('HN loaded', hn.url());

  // Slow browse — keep focused so the engagement aggregator can accumulate
  // focusedWindowMs and emit at the 30 s tick.
  await hn.bringToFront();
  await hn.waitForTimeout(35_000);

  // Open one HN comment thread to add a navigation
  const articleLink = await hn.$('a.titleline > a').catch(() => null);
  if (articleLink !== null) {
    await articleLink.click({ noWaitAfter: true }).catch(() => undefined);
    await hn.waitForTimeout(15_000);
  }

  // Probe 2: journal + inbox state after browsing
  const after = await panel.evaluate(async () => {
    const diag = await chrome.runtime
      .sendMessage({ type: 'sidetrack.dev.diag' })
      .catch((e) => ({ error: e?.message ?? String(e) }));
    const session = await chrome.storage.session.get('sidetrack.engagement.diag').catch(() => ({}));
    return {
      engagementJournal: diag?.diagnostics?.engagement ?? null,
      engagementJournalFromSession: session['sidetrack.engagement.diag'] ?? null,
      observer: diag?.diagnostics?.observer ?? null,
      materializer: diag?.diagnostics?.materializer ?? null,
    };
  });
  log('after 50 s of HN browsing', after);

  await browser.close();
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
