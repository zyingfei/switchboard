import '@testing-library/jest-dom';
import { vi } from 'vitest';

const memory: Record<string, unknown> = {};

Object.defineProperty(globalThis, 'chrome', {
  configurable: true,
  value: {
    runtime: {
      getManifest: vi.fn(() => ({ version: '0.0.0' })),
      lastError: null,
      onInstalled: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn() },
      sendMessage: vi.fn(),
      sendNativeMessage: vi.fn(),
    },
    sidePanel: {
      setPanelBehavior: vi.fn(async () => undefined),
    },
    storage: {
      local: {
        get: vi.fn(async (keys?: string | string[] | Record<string, unknown>) => {
          if (!keys) {
            return { ...memory };
          }
          if (typeof keys === 'string') {
            return { [keys]: memory[keys] };
          }
          if (Array.isArray(keys)) {
            return Object.fromEntries(keys.map((key) => [key, memory[key]]));
          }
          return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, memory[key] ?? fallback]));
        }),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(memory, values);
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            delete memory[key];
          }
        }),
      },
    },
  },
});

beforeEach(() => {
  for (const key of Object.keys(memory)) {
    delete memory[key];
  }
});
