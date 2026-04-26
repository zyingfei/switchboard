#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const companionDir = path.join(rootDir, 'companion');
const extensionDir = path.join(rootDir, 'extension');
const extensionOutputDir = path.join(extensionDir, '.output', 'chrome-mv3');

const sleep = async (ms) => await new Promise((resolve) => setTimeout(resolve, ms));

const parseArgs = (argv) => {
  const args = {
    browser: false,
    build: true,
    keepBrowser: false,
    tail: true,
    tickSeconds: 8,
    vault: path.join(os.tmpdir(), 'bac-local-bridge-auto'),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === '--help' || current === '-h') {
      args.help = true;
      continue;
    }
    if (current === '--vault') {
      args.vault = path.resolve(argv[++index]);
      continue;
    }
    if (current === '--port') {
      args.port = Number.parseInt(argv[++index], 10);
      continue;
    }
    if (current === '--tick-seconds') {
      args.tickSeconds = Number.parseInt(argv[++index], 10);
      continue;
    }
    if (current === '--chrome') {
      args.chromePath = argv[++index];
      continue;
    }
    if (current === '--browser') {
      args.browser = true;
      continue;
    }
    if (current === '--no-browser') {
      args.browser = false;
      continue;
    }
    if (current === '--no-build') {
      args.build = false;
      continue;
    }
    if (current === '--no-tail') {
      args.tail = false;
      continue;
    }
    if (current === '--keep-browser') {
      args.keepBrowser = true;
      continue;
    }
    throw new Error(`Unknown argument: ${current}`);
  }

  return args;
};

const usage = `BAC local-bridge automated verification

Usage:
  npm run verify -- [--vault /path/to/vault] [--port 17875] [--tick-seconds 8]

Examples:
  npm run verify
  npm run verify -- --vault "/Users/$USER/Library/Mobile Documents/com~apple~CloudDocs/tmp" --tick-seconds 60
  npm run verify -- --browser --tick-seconds 10

Notes:
  - Uses HTTP localhost transport.
  - Starts and stops its own companion process.
  - Default mode verifies the companion/auth/write/tick/outage path over HTTP.
  - Also probes "tail -f" delivery for a sentinel write unless --no-tail is passed.
  - Browser mode is optional and tries to load extension/.output/chrome-mv3 in a temporary Chrome profile.
  - Temporary Chrome profile is left in /tmp so the script never deletes local files for you.
`;

const run = async (label, command, args, options = {}) => {
  process.stdout.write(`\n> ${label}\n`);
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      ...options,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${label} failed with exit ${code}`));
    });
  });
};

const getFreePort = async () =>
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(() => {
        if (port) {
          resolve(port);
          return;
        }
        reject(new Error('Could not allocate local port'));
      });
    });
  });

const waitFor = async (label, fn, timeoutMs = 15_000) => {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
};

const readKey = async (vaultPath) => {
  const keyPath = path.join(vaultPath, '_BAC', '.config', 'bridge.key');
  return (await waitFor('bridge key', async () => {
    if (!existsSync(keyPath)) {
      return undefined;
    }
    const key = readFileSync(keyPath, 'utf8').trim();
    return key || undefined;
  })).trim();
};

const startCompanion = async ({ vault, port }) => {
  const tsxPath = path.join(companionDir, 'node_modules', '.bin', 'tsx');
  if (!existsSync(tsxPath)) {
    throw new Error(`Missing companion dependencies. Run: npm --prefix ${companionDir} install`);
  }

  await mkdir(vault, { recursive: true });
  const child = spawn('npm', ['start', '--', '--vault', vault, '--port', String(port)], {
    cwd: companionDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`[companion] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[companion] ${chunk}`));
  child.on('exit', (code) => {
    if (code && code !== 143 && code !== 130) {
      process.stderr.write(`[companion] exited with ${code}\n`);
    }
  });

  await waitFor('companion /health', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/health`).catch(() => undefined);
    return response?.ok;
  });

  const key = await readKey(vault);
  return { child, key };
};

const stopCompanion = async (child) => {
  if (!child || child.exitCode !== null) {
    return;
  }
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
};

const postJson = async (port, pathName, key, body = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}${pathName}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { 'x-bac-bridge-key': key } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const value = text ? JSON.parse(text) : {};
  return { response, value };
};

const dateKey = (date = new Date()) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

const eventPathForToday = (vaultPath) => path.join(vaultPath, '_BAC', 'events', `${dateKey()}.jsonl`);

const stopTail = async (tail) => {
  if (!tail || tail.exitCode !== null) {
    return;
  }
  tail.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 500);
    tail.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
};

