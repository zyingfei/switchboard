import type { CollectorEvent, PayloadVersionStatus } from './types.js';

export interface MaterializerRegistration<P_current, EmittedEvent = unknown> {
  readonly collector_id: string;
  readonly event_type: string;
  readonly current_payload_version: number;
  readonly versions: ReadonlyMap<
    number,
    {
      readonly status: PayloadVersionStatus;
      readonly upcastTo?: (older: unknown) => unknown;
    }
  >;
  readonly validate: (latest: unknown) => P_current;
  readonly toClassA: (latest: P_current, env: CollectorEvent) => readonly EmittedEvent[];
}

export interface MaterializerRegistry {
  register<P, E>(reg: MaterializerRegistration<P, E>): void;
  get(
    collector_id: string,
    event_type: string,
    payload_version: number,
  ):
    | {
        kind: 'found';
        reg: MaterializerRegistration<unknown>;
        status: PayloadVersionStatus;
        upcasterChain: readonly ((x: unknown) => unknown)[];
      }
    | { kind: 'not-registered' }
    | { kind: 'version-too-new'; max_known: number };
  allRegistrations(): readonly MaterializerRegistration<unknown>[];
  allTuples(): ReadonlySet<string>;
  maxKnownPayloadVersionFor(collector_id: string, event_type: string): number | undefined;
}

const tupleKey = (collector_id: string, event_type: string, payload_version: number): string =>
  `${collector_id}:${event_type}:${payload_version}`;

const registrationKey = (collector_id: string, event_type: string): string =>
  `${collector_id}:${event_type}`;

export const createMaterializerRegistry = (): MaterializerRegistry => {
  const registrations = new Map<string, MaterializerRegistration<unknown>>();
  const registrationsInOrder: MaterializerRegistration<unknown>[] = [];
  const tupleToRegistration = new Map<string, MaterializerRegistration<unknown>>();
  const maxVersions = new Map<string, number>();

  return {
    register<P, E>(reg: MaterializerRegistration<P, E>): void {
      const stored = reg as unknown as MaterializerRegistration<unknown>;
      const baseKey = registrationKey(reg.collector_id, reg.event_type);

      for (const version of reg.versions.keys()) {
        const key = tupleKey(reg.collector_id, reg.event_type, version);
        if (tupleToRegistration.has(key)) {
          throw new Error(`duplicate materializer registration: ${key}`);
        }
      }

      registrations.set(baseKey, stored);
      registrationsInOrder.push(stored);
      for (const version of reg.versions.keys()) {
        tupleToRegistration.set(tupleKey(reg.collector_id, reg.event_type, version), stored);
        maxVersions.set(
          baseKey,
          Math.max(maxVersions.get(baseKey) ?? Number.NEGATIVE_INFINITY, version),
        );
      }
    },

    get(
      collector_id: string,
      event_type: string,
      payload_version: number,
    ):
      | {
          kind: 'found';
          reg: MaterializerRegistration<unknown>;
          status: PayloadVersionStatus;
          upcasterChain: readonly ((x: unknown) => unknown)[];
        }
      | { kind: 'not-registered' }
      | { kind: 'version-too-new'; max_known: number } {
      const baseKey = registrationKey(collector_id, event_type);
      const reg = registrations.get(baseKey);
      if (reg === undefined) {
        return { kind: 'not-registered' };
      }

      if (payload_version > reg.current_payload_version) {
        return {
          kind: 'version-too-new',
          max_known: maxVersions.get(baseKey) ?? reg.current_payload_version,
        };
      }

      const versionInfo = reg.versions.get(payload_version);
      if (versionInfo === undefined) {
        return { kind: 'not-registered' };
      }

      const upcasterChain: ((x: unknown) => unknown)[] = [];
      for (let version = payload_version; version < reg.current_payload_version; version += 1) {
        const next = reg.versions.get(version)?.upcastTo;
        if (next === undefined) {
          return { kind: 'not-registered' };
        }
        upcasterChain.push(next);
      }

      return {
        kind: 'found',
        reg,
        status: versionInfo.status,
        upcasterChain,
      };
    },

    allRegistrations(): readonly MaterializerRegistration<unknown>[] {
      return [...registrationsInOrder];
    },

    allTuples(): ReadonlySet<string> {
      return new Set(tupleToRegistration.keys());
    },

    maxKnownPayloadVersionFor(collector_id: string, event_type: string): number | undefined {
      return maxVersions.get(registrationKey(collector_id, event_type));
    },
  };
};
