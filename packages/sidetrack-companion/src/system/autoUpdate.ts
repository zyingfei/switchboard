import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { checkLatestVersion, type UpdateAdvisory } from './versionCheck.js';

const execFileAsync = promisify(execFile);

export interface UpdateResult {
  readonly ok: boolean;
  readonly from: string;
  readonly to: string | null;
  readonly durationMs: number;
  readonly stderr?: string;
}

export interface AutoUpdateExecPort {
  readonly execFile: (
    file: string,
    args: readonly string[],
  ) => Promise<{ readonly stdout: string; readonly stderr: string }>;
}

export const nodeAutoUpdateExecPort: AutoUpdateExecPort = {
  execFile: (file, args) =>
    execFileAsync(file, [...args]).then((result) => ({
      stdout: result.stdout,
      stderr: result.stderr,
    })),
};

export const runAutoUpdate = async (opts: {
  readonly confirm: string;
  readonly currentVersion: string;
  readonly exec?: AutoUpdateExecPort;
  readonly checkLatest?: (currentVersion: string, now: Date) => Promise<UpdateAdvisory>;
  readonly nowFn?: () => Date;
}): Promise<UpdateResult> => {
  const started = opts.nowFn?.() ?? new Date();
  const advisory = await (opts.checkLatest ?? ((current, now) => checkLatestVersion(current, globalThis.fetch, now)))(
    opts.currentVersion,
    started,
  );
  if (!advisory.behind || advisory.latest === null) {
    return { ok: false, from: opts.currentVersion, to: advisory.latest, durationMs: 0 };
  }
  if (opts.confirm !== advisory.latest) {
    return { ok: false, from: opts.currentVersion, to: advisory.latest, durationMs: 0 };
  }
  try {
    const result = await (opts.exec ?? nodeAutoUpdateExecPort).execFile('npm', [
      'update',
      '-g',
      '@sidetrack/companion',
    ]);
    const ended = opts.nowFn?.() ?? new Date();
    return {
      ok: true,
      from: opts.currentVersion,
      to: advisory.latest,
      durationMs: Math.max(0, ended.getTime() - started.getTime()),
      ...(result.stderr.length === 0 ? {} : { stderr: result.stderr }),
    };
  } catch (error) {
    const ended = opts.nowFn?.() ?? new Date();
    return {
      ok: false,
      from: opts.currentVersion,
      to: advisory.latest,
      durationMs: Math.max(0, ended.getTime() - started.getTime()),
      stderr: error instanceof Error ? error.message : 'npm update failed',
    };
  }
};