const probeTail = async ({ port, key, eventPath, timeoutMs = 2_500 }) => {
  if (!existsSync(eventPath)) {
    return { enabled: true, observed: false, error: `Missing event file: ${eventPath}` };
  }

  const id = `auto-tail-${Date.now()}`;
  const startedAt = Date.now();
  let stdout = '';
  let stderr = '';
  const tail = spawn('tail', ['-n', '0', '-f', eventPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  tail.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  tail.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  try {
    await sleep(250);
    const write = await postJson(port, '/events', key, {
      id,
      timestamp: new Date().toISOString(),
      sequenceNumber: Date.now(),
      payload: 'synthetic',
      source: 'tail-probe',
    });
    if (!write.response.ok) {
      return {
        enabled: true,
        observed: false,
        error: `Tail sentinel write failed with HTTP ${write.response.status}`,
      };
    }

    while (Date.now() - startedAt < timeoutMs) {
      if (stdout.includes(id)) {
        return {
          enabled: true,
          observed: true,
          latencyMs: Date.now() - startedAt,
          id,
        };
      }
      await sleep(100);
    }

    return {
      enabled: true,
      observed: false,
      timeoutMs,
      id,
      stderr: stderr.trim() || undefined,
    };
  } finally {
    await stopTail(tail);
  }
};

const readJsonl = async (filePath) => {
  const raw = await readFile(filePath, 'utf8').catch(() => '');
  return raw.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
};

const summarizeVault = async (vaultPath, runIds) => {
  const eventPath = eventPathForToday(vaultPath);
  const events = await readJsonl(eventPath);
  const observations = [];
  for (const runId of runIds) {
    observations.push(
      ...(await readJsonl(path.join(vaultPath, '_BAC', 'observations', `run-${runId}.jsonl`))),
    );
  }
  const latencies = observations.map((row) => row.latencyMs).sort((left, right) => left - right);
  return {
    eventPath,
    totalEventLines: events.length,
    latestEvent: events.at(-1),
    observations: observations.length,
    errors: observations.filter((row) => !row.ok).length,
    p95: latencies[Math.floor((latencies.length - 1) * 0.95)] ?? 0,
  };
};

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    if (typeof WebSocket === 'undefined') {
      throw new Error('Global WebSocket is unavailable; use Node 22+.');
    }
    this.ws = new WebSocket(this.wsUrl);
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) {
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message));
        return;
      }
      pending.resolve(message.result ?? {});
    });
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
  }

  async call(method, params = {}, sessionId) {
    const id = this.nextId;
    this.nextId += 1;
    const payload = { id, method, params };
    if (sessionId) {
      payload.sessionId = sessionId;
    }
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.ws.send(JSON.stringify(payload));
    return await promise;
  }

  close() {
    this.ws?.close();
  }
}

const defaultChromePath = () => {
  const macPath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  return existsSync(macPath) ? macPath : 'google-chrome';
};

const readExtensionIdFromPreferences = (userDataDir) => {
  for (const fileName of ['Preferences', 'Secure Preferences']) {
    const filePath = path.join(userDataDir, 'Default', fileName);
    if (!existsSync(filePath)) {
      continue;
    }
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    const settings = parsed.extensions?.settings ?? {};
    for (const [id, value] of Object.entries(settings)) {
      if (
        value?.path === extensionOutputDir ||
        value?.manifest?.name === 'BAC Local Bridge POC'
      ) {
        return id;
      }
    }
  }
  return undefined;
};

