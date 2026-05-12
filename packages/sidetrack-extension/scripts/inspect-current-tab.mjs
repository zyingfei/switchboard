import { chromium } from 'playwright';

const cdpUrl = process.env.SIDETRACK_E2E_CDP_URL ?? 'http://localhost:9223';

const log = (label, value) => {
  console.log(`\n=== ${label} ===`);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
};

const main = async () => {
  const browser = await chromium.connectOverCDP(cdpUrl);
  const ctx = browser.contexts()[0];
  const sw = ctx.serviceWorkers()[0];
  const extensionId = sw?.url().match(/chrome-extension:\/\/([^/]+)/)?.[1];
  const panel = ctx.pages().find((p) => p.url().includes(`${extensionId}/sidepanel.html`));
  if (panel === undefined) throw new Error('no side panel');

  const result = await panel.evaluate(async () => {
    // ALL tabs in ALL windows, not just my Playwright context.
    const allTabs = await chrome.tabs.query({});
    const activeHttpTabs = allTabs.filter(
      (t) =>
        t.active === true &&
        typeof t.url === 'string' &&
        (t.url.startsWith('http://') || t.url.startsWith('https://')),
    );

    // Read companion settings.
    const settings = (await chrome.storage.local.get('sidetrack.settings'))['sidetrack.settings'] ?? {};
    const port = settings.companion?.port ?? null;
    const bridgeKey = settings.companion?.bridgeKey ?? null;

    // For each active-http tab, look up its URL in the URL projection.
    let projectionByCanonical = {};
    let projectionFetchError = null;
    if (port !== null && bridgeKey !== null) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/visits/projection`, {
          headers: { 'x-bac-bridge-key': bridgeKey },
        });
        if (res.ok) {
          const body = await res.json();
          projectionByCanonical = body.data?.byCanonicalUrl ?? {};
        } else {
          projectionFetchError = `HTTP ${res.status}`;
        }
      } catch (err) {
        projectionFetchError = err.message;
      }
    }

    const checks = activeHttpTabs.map((t) => {
      const url = t.url ?? '';
      const direct = projectionByCanonical[url];
      // Find any projection key that contains the same hostname
      const host = (() => {
        try { return new URL(url).hostname; } catch { return ''; }
      })();
      const hostMatches = Object.keys(projectionByCanonical).filter((k) => k.includes(host));
      return {
        tabId: t.id ?? null,
        windowId: t.windowId ?? null,
        url: url.slice(0, 120),
        title: t.title?.slice(0, 60) ?? null,
        active: t.active,
        inProjectionDirect: direct !== undefined,
        projectionAttribution: direct?.currentAttribution ?? null,
        projectionLastSeenAt: direct?.lastSeenAt ?? null,
        hostMatchesInProjection: hostMatches.length,
        // First match if any
        sampleHostMatch: hostMatches[0]?.slice(0, 120) ?? null,
      };
    });

    return {
      companionPort: port,
      projectionFetchError,
      totalProjectionUrls: Object.keys(projectionByCanonical).length,
      activeHttpTabCount: activeHttpTabs.length,
      activeHttpTabs: checks,
      // Also include a few recent projection entries so we can see what
      // the companion DOES have
      recentProjectionUrls: Object.values(projectionByCanonical)
        .sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1))
        .slice(0, 5)
        .map((r) => ({ url: r.canonicalUrl?.slice(0, 120), lastSeenAt: r.lastSeenAt })),
    };
  });
  log('current-tab diagnostics', result);

  // Read what the side panel's DOM is actually rendering for Current tab
  const cardState = await panel.evaluate(() => {
    const card = document.querySelector('[data-testid="focused-tab-attribution"]');
    if (card === null) return null;
    return {
      classList: card.className,
      titleText: card.querySelector('.tab-attribution-card-title')?.textContent?.slice(0, 200) ?? null,
      pendingText: card.querySelector('.tab-attribution-card-pending')?.textContent ?? null,
      titleTooltip: card.querySelector('.tab-attribution-card-title')?.getAttribute('title') ?? null,
    };
  });
  log('Current tab card DOM state (what the user sees)', cardState);

  // Cross-window tab inventory (what the side panel sees across all windows)
  const panelTabView = await panel.evaluate(async () => {
    const allTabs = await chrome.tabs.query({});
    return Object.fromEntries(
      Object.entries(
        allTabs.reduce((acc, t) => {
          const k = String(t.windowId);
          (acc[k] = acc[k] || []).push({
            id: t.id,
            active: t.active,
            url: t.url?.slice(0, 100) ?? null,
          });
          return acc;
        }, {}),
      ),
    );
  });
  log('all tabs by window (cross-window inventory)', panelTabView);

  await browser.close();
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
