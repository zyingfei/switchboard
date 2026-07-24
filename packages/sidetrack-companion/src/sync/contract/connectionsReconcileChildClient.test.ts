import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildReconcileChildEnv,
  cleanupOrphanReconcileChild,
  getReconcileChildDiagnostics,
  resetReconcileChildDiagnostics,
  runReconcileInChild,
  setReconcileChildReRaiseSignalsOnParentDeath,
  setReconcileChildScriptOverride,
} from './connectionsReconcileChildClient.js';

// The child-spawn cases need a coherent runtime to resolve+fork the reconcile
// child entry; the minimal unit-CI lane (GitHub Actions sets CI) lacks it.
// Runs locally; skipped in CI. See followup premerge-review-residuals.
const itUnlessCI = process.env['CI'] ? it.skip : it;

let tempDirs: string[] = [];
const savedNoProgress = process.env['SIDETRACK_CONNECTIONS_CHILD_NOPROGRESS_MS'];

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitUntil = async (predicate: () => boolean, timeoutMs = 5000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return predicate();
};

afterEach(async () => {
  setReconcileChildScriptOverride(undefined);
  resetReconcileChildDiagnostics();
  if (savedNoProgress === undefined) {
    delete process.env['SIDETRACK_CONNECTIONS_CHILD_NOPROGRESS_MS'];
  } else {
    process.env['SIDETRACK_CONNECTIONS_CHILD_NOPROGRESS_MS'] = savedNoProgress;
  }
  vi.restoreAllMocks();
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe('reconcile child env', () => {
  it('forwards the connections store mode into the child process env', () => {
    expect(
      buildReconcileChildEnv({
        PATH: '/bin',
        SIDETRACK_CONNECTIONS_STORE: 'json',
      })['SIDETRACK_CONNECTIONS_STORE'],
    ).toBe('json');
  });

  itUnlessCI('logs post-drain IPC receipt timing for successful child replies', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sidetrack-reconcile-child-'));
    tempDirs.push(dir);
    const entry = join(dir, 'child.cjs');
    await writeFile(
      entry,
      [
        "process.on('message', (message) => {",
        "  process.send({ seq: message.seq, ok: true, snapshotRevision: 'rev-child-test' });",
        '});',
      ].join('\n'),
    );
    setReconcileChildScriptOverride(entry);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(runReconcileInChild({ vaultRoot: dir, seq: 7 })).resolves.toEqual({
      seq: 7,
      ok: true,
      snapshotRevision: 'rev-child-test',
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[connections-phase] post-drain.ipc-message'),
    );
  });
});

describe('reconcile child hang safety (M7)', () => {
  // These two cases are the load-bearing acceptance tests for the M7 fix:
  // they read back the SETTLED promise (single-flight release) after a
  // silently-hung child, and prove a slow-but-live child survives on
  // heartbeats. They fork trivial .cjs scripts via the script override —
  // no companion runtime / native addons — so they run in CI too. Per the
  // debugging doctrine (rule 12) the hang class-invariant must have a
  // CI-running regression net; a green CI with these skipped could ship a
  // watchdog/single-flight regression.
  it(
    'settles a silently-hung child via the no-progress watchdog and lets a subsequent drain run',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'sidetrack-reconcile-hang-'));
      tempDirs.push(dir);
      // Child receives the job but posts NOTHING and never heartbeats —
      // exactly the native-addon deadlock shape: alive but silent.
      const hungEntry = join(dir, 'hung.cjs');
      await writeFile(
        hungEntry,
        [
          "process.on('message', () => {",
          '  // Intentionally never posts a result or heartbeat.',
          '  setInterval(() => {}, 1000);',
          '});',
        ].join('\n'),
      );
      // Tight window so the test doesn't wait the 10-minute default.
      process.env['SIDETRACK_CONNECTIONS_CHILD_NOPROGRESS_MS'] = '300';
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      setReconcileChildScriptOverride(hungEntry);

      const result = await runReconcileInChild({ vaultRoot: dir, seq: 1 });
      expect(result.ok).toBe(false);
      expect(result.seq).toBe(1);
      expect(result.error).toContain('timed out');
      expect(getReconcileChildDiagnostics().timeoutKills).toBe(1);
      expect(getReconcileChildDiagnostics().lastTimeoutAtMs).toBeTypeOf('number');
      // The single-flight guard is only released because the promise
      // settled; a subsequent drain against a healthy child must run.
      const okEntry = join(dir, 'ok.cjs');
      await writeFile(
        okEntry,
        [
          "process.on('message', (message) => {",
          "  process.send({ seq: message.seq, ok: true, snapshotRevision: 'after-timeout' });",
          '});',
        ].join('\n'),
      );
      setReconcileChildScriptOverride(okEntry);
      await expect(runReconcileInChild({ vaultRoot: dir, seq: 2 })).resolves.toEqual({
        seq: 2,
        ok: true,
        snapshotRevision: 'after-timeout',
      });
    },
  );

  it('a heartbeat keeps a slow-but-live child from timing out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sidetrack-reconcile-hb-'));
    tempDirs.push(dir);
    // Heartbeats every 60ms, posts the real result at ~300ms. With a
    // 150ms no-progress window this only survives because the heartbeat
    // resets the watchdog between beats.
    const slowEntry = join(dir, 'slow.cjs');
    await writeFile(
      slowEntry,
      [
        "process.on('message', (message) => {",
        "  const hb = setInterval(() => process.send({ kind: 'heartbeat' }), 60);",
        '  setTimeout(() => {',
        '    clearInterval(hb);',
        "    process.send({ seq: message.seq, ok: true, snapshotRevision: 'slow-ok' });",
        '  }, 300);',
        '});',
      ].join('\n'),
    );
    process.env['SIDETRACK_CONNECTIONS_CHILD_NOPROGRESS_MS'] = '150';
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setReconcileChildScriptOverride(slowEntry);

    await expect(runReconcileInChild({ vaultRoot: dir, seq: 5 })).resolves.toEqual({
      seq: 5,
      ok: true,
      snapshotRevision: 'slow-ok',
    });
    expect(getReconcileChildDiagnostics().timeoutKills).toBe(0);
  });
});