const launchBrowser = async ({ chromePath, port, key, tickSeconds, companionControl }) => {
  if (!existsSync(extensionOutputDir)) {
    throw new Error(`Missing extension build output: ${extensionOutputDir}`);
  }

  const debugPort = await getFreePort();
  const userDataDir = path.join(os.tmpdir(), `bac-local-bridge-chrome-${Date.now()}`);
  mkdirSync(userDataDir, { recursive: true });
  const chrome = spawn(chromePath, [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${debugPort}`,
    `--disable-extensions-except=${extensionOutputDir}`,
    `--load-extension=${extensionOutputDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  chrome.stderr.on('data', (chunk) => {
    const text = String(chunk);
    if (!/DevTools listening/u.test(text)) {
      return;
    }
    process.stderr.write(`[chrome] ${text}`);
  });

  let cdp;
  try {
    const version = await waitFor('Chrome DevTools', async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`).catch(() => undefined);
      return response?.ok ? await response.json() : undefined;
    });
    cdp = new Cdp(version.webSocketDebuggerUrl);
    await cdp.connect();

    const extensionId = await waitFor('extension id', async () => {
    const targets = await cdp.call('Target.getTargets');
    const serviceWorker = targets.targetInfos?.find((target) =>
      target.url?.startsWith('chrome-extension://') && target.url.includes('/background.js'));
    if (serviceWorker) {
      return new URL(serviceWorker.url).host;
    }
    return readExtensionIdFromPreferences(userDataDir);
  });

    const { targetId } = await cdp.call('Target.createTarget', {
      url: `chrome-extension://${extensionId}/sidepanel.html`,
    });
    const { sessionId } = await cdp.call('Target.attachToTarget', { targetId, flatten: true });
    await cdp.call('Runtime.enable', {}, sessionId);
    await sleep(500);

    const sendMessage = async (type, extra = {}) => {
    const message = { type, ...extra };
    const expression = `new Promise((resolve, reject) => chrome.runtime.sendMessage(${JSON.stringify(message)}, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    }))`;
    const result = await cdp.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text ?? 'Runtime.evaluate failed');
    }
    return result.result.value;
  };

    const configure = await sendMessage('BAC_LOCAL_BRIDGE_CONFIGURE', {
      settings: { transport: 'http', port, key },
    });
    const write = await sendMessage('BAC_LOCAL_BRIDGE_WRITE_TEST_EVENT');
    const tickStart = await sendMessage('BAC_LOCAL_BRIDGE_START_TICK');
    await sleep(tickSeconds * 1_000);
    const tickStop = await sendMessage('BAC_LOCAL_BRIDGE_STOP_TICK');

    await companionControl.stop();
    const offlineWrite = await sendMessage('BAC_LOCAL_BRIDGE_WRITE_TEST_EVENT');
    await companionControl.start();
    const drain = await sendMessage('BAC_LOCAL_BRIDGE_DRAIN_QUEUE');

    if (!companionControl.keepBrowser) {
      await cdp.call('Browser.close').catch(() => undefined);
    }
    cdp.close();

    return {
      extensionId,
      userDataDir,
      configure,
      write,
      tickStart,
      tickStop,
      offlineWrite,
      drain,
    };
  } catch (error) {
    await cdp?.call('Browser.close').catch(() => undefined);
    cdp?.close();
    chrome.kill('SIGTERM');
    throw error;
  }
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage);
    return;
  }

  const port = args.port ?? await getFreePort();
  const chromePath = args.chromePath ?? defaultChromePath();
  const runIds = [];
  let companion;

  const start = async () => {
    companion = await startCompanion({ vault: args.vault, port });
    const status = await (await fetch(`http://127.0.0.1:${port}/status`, {
      headers: { 'x-bac-bridge-key': companion.key },
    })).json();
    runIds.push(status.runId);
    return companion;
  };
  const stop = async () => {
    await stopCompanion(companion?.child);
  };

  try {
    if (args.build) {
      await run('build extension', 'npm', ['run', 'build'], { cwd: extensionDir });
    }

    await start();
    const key = companion.key;
    const base = `http://127.0.0.1:${port}`;
    const unauthorized = await fetch(`${base}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (unauthorized.status !== 401) {
      throw new Error(`Expected unauthorized write to return 401, got ${unauthorized.status}`);
    }

    const directEvent = {
      id: `auto-direct-${Date.now()}`,
      timestamp: new Date().toISOString(),
      sequenceNumber: Date.now(),
      payload: 'synthetic',
      source: 'manual',
    };
    const direct = await postJson(port, '/events', key, directEvent);
    if (!direct.response.ok) {
      throw new Error(`Direct authorized event failed: ${direct.response.status}`);
    }

    const tailCheck = args.tail
      ? await probeTail({ port, key, eventPath: eventPathForToday(args.vault) })
      : { enabled: false };

    let browserResult;
    if (args.browser) {
      browserResult = await launchBrowser({
        chromePath,
        port,
        key,
        tickSeconds: args.tickSeconds,
        companionControl: {
          start,
          stop,
          keepBrowser: args.keepBrowser,
        },
      });
    } else {
      await postJson(port, '/tick/start', key, {});
      await sleep(args.tickSeconds * 1_000);
      await postJson(port, '/tick/stop', key, {});
      await stop();
      const outage = await fetch(`${base}/events`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-bac-bridge-key': key,
        },
        body: JSON.stringify({
          id: `auto-outage-${Date.now()}`,
          timestamp: new Date().toISOString(),
          sequenceNumber: Date.now(),
          payload: 'synthetic',
          source: 'manual',
        }),
      }).catch(() => undefined);
      if (outage) {
        throw new Error('Expected write to fail while companion was stopped');
      }
      await start();
      await postJson(port, '/events', key, {
        id: `auto-after-restart-${Date.now()}`,
        timestamp: new Date().toISOString(),
        sequenceNumber: Date.now(),
        payload: 'synthetic',
        source: 'manual',
      });
    }

    const summary = await summarizeVault(args.vault, [...new Set(runIds)]);
    const result = {
      ok: true,
      vault: args.vault,
      port,
      mode: args.browser ? 'browser-extension' : 'http-only',
      tickSeconds: args.tickSeconds,
      runIds: [...new Set(runIds)],
      tailCheck,
      browser: browserResult
        ? {
            extensionId: browserResult.extensionId,
            tempProfile: browserResult.userDataDir,
            connected: browserResult.configure.state.connected,
            extensionWriteOk: browserResult.write.state.companion?.lastWrite?.ok ?? false,
            tickSequence: browserResult.tickStop.state.companion?.tickSequence,
            queuedWhileOffline: browserResult.offlineWrite.state.queueCount,
            queueAfterDrain: browserResult.drain.state.queueCount,
          }
        : undefined,
      httpOnly: browserResult
        ? undefined
        : {
            outageWriteFailed: true,
            restartWriteOk: true,
            queueReplayCovered: false,
          },
      summary,
    };
    process.stdout.write(`\nPASS ${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await stop();
  }
};

void main().catch((error) => {
  process.stderr.write(`\nFAIL ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
