#!/usr/bin/env node
// Live CfT smoke test for the Scope A-F migration.
//
// Pre-reqs (caller responsible):
//   1. test companion running on :17374
//   2. chrome-debug.mjs launched in another terminal (or by us)
//      with CDP port 9222 open
//
// Asserts:
//   - sidepanel.html renders with the new 5-tab shape
//     (Now / Threads / Workstreams / Inbox / Search)
//   - default viewMode is 'now' (Now tab has aria-selected=true)
//   - the focused-tab-attribution section is mounted under Now
//   - clicking Search switches the right rail to search subMode
//   - no raw tses_*/visit-instance:/tab-session: appear in
//     container.textContent during the smoke walk

import { chromium } from 'playwright';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CDP_URL = process.env.SIDETRACK_E2E_CDP_URL ?? 'http://localhost:9222';
const PROFILE_DIR = process.env.SIDETRACK_USER_DATA_DIR ?? `${process.env.HOME}/.sidetrack-test-profile`;
const SCREENSHOT_DIR = '/tmp/cft-smoke';

const fail = (msg) => {
  console.error(`[FAIL] ${msg}`);
  process.exitCode = 1;
};
const ok = (msg) => console.log(`[OK]   ${msg}`);

// Find the extension id from chrome.management.getAll-style probe
// by looking at chrome-extension:// service-worker URLs in CDP target list.
const findExtensionId = async (browser) => {
  // Each loaded MV3 extension registers a service worker target.
  // Prefer the persistent file dropped by chrome-debug.mjs if present.
  const idFile = process.env.SIDETRACK_EXTENSION_PATH
    ? `${process.env.SIDETRACK_EXTENSION_PATH}/../cdp-extension-id`
    : `${process.env.HOME}/playground/playground/browser-ai-companion/packages/sidetrack-extension/.output/cdp-extension-id`;
  if (existsSync(idFile)) {
    const id = readFileSync(idFile, 'utf8').trim();
    if (id.length > 0) return id;
  }
  // Fallback: walk all contexts for any chrome-extension:// URL.
  for (const ctx of browser.contexts()) {
    for (const page of ctx.pages()) {
      const m = page.url().match(/^chrome-extension:\/\/([a-p]+)\//);
      if (m) return m[1];
    }
  }
  // Last resort: ping CDP targets directly.
  const res = await fetch(`${CDP_URL}/json/list`);
  const targets = await res.json();
  for (const t of targets) {
    const m = (t.url ?? '').match(/^chrome-extension:\/\/([a-p]+)\//);
    if (m) return m[1];
  }
  return null;
};

const main = async () => {
  console.log(`[smoke] connecting to CDP at ${CDP_URL}`);
  const browser = await chromium.connectOverCDP(CDP_URL);

  const extId = await findExtensionId(browser);
  if (!extId) {
    fail(`could not find extension id (check ${PROFILE_DIR}/.../cdp-extension-id or CDP targets)`);
    return;
  }
  ok(`extension id: ${extId}`);

  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  const url = `chrome-extension://${extId}/sidepanel.html`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  console.log(`[smoke] sidepanel mounted: ${url}`);

  // The wizard may show on first launch; skip it by seeding storage.
  await page.evaluate(async () => {
    await new Promise((resolve) =>
      chrome.storage.local.set({ 'sidetrack:setupCompleted': true }, () => resolve()),
    );
  });
  await page.reload({ waitUntil: 'domcontentloaded' });

  // Give React a moment to render after reload.
  await page.waitForSelector('[role="tablist"]', { timeout: 10_000 });

  // Assert all 5 tab labels are present.
  const tabLabels = await page.$$eval('[role="tab"]', (tabs) =>
    tabs.map((t) => t.getAttribute('aria-label')),
  );
  console.log(`[smoke] tabs found: ${JSON.stringify(tabLabels)}`);
  const expected = ['Now', 'Threads', 'Workstreams', 'Inbox', 'Search'];
  for (const want of expected) {
    if (tabLabels.includes(want)) ok(`tab present: ${want}`);
    else fail(`tab MISSING: ${want}`);
  }
  // Make sure the old labels are gone (renames).
  for (const gone of ['Workstream', 'All threads', 'Connections']) {
    if (tabLabels.includes(gone)) fail(`legacy tab leaked: ${gone}`);
    else ok(`legacy tab gone: ${gone}`);
  }

  // Default tab is Now → aria-selected.
  const selected = await page.$eval(
    '[role="tab"][aria-selected="true"]',
    (el) => el.getAttribute('aria-label'),
  );
  if (selected === 'Now') ok(`default tab is Now (aria-selected=true)`);
  else fail(`default tab is ${selected}, expected Now`);

  // Current-tab card mounted under Now.
  const cardPresent = await page.$('[data-testid="focused-tab-attribution"]');
  if (cardPresent !== null) ok('focused-tab-attribution card mounted under Now');
  else fail('focused-tab-attribution NOT mounted under Now');

  // Page-kind eyebrow visible.
  const kindEyebrow = await page.$eval(
    '[data-testid="now-page-kind"]',
    (el) => el.textContent,
  ).catch(() => null);
  if (kindEyebrow !== null) ok(`page kind eyebrow: ${kindEyebrow}`);
  else fail('now-page-kind eyebrow missing');

  // No raw ids in visible text.
  const visibleText = await page.evaluate(() => document.body.textContent ?? '');
  const forbidden = [
    { name: 'tses_*', re: /tses_[A-Z0-9]/ },
    { name: 'visit-instance:', re: /visit-instance:/ },
    { name: 'tab-session:', re: /tab-session:/ },
    { name: 'replica:<id>', re: /\breplica:[^\s"'<>]+/ },
  ];
  for (const f of forbidden) {
    if (f.re.test(visibleText)) fail(`visible text leaks ${f.name}`);
    else ok(`visible text clean of ${f.name}`);
  }

  // Switch to Search tab and verify routing.
  await page.click('[role="tab"][aria-label="Search"]');
  await page.waitForTimeout(500);
  const searchAriaSelected = await page.$eval(
    '[role="tab"][aria-label="Search"]',
    (el) => el.getAttribute('aria-selected'),
  );
  if (searchAriaSelected === 'true') ok('Search tab clickable + selected');
  else fail(`Search tab aria-selected=${searchAriaSelected}`);

  // Render the connections-mode-search sub mode (ConnectionsView's search mode).
  const searchTab = await page.$('[data-testid="connections-search-tab"]');
  if (searchTab !== null) ok('Search → ConnectionsView search subMode rendered');
  else {
    // The subMode trigger may not be data-testid'd if the search button is hidden.
    // Fall back to any [data-testid*=search] element.
    const anySearch = await page.$('[data-testid*="search"]');
    if (anySearch !== null) ok('Search route surfaces some search UI');
    else fail('Search route did not surface search UI');
  }

  // Type a query and HARD-assert the extension fires recallV2Query
  // with intent='search'. This is the load-bearing assertion that
  // catches schema drift (the kind of regression the live CfT test
  // surfaced when /v2/recall first 400'd on the new intent field);
  // soft-skipping defeats the purpose.
  const searchInput = await page.$('[data-testid="connections-search-tab-input"]');
  if (searchInput === null) {
    fail('search input not surfaced — Search route did not mount its input field');
  } else {
    // Hook chrome.runtime.sendMessage to capture outgoing recallV2Query.
    await page.evaluate(() => {
      const original = chrome.runtime.sendMessage;
      window.__capturedRecallV2Reqs = [];
      chrome.runtime.sendMessage = function (...args) {
        const msg = args[0];
        if (msg && typeof msg === 'object' && msg.type === 'sidetrack.recall.v2.query') {
          window.__capturedRecallV2Reqs.push(JSON.parse(JSON.stringify(msg)));
        }
        return original.apply(this, args);
      };
    });
    await searchInput.fill('sidetrack');
    // The hook itself debounces (SEARCH_DEBOUNCE_MS = 300ms). Wait
    // generously past that so the recallV2Query has time to fire.
    // Poll for up to 3s — flake-resistant without inflating happy-
    // path wall time.
    let captured = [];
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      captured = await page.evaluate(() => window.__capturedRecallV2Reqs ?? []);
      if (captured.length > 0) break;
      await page.waitForTimeout(150);
    }
    console.log(`[smoke] captured recallV2Query messages: ${captured.length}`);
    if (captured.length === 0) {
      fail(
        'extension did NOT fire recallV2Query within 3s of typing — schema, ' +
          'background bridge, or useRecallSearch hook is broken',
      );
    } else {
      ok('extension fired recallV2Query');
      const req = captured[0].req;
      if (req?.intent === 'search') ok(`request carries intent='search'`);
      else fail(`request missing/wrong intent: ${JSON.stringify(req?.intent)}`);
      if (typeof req?.q === 'string' && req.q.length > 0) ok(`request carries q='${req.q}'`);
      else fail(`request missing q`);
    }
  }

  // Screenshot the final state for visual inspection.
  await page.screenshot({ path: `${SCREENSHOT_DIR}/sidepanel-search.png`, fullPage: true });
  ok(`screenshot: ${SCREENSHOT_DIR}/sidepanel-search.png`);

  // Switch back to Now for the screenshot record.
  await page.click('[role="tab"][aria-label="Now"]');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/sidepanel-now.png`, fullPage: true });
  ok(`screenshot: ${SCREENSHOT_DIR}/sidepanel-now.png`);

  await page.close();
  await browser.close();
  console.log(`[smoke] done — exit ${process.exitCode ?? 0}`);
};

main().catch((err) => {
  console.error('[smoke] crashed:', err);
  process.exit(2);
});
