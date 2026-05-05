import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
const page = b.contexts()[0].pages().find(p => /chatgpt\.com\/c\//.test(p.url()));
const data = await page.evaluate(() => {
  // Look for any text near the conversation that resembles a model name.
  const candidates = [];
  // Per-message metadata
  const msgs = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]')).slice(-3);
  for (const m of msgs) {
    const id = m.getAttribute('data-message-id');
    const modelSlug = m.getAttribute('data-message-model-slug');
    candidates.push({ kind: 'message', id, modelSlug, attrs: Object.fromEntries(Array.from(m.attributes).filter(a => /model|slug/.test(a.name)).map(a => [a.name, a.value])) });
  }
  // Look for any element with model text
  const allTexts = Array.from(document.querySelectorAll('span, button, div')).filter(el => {
    const t = (el.textContent || '').trim();
    return /^(GPT-\d|GPT-4o|GPT-5|o\d|gpt-)/i.test(t) && t.length < 30 && el.children.length < 3;
  }).slice(0, 5).map(el => ({ tag: el.tagName, cls: (el.className?.toString?.()||'').slice(0, 60), text: (el.textContent||'').trim() }));
  // Page metadata
  const meta = Array.from(document.querySelectorAll('meta[name], meta[property]')).filter(m => /model|chat/.test(m.getAttribute('name') || m.getAttribute('property') || '')).map(m => ({ key: m.getAttribute('name') || m.getAttribute('property'), value: m.getAttribute('content') }));
  return { candidates, modelTexts: allTexts, meta };
});
console.log(JSON.stringify(data, null, 2));
await b.close();
