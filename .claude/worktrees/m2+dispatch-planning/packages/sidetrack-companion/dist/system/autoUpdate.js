import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkLatestVersion } from './versionCheck.js';
const execFileAsync = promisify(execFile);
export const nodeAutoUpdateExecPort = {
    execFile: (file, args) => execFileAsync(file, [...args]).then((result) => ({
        stdout: result.stdout,
        stderr: result.stderr,
    })),
};
export const runAutoUpdate = async (opts) => {
    const started = opts.nowFn?.() ?? new Date();
    const advisory = await (opts.checkLatest ?? ((current, now) => checkLatestVersion(current, globalThis.fetch, now)))(opts.currentVersion, started);
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
    }
    catch (error) {
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
//# sourceMappingURL=autoUpdate.js.map