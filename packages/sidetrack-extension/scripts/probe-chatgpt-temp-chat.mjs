#!/usr/bin/env node
// Probe whether https://chatgpt.com/?temporary-chat=true bypasses the
// "redirect to last active chat" behavior that bare https://chatgpt.com/
// triggers for logged-in users. Connects to the already-running
// Chrome-for-Testing instance via CDP (defaults to port 9222 — the
// e2e:chrome-debug script's default), opens a probe tab, and prints
// where the URL settles.

import { chromium } from '@playwright/test';

const cdpUrl = process.env.SIDETRACK_E2E_CDP_URL ?? 'http://localhost:9222';

const main = async () => {
  console.log(`[probe] connecting to ${cdpUrl}`);
  const browser = await chromium.connectOverCDP(cdpUrl);
  const [context] = browser.contexts();
  if (context === undefined) {
    console.error('[probe] no browser contexts found.');
    process.exit(1);
  }

  const page = await context.newPage();
  try {
    const target = 'https://chatgpt.com/?temporary-chat=true';
    console.log(`[probe] navigating to ${target}`);
    await page.goto(target, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(8_000);
    const finalUrl = page.url();
    const title = await page.title();
    const hasComposer = await page.evaluate(() =>
      document.querySelector('#prompt-textarea, [data-testid="prompt-textarea"]') !== null,
    );
    const hasTempBadge = await page.evaluate(() =>
      Array.from(document.querySelectorAll('*')).some((node) =>
        /temporary chat/i.test(node.textContent ?? ''),
      ),
    );
    const looksLikeLogin = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button, a')).some((node) =>
        /log\s*in|sign\s*up/i.test(node.textContent ?? ''),
      ),
    );

    console.log('[probe] result:');
    console.log(`  final URL:      ${finalUrl}`);
    console.log(`  page title:     ${title}`);
    console.log(`  composer ready: ${String(hasComposer)}`);
    console.log(`  temp-chat UI:   ${String(hasTempBadge)}`);
    console.log(`  login wall:     ${String(looksLikeLogin)}`);
    console.log(
      `  redirected to /c/<id>: ${finalUrl.includes('/c/') ? 'YES (fix did NOT work)' : 'no (good)'}`,
    );

    // Leave the probe tab visible for 3 more seconds so the developer
    // can eyeball it, then close it (don't litter tabs).
    await page.waitForTimeout(3_000);
  } finally {
    await page.close();
    await browser.close();
  }
};

main().catch((error) => {
  console.error('[probe] failed:', error);
  process.exit(1);
});
