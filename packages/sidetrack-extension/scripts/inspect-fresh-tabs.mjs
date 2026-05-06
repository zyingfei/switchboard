import { chromium } from '@playwright/test';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const [context] = browser.contexts();
const targetIds = ['69fa83c7', '69fa83c8'];
for (const page of context.pages()) {
  if (!targetIds.some((id) => page.url().includes(id))) continue;
  console.log(`\n=== ${page.url()} ===`);
  const state = await page.evaluate(() => {
    const turns = Array.from(
      document.querySelectorAll('main [data-message-author-role]'),
    ).map((el) => ({
      role: el.getAttribute('data-message-author-role'),
      head: (el.textContent ?? '').replace(/\s+/g, ' ').slice(0, 120),
    }));
    return {
      pathname: location.pathname,
      title: document.title,
      canary: document.documentElement.getAttribute('data-sidetrack-provider-canary'),
      turnCount: turns.length,
      turns,
    };
  });
  console.log(JSON.stringify(state, null, 2));
}
await browser.close();
