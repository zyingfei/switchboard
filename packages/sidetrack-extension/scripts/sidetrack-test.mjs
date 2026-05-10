#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(SCRIPT_DIR, '..');
const ONE_BROWSER_SPEC = 'tests/e2e/record-replay-one-browser.manual.spec.ts';
const TWO_BROWSER_SPEC = 'tests/e2e/record-replay-two-browser.manual.spec.ts';
const CAPTURE_LEVELS = new Set(['minimal', 'html', 'html+paste']);

const usage = `Usage:
  sidetrack-test record [--browsers 1|2] [--capture-level minimal|html|html+paste] [--strict-offline]
  sidetrack-test replay <pack> [--hold] [--report-dir <path>] [--strict-offline] [--speed N] [--max-idle-ms N]
  sidetrack-test report <run>
  sidetrack-test list
  sidetrack-test inspect <pack>

Flags:
  --strict-offline   Block any HTTP request that does not match a recorded
                     navigation; report counts the aborted requests. Equivalent
                     to SIDETRACK_REPLAY_STRICT_OFFLINE=1.
  --speed N          Replay-timing multiplier (1 = real-time; 2 = 2x faster).
                     Equivalent to SIDETRACK_REPLAY_SPEED=N.
  --max-idle-ms N    Cap the gap between consecutive replay events. Default
                     1500ms. Use a large value (or "Infinity") to keep raw
                     timing. Equivalent to SIDETRACK_REPLAY_MAX_IDLE_MS=N.
`;

const fail = (message, code = 1) => {
  console.error(`sidetrack-test: ${message}`);
  return code;
};

const resolveSessionsDir = (env = process.env) =>
  path.resolve(
    env.SIDETRACK_TEST_SESSIONS_DIR ?? path.join(homedir(), '.sidetrack', 'test-sessions'),
  );

const isInside = (root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === '' ||
    (relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative))
  );
};

const assertInsideSessions = (target, sessionsDir, label) => {
  const resolved = path.resolve(target);
  if (!isInside(sessionsDir, resolved)) {
    throw new Error(`${label} must live under SIDETRACK_TEST_SESSIONS_DIR (${sessionsDir}).`);
  }
  return resolved;
};

const readJson = async (filePath) => JSON.parse(await readFile(filePath, 'utf8'));

const resolvePackPath = async (input, sessionsDir) => {
  const resolved = assertInsideSessions(input, sessionsDir, 'pack');
  const packPath =
    existsSync(resolved) && (await stat(resolved)).isDirectory()
      ? path.join(resolved, 'pack.json')
      : resolved;
  if (!packPath.endsWith('pack.json')) {
    throw new Error(
      'pack path must point to pack.json or a session directory containing pack.json.',
    );
  }
  if (!existsSync(packPath)) throw new Error(`pack not found: ${packPath}`);
  return packPath;
};

const resolveRunDir = async (input, sessionsDir) => {
  const resolved = assertInsideSessions(input, sessionsDir, 'run');
  if (!existsSync(resolved)) throw new Error(`run not found: ${resolved}`);
  if ((await stat(resolved)).isDirectory()) return resolved;
  const basename = path.basename(resolved);
  if (basename !== 'report.md' && basename !== 'report.json') {
    throw new Error('run path must be a run directory, report.md, or report.json.');
  }
  return path.dirname(resolved);
};

const parsePack = (value, packPath) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`pack ${packPath} must be an object.`);
  }
  if (value.schemaVersion !== 1) {
    throw new Error(
      `Unsupported SessionPack schemaVersion ${String(value.schemaVersion)}; supported: 1.`,
    );
  }
  const mode = value.mode;
  if (typeof mode !== 'object' || mode === null || Array.isArray(mode)) {
    throw new Error(`pack ${packPath} is missing mode.`);
  }
  if (mode.browsers !== 1 && mode.browsers !== 2) {
    throw new Error(`pack ${packPath} has unsupported mode.browsers ${String(mode.browsers)}.`);
  }
  if (!CAPTURE_LEVELS.has(mode.captureLevel)) {
    throw new Error(
      `pack ${packPath} has unsupported mode.captureLevel ${String(mode.captureLevel)}.`,
    );
  }
  return value;
};

const readPack = async (packPath) => parsePack(await readJson(packPath), packPath);

const reportStatusCode = (report) =>
  report.status === 'fail' || report.advisoryColor === 'red' ? 1 : 0;

const parseOptions = (args, booleanOptions = new Set()) => {
  const positional = [];
  const options = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (booleanOptions.has(name)) {
      options.set(name, eq === -1 ? 'true' : arg.slice(eq + 1));
      continue;
    }
    const value = eq === -1 ? args[index + 1] : arg.slice(eq + 1);
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`--${name} requires a value.`);
    }
    if (eq === -1) index += 1;
    options.set(name, value);
  }
  return { positional, options };
};