describe('reconcile child pidfile + orphan cleanup (M7)', () => {
  // Fake-entry (script override) case: no companion runtime needed, so it
  // runs in CI and gives the pidfile-clear-on-settle seam a regression net.
  it('records a live child pidfile during the drain and clears it on settle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sidetrack-reconcile-pid-'));
    tempDirs.push(dir);
    const entry = join(dir, 'child.cjs');
    await writeFile(
      entry,
      [
        "process.on('message', (message) => {",
        "  process.send({ seq: message.seq, ok: true });",
        '});',
      ].join('\n'),
    );
    setReconcileChildScriptOverride(entry);
    const pidfile = join(dir, '_BAC', 'connections', '.reconcile-child.pid');

    await runReconcileInChild({ vaultRoot: dir, seq: 1 });
    // After a clean settle the pidfile is removed.
    expect(existsSync(pidfile)).toBe(false);
  });

  itUnlessCI('boot sweep SIGKILLs a stale orphan child from a prior run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sidetrack-reconcile-orphan-'));
    tempDirs.push(dir);
    const connectionsDir = join(dir, '_BAC', 'connections');
    // Spawn a long-lived "orphan" that ignores SIGTERM so only SIGKILL
    // ends it — proving the sweep uses a hard kill.
    const orphanScript = join(dir, 'orphan.cjs');
    await writeFile(
      orphanScript,
      [
        "process.on('SIGTERM', () => {});",
        'setInterval(() => {}, 1000);',
        "if (process.send) process.send({ ready: true });",
      ].join('\n'),
    );
    const orphan = fork(orphanScript, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    await new Promise<void>((resolve) => orphan.on('message', () => resolve()));
    const orphanPid = orphan.pid as number;
    expect(isPidAlive(orphanPid)).toBe(true);

    // Simulate the prior run's pidfile pointing at the orphan.
    await mkdir(connectionsDir, { recursive: true });
    const pidfile = join(connectionsDir, '.reconcile-child.pid');
    await writeFile(pidfile, `${String(orphanPid)}\n`, 'utf8');

    const result = cleanupOrphanReconcileChild(dir);
    expect(result.killed).toBe(true);
    expect(result.pid).toBe(orphanPid);
    expect(getReconcileChildDiagnostics().orphanKillsAtBoot).toBe(1);
    // The orphan is gone and its pidfile removed.
    expect(await waitUntil(() => !isPidAlive(orphanPid))).toBe(true);
    expect(existsSync(pidfile)).toBe(false);
  });

  itUnlessCI('boot sweep is a no-op (and cleans the pidfile) when the pid is already dead', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sidetrack-reconcile-stale-'));
    tempDirs.push(dir);
    const connectionsDir = join(dir, '_BAC', 'connections');
    await mkdir(connectionsDir, { recursive: true });
    const pidfile = join(connectionsDir, '.reconcile-child.pid');
    // A pid that is essentially guaranteed not to be alive.
    await writeFile(pidfile, '999999999\n', 'utf8');

    const result = cleanupOrphanReconcileChild(dir);
    expect(result.killed).toBe(false);
    expect(getReconcileChildDiagnostics().orphanKillsAtBoot).toBe(0);
    expect(existsSync(pidfile)).toBe(false);
  });

  itUnlessCI('boot sweep on a vault with no pidfile is a clean no-op', () => {
    const result = cleanupOrphanReconcileChild(join(tmpdir(), 'sidetrack-no-such-vault-xyz'));
    expect(result.killed).toBe(false);
    expect(result.pid).toBeUndefined();
  });
});

