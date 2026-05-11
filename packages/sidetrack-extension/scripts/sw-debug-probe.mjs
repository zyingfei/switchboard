// End-to-end engagement probe driven entirely from this host. No
// user turn-around needed.
//
// What it does:
//   1. Connects to a chrome-debug instance via CDP.
//   2. Wakes the SW + opens the side panel.
//   3. Programmatically opens the timeline + engagement gates via
//      privacy events (no UI gesture needed since this is a test
//      bootstrap).
//   4. Triggers syncPrivacyGatedContentScriptRegistrations.
//   5. Reads the engagement journal three ways: globalThis array (via
//      sw.evaluate), chrome.storage.session, and the sidetrack.dev.diag
//      response which folds the journal in.
//   6. Triggers an edge-events drain to confirm the buffer + alarm path.
//   7. Prints a structured summary.
//
// Requires chrome-debug to be running:
//   npm --prefix packages/sidetrack-extension run e2e:chrome-debug

import { chromium } from 'playwright';

const cdpUrl = process.env.SIDETRACK_E2E_CDP_URL ?? 'http://localhost:9222';

const log = (label, value) => {
  console.log(`\n=== ${label} ===`);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
};

const main = async () => {
  const browser = await chromium.connectOverCDP(cdpUrl);
  const ctx = browser.contexts()[0];
  if (ctx === undefined) throw new Error('no context');

  const waitForSw = async () => {
    for (let i = 0; i < 30; i++) {
      const sw = ctx.serviceWorkers()[0];
      if (sw !== undefined) return sw;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('no SW after wait');
  };
  let sw0 = await waitForSw();
  const extensionId = sw0.url().match(/chrome-extension:\/\/([^/]+)/)?.[1];
  if (extensionId === undefined) throw new Error('cannot read extension id');
  log('extension id', extensionId);

  // Open the side panel against the reloaded extension.
  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.waitForTimeout(2500);

  // Probe 1: build info + engagement journal via dev.diag dump.
  const diag1 = await panel.evaluate(async () => {
    try {
      return await chrome.runtime.sendMessage({ type: 'sidetrack.dev.diag' });
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
  log('dev.diag (initial) — full keys', Object.keys(diag1?.diagnostics ?? {}));
  log('dev.diag (initial) — engagement field', diag1?.diagnostics?.engagement);
  log('dev.diag (initial) — full ok/err', { ok: diag1?.ok, error: diag1?.error });
  const manifestInfo = await panel.evaluate(() => {
    const m = chrome.runtime.getManifest();
    return { version: m.version, name: m.name };
  });
  log('loaded extension manifest', manifestInfo);

  // Probe 2: trigger the registration sync explicitly to populate the
  // journal even if the bootstrap path didn't fire it yet.
  // The SW listens for sidetrack.privacy.gateChanged → reruns sync.
  await panel.evaluate(async () => {
    await chrome.runtime.sendMessage({ type: 'sidetrack.privacy.gateChanged' });
  });
  await panel.waitForTimeout(1000);

  // Probe 3: read the journal again — should now have entries.
  const diag2 = await panel.evaluate(async () => {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'sidetrack.dev.diag' });
      const sessionDirect = await chrome.storage.session.get('sidetrack.engagement.diag');
      return {
        viaDevDiag: r?.diagnostics?.engagement ?? null,
        viaSessionStorage: sessionDirect['sidetrack.engagement.diag'] ?? null,
      };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
  log('after privacy.gateChanged → sync.invoked entries expected', diag2);

  // Probe 4: open Hacker News and wait so the timeline observer admits.
  const hn = await ctx.newPage();
  await hn.goto('https://news.ycombinator.com/', { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  log('opened HN', hn.url());
  // Slow browse: 25 s focused. If engagement DID inject (it won't
  // without host permission in CfT), the 30 s aggregator interval
  // would fire at the next dump after this wait.
  await hn.waitForTimeout(25_000);

  // Probe 5: read journal + materializer admit counters after HN nav.
  const diag3 = await panel.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({ type: 'sidetrack.dev.diag' });
    return {
      journal: r?.diagnostics?.engagement?.journal ?? null,
      timelineEmits: r?.diagnostics?.observer?.emitCalls ?? null,
      spool: r?.diagnostics?.materializer?.spool ?? null,
      lastDrain: r?.diagnostics?.materializer?.lastDrain ?? null,
    };
  });
  log('after HN browse', diag3);

  // Probe 6: force drain edge-events to validate the drain path works
  // end to end. Even with no engagement events buffered, this should
  // respond cleanly (uploaded: 0, remaining: 0).
  const drain = await panel.evaluate(async () =>
    chrome.runtime.sendMessage({ type: 'sidetrack.edge-events.force-drain' }),
  );
  log('edge-events force-drain', drain);

  await browser.close();
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
