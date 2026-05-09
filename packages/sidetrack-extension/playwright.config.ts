import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

const manualSpecPatterns = ['**/manual-*.spec.ts', '**/*.manual.spec.ts'];

const manualRunRequested =
  process.env.SIDETRACK_E2E_MANUAL === '1' ||
  process.argv.some((arg, index, argv) => {
    if (arg === '--project=manual' || (arg === '--project' && argv[index + 1] === 'manual')) {
      return true;
    }
    if (arg === '--grep' && (argv[index + 1] ?? '').includes('manual')) {
      return true;
    }
    return arg.startsWith('--grep=') && arg.includes('manual');
  });

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: path.join(tmpdir(), 'sidetrack-extension-playwright-results'),
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'default',
      testIgnore: manualSpecPatterns,
    },
    {
      name: 'manual',
      testMatch: manualSpecPatterns,
      grep: manualRunRequested ? /manual/u : /$^/u,
    },
  ],
});
