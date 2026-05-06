import { chromium } from '@playwright/test';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const [context] = browser.contexts();
const chat = context.pages().find((p) => p.url().includes('69fa8f0f'));
if (!chat) { console.log('chat tab not found'); process.exit(1); }

// Read the live DOM textContent and try to manually replicate the
// findAnchor normalized-match for each annotation. This bypasses the
// content script and tells us whether the raw anchor data CAN match
// the live DOM at all.
const out = await chat.evaluate(() => {
  const fullText = document.body.textContent ?? '';
  const stripMd = (s) => s.replace(/[*_`~#>]/g, '').replace(/\s+/g, ' ');
  const search = (term, expectedPrefix, expectedSuffix) => {
    const CONTEXT_CHARS = 32;
    const expectedPrefixNorm = stripMd(expectedPrefix);
    const expectedSuffixNorm = stripMd(expectedSuffix);
    let from = 0;
    let occurrences = 0;
    const tries = [];
    while (from <= fullText.length) {
      const idx = fullText.indexOf(term, from);
      if (idx < 0) break;
      occurrences += 1;
      const prefix = fullText.slice(Math.max(0, idx - CONTEXT_CHARS), idx);
      const suffix = fullText.slice(idx + term.length, idx + term.length + CONTEXT_CHARS);
      const rawPrefixOk = prefix.endsWith(expectedPrefix);
      const rawSuffixOk = suffix.startsWith(expectedSuffix);
      const normPrefixOk = stripMd(prefix).endsWith(expectedPrefixNorm);
      const normSuffixOk = stripMd(suffix).startsWith(expectedSuffixNorm);
      const matched = (rawPrefixOk || normPrefixOk) && (rawSuffixOk || normSuffixOk);
      if (matched || occurrences <= 3) {
        tries.push({
          idx, matched, rawPrefixOk, rawSuffixOk, normPrefixOk, normSuffixOk,
          prefixSeen: JSON.stringify(prefix.slice(-32)),
          suffixSeen: JSON.stringify(suffix.slice(0, 32)),
        });
      }
      if (matched) return { occurrences, matched: true, tries };
      from = idx + 1;
    }
    return { occurrences, matched: false, tries };
  };
  const cases = [
    { term: 'Chrome', prefix: "e.\n\nI’ve got the candidate: the ", suffix: '/Gemini Nano story is far ahead ' },
    { term: 'V8',     prefix: 'parable in spirit to shipping **',    suffix: '**, **SQLite**, **PDFium**, or m' },
    { term: 'WebGPU', prefix: 'l than N websites each bundling ',   suffix: '/WASM inference stacks, ONNX Run' },
    { term: 'GPU',    prefix: 'han N websites each bundling Web',   suffix: '/WASM inference stacks, ONNX Run' },
  ];
  return {
    fullTextLen: fullText.length,
    canary: document.documentElement.getAttribute('data-sidetrack-provider-canary'),
    overlayRoot: document.getElementById('sidetrack-overlay-root') !== null,
    results: cases.map((c) => ({ term: c.term, ...search(c.term, c.prefix, c.suffix) })),
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
