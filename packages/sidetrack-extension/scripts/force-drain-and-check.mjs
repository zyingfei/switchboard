import { chromium } from 'playwright';

const cdpUrl = process.env.SIDETRACK_E2E_CDP_URL ?? 'http://localhost:9223';

const main = async () => {
  const browser = await chromium.connectOverCDP(cdpUrl);
  const ctx = browser.contexts()[0];
  if (ctx === undefined) throw new Error('no context');
  const extensionId = ctx.serviceWorkers()[0]?.url().match(/chrome-extension:\/\/([^/]+)/)?.[1];

  const panel = ctx.pages().find((p) => p.url().includes(`${extensionId}/sidepanel.html`));
  if (panel === undefined) throw new Error('no side panel');

  const drain = await panel.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'sidetrack.edge-events.force-drain' }),
  );
  console.log('force-drain result:', JSON.stringify(drain, null, 2));

  const post = await panel.evaluate(async () => {
    const diag = await chrome.runtime.sendMessage({ type: 'sidetrack.dev.diag' });
    return {
      engagementJournal: diag?.diagnostics?.engagement?.journal?.slice(-6) ?? null,
      materializer: diag?.diagnostics?.materializer ?? null,
    };
  });
  console.log('post-drain state:', JSON.stringify(post, null, 2));

  await browser.close();
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
