import { chromium } from 'playwright';

const cdpUrl = process.env.SIDETRACK_E2E_CDP_URL ?? 'http://localhost:9223';

const main = async () => {
  const browser = await chromium.connectOverCDP(cdpUrl);
  const contexts = browser.contexts();
  console.log(`Browser has ${contexts.length} context(s)`);
  for (const [i, ctx] of contexts.entries()) {
    console.log(`\n--- Context ${i} ---`);
    const pages = ctx.pages();
    console.log(`Pages: ${pages.length}`);
    for (const p of pages) {
      const url = p.url();
      const title = await p.title().catch(() => '?');
      console.log(`  - ${url.slice(0, 130)}`);
      console.log(`    title: ${title.slice(0, 60)}`);
    }
    const sws = ctx.serviceWorkers();
    console.log(`Service workers: ${sws.length}`);
    for (const sw of sws) console.log(`  - ${sw.url()}`);
  }
  // Also fetch /json/list from CDP to see all targets (including ones
  // Playwright might not surface as pages)
  const res = await fetch(cdpUrl.replace(/\/$/, '') + '/json/list');
  const all = await res.json();
  console.log(`\nCDP /json/list — ${all.length} targets total:`);
  for (const t of all) {
    console.log(`  [${t.type}] ${t.url?.slice(0, 130) ?? ''}`);
    if (t.title !== undefined && t.title.length > 0) console.log(`    title: ${t.title.slice(0, 60)}`);
  }
  await browser.close();
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
