// Non-destructive observation of the running recorder. Does NOT
// inject new tabs, navigate, or fire any drain — just reads.

import { chromium } from 'playwright';

const cdpUrl = process.env.SIDETRACK_E2E_CDP_URL ?? 'http://localhost:9223';

const log = (label, value) => {
  console.log(`\n=== ${label} ===`);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
};

const main = async () => {
  const browser = await chromium.connectOverCDP(cdpUrl);
  const ctx = browser.contexts()[0];
  if (ctx === undefined) throw new Error('no context');
  const sw = ctx.serviceWorkers()[0];
  const extensionId = sw?.url().match(/chrome-extension:\/\/([^/]+)/)?.[1];
  const panel = ctx.pages().find((p) => p.url().includes(`${extensionId}/sidepanel.html`));
  if (panel === undefined) throw new Error('no side panel');

  const state = await panel.evaluate(async () => {
    const manifest = chrome.runtime.getManifest();
    const settings =
      (await chrome.storage.local.get('sidetrack.settings'))['sidetrack.settings'] ?? {};
    const port = settings.companion?.port ?? null;
    const bridgeKey = settings.companion?.bridgeKey ?? null;
    const diag = await chrome.runtime.sendMessage({ type: 'sidetrack.dev.diag' }).catch((e) => ({
      error: e?.message ?? String(e),
    }));

    let projectionStats = null;
    if (port !== null && bridgeKey !== null) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/visits/projection`, {
          headers: { 'x-bac-bridge-key': bridgeKey },
        });
        if (res.ok) {
          const body = await res.json();
          const urls = Object.keys(body.data?.byCanonicalUrl ?? {});
          projectionStats = { count: urls.length, sample: urls.slice(0, 3) };
        } else {
          projectionStats = { error: `HTTP ${res.status}` };
        }
      } catch (err) {
        projectionStats = { error: err.message };
      }
    }

    const card = document.querySelector('[data-testid="focused-tab-attribution"]');
    const cardState =
      card === null
        ? null
        : {
            classList: card.className,
            title: card.querySelector('.tab-attribution-card-title')?.textContent?.slice(0, 120),
            pending: card.querySelector('.tab-attribution-card-pending')?.textContent ?? null,
          };

    const tabsView = await chrome.tabs.query({});
    const httpTabs = tabsView.filter(
      (t) => typeof t.url === 'string' && /^https?:\/\//.test(t.url),
    );

    return {
      manifestVersion: manifest.version,
      companionPort: port,
      projectionStats,
      cardState,
      diagSummary: {
        wiring: {
          initialized: diag?.diagnostics?.wiring?.initialized ?? null,
          lastObserveRequest: diag?.diagnostics?.wiring?.lastObserveRequest ?? null,
          lastDrainTrigger: diag?.diagnostics?.wiring?.lastDrainTrigger ?? null,
          triggerDrainCalls: diag?.diagnostics?.wiring?.triggerDrainCalls ?? null,
          listenerCalls: diag?.diagnostics?.wiring?.listenerCalls ?? null,
        },
        observer: diag?.diagnostics?.observer ?? null,
        materializer: diag?.diagnostics?.materializer ?? null,
        engagementJournalTail: (diag?.diagnostics?.engagement?.journal ?? [])
          .slice(-6),
        engagementJournalLength: diag?.diagnostics?.engagement?.journalLength ?? 0,
      },
      httpTabCount: httpTabs.length,
      sampleHttpTabs: httpTabs.slice(0, 5).map((t) => ({
        active: t.active,
        url: t.url?.slice(0, 100) ?? null,
        windowId: t.windowId,
      })),
    };
  });
  log('observation', state);

  await browser.close();
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
