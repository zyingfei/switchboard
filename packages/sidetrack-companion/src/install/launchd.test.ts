import { describe, expect, it } from 'vitest';

import { probeServiceLiveness, type ProbeExec } from './launchd.js';

// A ProbeExec that returns a canned result and records the invocation, so
// tests assert both the parsed liveness AND that the right tool/args ran.
const fakeExec = (
  result: Awaited<ReturnType<ProbeExec['run']>>,
): ProbeExec & { readonly calls: { file: string; args: readonly string[] }[] } => {
  const calls: { file: string; args: readonly string[] }[] = [];
  return {
    calls,
    run: (file, args) => {
      calls.push({ file, args });
      return Promise.resolve(result);
    },
  };
};

describe('probeServiceLiveness', () => {
  describe('darwin (launchctl print)', () => {
    it('running when the loaded job reports a pid', async () => {
      const exec = fakeExec({ code: 0, stdout: 'com.sidetrack.companion = {\n\tpid = 1234\n}' });
      const liveness = await probeServiceLiveness('darwin', exec);
      expect(liveness).toBe('running');
      expect(exec.calls[0]?.file).toBe('launchctl');
      expect(exec.calls[0]?.args[0]).toBe('print');
    });

    it('running when the job reports state = running', async () => {
      const exec = fakeExec({ code: 0, stdout: 'state = running\n' });
      expect(await probeServiceLiveness('darwin', exec)).toBe('running');
    });

    it('not-running when the label is not loaded (non-zero exit)', async () => {
      // launchctl print exits non-zero when the label is not bootstrapped.
      const exec = fakeExec({ code: 113, stdout: '' });
      expect(await probeServiceLiveness('darwin', exec)).toBe('not-running');
    });

    it('not-running when loaded but no pid / not spawned', async () => {
      const exec = fakeExec({ code: 0, stdout: 'com.sidetrack.companion = {\n\tstate = waiting\n}' });
      expect(await probeServiceLiveness('darwin', exec)).toBe('not-running');
    });

    it('unknown when launchctl is absent (ENOENT)', async () => {
      const exec = fakeExec({ enoent: true });
      expect(await probeServiceLiveness('darwin', exec)).toBe('unknown');
    });

    it('unknown when the probe times out / is killed (code null)', async () => {
      const exec = fakeExec({ code: null, stdout: '' });
      expect(await probeServiceLiveness('darwin', exec)).toBe('unknown');
    });
  });

  describe('linux (systemctl is-active)', () => {
    it('running when systemctl reports active', async () => {
      const exec = fakeExec({ code: 0, stdout: 'active\n' });
      const liveness = await probeServiceLiveness('linux', exec);
      expect(liveness).toBe('running');
      expect(exec.calls[0]?.file).toBe('systemctl');
      expect(exec.calls[0]?.args).toEqual(['--user', 'is-active', 'sidetrack-companion.service']);
    });

    it('not-running when systemctl reports inactive (non-zero exit)', async () => {
      const exec = fakeExec({ code: 3, stdout: 'inactive\n' });
      expect(await probeServiceLiveness('linux', exec)).toBe('not-running');
    });

    it('unknown when systemctl is absent (ENOENT)', async () => {
      const exec = fakeExec({ enoent: true });
      expect(await probeServiceLiveness('linux', exec)).toBe('unknown');
    });
  });

  it('unknown on an unsupported platform', async () => {
    const exec = fakeExec({ code: 0, stdout: 'active' });
    expect(await probeServiceLiveness('win32', exec)).toBe('unknown');
    // No probe tool exists there, so we never shell out.
    expect(exec.calls).toHaveLength(0);
  });

  it('unknown when the exec itself throws (never crashes the health path)', async () => {
    const throwingExec: ProbeExec = {
      run: () => Promise.reject(new Error('spawn failed')),
    };
    expect(await probeServiceLiveness('darwin', throwingExec)).toBe('unknown');
  });
});
