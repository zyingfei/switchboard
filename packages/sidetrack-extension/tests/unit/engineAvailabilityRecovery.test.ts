import { afterEach, describe, expect, it } from 'vitest';

import {
  APPLE_PROBE_TTL_MS,
  appleServiceStatus,
  setAppleProbeForTest,
} from '../../src/sidepanel/nano/engine';
import { APPLE_SERVICE_ABSENT, type AppleServiceInfo } from '../../src/sidepanel/nano/appleService';
import { routeEnrichmentEngine } from '../../src/sidepanel/nano/language';

// REPORTED LIVE, 2026-07-28: "AI: model not loaded — Load in Health / why now
// show apple?" — while apfel was healthy and answering, and the probe run
// verbatim inside the panel returned 200 on both of its calls.
//
// The row was reading a STALE NEGATIVE. The availability snapshot only re-runs
// when the focused URL changes or something bumps the probe nonce. The Apple
// probe caches for 30s, but nothing RE-READS it — so a transient failure (the
// local service restarting, a cold session losing a race) pinned the row to
// "model not loaded" indefinitely. Navigating to any other page fixed it
// instantly, which is what identified the cause.
//
// Two properties keep that from recurring: the cache must actually expire, and
// a blocked route must be re-checkable rather than terminal.

const UP: AppleServiceInfo = {
  available: true,
  contextTokens: 4096,
  modelId: 'apple-foundationmodel',
  reason: 'ok',
};

afterEach(() => {
  setAppleProbeForTest(() => Promise.resolve(APPLE_SERVICE_ABSENT));
});

describe('a transient probe failure must not be permanent', () => {
  it('re-probes after the TTL and RECOVERS once the service returns', async () => {
    // The exact live sequence: one failed probe, service healthy again, and the
    // next check past the TTL must see it.
    let healthy = false;
    setAppleProbeForTest(() => Promise.resolve(healthy ? UP : APPLE_SERVICE_ABSENT));

    const first = await appleServiceStatus(false, 1_000);
    expect(first.available).toBe(false);

    healthy = true;
    // Still inside the TTL — the cached negative is returned, which is correct
    // and is exactly why something must re-ask later.
    expect((await appleServiceStatus(false, 1_000 + APPLE_PROBE_TTL_MS - 1)).available).toBe(false);
    // Past the TTL — recovery, with no navigation and no reload.
    expect((await appleServiceStatus(false, 1_000 + APPLE_PROBE_TTL_MS + 1)).available).toBe(true);
  });

  it('an explicit re-check recovers immediately, without waiting out the TTL', async () => {
    let healthy = false;
    setAppleProbeForTest(() => Promise.resolve(healthy ? UP : APPLE_SERVICE_ABSENT));
    await appleServiceStatus(false, 1_000);
    healthy = true;
    expect((await appleServiceStatus(true, 1_100)).available).toBe(true);
  });
});

describe('the blocked state the re-probe timer watches for', () => {
  const nothingReady = {
    nanoReady: false,
    webGpuLoaded: false,
    webGpuSupported: true,
  };

  it('is exactly "no engine can serve" — the only state where a stale negative hurts', () => {
    // App.tsx arms its re-probe interval on this condition. If any engine is
    // ready the interval must stay disarmed, because the Apple probe is a real
    // (if tiny) on-device generation rather than a free ping.
    expect(routeEnrichmentEngine('en', nothingReady)).toEqual({
      engine: null,
      reason: 'model-not-loaded',
    });
    // ...and each of these must NOT be blocked, so none of them polls.
    expect(routeEnrichmentEngine('en', { ...nothingReady, appleReady: true }).engine).toBe('apple');
    expect(routeEnrichmentEngine('en', { ...nothingReady, nanoReady: true }).engine).toBe('nano');
    expect(routeEnrichmentEngine('en', { ...nothingReady, webGpuLoaded: true }).engine).toBe(
      'webgpu',
    );
    expect(routeEnrichmentEngine('en', { ...nothingReady, remoteReady: true }).engine).toBe(
      'remote',
    );
  });

  it('does not treat an in-flight WebGPU load as blocked — that resolves on its own', () => {
    const route = routeEnrichmentEngine('en', { ...nothingReady, webGpuLoading: true });
    expect(route).toEqual({ engine: null, reason: 'model-loading' });
  });
});
