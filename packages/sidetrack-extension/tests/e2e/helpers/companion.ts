import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

export interface TestCompanion {
  readonly bridgeKey: string;
  readonly port: number;
  readonly vaultPath: string;
  // Hard close: kill process AND remove vault. Use in finally{} for
  // teardown.
  readonly close: () => Promise<void>;
  // Soft stop: kill process, KEEP vault on disk (and the bridge key
  // file, replicaId, recall index, event log). Pair with restart()
  // for offline-then-reconnect tests.
  readonly stop: () => Promise<void>;
  // Respawn the companion against the same vault on the same port +
  // sync settings. Bridge key + replicaId are preserved (read from
  // vault). Returns when the new process is listening.
  readonly restart: () => Promise<void>;
}

export interface StartTestCompanionOptions {
  readonly syncRelay?: string;
  readonly syncRelayLocalPort?: number;
  readonly syncRendezvousSecret?: string;
}

const packageRoot = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const companionRoot = path.resolve(packageRoot, '../sidetrack-companion');
const companionCliPath = path.join(companionRoot, 'dist/cli.js');

type CompanionProcess = ChildProcessByStdio<null, Readable, Readable>;

const reservePort = async (): Promise<number> => {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not reserve a companion test port.'));
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
};

const waitForListening = async (child: CompanionProcess, port: number): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Companion did not start on port ${String(port)}. Output:\n${output}`));
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
          `Companion exited before listening on port ${String(port)}: code=${String(
            code,
          )} signal=${String(signal)} output=${output}`,
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

const closeProcess = async (child: CompanionProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill('SIGTERM');
  const exited = await Promise.race([
    once(child, 'exit').then(() => true),
    new Promise<boolean>((resolve) => {
      setTimeout(() => {
        resolve(false);
      }, 2_000);
    }),
  ]);

  if (!exited) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
};

export const startTestCompanion = async (
  options: StartTestCompanionOptions = {},
): Promise<TestCompanion> => {
  const vaultPath = await mkdtemp(path.join(tmpdir(), 'sidetrack-extension-e2e-vault-'));
  const port = await reservePort();
  const args = [
    companionCliPath,
    '--vault',
    vaultPath,
    '--port',
    String(port),
    ...(options.syncRelayLocalPort === undefined
      ? []
      : ['--sync-relay-local', String(options.syncRelayLocalPort)]),
    ...(options.syncRelay === undefined || options.syncRendezvousSecret === undefined
      ? []
      : [
          '--sync-relay',
          options.syncRelay,
          '--sync-rendezvous-secret',
          options.syncRendezvousSecret,
        ]),
    ...(options.syncRelayLocalPort === undefined || options.syncRendezvousSecret === undefined
      ? []
      : ['--sync-rendezvous-secret', options.syncRendezvousSecret]),
  ];

  // Mutable handle for the current child process. stop()/restart()
  // swap this out so the test can drive offline → online cycles
  // against the same vault. Same-port + same-vault means the
  // extension's settings keep working without a re-seed.
  let child: CompanionProcess | null = null;

  const spawnNow = async (): Promise<void> => {
    const next = spawn(process.execPath, args, {
      cwd: companionRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await waitForListening(next, port);
    } catch (error) {
      await closeProcess(next);
      throw error;
    }
    child = next;
  };

  await spawnNow();
  let bridgeKey: string;
  try {
    bridgeKey = (
      await readFile(path.join(vaultPath, '_BAC/.config/bridge.key'), 'utf8')
    ).trim();
  } catch (error) {
    if (child !== null) await closeProcess(child);
    await rm(vaultPath, { recursive: true, force: true });
    throw error;
  }

  return {
    bridgeKey,
    port,
    vaultPath,
    async close() {
      try {
        if (child !== null) await closeProcess(child);
      } finally {
        await rm(vaultPath, { recursive: true, force: true });
      }
    },
    async stop() {
      if (child !== null) {
        await closeProcess(child);
        child = null;
      }
    },
    async restart() {
      // No-op if the previous stop() already cleaned up; otherwise
      // SIGTERM the existing child first so we don't double-bind the
      // port. spawnNow() reads the same args + vault.
      if (child !== null) await closeProcess(child);
      child = null;
      await spawnNow();
    },
  };
};
