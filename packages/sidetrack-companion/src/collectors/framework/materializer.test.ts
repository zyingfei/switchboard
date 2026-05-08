import { describe, expect, it } from 'vitest';

import {
  createMaterializerRegistry,
  type MaterializerRegistration,
} from './materializer.js';

type VersionInfo = MaterializerRegistration<CurrentPayload>['versions'] extends ReadonlyMap<
  number,
  infer V
>
  ? V
  : never;

interface CurrentPayload {
  readonly value: string;
  readonly version: number;
}

const versionMap = (
  entries: readonly (readonly [number, VersionInfo])[],
): ReadonlyMap<number, VersionInfo> => new Map(entries);

const registration = (
  versions: MaterializerRegistration<CurrentPayload>['versions'],
  current_payload_version: number,
): MaterializerRegistration<CurrentPayload> => ({
  collector_id: 'test-collector',
  event_type: 'test.event',
  current_payload_version,
  versions,
  validate: (latest) => latest as CurrentPayload,
  toClassA: () => [],
});

const expectFound = (
  result: ReturnType<ReturnType<typeof createMaterializerRegistry>['get']>,
) => {
  if (result.kind !== 'found') {
    throw new Error(`expected found, received ${result.kind}`);
  }
  return result;
};

describe('materializer registry', () => {
  it('returns current registrations with an empty upcaster chain', () => {
    const registry = createMaterializerRegistry();
    registry.register(registration(versionMap([[1, { status: 'current' }]]), 1));

    const result = expectFound(registry.get('test-collector', 'test.event', 1));

    expect(result.status).toBe('current');
    expect(result.upcasterChain).toEqual([]);
  });

  it('returns a one-step upcaster chain for an accepted prior version', () => {
    const registry = createMaterializerRegistry();
    registry.register(
      registration(
        versionMap([
          [
            1,
            {
              status: 'accepted',
              upcastTo: (older) => ({
                ...(older as { readonly value: string }),
                version: 2,
              }),
            },
          ],
          [2, { status: 'current' }],
        ]),
        2,
      ),
    );

    const result = expectFound(registry.get('test-collector', 'test.event', 1));
    const latest = result.upcasterChain.reduce<unknown>(
      (payload, upcast) => upcast(payload),
      { value: 'alpha' },
    );

    expect(result.status).toBe('accepted');
    expect(result.upcasterChain).toHaveLength(1);
    expect(latest).toEqual({ value: 'alpha', version: 2 });
  });

  it('returns a multi-step upcaster chain for older accepted versions', () => {
    const registry = createMaterializerRegistry();
    registry.register(
      registration(
        versionMap([
          [
            1,
            {
              status: 'accepted',
              upcastTo: (older) => ({
                ...(older as { readonly value: string }),
                version: 2,
              }),
            },
          ],
          [
            2,
            {
              status: 'accepted',
              upcastTo: (older) => ({
                ...(older as { readonly value: string; readonly version: number }),
                version: 3,
              }),
            },
          ],
          [3, { status: 'current' }],
        ]),
        3,
      ),
    );

    const result = expectFound(registry.get('test-collector', 'test.event', 1));
    const latest = result.upcasterChain.reduce<unknown>(
      (payload, upcast) => upcast(payload),
      { value: 'alpha' },
    );

    expect(result.upcasterChain).toHaveLength(2);
    expect(latest).toEqual({ value: 'alpha', version: 3 });
  });

  it('returns not-registered for unknown collector/event tuples', () => {
    const registry = createMaterializerRegistry();

    expect(registry.get('missing-collector', 'missing.event', 1)).toEqual({
      kind: 'not-registered',
    });
  });

  it('returns version-too-new when the requested version is newer than current', () => {
    const registry = createMaterializerRegistry();
    registry.register(registration(versionMap([[2, { status: 'current' }]]), 2));

    expect(registry.get('test-collector', 'test.event', 3)).toEqual({
      kind: 'version-too-new',
      max_known: 2,
    });
  });

  it('throws on duplicate tuple registration', () => {
    const registry = createMaterializerRegistry();
    registry.register(registration(versionMap([[1, { status: 'current' }]]), 1));

    expect(() =>
      registry.register(registration(versionMap([[1, { status: 'current' }]]), 1)),
    ).toThrow('duplicate materializer registration: test-collector:test.event:1');
  });

  it('returns the maximum known payload version across registered versions', () => {
    const registry = createMaterializerRegistry();
    registry.register(
      registration(
        versionMap([
          [1, { status: 'accepted', upcastTo: (older) => older }],
          [3, { status: 'current' }],
          [2, { status: 'accepted', upcastTo: (older) => older }],
        ]),
        3,
      ),
    );

    expect(
      registry.maxKnownPayloadVersionFor('test-collector', 'test.event'),
    ).toBe(3);
    expect(
      registry.maxKnownPayloadVersionFor('missing-collector', 'missing.event'),
    ).toBeUndefined();
  });
});
