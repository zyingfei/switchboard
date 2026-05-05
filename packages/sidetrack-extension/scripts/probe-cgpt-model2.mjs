import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
const page = b.contexts()[0].pages().find(p => /chatgpt\.com\/c\//.test(p.url()));
const data = await page.evaluate(() => {
  const btn = document.querySelector('[aria-label="Switch model"]');
  if (!btn) return { found: false };
  // Look at parent / siblings — the model name might be displayed adjacent.
  const parent = btn.parentElement;
  const grandparent = parent?.parentElement;
  return {
    btnText: btn.textContent?.trim(),
    btnInnerHTML: btn.innerHTML.slice(0, 200),
    btnAttrs: Object.fromEntries(Array.from(btn.attributes).map(a => [a.name, a.value.slice(0, 40)])),
    parentText: parent?.textContent?.trim().slice(0, 80),
    parentHTML: parent?.innerHTML.slice(0, 300),
    gpText: grandparent?.textContent?.trim().slice(0, 100),
    siblings: Array.from(parent?.children || []).map(c => ({ tag: c.tagName, cls: (c.className?.toString?.()||'').slice(0,50), text: c.textContent?.trim().slice(0, 60) })),
  };
});
console.log(JSON.stringify(data, null, 2));
await b.close();
