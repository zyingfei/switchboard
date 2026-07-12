import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';

import { buildCompanionServiceCommand } from './command.js';
import type {
  ExecPort,
  FilePort,
  Installer,
  InstallOptions,
  InstallResult,
  ServiceStatus,
} from './types.js';

const LABEL = 'com.sidetrack.companion';
// Systemd unit name mirrors the launchd label — kept in one place so the
// Linux liveness probe and any future installer stay in sync.
const SYSTEMD_UNIT = 'sidetrack-companion.service';

// Actual process liveness, distinct from "the service file exists on
// disk". `running` is a real yes/no; `unknown` is the honest answer when
// the platform's service tool is absent or the probe times out — never
// conflated with "not running". A caller must NOT report `false` from
// `unknown`.
export type Liveness = 'running' | 'not-running' | 'unknown';

// Bounded command runner for the liveness probe. Returns the exit code +
// stdout instead of throwing on a non-zero exit, because the probe tools
// SIGNAL state through the exit code (`systemctl is-active` → 3 when
// inactive; `launchctl print` → non-zero when the label isn't loaded).
// Injected in tests; the default shells out with a hard timeout so a
// wedged tool can never block the health path.
export interface ProbeExec {
  readonly run: (
    file: string,
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<{ readonly code: number | null; readonly stdout: string } | { readonly enoent: true }>;
}

const LIVENESS_PROBE_TIMEOUT_MS = 1_500;

export const nodeProbeExec: ProbeExec = {
  run: (file, args, timeoutMs) =>
    new Promise((resolve) => {
      execFile(
        file,
        [...args],
        { timeout: timeoutMs, killSignal: 'SIGKILL' },
        (error, stdout) => {
          // ENOENT ⇒ the tool isn't installed on this host.
          if (error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
            resolve({ enoent: true });
            return;
          }
          // A non-zero exit is NOT a failure here — it encodes state.
          // `error.code` is the numeric exit status when the child ran.
          const code =
            error !== null && typeof (error as { code?: unknown }).code === 'number'
              ? ((error as { code: number }).code)
              : error !== null
                ? null
                : 0;
          // Default encoding is utf8 (no `encoding: 'buffer'`) so stdout
          // is already a string.
          resolve({ code, stdout });
        },
      );
    }),
};

// Query real liveness of the companion login service. macOS:
// `launchctl print gui/<uid>/<label>` — a loaded, running job reports a
// non-negative `state = running` / a `pid = N`; a not-loaded label exits
// non-zero. Linux: `systemctl --user is-active <unit>` — stdout `active`
// ⇒ running, `inactive`/`failed` ⇒ not-running. Any missing tool or
// timeout ⇒ `unknown`. Never throws; bounded exec.
export const probeServiceLiveness = async (
  platform: NodeJS.Platform,
  exec: ProbeExec = nodeProbeExec,
  timeoutMs: number = LIVENESS_PROBE_TIMEOUT_MS,
): Promise<Liveness> => {
  try {
    if (platform === 'darwin') {
      const uid = String(process.getuid?.() ?? 0);
      const result = await exec.run('launchctl', ['print', `gui/${uid}/${LABEL}`], timeoutMs);
      if ('enoent' in result) return 'unknown';
      if (result.code === null) return 'unknown';
      // Label not loaded ⇒ non-zero exit ⇒ not running.
      if (result.code !== 0) return 'not-running';
      // Loaded: a live job has a numeric pid AND state = running. A
      // loaded-but-not-spawned job (e.g. crashed under KeepAlive) omits
      // the pid or reports a non-running state.
      const hasPid = /(^|\n)\s*pid\s*=\s*\d+/.test(result.stdout);
      const stateRunning = /state\s*=\s*running/.test(result.stdout);
      return hasPid || stateRunning ? 'running' : 'not-running';
    }
    if (platform === 'linux') {
      const result = await exec.run('systemctl', ['--user', 'is-active', SYSTEMD_UNIT], timeoutMs);
      if ('enoent' in result) return 'unknown';
      if (result.code === null) return 'unknown';
      const state = result.stdout.trim();
      // is-active exits 0 + "active" when running; non-zero + a state
      // word (inactive/failed/activating) otherwise. "activating" is not
      // yet serving, so it is honestly not-running.
      if (state === 'active') return 'running';
      if (state.length > 0) return 'not-running';
      return result.code === 0 ? 'running' : 'not-running';
    }
    return 'unknown';
  } catch {
    // A throwing exec (unexpected) must degrade to unknown, never crash
    // the health path.
    return 'unknown';
  }
};

const xmlEscape = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

const plist = (opts: InstallOptions): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${buildCompanionServiceCommand(opts)
  .map((arg) => `    <string>${xmlEscape(arg)}</string>`)
  .join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`;

export class LaunchdInstaller implements Installer {
  readonly path: string;

  constructor(
    homeDir: string,
    private readonly files: FilePort,
    private readonly exec: ExecPort,
  ) {
    this.path = join(homeDir, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  }

  async install(opts: InstallOptions): Promise<InstallResult> {
    await this.files.mkdir(dirname(this.path));
    await this.files.writeFile(this.path, plist(opts));
    await this.exec
      .execFile('launchctl', ['bootout', `gui/${String(process.getuid?.() ?? 0)}`, this.path])
      .catch(() => undefined);
    await this.exec.execFile('launchctl', [
      'bootstrap',
      `gui/${String(process.getuid?.() ?? 0)}`,
      this.path,
    ]);
    return { platform: 'darwin', path: this.path, installed: true, running: true };
  }

  async uninstall(): Promise<void> {
    await this.exec
      .execFile('launchctl', ['bootout', `gui/${String(process.getuid?.() ?? 0)}`, this.path])
      .catch(() => undefined);
    await this.files.rm(this.path);
  }

  async status(): Promise<ServiceStatus> {
    const installed = await this.files.exists(this.path);
    return { platform: 'darwin', installed, running: installed, path: this.path };
  }
}
