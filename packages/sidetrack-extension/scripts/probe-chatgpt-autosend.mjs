#!/usr/bin/env node
// Drive a real autoSend cycle against chatgpt.com using the SAME
// selectors the content-script driver uses (PROVIDER_DRIVERS.chatgpt
// in entrypoints/content.ts). Verifies whether the composer +
// stop-button selectors still match the live DOM and whether the
// page pushState's to /c/<id> after the assistant replies.
//
// One small ChatGPT request is made on the user's account
// ("respond with one word: hi"). Connects to the running CfT
// instance over CDP — does not log in, does not store credentials.

import { chromium } from '@playwright/test';

const cdpUrl = process.env.SIDETRACK_E2E_CDP_URL ?? 'http://localhost:9222';

const COMPOSER_SELECTORS = ['div#prompt-textarea[role="textbox"]', '#prompt-textarea'];
const STOP_BUTTON_SELECTORS = [
  'button[data-testid="stop-button"]',
  'button[aria-label*="Stop" i]',
];

const main = async () => {
  const browser = await chromium.connectOverCDP(cdpUrl);
  const [context] = browser.contexts();
  if (context === undefined) {
    console.error('[probe] no browser contexts found.');
    process.exit(1);
  }
  const page = await context.newPage();
  try {
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5_000);
    console.log(`[probe] landed at: ${page.url()}`);

    // If we got redirected to /c/<id>, click the new-chat button.
    if (page.url().includes('/c/')) {
      console.log('[probe] redirected to existing chat — clicking new-chat button');
      const reset = await page.evaluate(() => {
        const el = document.querySelector('a[data-testid="create-new-chat-button"]');
        if (!(el instanceof HTMLElement)) return false;
        el.click();
        return true;
      });
      if (!reset) {
        console.log('[probe] could not find new-chat button.');
        process.exit(2);
      }
      await page.waitForTimeout(2_000);
      console.log(`  after reset: ${page.url()}`);
    }

    // Composer presence
    const composerOk = await page.evaluate((sels) => {
      for (const sel of sels) {
        if (document.querySelector(sel) !== null) return sel;
      }
      return null;
    }, COMPOSER_SELECTORS);
    console.log(`[probe] composer selector match: ${composerOk}`);
    if (composerOk === null) {
      console.log('[probe] composer not found — content-script selectors are stale.');
      process.exit(3);
    }

    // Insert text via execCommand (the content script's path), press Enter.
    await page.evaluate((sels) => {
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (el instanceof HTMLElement) {
          el.focus();
          break;
        }
      }
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      document.execCommand('insertText', false, 'Respond with exactly one word: hi');
    }, COMPOSER_SELECTORS);
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    console.log('[probe] sent prompt; waiting for stop button (response stream)…');

    let streamStartUrl = '';
    try {
      await page.waitForFunction(
        (sels) =>
          sels.some((sel) => {
            const btn = document.querySelector(sel);
            return btn instanceof HTMLElement && btn.offsetParent !== null;
          }),
        STOP_BUTTON_SELECTORS,
        { timeout: 12_000 },
      );
      streamStartUrl = page.url();
      console.log(`  stop button visible (response started). URL: ${streamStartUrl}`);
    } catch {
      console.log('  stop button never appeared within 12s.');
      const composerNow = await page.evaluate(
        (sels) => sels.find((sel) => document.querySelector(sel) !== null) ?? null,
        COMPOSER_SELECTORS,
      );
      console.log(`  composer still present? ${composerNow !== null ? 'yes' : 'no'}`);
      process.exit(4);
    }

    try {
      await page.waitForFunction(
        (sels) =>
          !sels.some((sel) => {
            const btn = document.querySelector(sel);
            return btn instanceof HTMLElement && btn.offsetParent !== null;
          }),
        STOP_BUTTON_SELECTORS,
        { timeout: 30_000 },
      );
      console.log('  response complete.');
    } catch {
      console.log('  response did not finish within 30s.');
    }

    const finalUrl = page.url();
    const articleCount = await page.evaluate(
      () => document.querySelectorAll('article[data-message-author-role]').length,
    );
    console.log('[probe] final state:');
    console.log(`  URL:            ${finalUrl}`);
    console.log(`  article count:  ${articleCount}`);
    console.log(`  pushState'd to /c/<id>: ${finalUrl.includes('/c/')}`);
  } finally {
    await page.close();
    await browser.close();
  }
};

main().catch((error) => {
  console.error('[probe] failed:', error);
  process.exit(1);
});
