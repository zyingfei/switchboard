import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: './.cache/vite',
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/unit/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
  },
});
