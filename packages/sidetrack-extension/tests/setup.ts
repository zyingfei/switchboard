import '@testing-library/jest-dom/vitest';

// __BUILD_INFO__ is injected by Vite's `define` (see wxt.config.ts)
// at build time. Vitest doesn't run through that pipeline, so we
// stub it here for tests so any component that reads it gets a
// stable value instead of a ReferenceError.
(globalThis as { __BUILD_INFO__?: unknown }).__BUILD_INFO__ = {
  version: '0.0.0-test',
  sha: 'test',
  builtAt: '2026-04-30T00:00:00.000Z',
};
