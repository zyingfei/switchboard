// Leaner probe: don't go through chrome.runtime.sendMessage (which is
// hanging — SW likely busy). Read state from chrome.storage + DOM.

import { chromium } from 'playwright';

const cdpUrl = process.env.SIDETRACK_E2E_CDP_URL ?? 'http://localhost:9223';

const log = (label, value) => {
  console.log(`\n=== ${label} ===`);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
};

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timeout ${label} after ${ms}ms`)), ms),
    ),
  ]);

const main = async () => {
  const browser = await chromium.connectOverCDP(cdpUrl);
  const ctx = browser.contexts()[0];
  const sw = ctx.serviceWorkers()[0];
  const extensionId = sw?.url().match(/chrome-extension:\/\/([^/]+)/)?.[1];
  const panel = ctx.pages().find((p) => p.url().includes(`${extensionId}/sidepanel.html`));
  if (panel === undefined) throw new Error('no side panel');

  // 1. Storage + DOM (no SW round-trip)
  const passive = await withTimeout(
    panel.evaluate(async () => {
      const settings =
        (await chrome.storage.local.get('sidetrack.settings'))['sidetrack.settings'] ?? {};
      const port = settings.companion?.port ?? null;
      const bridgeKey = settings.companion?.bridgeKey ?? null;
      const pill = document.querySelector('.sp-status-pill[title*="Companion"]');
      return {
        companionPort: port,
        bridgeKeyPrefix: bridgeKey?.slice(0, 6) ?? null,
        pillText: pill?.textContent?.trim() ?? null,
        pillClass: pill?.className ?? null,
      };
    }),
    10_000,
    'panel passive read',
  );
  log('settings + DOM pill', passive);

  // 2. Direct HTTP probe from Node (no SW involvement)
  if (passive.companionPort !== null && passive.bridgeKeyPrefix !== null) {
    // Need the full bridge key — re-read directly
    const fullKey = await withTimeout(
      panel.evaluate(
        async () =>
          (await chrome.storage.local.get('sidetrack.settings'))['sidetrack.settings']?.companion
            ?.bridgeKey,
      ),
      5000,
      'full bridge key read',
    );
    const probe = async (path) => {
      const t0 = Date.now();
      try {
        const res = await fetch(`http://127.0.0.1:${passive.companionPort}${path}`, {
          headers: { 'x-bac-bridge-key': fullKey },
          signal: AbortSignal.timeout(5000),
        });
        return {
          path,
          status: res.status,
          latencyMs: Date.now() - t0,
          body: (await res.text()).slice(0, 200),
        };
      } catch (err) {
        return { path, latencyMs: Date.now() - t0, error: err.message ?? String(err) };
      }
    };
    log('direct /v1/status (what SW polls)', await probe('/v1/status'));
    log('direct /v1/system/health', await probe('/v1/system/health'));
    log('direct /v1/version', await probe('/v1/version'));
  }

  // 3. Try SW round-trip with a short timeout
  try {
    const workboard = await withTimeout(
      panel.evaluate(async () => chrome.runtime.sendMessage({ type: 'sidetrack.workboard.state' })),
      8000,
      'SW workboard.state',
    );
    log('SW workboard.state', {
      companionStatus: workboard?.state?.companionStatus ?? null,
      lastError: workboard?.state?.lastError ?? workboard?.error ?? null,
    });
  } catch (err) {
    log('SW workboard.state ERRORED OR HUNG', err.message);
  }

  await browser.close();
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
