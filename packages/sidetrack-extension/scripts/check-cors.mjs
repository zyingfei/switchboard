import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0];

// 1) Side panel — extension origin, should succeed
const sp = ctx.pages().find(p => p.url().includes('sidepanel.html'));
const fromSidepanel = await sp.evaluate(async () => {
  try {
    const r = await fetch('http://127.0.0.1:17373/v1/system/health', {
      headers: { 'x-bac-bridge-key': 'Xnr-n2HC2QO5aSvpWFRPROqrhTiSJyWUTYP7WHb2QZg' },
    });
    return { ok: true, status: r.status };
  } catch (e) { return { ok: false, error: String(e) }; }
});
console.log('from sidepanel (extension origin):', fromSidepanel);

// 2) Real chatgpt page main world — page origin, will be CORS-restricted
const cp = ctx.pages().find(p => p.url().startsWith('https://chatgpt.com/'));
const fromMainWorld = await cp.evaluate(async () => {
  try {
    const r = await fetch('http://127.0.0.1:17373/v1/system/health', {
      headers: { 'x-bac-bridge-key': 'Xnr-n2HC2QO5aSvpWFRPROqrhTiSJyWUTYP7WHb2QZg' },
    });
    return { ok: true, status: r.status };
  } catch (e) { return { ok: false, error: String(e) }; }
});
console.log('from chatgpt main-world:', fromMainWorld);

// 3) Probe via the extension's content script context isn't directly reachable
// from playwright; but we can check the response headers the companion sends.
const headers = await sp.evaluate(async () => {
  const r = await fetch('http://127.0.0.1:17373/v1/system/health', {
    method: 'OPTIONS',
    headers: {
      'Origin': 'https://chatgpt.com',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'x-bac-bridge-key',
    },
  });
  const headerObj = {};
  for (const [k, v] of r.headers.entries()) headerObj[k] = v;
  return { status: r.status, headers: headerObj };
});
console.log('OPTIONS preflight from chatgpt origin:', headers);

await browser.close();
