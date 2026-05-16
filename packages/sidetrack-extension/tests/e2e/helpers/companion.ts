import { execSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  readonly ingestEvents: (events: readonly unknown[]) => Promise<void>;
}

export interface StartTestCompanionOptions {
  readonly syncRelay?: string;
  readonly syncRelayLocalPort?: number;
  readonly syncRendezvousSecret?: string;
  // Pin the companion's vault dir so workstreams / threads / connections
  // survive across test reruns. When omitted (the default), a fresh
  // mkdtemp vault is created and discarded on close. Manual recorder
  // sessions pass a stable path under e.g.
  // .sidetrack-browser-profiles/<runner>/companion-vault so the user
  // doesn't have to recreate workstreams every time.
  readonly vaultDir?: string;
  // Scoped opt-out for latency-sensitive manual/recorder flows. The
  // helper strips SIDETRACK_SKIP_RANKER_SNAPSHOT from inherited env so
  // a debug shell export does not silently affect every spawned
  // companion.
  readonly skipRankerSnapshot?: boolean;
}

const packageRoot = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const companionRoot = path.resolve(packageRoot, '../sidetrack-companion');
const companionCliPath = path.join(companionRoot, 'dist/cli.js');

// Stage 5 follow-up — best-effort git SHA used by the attach-diag's
// stale-process detection. Returns the env-var key/value pair when the
// SHA can be read; returns `{}` so the spread is a no-op when git
// isn't available (CI image without git, or running outside a repo).
const readGitShaForEnv = (): { readonly SIDETRACK_COMPANION_GIT_SHA?: string } => {
  try {
    const sha = execSync('git rev-parse --short HEAD', {
      cwd: companionRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return sha.length > 0 ? { SIDETRACK_COMPANION_GIT_SHA: sha } : {};
  } catch {
    return {};
  }
};

type CompanionProcess = ChildProcessByStdio<null, Readable, Readable>;

const companionEnv = (
  options: Pick<StartTestCompanionOptions, 'skipRankerSnapshot'> = {},
): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env['SIDETRACK_SKIP_RANKER_SNAPSHOT'];
  if (options.skipRankerSnapshot === true) {
    env['SIDETRACK_SKIP_RANKER_SNAPSHOT'] = '1';
  }
  return env;
};

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

const runCli = async (args: readonly string[]): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [companionCliPath, ...args], {
      cwd: companionRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...companionEnv(),
        SIDETRACK_TEST_EMBEDDER: '1',
      },
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Companion CLI failed: code=${String(code)} signal=${String(signal)} output=${output}`,
        ),
      );
    });
  });
};

export const startTestCompanion = async (
  options: StartTestCompanionOptions = {},
): Promise<TestCompanion> => {
  const vaultPath =
    options.vaultDir !== undefined && options.vaultDir.length > 0
      ? (await mkdir(options.vaultDir, { recursive: true }), options.vaultDir)
      : await mkdtemp(path.join(tmpdir(), 'sidetrack-extension-e2e-vault-'));
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
      env: {
        ...companionEnv(options),
        // Sync Contract v1 / L1-G2 + L1-G3 e2e fixture: enable the
        // deterministic test embedder so the spawned companion can
        // build a recall index without loading the 100+MB HF
        // multilingual-e5-small model. Same hook is used in
        // companion-side unit tests via vi.mock; the env-var path
        // is what the spawned subprocess sees.
        SIDETRACK_TEST_EMBEDDER: '1',
        // The test embedder hashes tokens into 384 dims with ±0.25
        // weight; even visits sharing 3-4 corpus tokens reach only
        // ~0.35 cosine, well below the 0.85 production gate. Lower
        // both the similarity producer + topic clusterer gates so the
        // full-browser-sync e2e (and any other test that uses the
        // deterministic embedder) actually forms clusters. Production
        // companions keep the 0.85 default — these envs only fire for
        // spawned test companions.
        ...(process.env['SIDETRACK_SIMILARITY_THRESHOLD'] === undefined
          ? { SIDETRACK_SIMILARITY_THRESHOLD: '0.2' }
          : {}),
        ...(process.env['SIDETRACK_TOPIC_COSINE_THRESHOLD'] === undefined
          ? { SIDETRACK_TOPIC_COSINE_THRESHOLD: '0.2' }
          : {}),
        // Stage 5 follow-up — inherit the test-harness's git SHA so the
        // companion's /v1/version reports the actual build identity.
        // Lets the attach-diag detect "extension rebuilt but the
        // companion is still running the prior build."
        ...(process.env['SIDETRACK_COMPANION_GIT_SHA'] === undefined
          ? readGitShaForEnv()
          : {}),
      },
    });
    try {
      await waitForListening(next, port);
    } catch (error) {
      await closeProcess(next);
      throw error;
    }
    // After listening, drain stdout/stderr so the pipes don't fill
    // and stall the child. Stderr is forwarded so test failures
    // surface companion errors; stdout is silenced (the build's
    // own [recall] / [relay] info logs would drown out test
    // output otherwise — set DEBUG_COMP=1 to re-enable).
    const debugComp = process.env.DEBUG_COMP === '1';
    next.stdout.on('data', (chunk: Buffer) => {
      if (!debugComp) return;
      const text = chunk.toString('utf8').trimEnd();
      if (text.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`[comp:${String(port)}] ${text}`);
      }
    });
    next.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trimEnd();
      if (text.length > 0) {
         
        console.warn(`[comp:${String(port)}] ${text}`);
      }
    });
    child = next;
  };

  // When the caller supplied vaultDir, the vault is THEIRS and must
  // survive across runs (workstreams, connections, etc.). Auto-mkdtemp
  // vaults are owned by us and cleaned up on close.
  const cleanupOnClose =
    options.vaultDir === undefined || options.vaultDir.length === 0;

  await spawnNow();
  let bridgeKey: string;
  try {
    bridgeKey = (
      await readFile(path.join(vaultPath, '_BAC/.config/bridge.key'), 'utf8')
    ).trim();
  } catch (error) {
    // spawnNow() mutates `child` via closure capture, but TS narrows
    // the local back to `null` because the mutation isn't visible in
    // type-flow analysis. The runtime check is meaningful.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (child !== null) await closeProcess(child);
    if (cleanupOnClose) await rm(vaultPath, { recursive: true, force: true });
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
        if (cleanupOnClose) await rm(vaultPath, { recursive: true, force: true });
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
    async ingestEvents(events) {
      if (child !== null) {
        await closeProcess(child);
        child = null;
      }
      const dir = await mkdtemp(path.join(tmpdir(), 'sidetrack-extension-e2e-ingest-'));
      const archivePath = path.join(dir, 'events.jsonl');
      try {
        await writeFile(
          archivePath,
          events.map((event) => JSON.stringify(event)).join('\n') + '\n',
          'utf8',
        );
        await runCli(['ingest', '--import', archivePath, '--vault', vaultPath]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      await spawnNow();
    },
  };
};
