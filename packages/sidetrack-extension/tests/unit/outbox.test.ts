import { describe, expect, it } from 'vitest';

import {
  baseOutboxItemShape,
  createOutbox,
  type OutboxItem,
  type OutboxStorage,
} from '../../src/companion/outbox';

interface DemoPayload {
  readonly threadId: string;
  readonly comment: string;
}

const createMemoryStorage = (): OutboxStorage & {
  readonly snapshot: () => Record<string, unknown>;
} => {
  const values = new Map<string, unknown>();
  return {
    get(key, fallback) {
      return Promise.resolve((values.has(key) ? values.get(key) : fallback) as typeof fallback);
    },
    set(nextValues) {
      Object.entries(nextValues).forEach(([key, value]) => {
        values.set(key, value);
      });
      return Promise.resolve();
    },
    snapshot() {
      return Object.fromEntries(values.entries());
    },
  };
};

const isDemo = (value: unknown): value is DemoPayload =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Record<string, unknown>).threadId === 'string' &&
  typeof (value as Record<string, unknown>).comment === 'string';

const migrate = (raw: unknown): OutboxItem<DemoPayload> | null => {
  const base = baseOutboxItemShape(raw);
  if (base === null || !isDemo(base.payload)) return null;
  return {
    id: base.id,
    queuedAt: base.queuedAt,
    attempts: base.attempts,
    nextAttemptAt: base.nextAttemptAt,
    payload: base.payload,
  };
};

const makeOutbox = () =>
  createOutbox<DemoPayload>({
    storageKey: 'sidetrack.outbox.demo',
    droppedKey: 'sidetrack.outbox.demo.droppedCount',
    migrate,
  });

describe('generic outbox', () => {
  it('mints a fresh idempotency-key-shaped id per enqueue and exposes it on drain', async () => {
    const storage = createMemoryStorage();
    const outbox = makeOutbox();
    await outbox.enqueue({ threadId: 't-1', comment: 'a' }, storage);
    await outbox.enqueue({ threadId: 't-1', comment: 'b' }, storage);

    const seenIds = new Set<string>();
    await outbox.drain(
      (item) => {
        seenIds.add(item.id);
        return Promise.resolve();
      },
      storage,
      new Date(),
      () => 0.5,
      { ignoreBackoff: true },
    );
    expect(seenIds.size).toBe(2);
    for (const id of seenIds) {
      expect(id).toMatch(/^[0-9a-f-]{36}$/i);
    }
  });

  it('evicts oldest items when limit is exceeded and increments dropped count', async () => {
    const storage = createMemoryStorage();
    const outbox = makeOutbox();
    await outbox.enqueue({ threadId: 't-1', comment: '1' }, storage, 2);
    await outbox.enqueue({ threadId: 't-1', comment: '2' }, storage, 2);
    const result = await outbox.enqueue({ threadId: 't-1', comment: '3' }, storage, 2);

    expect(result.evicted).toBe(1);
    expect((await outbox.read(storage)).map((entry) => entry.payload.comment)).toEqual(['2', '3']);
    expect(await outbox.readDropped(storage)).toBe(1);
  });

  it('keeps separate keyspaces — two outboxes do not collide on storage', async () => {
    const storage = createMemoryStorage();
    const a = createOutbox<DemoPayload>({
      storageKey: 'a',
      droppedKey: 'a.dropped',
      migrate,
    });
    const b = createOutbox<DemoPayload>({
      storageKey: 'b',
      droppedKey: 'b.dropped',
      migrate,
    });
    await a.enqueue({ threadId: 't-a', comment: 'a' }, storage);
    await b.enqueue({ threadId: 't-b', comment: 'b' }, storage);
    expect((await a.read(storage)).map((entry) => entry.payload.comment)).toEqual(['a']);
    expect((await b.read(storage)).map((entry) => entry.payload.comment)).toEqual(['b']);
  });

  it('drops an item after exceeding maxAttempts during drain', async () => {
    const storage = createMemoryStorage();
    const outbox = createOutbox<DemoPayload>({
      storageKey: 'k',
      droppedKey: 'k.dropped',
      migrate,
      maxAttempts: 2,
    });
    await outbox.enqueue({ threadId: 't', comment: 'x' }, storage);

    // Three drain passes against a permanently failing send: attempts
    // climb 0 → 1 → 2 → 3, exceeding the cap, item is dropped.
    for (let i = 0; i < 3; i += 1) {
      await outbox.drain(
        () => Promise.reject(new Error('offline')),
        storage,
        new Date(`2026-04-26T22:0${String(i)}:00.000Z`),
        () => 0.5,
        { ignoreBackoff: true },
      );
    }
    expect(await outbox.read(storage)).toEqual([]);
    expect(await outbox.readDropped(storage)).toBe(1);
  });

  it('migrates legacy entries that stored the payload under `event`', async () => {
    const storage = createMemoryStorage();
    const outbox = makeOutbox();
    await storage.set({
      'sidetrack.outbox.demo': [
        {
          id: 'legacy',
          queuedAt: '2026-04-26T21:00:00.000Z',
          event: { threadId: 't-legacy', comment: 'legacy' },
        },
      ],
    });
    const items = await outbox.read(storage);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'legacy',
      attempts: 0,
      payload: { threadId: 't-legacy', comment: 'legacy' },
    });
  });

  it('reject-when-full overflow throws OutboxFullError instead of silently evicting', async () => {
    const { OutboxFullError } = await import('../../src/companion/outbox');
    const storage = createMemoryStorage();
    const outbox = createOutbox<DemoPayload>({
      storageKey: 'reject',
      droppedKey: 'reject.dropped',
      defaultLimit: 2,
      overflowPolicy: { kind: 'reject-when-full' },
      migrate,
    });
    await outbox.enqueue({ threadId: 't', comment: '1' }, storage);
    await outbox.enqueue({ threadId: 't', comment: '2' }, storage);
    await expect(outbox.enqueue({ threadId: 't', comment: '3' }, storage)).rejects.toBeInstanceOf(
      OutboxFullError,
    );
    // The existing items are preserved — reject-when-full is the
    // safety net for user-authored content.
    const remaining = await outbox.read(storage);
    expect(remaining.map((entry) => entry.payload.comment)).toEqual(['1', '2']);
    expect(await outbox.readDropped(storage)).toBe(0);
  });

  it('clear empties the queue but does not reset dropped count', async () => {
    const storage = createMemoryStorage();
    const outbox = makeOutbox();
    await outbox.enqueue({ threadId: 't', comment: 'x' }, storage);
    await storage.set({ 'sidetrack.outbox.demo.droppedCount': 5 });
    await outbox.clear(storage);
    expect(await outbox.read(storage)).toEqual([]);
    expect(await outbox.readDropped(storage)).toBe(5);
  });
});
