import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createLocalQueueItem,
  readQueueItems,
  updateLocalQueueItem,
} from '../../src/background/state';

const installChromeStorageMock = (): { snapshot: () => Record<string, unknown> } => {
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
  return { snapshot: () => ({ ...values }) };
};

describe('updateLocalQueueItem.lastError tri-state', () => {
  beforeEach(() => {
    installChromeStorageMock();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('omits lastError on freshly created items', async () => {
    const item = await createLocalQueueItem({
      text: 'Ask Gemini for follow-up.',
      scope: 'thread',
      targetId: 'bac_thread_test',
    });
    expect(item.lastError).toBeUndefined();
    expect(item.status).toBe('pending');
  });

  it('sets lastError when a string value is passed', async () => {
    const item = await createLocalQueueItem({
      text: 'q1',
      scope: 'thread',
      targetId: 'bac_thread_test',
    });
    const updated = await updateLocalQueueItem(item.bac_id, {
      lastError: 'Open the chat tab; auto-send needs the conversation visible to type into.',
    });
    expect(updated?.lastError).toBe(
      'Open the chat tab; auto-send needs the conversation visible to type into.',
    );
    // Status untouched since not in the patch.
    expect(updated?.status).toBe('pending');
  });

  it('clears lastError when null is passed', async () => {
    const item = await createLocalQueueItem({
      text: 'q1',
      scope: 'thread',
      targetId: 'bac_thread_test',
    });
    await updateLocalQueueItem(item.bac_id, { lastError: 'temporary failure' });
    const cleared = await updateLocalQueueItem(item.bac_id, { lastError: null });
    expect(cleared?.lastError).toBeUndefined();
    // Verify the field is actually deleted, not just undefined-overwritten.
    const persisted = (await readQueueItems()).find((q) => q.bac_id === item.bac_id);
    expect(persisted !== undefined && 'lastError' in persisted).toBe(false);
  });

  it('leaves lastError untouched when the field is not in the patch', async () => {
    const item = await createLocalQueueItem({
      text: 'q1',
      scope: 'thread',
      targetId: 'bac_thread_test',
    });
    await updateLocalQueueItem(item.bac_id, { lastError: 'first failure' });
    // A patch that updates only status should not erase the prior error.
    const afterStatus = await updateLocalQueueItem(item.bac_id, { status: 'pending' });
    expect(afterStatus?.lastError).toBe('first failure');
  });

  it('clears lastError on successful done transition (status + null pattern)', async () => {
    const item = await createLocalQueueItem({
      text: 'q1',
      scope: 'thread',
      targetId: 'bac_thread_test',
    });
    await updateLocalQueueItem(item.bac_id, { lastError: 'preflight blocked' });
    // This is the exact call shape the drain uses on successful send.
    const done = await updateLocalQueueItem(item.bac_id, { status: 'done', lastError: null });
    expect(done?.status).toBe('done');
    expect(done?.lastError).toBeUndefined();
  });
});
