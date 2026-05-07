import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

// Standalone test relay: runs `bin/sidetrack-companion relay`
// in its own subprocess so we can kill it independently of the
// companions. The two-browser-review-draft-sync.spec uses
// `--sync-relay-local` which embeds the relay inside companion-A;
// that's fine for happy-path sync, but Tier 6 + 7 need a
// kill-the-relay-without-killing-the-companion mode (T6.7.b is the
// load-bearing case).

const packageRoot = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const companionRoot = path.resolve(packageRoot, '../sidetrack-companion');
const companionCliPath = path.join(companionRoot, 'dist/cli.js');

type RelayProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface TestRelay {
  readonly port: number;
  readonly url: string;
  // Soft stop: kill the relay process. Companions wired via
  // --sync-relay reconnect automatically when the URL becomes
  // available again. KEEP the URL the same on restart() so already-
  // connected companions don't need a reconfigure.
  readonly stop: () => Promise<void>;
  readonly restart: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface StartTestRelayOptions {
  readonly port?: number;
}

const reservePort = async (): Promise<number> =>
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not reserve a relay test port.'));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on('error', reject);
  });

const waitForListening = async (child: RelayProcess, port: number): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Relay did not start on port ${String(port)}. Output:\n${output}`));
    }, 15_000);

    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('exit', onExit);
      child.off('error', onError);
    };

    const onStdout = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      // Relay logs `sidetrack-relay listening on http://127.0.0.1:<port>`.
      if (output.includes(`127.0.0.1:${String(port)}`)) {
        cleanup();
        resolve();
      }
    };
    const onStderr = (chunk: Buffer) => {
      output += chunk.toString('utf8');
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `Relay exited (code=${String(code)} signal=${String(signal ?? '')}) before listening. Output:\n${output}`,
        ),
      );
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('exit', onExit);
    child.once('error', onError);
  });
};

const closeProcess = async (child: RelayProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    once(child, 'exit').then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);
  if (!exited) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
};

export const startTestRelay = async (options: StartTestRelayOptions = {}): Promise<TestRelay> => {
  const port = options.port ?? (await reservePort());
  let child: RelayProcess | null = null;

  const spawnNow = async (): Promise<void> => {
    const next = spawn(
      process.execPath,
      [companionCliPath, 'relay', '--relay-port', String(port)],
      { cwd: companionRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    try {
      await waitForListening(next, port);
    } catch (error) {
      await closeProcess(next);
      throw error;
    }
    child = next;
  };

  await spawnNow();

  return {
    port,
    url: `ws://127.0.0.1:${String(port)}/`,
    async stop() {
      if (child !== null) {
        await closeProcess(child);
        child = null;
      }
    },
    async restart() {
      if (child !== null) await closeProcess(child);
      child = null;
      await spawnNow();
    },
    async close() {
      if (child !== null) await closeProcess(child);
      child = null;
    },
  };
};
