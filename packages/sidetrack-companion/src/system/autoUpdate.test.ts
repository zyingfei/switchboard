import { describe, expect, it } from 'vitest';

import { runAutoUpdate, type AutoUpdateExecPort } from './autoUpdate.js';

const advisory = (latest: string | null, behind: boolean) => ({
  current: '1.0.0',
  latest,
  behind,
  ageDays: null,
  releasedAt: null,
});

describe('runAutoUpdate', () => {
  it('refuses when the confirm token does not match latest', async () => {
    const result = await runAutoUpdate({
      confirm: '1.0.1',
      currentVersion: '1.0.0',
      checkLatest: () => Promise.resolve(advisory('1.0.2', true)),
    });

    expect(result).toEqual({ ok: false, from: '1.0.0', to: '1.0.2', durationMs: 0 });
  });

  it('refuses when already current', async () => {
    const result = await runAutoUpdate({
      confirm: '1.0.0',
      currentVersion: '1.0.0',
      checkLatest: () => Promise.resolve(advisory('1.0.0', false)),
    });

    expect(result).toEqual({ ok: false, from: '1.0.0', to: '1.0.0', durationMs: 0 });
  });

  it('runs npm update on success and reports duration', async () => {
    const exec: AutoUpdateExecPort = {
      execFile: (file, args) => {
        expect(file).toBe('npm');
        expect(args).toEqual(['update', '-g', '@sidetrack/companion']);
        return Promise.resolve({ stdout: 'ok', stderr: '' });
      },
    };
    const times = [new Date('2026-05-03T00:00:00.000Z'), new Date('2026-05-03T00:00:02.000Z')];

    const result = await runAutoUpdate({
      confirm: '1.0.2',
      currentVersion: '1.0.0',
      exec,
      nowFn: () => times.shift() ?? new Date('2026-05-03T00:00:02.000Z'),
      checkLatest: () => Promise.resolve(advisory('1.0.2', true)),
    });

    expect(result).toEqual({ ok: true, from: '1.0.0', to: '1.0.2', durationMs: 2000 });
  });

  it('surfaces exec failures without throwing', async () => {
    const result = await runAutoUpdate({
      confirm: '1.0.2',
      currentVersion: '1.0.0',
      exec: { execFile: () => Promise.reject(new Error('npm exploded')) },
      checkLatest: () => Promise.resolve(advisory('1.0.2', true)),
    });

    expect(result).toMatchObject({
      ok: false,
      from: '1.0.0',
      to: '1.0.2',
      stderr: 'npm exploded',
    });
  });
});
