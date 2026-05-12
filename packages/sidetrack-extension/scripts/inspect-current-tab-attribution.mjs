// Fast probe — just the DOM + active tab info, no companion HTTP roundtrip.
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

  // Pure DOM read — no chrome.runtime, no HTTP
  const dom = await panel.evaluate(() => {
    const card = document.querySelector('[data-testid="focused-tab-attribution"]');
    if (card === null) return null;
    // Pretty-print the visible Current-tab card
    return {
      classList: card.className,
      titleEl: card.querySelector('.tab-attribution-card-title')?.outerHTML?.slice(0, 300) ?? null,
      bodyEl: card.querySelector('.tab-attribution-card-body')?.outerHTML?.slice(0, 600) ?? null,
      fullCardHtml: card.outerHTML.slice(0, 1500),
    };
  });
  log('Current-tab card DOM', dom);

  // Also fetch active tab info quickly (chrome.tabs is in-memory, fast)
  const tabInfo = await panel.evaluate(async () => {
    const all = await chrome.tabs.query({});
    const active = all.find(
      (t) =>
        t.active === true &&
        typeof t.url === 'string' &&
        (t.url.startsWith('https://') || t.url.startsWith('http://')),
    );
    return active
      ? { id: active.id, url: active.url.slice(0, 130), title: active.title?.slice(0, 80) ?? null }
      : null;
  });
  log('active http tab', tabInfo);

  await browser.close();
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
