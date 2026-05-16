// Drive an HN /jobs navigation and observe whether the URL lands in
// the companion's URL projection. Probes 4 layers:
//   1. SW timeline observer admits the URL
//   2. SW timeline drain ships it to the companion
//   3. Companion's URL projection includes it
//   4. Side panel's comparableTabUrl lookup matches the projection key

import { chromium } from 'playwright';

const cdpUrl = process.env.SIDETRACK_E2E_CDP_URL ?? 'http://localhost:9223';

const log = (label, value) => {
  console.log(`\n=== ${label} ===`);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
};

const main = async () => {
  const browser = await chromium.connectOverCDP(cdpUrl);
  const ctx = browser.contexts()[0];
  const extensionId = ctx
    .serviceWorkers()[0]
    ?.url()
    .match(/chrome-extension:\/\/([^/]+)/)?.[1];
  const panel = ctx.pages().find((p) => p.url().includes(`${extensionId}/sidepanel.html`));
  if (panel === undefined) throw new Error('no side panel');

  // Open /jobs in a fresh tab and dwell briefly.
  const jobs = await ctx.newPage();
  await jobs
    .goto('https://news.ycombinator.com/jobs', { waitUntil: 'domcontentloaded' })
    .catch(() => undefined);
  await jobs.bringToFront();
  await jobs.waitForTimeout(2500);

  // What did the SW see?
  const swDiag = await panel.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({ type: 'sidetrack.dev.diag' });
    return {
      lastObserveRequest: r?.diagnostics?.wiring?.lastObserveRequest ?? null,
      lastDecision: r?.diagnostics?.observer?.lastDecision ?? null,
      lastAdmit: r?.diagnostics?.materializer?.lastAdmit ?? null,
      lastDrain: r?.diagnostics?.materializer?.lastDrain ?? null,
      spool: r?.diagnostics?.materializer?.spool ?? null,
    };
  });
  log('SW after /jobs navigation', swDiag);

  // Force a timeline drain so anything buffered ships to the companion.
  const drainResult = await panel.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'sidetrack.timeline.force-drain' }),
  );
  log('timeline force-drain', drainResult);

  // Companion-side: pull the URL projection and grep for HN URLs.
  const projection = await panel.evaluate(async () => {
    const settings =
      (await chrome.storage.local.get('sidetrack.settings'))['sidetrack.settings'] ?? {};
    const port = settings.companion?.port ?? null;
    const bridgeKey = settings.companion?.bridgeKey ?? null;
    if (port === null || bridgeKey === null) return { error: 'no companion config' };
    const res = await fetch(`http://127.0.0.1:${port}/v1/visits/projection`, {
      headers: { 'x-bac-bridge-key': bridgeKey },
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const body = await res.json();
    const all = Object.keys(body.data?.byCanonicalUrl ?? {});
    return {
      totalUrls: all.length,
      hnUrls: all.filter((k) => k.includes('news.ycombinator.com')),
      directLookupJobs: body.data?.byCanonicalUrl?.['https://news.ycombinator.com/jobs'] ?? null,
    };
  });
  log('companion URL projection', projection);

  // Cross-window active-tab inventory (what side panel sees).
  const tabs = await panel.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return all
      .filter((t) => typeof t.url === 'string' && /^https?:\/\//.test(t.url))
      .map((t) => ({
        active: t.active,
        windowId: t.windowId,
        url: t.url?.slice(0, 120),
      }));
  });
  log('http(s) tabs', tabs);

  await browser.close();
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
