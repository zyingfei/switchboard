import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { upsertLocalThread } from '../../src/background/state';

const installChromeStorageMock = (): void => {
  const values: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn((query: Record<string, unknown> | string | null | undefined) => {
          if (typeof query === 'string') {
            return Promise.resolve({ [query]: values[query] });
          }
          if (query !== null && query !== undefined && typeof query === 'object') {
            return Promise.resolve(
              Object.fromEntries(
                Object.entries(query).map(([key, fallback]) => [key, values[key] ?? fallback]),
              ),
            );
          }
          return Promise.resolve({ ...values });
        }),
        set: vi.fn((next: Record<string, unknown>) => {
          Object.assign(values, next);
          return Promise.resolve();
        }),
      },
    },
  });
};

describe('upsertLocalThread carries lastResearchMode', () => {
  beforeEach(() => {
    installChromeStorageMock();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('persists a fresh deep-research mode on first upsert', async () => {
    const thread = await upsertLocalThread({
      bac_id: 'bac_dr_thread',
      provider: 'chatgpt',
      threadUrl: 'https://chatgpt.com/c/dr-1',
      title: 'Deep research thread',
      lastSeenAt: '2026-05-06T17:00:00.000Z',
      status: 'active',
      trackingMode: 'auto',
      tags: [],
      lastResearchMode: 'deep-research',
    });
    expect(thread.lastResearchMode).toBe('deep-research');
  });

  it('keeps the prior lastResearchMode when a state-only upsert omits it', async () => {
    await upsertLocalThread({
      bac_id: 'bac_dr_keep',
      provider: 'chatgpt',
      threadUrl: 'https://chatgpt.com/c/dr-keep',
      title: 'Stays deep research',
      lastSeenAt: '2026-05-06T17:00:00.000Z',
      status: 'active',
      trackingMode: 'auto',
      tags: [],
      lastResearchMode: 'deep-research',
    });
    // Subsequent upsert without lastResearchMode (e.g., the
    // markClosedTabRestorable transition) must NOT erase the prior
    // value — otherwise closing+reopening a tab strips the chip.
    const next = await upsertLocalThread({
      bac_id: 'bac_dr_keep',
      provider: 'chatgpt',
      threadUrl: 'https://chatgpt.com/c/dr-keep',
      title: 'Stays deep research',
      lastSeenAt: '2026-05-06T18:00:00.000Z',
      status: 'restorable',
      trackingMode: 'auto',
      tags: [],
    });
    expect(next.lastResearchMode).toBe('deep-research');
  });

  it('overwrites when a fresh assistant turn promotes a different research mode', async () => {
    await upsertLocalThread({
      bac_id: 'bac_dr_overwrite',
      provider: 'chatgpt',
      threadUrl: 'https://chatgpt.com/c/dr-overwrite',
      title: 'Overwrite mode',
      lastSeenAt: '2026-05-06T17:00:00.000Z',
      status: 'active',
      trackingMode: 'auto',
      tags: [],
      lastResearchMode: 'deep-research',
    });
    const next = await upsertLocalThread({
      bac_id: 'bac_dr_overwrite',
      provider: 'chatgpt',
      threadUrl: 'https://chatgpt.com/c/dr-overwrite',
      title: 'Overwrite mode',
      lastSeenAt: '2026-05-06T18:00:00.000Z',
      status: 'active',
      trackingMode: 'auto',
      tags: [],
      lastResearchMode: 'gemini-deep-research',
    });
    expect(next.lastResearchMode).toBe('gemini-deep-research');
  });
});
