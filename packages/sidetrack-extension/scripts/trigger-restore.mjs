import { chromium } from '@playwright/test';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const [context] = browser.contexts();
const sw = context.serviceWorkers().find((w) => w.url().includes('background.js'));
if (!sw) { console.log('SW dormant — open the side panel briefly to wake it'); process.exit(1); }
const chat = context.pages().find((p) => p.url().includes('69fa8f0f'));
if (!chat) { console.log('chat tab not found'); process.exit(1); }
// Use SW to send captureVisibleThread to the chat tab's content script.
const result = await sw.evaluate(async (tabUrlSubstr) => {
  const tabs = await chrome.tabs.query({});
  const target = tabs.find((t) => t.url?.includes(tabUrlSubstr));
  if (!target?.id) return { error: 'tab not found' };
  const response = await chrome.tabs.sendMessage(target.id, {
    type: 'sidetrack.capture.visible-thread',
  });
  return { ok: true, hasCapture: response?.ok === true };
}, '69fa8f0f');
console.log('SW relay:', JSON.stringify(result));
await new Promise((r) => setTimeout(r, 2_500));
const after = await chat.evaluate(() => ({
  overlayRoot: document.getElementById('sidetrack-overlay-root') !== null,
  highlights: document.querySelectorAll('.sidetrack-ann-highlight').length,
  margins: document.querySelectorAll('.sidetrack-ann-margin').length,
  highlightTitles: Array.from(document.querySelectorAll('.sidetrack-ann-highlight'))
    .map((el) => el.title || (el.textContent ?? '').slice(0, 40))
    .slice(0, 8),
}));
console.log('After restore trigger:', JSON.stringify(after, null, 2));
await browser.close();
