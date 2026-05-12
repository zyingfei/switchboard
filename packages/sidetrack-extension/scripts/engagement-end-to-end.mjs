// Drive a full engagement validation through the recorder:
// open HN, dwell, click into a comment thread, close the tab, drain,
// inspect the vault.

import { chromium } from 'playwright';

const cdpUrl = process.env.SIDETRACK_E2E_CDP_URL ?? 'http://localhost:9223';

const log = (label, value) => {
  console.log(`\n=== ${label} ===`);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
};

const main = async () => {
  const browser = await chromium.connectOverCDP(cdpUrl);
  const ctx = browser.contexts()[0];
  const extensionId = ctx.serviceWorkers()[0]?.url().match(/chrome-extension:\/\/([^/]+)/)?.[1];
  const panel = ctx.pages().find((p) => p.url().includes(`${extensionId}/sidepanel.html`));
  if (panel === undefined) throw new Error('no side panel');

  // Open HN
  const hn = await ctx.newPage();
  await hn.goto('https://news.ycombinator.com/', { waitUntil: 'domcontentloaded' });
  await hn.bringToFront();
  log('opened HN — dwelling 35s for the 30s engagement aggregator interval', 'waiting...');
  await hn.waitForTimeout(35_000);

  // Click into one comments page (creates a navigation = new engagement visit)
  const commentLink = await hn.$('a:has-text("comments")').catch(() => null);
  if (commentLink !== null) {
    await commentLink.click({ noWaitAfter: true }).catch(() => undefined);
    log('clicked comments — dwelling another 35s', 'waiting...');
    await hn.waitForTimeout(35_000);
  }

  // Close the HN tab. This triggers chrome.tabs.onRemoved →
  // finalizeEngagementForTab → emits engagement.session.aggregated.
  log('closing HN tab to fire session.aggregated', '');
  await hn.close().catch(() => undefined);
  // Give the SW a beat to process the onRemoved + drain.
  await new Promise((r) => setTimeout(r, 4000));

  // Force-drain the edge event buffer.
  const drain = await panel.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'sidetrack.edge-events.force-drain' }),
  );
  log('force-drain after close', drain);

  // Read final journal.
  const finalDiag = await panel.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({ type: 'sidetrack.dev.diag' });
    return {
      journal: r?.diagnostics?.engagement?.journal?.slice(-10) ?? null,
      observer: r?.diagnostics?.observer ?? null,
      materializer: r?.diagnostics?.materializer ?? null,
    };
  });
  log('final state', finalDiag);

  await browser.close();
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
