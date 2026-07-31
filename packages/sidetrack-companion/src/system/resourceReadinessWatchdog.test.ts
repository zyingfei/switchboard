import { describe, expect, it } from 'vitest';

import {
  BOOT_TO_SERVING_BUDGET_MS,
  RSS_WARN_BYTES,
  createResourceReadinessWatchdog,
} from './resourceReadinessWatchdog.js';

const makeClock = (initialMs = Date.parse('2026-07-31T12:00:00.000Z')) => {
  let value = initialMs;
  return {
    now: () => value,
    advance: (deltaMs: number) => {
      value += deltaMs;
    },
  };
};

describe('resource/readiness watchdog', () => {
  it('warns at exactly 2 GiB and exposes signed growth plus peak RSS', () => {
    const clock = makeClock();
    let rss = RSS_WARN_BYTES - 1;
    const watchdog = createResourceReadinessWatchdog({
      nowMs: clock.now,
      readRssBytes: () => rss,
    });
    watchdog.markServing();

    const ok = watchdog.snapshot();
    expect(ok.rss).toMatchObject({
      status: 'ok',
      warnAtBytes: RSS_WARN_BYTES,
      currentBytes: RSS_WARN_BYTES - 1,
      growthBytes: 0,
      lastTransition: 'initialized',
    });

    clock.advance(1_000);
    rss = RSS_WARN_BYTES;
    const warning = watchdog.snapshot();
    expect(warning.rss).toMatchObject({
      status: 'warning',
      currentBytes: RSS_WARN_BYTES,
      growthBytes: 1,
      peakBytes: RSS_WARN_BYTES,
      lastTransition: 'warning',
    });

    clock.advance(1_000);
    rss = RSS_WARN_BYTES - 100;
    const recovered = watchdog.snapshot();
    expect(recovered.rss).toMatchObject({
      status: 'ok',
      growthBytes: -99,
      peakBytes: RSS_WARN_BYTES,
      lastTransition: 'recovered',
    });
  });

  it('reports a failed RSS sample as stale and recovers on the next cheap read', () => {
    const clock = makeClock();
    let shouldThrow = false;
    const watchdog = createResourceReadinessWatchdog({
      nowMs: clock.now,
      readRssBytes: () => {
        if (shouldThrow) throw new Error('synthetic read failure');
        return 512;
      },
    });
    watchdog.markServing();
    expect(watchdog.snapshot().rss.status).toBe('ok');

    shouldThrow = true;
    clock.advance(1_000);
    const stale = watchdog.snapshot().rss;
    expect(stale).toMatchObject({
      status: 'stale',
      currentBytes: null,
      lastObservedBytes: 512,
      lastTransition: 'stale',
    });

    shouldThrow = false;
    clock.advance(1_000);
    expect(watchdog.snapshot().rss).toMatchObject({
      status: 'ok',
      currentBytes: 512,
      lastTransition: 'recovered',
    });
  });

  it('enforces boot-to-serving under 10 seconds and attributes the slowest phase', () => {
    const clock = makeClock();
    const watchdog = createResourceReadinessWatchdog({
      nowMs: clock.now,
      readRssBytes: () => 1,
    });
    clock.advance(2_000);
    watchdog.recordBootPhase('identity-lock');
    clock.advance(6_000);
    watchdog.recordBootPhase('core-runtime');
    clock.advance(1_999);
    watchdog.markServing();

    expect(watchdog.snapshot().bootToServing).toMatchObject({
      status: 'ok',
      budgetMs: BOOT_TO_SERVING_BUDGET_MS,
      elapsedMs: 9_999,
      slowestPhase: 'core-runtime',
      phases: [
        { name: 'identity-lock', durationMs: 2_000 },
        { name: 'core-runtime', durationMs: 6_000 },
        { name: 'http-listen', durationMs: 1_999 },
      ],
    });
  });

  it('is stale before serving, recovers under budget, and warns at the 10-second boundary', () => {
    const clock = makeClock();
    const recovering = createResourceReadinessWatchdog({
      nowMs: clock.now,
      readRssBytes: () => 1,
    });
    clock.advance(2_000);
    expect(recovering.snapshot().bootToServing).toMatchObject({
      status: 'stale',
      servingAt: null,
      lastTransition: 'initialized',
    });
    clock.advance(1_000);
    recovering.markServing();
    expect(recovering.snapshot().bootToServing).toMatchObject({
      status: 'ok',
      elapsedMs: 3_000,
      lastTransition: 'recovered',
    });

    const warningClock = makeClock();
    const warning = createResourceReadinessWatchdog({
      nowMs: warningClock.now,
      readRssBytes: () => 1,
    });
    warningClock.advance(BOOT_TO_SERVING_BUDGET_MS);
    warning.markServing();
    expect(warning.snapshot().bootToServing).toMatchObject({
      status: 'warning',
      elapsedMs: BOOT_TO_SERVING_BUDGET_MS,
    });
  });
});
