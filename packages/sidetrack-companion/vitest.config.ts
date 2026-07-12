// This config is used only by the test:vitest script (bunx vitest run).
// The default `test` script now runs `bun test` which does NOT read this file.
// Coverage thresholds here are therefore dead under the default runner;
// they are kept only for informational parity should vitest be re-enabled.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    // Coverage thresholds below are not enforced by `bun test`. They apply
    // only when this config is loaded via the test:vitest script.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
  },
});
