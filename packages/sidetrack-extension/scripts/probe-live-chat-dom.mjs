import { chromium } from '@playwright/test';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const [context] = browser.contexts();
const target = 'https://chatgpt.com/c/69fa8f0f-8b24-8330-be54-7de1740f11bc';
const chat = context.pages().find((p) => p.url().includes('69fa8f0f'));
if (!chat) {
  console.log('chat tab not open. all chatgpt pages:');
  for (const p of context.pages()) {
    if (p.url().includes('chatgpt')) console.log('  ', p.url());
  }
  process.exit(1);
}
const out = await chat.evaluate(() => {
  const turns = [];
  for (const el of document.querySelectorAll('main [data-message-author-role]')) {
    turns.push({
      role: el.getAttribute('data-message-author-role'),
      length: (el.textContent ?? '').length,
      head: (el.textContent ?? '').slice(0, 200),
      tail: (el.textContent ?? '').slice(-200),
    });
  }
  // also check for stop-button (still streaming?)
  const streaming = document.querySelector('button[data-testid="stop-button"]') !== null;
  return { url: location.href, title: document.title, streaming, turns };
});
console.log('URL:     ', out.url);
console.log('Title:   ', out.title);
console.log('Streaming:', out.streaming);
console.log(`Turns: ${out.turns.length}`);
for (const t of out.turns) {
  console.log(`  [${t.role}] len=${t.length}`);
  console.log('   head:', JSON.stringify(t.head));
  if (t.length > 400) console.log('   tail:', JSON.stringify(t.tail));
}
await browser.close();
