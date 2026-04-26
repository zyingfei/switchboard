import '@testing-library/jest-dom';
import { vi } from 'vitest';

Object.defineProperty(globalThis, 'chrome', {
  configurable: true,
  value: {
    runtime: {
      getManifest: vi.fn(() => ({ version: '0.0.0' })),
      lastError: null,
      onInstalled: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn() },
      sendMessage: vi.fn(),
    },
    sidePanel: {
      setPanelBehavior: vi.fn(async () => undefined),
    },
  },
});
