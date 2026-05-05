#!/usr/bin/env node
// Probe two things against the running CfT instance (CDP @ 9222):
//   (1) https://chatgpt.com/?temporary-chat=true bypasses the
//       redirect-to-last-chat behavior of the bare URL.
//   (2) After submitting a short prompt, what URL does ChatGPT
//       settle on? (Stays at ?temporary-chat=true, or pushState to
//       /c/<temp-id>?…) This decides what isProviderThreadUrl
//       needs to accept so auto-capture can fire on temp chats.

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
    console.log(`[probe] (1) navigate to ${target}`);
    await page.goto(target, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6_000);
    const initialUrl = page.url();
    console.log(`  initial URL: ${initialUrl}`);
    if (initialUrl.includes('/c/')) {
      console.log('  redirect bypass: FAILED');
      process.exit(2);
    }
    console.log('  redirect bypass: OK');

    console.log('[probe] (2) submit a tiny prompt and observe URL behavior.');
    const composerSelector = '#prompt-textarea[role="textbox"], #prompt-textarea';
    await page.waitForSelector(composerSelector, { timeout: 8_000 });
    await page.click(composerSelector);
    // execCommand insertText is what the extension's content script
    // uses; mirror it so we exercise the same code path ChatGPT's
    // ProseMirror editor expects.
    await page.evaluate(() => {
      const el = document.querySelector(
        '#prompt-textarea[role="textbox"], #prompt-textarea',
      );
      if (el instanceof HTMLElement) el.focus();
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      document.execCommand('insertText', false, 'Reply with one word: hi');
    });
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    // Wait for the stop button to appear (response streaming).
    let urlOnStreamStart = '';
    try {
      await page.waitForFunction(
        () =>
          document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop" i]')
            ?.checkVisibility?.() ?? false,
        null,
        { timeout: 12_000 },
      );
      urlOnStreamStart = page.url();
      console.log(`  url at stream-start: ${urlOnStreamStart}`);
    } catch {
      console.log('  stream-start not detected within 12s (auto-send may have failed).');
    }
    // Wait for streaming to finish (stop button gone) or 30s.
    try {
      await page.waitForFunction(
        () =>
          document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop" i]')
            ?.checkVisibility?.() === false ||
          document.querySelector('button[data-testid="stop-button"]') === null,
        null,
        { timeout: 30_000 },
      );
    } catch {
      // Streaming didn't finish; we still report what URL we saw.
    }
    const finalUrl = page.url();
    console.log(`  final URL:           ${finalUrl}`);
    console.log(`  contains /c/<id>:    ${finalUrl.includes('/c/')}`);
    console.log(
      `  contains ?temporary-chat=true: ${finalUrl.includes('temporary-chat=true')}`,
    );
    const articleCount = await page.evaluate(
      () => document.querySelectorAll('article[data-message-author-role]').length,
    );
    console.log(`  article count:       ${articleCount}`);

    await page.waitForTimeout(2_000);
  } finally {
    await page.close();
    await browser.close();
  }
};

main().catch((error) => {
  console.error('[probe] failed:', error);
  process.exit(1);
});