const playwrightArgs = (specPath) => [
  'playwright',
  'test',
  specPath,
  '--project',
  'manual',
  '--headed',
  '--timeout',
  '0',
  '--grep',
  'manual',
];

const selectedEnv = (env) => {
  const keys = [
    'SIDETRACK_TEST_SESSIONS_DIR',
    'SIDETRACK_CAPTURE_LEVEL',
    'SIDETRACK_RECORD_CAPTURE_LEVEL',
    'SIDETRACK_REPLAY_PACK',
    'SIDETRACK_REPLAY_HOLD',
    'SIDETRACK_REPLAY_REPORT_DIR',
    'SIDETRACK_REPLAY_STRICT_OFFLINE',
    'SIDETRACK_REPLAY_SPEED',
    'SIDETRACK_REPLAY_MAX_IDLE_MS',
    'SIDETRACK_E2E_MANUAL',
  ];
  return Object.fromEntries(
    keys.filter((key) => env[key] !== undefined).map((key) => [key, env[key]]),
  );
};

const spawnPlaywright = async (specPath, env, mode) => {
  const args = playwrightArgs(specPath);
  if (process.env.SIDETRACK_TEST_CLI_DRY_RUN === '1') {
    console.log(
      JSON.stringify(
        {
          command: 'npx',
          args,
          cwd: PACKAGE_DIR,
          env: selectedEnv(env),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  let lastPackPath = null;
  let lastReportPath = null;
  let interrupted = false;
  const child = spawn('npx', args, {
    cwd: PACKAGE_DIR,
    env,
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  const parseLine = (line) => {
    const packMatch = /(?:^|\]\s*)pack:\s*(.+)$/u.exec(line);
    if (packMatch?.[1] !== undefined) lastPackPath = packMatch[1].trim();
    const reportMatch = /(?:^|\]\s*)report:\s*(.+)$/u.exec(line);
    if (reportMatch?.[1] !== undefined) lastReportPath = reportMatch[1].trim();
  };
  const mirror = (stream, target) => {
    stream.on('data', (chunk) => {
      const text = chunk.toString();
      target.write(text);
      for (const line of text.split(/\r?\n/u)) parseLine(line);
    });
  };
  mirror(child.stdout, process.stdout);
  mirror(child.stderr, process.stderr);
  const onSigint = () => {
    interrupted = true;
    child.kill('SIGINT');
  };
  process.once('SIGINT', onSigint);
  const childCode = await new Promise((resolve) => {
    child.on('close', (code, signal) => {
      process.removeListener('SIGINT', onSigint);
      if (interrupted || signal === 'SIGINT') resolve(130);
      else resolve(code ?? 1);
    });
  });
  if (lastPackPath !== null && mode === 'record')
    console.log(`[sidetrack-test] pack: ${lastPackPath}`);
  if (lastReportPath !== null) console.log(`[sidetrack-test] report: ${lastReportPath}`);
  if (childCode !== 0) return childCode;
  if (lastReportPath === null) return 0;
  try {
    const report = await readJson(lastReportPath.replace(/report\.md$/u, 'report.json'));
    return reportStatusCode(report);
  } catch (error) {
    console.error(
      `sidetrack-test: could not read report status: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
};

const commandRecord = async (args) => {
  const { positional, options } = parseOptions(args, new Set(['strict-offline']));
  if (positional.length > 0) throw new Error('record does not accept positional arguments.');
  const browsersRaw = options.get('browsers') ?? '1';
  const browsers = Number.parseInt(browsersRaw, 10);
  if (browsers !== 1 && browsers !== 2) throw new Error('--browsers must be 1 or 2.');
  const captureLevel = options.get('capture-level') ?? 'minimal';
  if (!CAPTURE_LEVELS.has(captureLevel)) {
    throw new Error('--capture-level must be minimal, html, or html+paste.');
  }
  const strictOffline =
    options.has('strict-offline') || process.env.SIDETRACK_REPLAY_STRICT_OFFLINE === '1';
  const sessionsDir = resolveSessionsDir();
  const env = {
    ...process.env,
    SIDETRACK_E2E_MANUAL: '1',
    SIDETRACK_TEST_SESSIONS_DIR: sessionsDir,
    SIDETRACK_CAPTURE_LEVEL: captureLevel,
    SIDETRACK_RECORD_CAPTURE_LEVEL: captureLevel,
    ...(strictOffline ? { SIDETRACK_REPLAY_STRICT_OFFLINE: '1' } : {}),
  };
  return await spawnPlaywright(browsers === 1 ? ONE_BROWSER_SPEC : TWO_BROWSER_SPEC, env, 'record');
};

const commandReplay = async (args) => {
  const { positional, options } = parseOptions(args, new Set(['hold', 'strict-offline']));
  if (positional.length !== 1) throw new Error('replay requires exactly one pack path.');
  const sessionsDir = resolveSessionsDir();
  const packPath = await resolvePackPath(positional[0], sessionsDir);
  const pack = await readPack(packPath);
  const reportDirRaw = options.get('report-dir');
  const reportDir =
    reportDirRaw === undefined
      ? undefined
      : assertInsideSessions(reportDirRaw, sessionsDir, 'report directory');
  const strictOffline =
    options.has('strict-offline') || process.env.SIDETRACK_REPLAY_STRICT_OFFLINE === '1';
  const speed = options.get('speed') ?? process.env.SIDETRACK_REPLAY_SPEED;
  if (speed !== undefined) {
    const parsed = Number.parseFloat(speed);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error('--speed must be a positive number (e.g. 1, 0.5, 2).');
    }
  }
  const maxIdle = options.get('max-idle-ms') ?? process.env.SIDETRACK_REPLAY_MAX_IDLE_MS;
  if (maxIdle !== undefined && maxIdle !== 'Infinity') {
    const parsed = Number.parseFloat(maxIdle);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error('--max-idle-ms must be a non-negative number or "Infinity".');
    }
  }
  const env = {
    ...process.env,
    SIDETRACK_E2E_MANUAL: '1',
    SIDETRACK_TEST_SESSIONS_DIR: sessionsDir,
    SIDETRACK_CAPTURE_LEVEL: pack.mode.captureLevel,
    SIDETRACK_RECORD_CAPTURE_LEVEL: pack.mode.captureLevel,
    SIDETRACK_REPLAY_PACK: packPath,
    ...(options.has('hold') ? { SIDETRACK_REPLAY_HOLD: '1' } : {}),
    ...(reportDir === undefined ? {} : { SIDETRACK_REPLAY_REPORT_DIR: reportDir }),
    ...(strictOffline ? { SIDETRACK_REPLAY_STRICT_OFFLINE: '1' } : {}),
    ...(speed === undefined ? {} : { SIDETRACK_REPLAY_SPEED: speed }),
    ...(maxIdle === undefined ? {} : { SIDETRACK_REPLAY_MAX_IDLE_MS: maxIdle }),
  };
  return await spawnPlaywright(
    pack.mode.browsers === 1 ? ONE_BROWSER_SPEC : TWO_BROWSER_SPEC,
    env,
    'replay',
  );
};

const readReport = async (runDir) => {
  const jsonPath = path.join(runDir, 'report.json');
  const markdownPath = path.join(runDir, 'report.md');
  return {
    jsonPath,
    markdownPath,
    report: await readJson(jsonPath),
    markdown: await readFile(markdownPath, 'utf8'),
  };
};

const reportTime = (report) => Date.parse(report.generatedAt ?? '') || 0;

const previousRun = async (runDir) => {
  const runsDir = path.dirname(runDir);
  if (path.basename(runsDir) !== 'runs') return null;
  const currentName = path.basename(runDir);
  const entries = await readdir(runsDir, { withFileTypes: true }).catch(() => []);
  const reports = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === currentName) continue;
    const candidate = path.join(runsDir, entry.name);
    const reportPath = path.join(candidate, 'report.json');
    if (!existsSync(reportPath)) continue;
    reports.push({ runDir: candidate, report: await readJson(reportPath) });
  }
  reports.sort((left, right) => reportTime(right.report) - reportTime(left.report));
  return reports[0] ?? null;
};

const scoreDiffs = (previous, current) => {
  const names = new Set([
    ...Object.keys(previous.scores ?? {}),
    ...Object.keys(current.scores ?? {}),
  ]);
  const lines = [];
  for (const name of [...names].sort()) {
    const before = previous.scores?.[name]?.score;
    const after = current.scores?.[name]?.score;
    if (before !== after) lines.push(`- score ${name}: ${String(before)} -> ${String(after)}`);
  }
  return lines;
};

const layerDiffs = (previous, current) => {
  const before = new Map((previous.layers ?? []).map((layer) => [layer.layer, layer.status]));
  const lines = [];
  for (const layer of current.layers ?? []) {
    const previousStatus = before.get(layer.layer);
    if (previousStatus !== layer.status) {
      lines.push(`- layer ${layer.layer}: ${String(previousStatus)} -> ${String(layer.status)}`);
    }
  }
  return lines;
};

const commandReport = async (args) => {
  const { positional } = parseOptions(args);
  if (positional.length !== 1) throw new Error('report requires exactly one run path.');
  const sessionsDir = resolveSessionsDir();
  const runDir = await resolveRunDir(positional[0], sessionsDir);
  const current = await readReport(runDir);
  process.stdout.write(current.markdown);
  const previous = await previousRun(runDir);
  console.log('\n## Diff vs previous run');
  if (previous === null) {
    console.log('- No previous run for this pack.');
  } else {
    const diffs = [
      ...(previous.report.status === current.report.status
        ? []
        : [`- status: ${String(previous.report.status)} -> ${String(current.report.status)}`]),
      ...(previous.report.advisoryColor === current.report.advisoryColor
        ? []
        : [
            `- advisoryColor: ${String(previous.report.advisoryColor)} -> ${String(
              current.report.advisoryColor,
            )}`,
          ]),
      ...layerDiffs(previous.report, current.report),
      ...scoreDiffs(previous.report, current.report),
    ];
    console.log(`- Previous run: ${previous.runDir}`);
    console.log(diffs.length === 0 ? '- No structured differences.' : diffs.join('\n'));
  }
  return reportStatusCode(current.report);
};

const latestReport = async (packDir) => {
  const runsDir = path.join(packDir, 'runs');
  const entries = await readdir(runsDir, { withFileTypes: true }).catch(() => []);
  const reports = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const reportPath = path.join(runsDir, entry.name, 'report.json');
    if (!existsSync(reportPath)) continue;
    reports.push({ runDir: path.join(runsDir, entry.name), report: await readJson(reportPath) });
  }
  reports.sort((left, right) => reportTime(right.report) - reportTime(left.report));
  return reports[0] ?? null;
};

const commandList = async () => {
  const sessionsDir = resolveSessionsDir();
  const entries = await readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  console.log('sessionId\trecordedAt\tmode\tlastReplay\tlastRun');
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const packDir = path.join(sessionsDir, entry.name);
    const packPath = path.join(packDir, 'pack.json');
    if (!existsSync(packPath)) continue;
    const pack = await readPack(packPath);
    const latest = await latestReport(packDir);
    const mode = `${String(pack.mode.browsers)}:${String(pack.mode.captureLevel)}`;
    const replay =
      latest === null
        ? '-'
        : `${String(latest.report.status)}/${String(latest.report.advisoryColor)}`;
    console.log(
      `${String(pack.sessionId)}\t${String(pack.recordedAt)}\t${mode}\t${replay}\t${
        latest?.runDir ?? '-'
      }`,
    );
  }
  return 0;
};

const clipboardByteLength = (pack) =>
  (pack.browsers ?? []).reduce(
    (sum, browser) =>
      sum +
      (browser.events ?? []).reduce(
        (eventSum, event) =>
          event.kind === 'copy' || event.kind === 'paste'
            ? eventSum + (typeof event.length === 'number' ? event.length : 0)
            : eventSum,
        0,
      ),
    0,
  );

const commandInspect = async (args) => {
  const { positional } = parseOptions(args);
  if (positional.length !== 1) throw new Error('inspect requires exactly one pack path.');
  const sessionsDir = resolveSessionsDir();
  const packPath = await resolvePackPath(positional[0], sessionsDir);
  const pack = await readPack(packPath);
  console.log(`Pack: ${packPath}`);
  console.log(`Session: ${String(pack.sessionId)}`);
  console.log(`Recorded: ${String(pack.recordedAt)}`);
  console.log(`Sidetrack version: ${String(pack.sidetrackVersion)}`);
  console.log(
    `Mode: browsers=${String(pack.mode.browsers)} captureLevel=${String(pack.mode.captureLevel)}`,
  );
  console.log(`Browsers: ${(pack.browsers ?? []).length}`);
  for (const browser of pack.browsers ?? []) {
    const events = browser.events ?? [];
    console.log(
      `- Browser ${String(browser.label)}: activeWorkstreamId=${String(
        browser.activeWorkstreamId,
      )} events=${events.length} navigations=${events.filter((event) => event.kind === 'navigation').length} snapshots=${
        Object.keys(browser.snapshots ?? {}).length
      } clipboardEvents=${events.filter((event) => event.kind === 'copy' || event.kind === 'paste').length}`,
    );
  }
  console.log(`Expected canonicals: ${(pack.expectations?.expectedCanonicalUrls ?? []).length}`);
  console.log(`Expected edges: ${(pack.expectations?.expectedEdges ?? []).length}`);
  console.log(`Known detours: ${(pack.expectations?.knownDetours ?? []).length}`);
  console.log(`Total copy/paste bytes: ${clipboardByteLength(pack)}`);
  return 0;
};

const main = async () => {
  const [command, ...args] = process.argv.slice(2);
  if (command === undefined || command === '--help' || command === '-h') {
    process.stdout.write(usage);
    return command === undefined ? 1 : 0;
  }
  try {
    if (command === 'record') return await commandRecord(args);
    if (command === 'replay') return await commandReplay(args);
    if (command === 'report') return await commandReport(args);
    if (command === 'list') return await commandList();
    if (command === 'inspect') return await commandInspect(args);
    return fail(`unknown command ${command}\n${usage}`);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
};

process.exitCode = await main();
