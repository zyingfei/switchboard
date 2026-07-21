// Unit tests for runIdempotent's in-flight dedupe behaviour. The persisted-
// replay path (idempotencyStore round-trip) is exercised in server.test.ts;
// here we focus exclusively on concurrent callers sharing a single operation
// execution while it is still in flight.

import { describe, expect, it, vi } from 'vitest';

import { runIdempotent } from './server.js';
import type { CompanionHttpConfig } from './server.js';

// Minimal context: no persisted idempotency store, no other wiring. runIdempotent
// does not need vault or auth fields for the in-flight-dedupe path.
const makeContext = (): CompanionHttpConfig =>
  ({
    bridgeKey: 'test-bridge-key',
    vaultWriter: {} as CompanionHttpConfig['vaultWriter'],
    // No idempotencyStore so the persistent-replay read always returns undefined
    // and the write is a no-op — the test isolates the in-flight Map.
  }) as unknown as CompanionHttpConfig;

describe('runIdempotent — in-flight dedupe', () => {
  it('invokes operation exactly once when two concurrent calls share the same route+key', async () => {
    const context = makeContext();
    let callCount = 0;

    // operation resolves after a tick so the second call arrives while it is
    // still in flight.
    const operation = vi.fn(async (): Promise<readonly [number, unknown]> => {
      callCount += 1;
      await Promise.resolve();
      return [200, { callCount }];
    });

    const [first, second] = await Promise.all([
      runIdempotent(context, 'testRoute', 'key-shared', operation),
      runIdempotent(context, 'testRoute', 'key-shared', operation),
    ]);

    expect(operation).toHaveBeenCalledTimes(1);
    // Both callers receive the same tuple value.
    expect(first).toEqual([200, { callCount: 1 }]);
    expect(second).toEqual([200, { callCount: 1 }]);
    expect(first).toBe(second);
  });

  it('invokes operation once per key when different keys run concurrently', async () => {
    const context = makeContext();

    const operationA = vi.fn(async (): Promise<readonly [number, unknown]> => {
      await Promise.resolve();
      return [200, { key: 'A' }];
    });
    const operationB = vi.fn(async (): Promise<readonly [number, unknown]> => {
      await Promise.resolve();
      return [201, { key: 'B' }];
    });

    const [resultA, resultB] = await Promise.all([
      runIdempotent(context, 'testRoute', 'key-A', operationA),
      runIdempotent(context, 'testRoute', 'key-B', operationB),
    ]);

    expect(operationA).toHaveBeenCalledTimes(1);
    expect(operationB).toHaveBeenCalledTimes(1);
    expect(resultA).toEqual([200, { key: 'A' }]);
    expect(resultB).toEqual([201, { key: 'B' }]);
  });

  it('propagates rejection to all concurrent callers, then re-runs for the next call', async () => {
    const context = makeContext();
    const error = new Error('boom');
    let attemptCount = 0;

    const operation = vi.fn(async (): Promise<readonly [number, unknown]> => {
      attemptCount += 1;
      await Promise.resolve();
      if (attemptCount === 1) {
        throw error;
      }
      return [200, { attempt: attemptCount }];
    });

    // First and second calls are concurrent — both should reject.
    const [first, second] = await Promise.allSettled([
      runIdempotent(context, 'testRoute', 'key-fail', operation),
      runIdempotent(context, 'testRoute', 'key-fail', operation),
    ]);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(first.status).toBe('rejected');
    expect(second.status).toBe('rejected');
    if (first.status === 'rejected') expect(first.reason).toBe(error);
    if (second.status === 'rejected') expect(second.reason).toBe(error);

    // Third call: the map entry was removed on settle, so a fresh attempt runs.
    const third = await runIdempotent(context, 'testRoute', 'key-fail', operation);
    expect(operation).toHaveBeenCalledTimes(2);
    expect(third).toEqual([200, { attempt: 2 }]);
  });
});
