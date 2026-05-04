import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { listPendingOffers, markStatus, upsertOffer } from '../../src/codingAttach/state';

const installChromeStorage = (): Map<string, unknown> => {
  const values = new Map<string, unknown>();
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: (key: string) => Promise.resolve({ [key]: values.get(key) }),
        set: (next: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(next)) {
            values.set(key, value);
          }
          return Promise.resolve();
        },
      },
    },
  });
  return values;
};

describe('coding attach offer state', () => {
  beforeEach(() => {
    installChromeStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('upserts pending offers and marks status', async () => {
    await upsertOffer(
      {
        tabId: 1,
        url: 'https://chatgpt.com/codex/project',
        surface: {
          id: 'codex',
          signals: { urlMatch: true, domHint: true },
          confidence: 'high',
        },
      },
      new Date('2026-05-03T00:00:00.000Z'),
    );

    await expect(listPendingOffers(new Date('2026-05-03T00:10:00.000Z'))).resolves.toHaveLength(1);
    await expect(markStatus(1, 'accepted')).resolves.toMatchObject({ status: 'accepted' });
    await expect(listPendingOffers(new Date('2026-05-03T00:10:00.000Z'))).resolves.toEqual([]);
  });

  it('expires pending offers after thirty minutes', async () => {
    await upsertOffer(
      {
        tabId: 2,
        url: 'https://claude.ai/code/session',
        surface: {
          id: 'claude_code',
          signals: { urlMatch: true, domHint: false },
          confidence: 'medium',
        },
      },
      new Date('2026-05-03T00:00:00.000Z'),
    );

    await expect(listPendingOffers(new Date('2026-05-03T00:31:00.000Z'))).resolves.toEqual([]);
  });
});