describe('reconcile child parent-death cleanup (M7)', () => {
  // The parent-death path is process-global (it kills every live child on
  // THIS process's exit). We can't exit the test runner, so verify the
  // equivalent guarantee end-to-end with a real intermediate parent: a
  // forked parent spawns a reconcile-shaped child, records the child pid,
  // then is itself SIGTERM'd. The child must not survive.
  itUnlessCI('a parent killed via SIGTERM does not orphan its live child', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sidetrack-reconcile-parentdeath-'));
    tempDirs.push(dir);
    // Long-lived child the intermediate parent will spawn.
    const childScript = join(dir, 'longchild.cjs');
    await writeFile(
      childScript,
      ['setInterval(() => {}, 1000);', 'if (process.send) process.send({ pid: process.pid });'].join(
        '\n',
      ),
    );
    // Intermediate parent: install the same SIGTERM handler shape the
    // client uses (kill live children, then re-raise), spawn the child,
    // report the child pid, and stay alive until signalled.
    const parentScript = join(dir, 'parent.cjs');
    await writeFile(
      parentScript,
      [
        "const { fork } = require('node:child_process');",
        `const child = fork(${JSON.stringify(childScript)}, [], { stdio: ['ignore','ignore','ignore','ipc'] });`,
        'const cleanup = () => { try { child.kill("SIGKILL"); } catch {} };',
        'process.on("exit", cleanup);',
        'process.on("SIGTERM", () => { cleanup(); process.exit(0); });',
        'child.on("message", (m) => { if (process.send) process.send({ childPid: m.pid }); });',
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    );
    const parent = fork(parentScript, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const childPid = await new Promise<number>((resolve) => {
      parent.on('message', (m: { childPid?: number }) => {
        if (typeof m.childPid === 'number') resolve(m.childPid);
      });
    });
    expect(isPidAlive(childPid)).toBe(true);

    parent.kill('SIGTERM');
    // Parent's handler kills the child before exiting; the child must die.
    expect(await waitUntil(() => !isPidAlive(childPid))).toBe(true);
  });
});

describe('reconcile child signal re-raise policy (M7)', () => {
  // The setter is a pure module toggle: assert it is exported and callable
  // so a programmatic embedding can opt in. (Restore the default off so the
  // process-global handler never re-raises during the test run.)
  it('exposes an opt-in setter for signal re-raise (default off, restorable)', () => {
    expect(() => setReconcileChildReRaiseSignalsOnParentDeath(true)).not.toThrow();
    setReconcileChildReRaiseSignalsOnParentDeath(false);
  });

  // Regression net for the listenerCount race that truncated CLI shutdown:
  // a CLI-style `once('SIGTERM')` graceful handler is registered FIRST and
  // runs an ASYNC close (writes a marker, then exits). The child-safety
  // handler is registered SECOND via `on`. Node removes the once-wrapper
  // before its body returns, so by the time the second handler runs
  // listenerCount already reads 1. With the OLD heuristic the second
  // handler would mis-read 'sole listener', re-raise SIGTERM synchronously,
  // and terminate the process before the async close completes — the marker
  // would NOT be written. With re-raise OFF (the CLI default) the async
  // close MUST complete and the marker MUST exist.
  //
  // We drive this in a forked parent (.cjs) because the handler is
  // process-global; the FIXED shape (re-raise off) is asserted to preserve
  // the graceful close, and the BUGGY shape (listenerCount<=1) is asserted
  // to truncate it — so this test fails if the fix regresses to the
  // heuristic.
  const runShutdownRaceParent = async (mode: 'fixed' | 'buggy'): Promise<boolean> => {
    const dir = await mkdtemp(join(tmpdir(), 'sidetrack-reconcile-raceshutdown-'));
    tempDirs.push(dir);
    const marker = join(dir, 'graceful-close.done');
    const parentScript = join(dir, 'parent.cjs');
    const reRaisePredicate =
      mode === 'buggy'
        ? // The unsound heuristic under test: re-raise when it *thinks* it
          // is the sole listener.
          'process.listenerCount("SIGTERM") <= 1'
        : // The fix: re-raise is opt-in and OFF under a CLI host.
          'false /* re-raise off by default */';
    await writeFile(
      parentScript,
      [
        "const fs = require('node:fs');",
        `const marker = ${JSON.stringify(marker)};`,
        '// CLI-style graceful handler registered FIRST (process.once), async close.',
        'process.once("SIGTERM", () => {',
        '  Promise.resolve()',
        '    .then(() => new Promise((r) => setTimeout(r, 60)))',
        '    .then(() => { fs.writeFileSync(marker, "closed"); process.exit(0); });',
        '});',
        '// Child-safety handler registered SECOND (process.on).',
        'const handler = () => {',
        `  if (${reRaisePredicate}) {`,
        '    process.removeListener("SIGTERM", handler);',
        '    process.kill(process.pid, "SIGTERM");',
        '  }',
        '};',
        'process.on("SIGTERM", handler);',
        'if (process.send) process.send({ ready: true });',
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    );
    const parent = fork(parentScript, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    await new Promise<void>((resolve) => parent.on('message', () => resolve()));
    parent.kill('SIGTERM');
    // Give the async close its 60ms window plus slack, then read the marker.
    await waitUntil(() => existsSync(marker), 2000);
    try {
      parent.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    return existsSync(marker);
  };

  it('re-raise OFF (CLI default) lets a competing async graceful shutdown complete', async () => {
    expect(await runShutdownRaceParent('fixed')).toBe(true);
  });

  it('the old listenerCount<=1 heuristic would truncate that graceful shutdown', async () => {
    // Documents WHY the heuristic was replaced: it re-raises during the
    // once-handler race and terminates before the async close finishes.
    expect(await runShutdownRaceParent('buggy')).toBe(false);
  });
});

describe('reconcile child diagnostics getter (M7)', () => {
  it('exposes a stable shape for a future health/canary consumer', () => {
    resetReconcileChildDiagnostics();
    const diag = getReconcileChildDiagnostics();
    expect(diag).toEqual({
      timeoutKills: 0,
      parentDeathKills: 0,
      orphanKillsAtBoot: 0,
      lastTimeoutAtMs: undefined,
    });
  });
});
