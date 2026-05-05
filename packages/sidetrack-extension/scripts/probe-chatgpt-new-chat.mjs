#!/usr/bin/env node
// Find a reliable selector for ChatGPT's "New chat" sidebar button
// (or equivalent affordance) so the dispatch driver can click it
// when chatgpt.com/ redirects to /c/<existing-id>. Probes the live
// DOM via the running CfT instance over CDP.

import { chromium } from '@playwright/test';

const cdpUrl = process.env.SIDETRACK_E2E_CDP_URL ?? 'http://localhost:9222';

const main = async () => {
  const browser = await chromium.connectOverCDP(cdpUrl);
  const [context] = browser.contexts();
  if (context === undefined) {
    console.error('[probe] no browser contexts found.');
    process.exit(1);
  }
  const page = await context.newPage();
  try {
    console.log('[probe] navigating to https://chatgpt.com/');
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6_000);
    console.log(`  landed at: ${page.url()}`);

    // Survey candidate selectors that could be the "new chat"
    // affordance. We look for visible elements only.
    const candidates = await page.evaluate(() => {
      const seen = new Map();
      const isVisible = (el) =>
        el instanceof HTMLElement && el.offsetParent !== null && el.checkVisibility?.() !== false;
      const record = (key, el) => {
        if (!isVisible(el)) return;
        const out = seen.get(key) ?? [];
        if (out.length >= 3) return;
        out.push({
          tag: el.tagName.toLowerCase(),
          textSnippet: (el.textContent ?? '').slice(0, 60).replace(/\s+/g, ' ').trim(),
          ariaLabel: el.getAttribute('aria-label'),
          dataTestid: el.getAttribute('data-testid'),
          href: el.getAttribute('href'),
          // Compute a short selector hint
          selectorHint: (() => {
            if (el.id) return `#${el.id}`;
            const cls = el.className.toString().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
            return cls ? `${el.tagName.toLowerCase()}.${cls}` : el.tagName.toLowerCase();
          })(),
        });
        seen.set(key, out);
      };

      // (a) Anything labeled "new chat".
      for (const el of document.querySelectorAll(
        '[aria-label*="new chat" i], [data-testid*="new-chat" i]',
      )) {
        record('by-label', el);
      }
      // (b) Sidebar link to "/".
      for (const el of document.querySelectorAll('a[href="/"], a[href="/?"], a[href="/?model=auto"]')) {
        record('href-root', el);
      }
      // (c) Buttons / links containing the literal text "New chat".
      for (const el of document.querySelectorAll('button, a')) {
        if (/new\s*chat/i.test(el.textContent ?? '')) {
          record('text-new-chat', el);
        }
      }
      // (d) Plus icons on the sidebar (often unlabeled).
      for (const el of document.querySelectorAll('button[aria-label*="plus" i], button:has(svg.lucide-plus)')) {
        record('plus-icon', el);
      }
      const out = {};
      for (const [k, v] of seen) out[k] = v;
      return out;
    });
    console.log('[probe] candidate selectors:');
    console.log(JSON.stringify(candidates, null, 2));

    // Try clicking the strongest candidate and see if URL resets.
    const target = await page.evaluate(() => {
      // Prefer aria-label, then data-testid, then sidebar a[href="/"].
      const isVisible = (el) =>
        el instanceof HTMLElement && el.offsetParent !== null && el.checkVisibility?.() !== false;
      const tries = [
        '[aria-label*="new chat" i]',
        '[data-testid*="new-chat" i]',
        'a[href="/"]',
      ];
      for (const sel of tries) {
        for (const el of document.querySelectorAll(sel)) {
          if (isVisible(el)) {
            const id = `__sidetrack_probe_${Math.random().toString(36).slice(2)}`;
            (el).setAttribute('data-sidetrack-probe-target', id);
            return { selector: `[data-sidetrack-probe-target="${id}"]`, used: sel };
          }
        }
      }
      return null;
    });
    if (target === null) {
      console.log('[probe] no clickable candidate found on this page.');
      return;
    }
    console.log(`[probe] clicking via: ${target.used}`);
    await page.click(target.selector, { timeout: 4_000 });
    await page.waitForTimeout(2_500);
    const afterClickUrl = page.url();
    console.log(`  url after click: ${afterClickUrl}`);
    const composerEmpty = await page.evaluate(() => {
      const el = document.querySelector('#prompt-textarea[role="textbox"], #prompt-textarea');
      if (!el) return null;
      return ((el).innerText ?? '').trim().length === 0;
    });
    console.log(`  composer present + empty: ${String(composerEmpty)}`);
    console.log(
      `  result: ${afterClickUrl === 'https://chatgpt.com/' ? 'reset to root (good)' : 'stayed at ' + afterClickUrl}`,
    );
  } finally {
    await page.close();
    await browser.close();
  }
};

main().catch((error) => {
  console.error('[probe] failed:', error);
  process.exit(1);
});
