import { chromium } from '@playwright/test';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const [context] = browser.contexts();
const sw = context.serviceWorkers().find((w) => w.url().includes('background.js'));
const out = await sw.evaluate(async () => {
  const tabs = await chrome.tabs.query({});
  const target = tabs.find((t) => t.url?.includes('69fa8f0f'));
  if (!target?.id) return { error: 'tab not found' };
  // Inject diagnostic into isolated world (same as content scripts)
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: target.id },
    world: 'ISOLATED',
    func: async () => {
      const get = (k) => new Promise((r) => chrome.storage.local.get(k, (v) => r(v[k])));
      const settings = await get('sidetrack.settings');
      const port = settings?.companion?.port;
      const bridgeKey = settings?.companion?.bridgeKey;
      const url = `http://127.0.0.1:${port}/v1/annotations?url=${encodeURIComponent(window.location.href)}`;
      const resp = await fetch(url, { headers: { 'x-bac-bridge-key': bridgeKey } });
      const body = await resp.json();
      const annotations = body?.data ?? [];
      // Re-implement findAnchor + stripMarkdownFormatting locally
      const stripMd = (s) => s.replace(/[*_`~#>]/g, '').replace(/\\([*_`~#>])/g, '$1').replace(/\s+/g, ' ');
      const CONTEXT_CHARS = 32;
      const findAnchor = (root, anchor) => {
        const fullText = root.textContent ?? '';
        const exact = anchor.textQuote.exact;
        if (exact.length === 0) return null;
        const expectedPrefixRaw = anchor.textQuote.prefix;
        const expectedSuffixRaw = anchor.textQuote.suffix;
        const expectedPrefixNorm = stripMd(expectedPrefixRaw);
        const expectedSuffixNorm = stripMd(expectedSuffixRaw);
        let from = 0;
        while (from <= fullText.length) {
          const index = fullText.indexOf(exact, from);
          if (index < 0) break;
          const prefix = fullText.slice(Math.max(0, index - CONTEXT_CHARS), index);
          const suffix = fullText.slice(index + exact.length, index + exact.length + CONTEXT_CHARS);
          const prefixOk = expectedPrefixRaw.length === 0 || prefix.endsWith(expectedPrefixRaw) || stripMd(prefix).endsWith(expectedPrefixNorm);
          const suffixOk = expectedSuffixRaw.length === 0 || suffix.startsWith(expectedSuffixRaw) || stripMd(suffix).startsWith(expectedSuffixNorm);
          if (prefixOk && suffixOk) return { matchIndex: index };
          from = index + 1;
        }
        return null;
      };
      return {
        url: window.location.href,
        annotationCount: annotations.length,
        results: annotations.map((a) => ({
          term: a.anchor?.textQuote?.exact,
          match: findAnchor(document.documentElement, a.anchor),
        })),
      };
    },
  });
  return result;
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
