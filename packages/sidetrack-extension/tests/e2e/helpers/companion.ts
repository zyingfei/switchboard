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
  readonly close: () => Promise<void>;
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
  const child = spawn(process.execPath, args, {
    cwd: companionRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForListening(child, port);
    const bridgeKey = await readFile(path.join(vaultPath, '_BAC/.config/bridge.key'), 'utf8');

    return {
      bridgeKey: bridgeKey.trim(),
      port,
      vaultPath,
      async close() {
        try {
          await closeProcess(child);
        } finally {
          await rm(vaultPath, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await closeProcess(child);
    await rm(vaultPath, { recursive: true, force: true });
    throw error;
  }
};
