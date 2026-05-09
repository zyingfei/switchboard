import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(TEST_DIR, '..', '..');
const CLI_PATH = path.join(PACKAGE_DIR, 'scripts', 'sidetrack-test.mjs');

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCli = async (args: readonly string[], env: Record<string, string>): Promise<CliResult> =>
  await new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI_PATH, ...args],
      {
        cwd: PACKAGE_DIR,
        env: { ...process.env, ...env },
      },
      (error, stdout, stderr) => {
        const code =
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          typeof error.code === 'number'
            ? error.code
            : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });

const writeJson = async (filePath: string, value: unknown): Promise<void> => {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const makeSessionsRoot = async (): Promise<{
  readonly root: string;
  readonly packPath: string;
}> => {
  const root = await mkdtempCompat('sidetrack-test-cli-');
  const packDir = path.join(root, 'ses_cli');
  const runsDir = path.join(packDir, 'runs');
  const olderRun = path.join(runsDir, 'run_older');
  const currentRun = path.join(runsDir, 'run_current');
  await mkdir(olderRun, { recursive: true });
  await mkdir(currentRun, { recursive: true });
  const pack = {
    schemaVersion: 1,
    sessionId: 'ses_cli',
    recordedAt: '2026-05-09T12:00:00.000Z',
    sidetrackVersion: 'test',
    mode: { browsers: 2, captureLevel: 'html+paste' },
    browsers: [
      {
        label: 'A',
        activeWorkstreamId: 'ws_cli',
        snapshots: {
          'https://example.test/source': {
            capturedAt: '2026-05-09T12:00:01.000Z',
            title: 'Source',
            htmlRedacted: 'DO-NOT-PRINT-HTML',
            redactionCounts: { email: 1 },
          },
        },
        events: [
          {
            kind: 'navigation',
            atMs: 0,
            tabIdHash: 'tab_a',
            url: 'https://example.test/source',
            canonicalUrl: 'https://example.test/source',
            title: 'Source',
            transition: 'updated',
          },
          {
            kind: 'paste',
            atMs: 10,
            tabIdHash: 'tab_a',
            contentHash: 'hash',
            length: 19,
            content: 'DO-NOT-PRINT-PASTE',
          },
        ],
      },
      {
        label: 'B',
        activeWorkstreamId: 'ws_cli',
        snapshots: {},
        events: [],
      },
    ],
    expectations: {
      expectedCanonicalUrls: ['https://example.test/source'],
      expectedEdges: [],
      knownDetours: [],
    },
  };
  const olderReport = {
    schemaVersion: 1,
    runId: 'run_older',
    sessionId: 'ses_cli',
    generatedAt: '2026-05-09T12:05:00.000Z',
    status: 'pass',
    advisoryColor: 'green',
    captureLevel: 'html+paste',
    scores: { 'topic-purity': { score: 1, color: 'green', rationale: 'old' } },
    layers: [{ layer: 'page-replay', status: 'pass', summary: 'old', details: [] }],
  };
  const currentReport = {
    ...olderReport,
    runId: 'run_current',
    generatedAt: '2026-05-09T12:10:00.000Z',
    advisoryColor: 'yellow',
    scores: { 'topic-purity': { score: 0.75, color: 'yellow', rationale: 'new' } },
    layers: [{ layer: 'page-replay', status: 'pass', summary: 'new', details: [] }],
  };
  await writeJson(path.join(packDir, 'pack.json'), pack);
  await writeJson(path.join(olderRun, 'report.json'), olderReport);
  await writeFile(path.join(olderRun, 'report.md'), '# Older report\n', 'utf8');
  await writeJson(path.join(currentRun, 'report.json'), currentReport);
  await writeFile(path.join(currentRun, 'report.md'), '# Current report\n', 'utf8');
  return { root, packPath: path.join(packDir, 'pack.json') };
};

const mkdtempCompat = async (prefix: string): Promise<string> => {
  return await mkdtemp(path.join(tmpdir(), prefix));
};

describe('sidetrack-test CLI', () => {
  it('lists, reports, and inspects session metadata without event bodies or HTML', async () => {
    const { root, packPath } = await makeSessionsRoot();
    try {
      const env = { SIDETRACK_TEST_SESSIONS_DIR: root };
      const inspect = await runCli(['inspect', packPath], env);
      expect(inspect.code).toBe(0);
      expect(inspect.stdout).toContain('Session: ses_cli');
      expect(inspect.stdout).toContain('captureLevel=html+paste');
      expect(inspect.stdout).not.toContain('DO-NOT-PRINT-PASTE');
      expect(inspect.stdout).not.toContain('DO-NOT-PRINT-HTML');

      const list = await runCli(['list'], env);
      expect(list.code).toBe(0);
      expect(list.stdout).toContain('ses_cli');
      expect(list.stdout).toContain('pass/yellow');

      const report = await runCli(
        ['report', path.join(root, 'ses_cli', 'runs', 'run_current')],
        env,
      );
      expect(report.code).toBe(0);
      expect(report.stdout).toContain('# Current report');
      expect(report.stdout).toContain('Diff vs previous run');
      expect(report.stdout).toContain('advisoryColor: green -> yellow');
      expect(report.stdout).toContain('score topic-purity: 1 -> 0.75');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('dry-runs record and replay as Playwright manual-spec wrappers', async () => {
    const { root, packPath } = await makeSessionsRoot();
    try {
      const dryEnv = {
        SIDETRACK_TEST_SESSIONS_DIR: root,
        SIDETRACK_TEST_CLI_DRY_RUN: '1',
      };
      const record = await runCli(
        ['record', '--browsers', '2', '--capture-level', 'html+paste'],
        dryEnv,
      );
      expect(record.code).toBe(0);
      const recordPlan = JSON.parse(record.stdout) as {
        readonly args: readonly string[];
        readonly env: Record<string, string>;
      };
      expect(recordPlan.args).toContain('tests/e2e/record-replay-two-browser.manual.spec.ts');
      expect(recordPlan.env.SIDETRACK_CAPTURE_LEVEL).toBe('html+paste');
      expect(recordPlan.env.SIDETRACK_TEST_SESSIONS_DIR).toBe(root);

      const replay = await runCli(['replay', packPath, '--hold'], dryEnv);
      expect(replay.code).toBe(0);
      const replayPlan = JSON.parse(replay.stdout) as {
        readonly args: readonly string[];
        readonly env: Record<string, string>;
      };
      expect(replayPlan.args).toContain('tests/e2e/record-replay-two-browser.manual.spec.ts');
      expect(replayPlan.env.SIDETRACK_REPLAY_PACK).toBe(packPath);
      expect(replayPlan.env.SIDETRACK_REPLAY_HOLD).toBe('1');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
