import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCapture } from '../../src/capture/model';
import { appendCapture, clearCaptures, readCaptures } from '../../src/background/storage';

const storageState = new Map<string, unknown>();

const sampleCapture = (id: string): ProviderCapture => ({
  id,
  provider: 'chatgpt',
  url: `https://chatgpt.com/c/${id}`,
  title: `capture ${id}`,
  capturedAt: '2026-04-25T00:00:00.000Z',
  selectorCanary: 'passed',
  turns: [
    {
      id: 'turn-1',
      role: 'assistant',
      text: 'Visible response',
      ordinal: 0,
      sourceSelector: '[data-message-author-role]',
    },
  ],
  artifacts: [],
  warnings: [],
  visibleTextCharCount: 16,
});

beforeEach(() => {
  storageState.clear();
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: storageState.get(key) })),
        set: vi.fn(async (value: Record<string, unknown>) => {
          for (const [key, entry] of Object.entries(value)) {
            storageState.set(key, entry);
          }
        }),
        remove: vi.fn(async (key: string) => {
          storageState.delete(key);
        }),
      },
    },
  });
});

describe('local storage wrapper', () => {
  it('persists captures in chrome.storage.local only', async () => {
    await appendCapture(sampleCapture('one'));
    const captures = await readCaptures();

    expect(captures).toHaveLength(1);
    expect(captures[0].id).toBe('one');
    expect(storageState.size).toBe(1);
  });

  it('clears local captures', async () => {
    await appendCapture(sampleCapture('one'));
    await clearCaptures();

    expect(await readCaptures()).toEqual([]);
  });

  it('replaces an existing capture for the same provider url instead of appending duplicates', async () => {
    await appendCapture(sampleCapture('one'));
    await appendCapture({
      ...sampleCapture('two'),
      url: 'https://chatgpt.com/c/one',
      title: 'updated capture',
    });

    const captures = await readCaptures();
    expect(captures).toHaveLength(1);
    expect(captures[0].title).toBe('updated capture');
  });

  it('normalizes legacy stored captures that predate artifacts and warnings fields', async () => {
    storageState.set('bac.providerCapture.captures', [
      {
        id: 'legacy',
        provider: 'chatgpt',
        url: 'https://chatgpt.com/c/legacy',
        title: 'legacy capture',
        capturedAt: '2026-04-25T00:00:00.000Z',
        selectorCanary: 'passed',
        turns: [
          {
            id: 'turn-1',
            role: 'assistant',
            text: 'Legacy response',
            ordinal: 0,
            sourceSelector: '[data-message-author-role]',
          },
        ],
        visibleTextCharCount: 15,
      },
    ]);

    const captures = await readCaptures();
    expect(captures).toHaveLength(1);
    expect(captures[0].artifacts).toEqual([]);
    expect(captures[0].warnings).toEqual([]);
    expect(storageState.get('bac.providerCapture.captures')).toEqual(captures);
  });
});
