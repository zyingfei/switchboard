import '@testing-library/jest-dom';
import { vi } from 'vitest';

export const createChromeMock = () => ({
  runtime: {
    getURL: vi.fn((path: string) => `chrome-extension://test-extension/${path}`),
    lastError: null,
    onInstalled: { addListener: vi.fn() },
    onMessage: { addListener: vi.fn() },
    sendMessage: vi.fn(),
  },
  sidePanel: {
    setPanelBehavior: vi.fn(async () => undefined),
  },
  tabs: {
    create: vi.fn(async ({ url }: { url: string }) => ({ id: Math.floor(Math.random() * 1000), url })),
    get: vi.fn(async (tabId: number) => ({ id: tabId, url: `chrome-extension://test/${tabId}` })),
    sendMessage: vi.fn(),
    update: vi.fn(async () => undefined),
  },
});

Object.defineProperty(globalThis, 'chrome', {
  configurable: true,
  value: createChromeMock(),
});
