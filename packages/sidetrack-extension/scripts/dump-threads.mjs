import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const sp = browser.contexts()[0].pages().find(p => p.url().includes('sidepanel.html'));
const dump = await sp.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('.thread'));
  return rows.slice(0, 6).map((r) => ({
    text: r.textContent?.slice(0, 80),
    classes: r.className,
    attrs: Object.fromEntries(Array.from(r.attributes).map((a) => [a.name, a.value])),
  }));
});
for (const d of dump) console.log(JSON.stringify(d, null, 2));
await browser.close();
