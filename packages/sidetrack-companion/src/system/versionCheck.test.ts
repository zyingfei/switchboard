import { beforeEach, describe, expect, it, vi } from 'vitest';

import { checkLatestVersion, clearVersionCheckCache, isBehind } from './versionCheck.js';

const response = (body: unknown, ok = true, status = 200): Response =>
  ({
    ok,
    status,
    json: () => Promise.resolve(body),
  }) as Response;

describe('versionCheck', () => {
  beforeEach(() => {
    clearVersionCheckCache();
  });

  it('compares major minor patch versions', () => {
    expect(isBehind('1.2.3', '1.2.4')).toBe(true);
    expect(isBehind('1.3.0', '1.2.9')).toBe(false);
    expect(isBehind('1.2.3', '1.2.3')).toBe(false);
  });

  it('returns behind=true with release age', async () => {
    const fetchPort = vi.fn(() =>
      Promise.resolve(response({ version: '1.2.0', time: '2026-05-01T00:00:00.000Z' })),
    );

    const advisory = await checkLatestVersion(
      '1.1.0',
      fetchPort,
      new Date('2026-05-03T00:00:00.000Z'),
    );

    expect(advisory).toMatchObject({
      current: '1.1.0',
      latest: '1.2.0',
      behind: true,
      ageDays: 2,
    });
  });

  it('returns behind=false when current is up to date', async () => {
    const advisory = await checkLatestVersion(
      '1.2.0',
      () => Promise.resolve(response({ version: '1.2.0' })),
      new Date('2026-05-03T00:00:00.000Z'),
    );

    expect(advisory.behind).toBe(false);
  });

  it('fails soft when offline', async () => {
    const advisory = await checkLatestVersion(
      '1.2.0',
      () => Promise.reject(new Error('offline')),
      new Date('2026-05-03T00:00:00.000Z'),
    );

    expect(advisory).toMatchObject({ latest: null, behind: false, warning: 'offline' });
  });

  it('uses the six-hour cache', async () => {
    const fetchPort = vi.fn(() => Promise.resolve(response({ version: '1.2.0' })));

    await checkLatestVersion('1.1.0', fetchPort, new Date('2026-05-03T00:00:00.000Z'));
    await checkLatestVersion('1.1.0', fetchPort, new Date('2026-05-03T01:00:00.000Z'));

    expect(fetchPort).toHaveBeenCalledTimes(1);
  });
});
