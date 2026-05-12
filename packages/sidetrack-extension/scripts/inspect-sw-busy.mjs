// What is the SW doing while the companion is CPU-stuck?
import { chromium } from 'playwright';

const cdpUrl = process.env.SIDETRACK_E2E_CDP_URL ?? 'http://localhost:9223';

const log = (label, value) => {
  console.log(`\n=== ${label} ===`);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
};

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timeout ${label} after ${ms}ms`)), ms),
    ),
  ]);

const main = async () => {
  const browser = await chromium.connectOverCDP(cdpUrl);
  const ctx = browser.contexts()[0];
  const sw = ctx.serviceWorkers()[0];
  const extensionId = sw?.url().match(/chrome-extension:\/\/([^/]+)/)?.[1];
  const panel = ctx.pages().find((p) => p.url().includes(`${extensionId}/sidepanel.html`));
  if (panel === undefined) throw new Error('no side panel');

  // Inflight fetches via Performance Observer — what's hot right now
  const inflight = await withTimeout(
    panel.evaluate(async () => {
      const entries = performance.getEntriesByType('resource').slice(-30);
      return entries
        .filter((e) => e.name.includes('127.0.0.1'))
        .map((e) => ({
          url: e.name.replace(/^http:\/\/127\.0\.0\.1:\d+/, ''),
          duration: Math.round(e.duration),
          transferSize: e.transferSize,
          startedAt: Math.round(e.startTime),
        }))
        .sort((a, b) => b.duration - a.duration)
        .slice(0, 15);
    }),
    5000,
    'panel perf entries',
  );
  log('top 15 slowest recent companion fetches from panel', inflight);

  // Read engagement journal tail
  const journal = await withTimeout(
    panel.evaluate(async () => {
      const got = await chrome.storage.session.get('sidetrack.engagement.diag');
      const j = got['sidetrack.engagement.diag'] ?? [];
      return j.slice(-10);
    }),
    5000,
    'engagement journal tail',
  ).catch((err) => `error: ${err.message}`);
  log('engagement journal tail (last 10)', journal);

  await browser.close();
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
