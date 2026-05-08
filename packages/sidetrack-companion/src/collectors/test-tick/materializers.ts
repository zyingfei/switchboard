// Stage 4 — synthetic test-tick collector materializer.
//
// Drives compass §2.G structural tests #2 / #3 / #4 / #6 by providing
// the smallest possible "real" materializer the framework can dispatch
// to. Promotes each tick line into a single `coding.tick.observed`
// Class A event with provenance per Lock 3.
//
// The fixture writer that produces the JSONL lines this materializer
// consumes lives at test/collectors/test-tick-collector/writer.ts.

import { z } from 'zod';

import {
  createMaterializerRegistry,
  type MaterializerRegistration,
  type MaterializerRegistry,
} from '../framework/materializer.js';

export const TEST_TICK_COLLECTOR_ID = 'sidetrack.test-tick' as const;

// Class A event type produced when a tick promotes. Must be
// registered in sync/contract/registry.ts (a future S16 integration
// step adds the ContractEntry row).
export const CODING_TICK_OBSERVED = 'coding.tick.observed' as const;

// ─── payload schemas ───────────────────────────────────────────────

const tickPayloadV1Schema = z.object({
  tick_index: z.number().int().nonnegative(),
  message: z.string().optional(),
});

export type TickPayloadV1 = z.infer<typeof tickPayloadV1Schema>;

// ─── promoted Class A event shape ──────────────────────────────────

export interface CodingTickObservedEvent {
  readonly type: typeof CODING_TICK_OBSERVED;
  readonly payloadVersion: 1;
  readonly emittedAt: string;
  readonly tickIndex: number;
  readonly message?: string;
  readonly producedBy: {
    readonly kind: 'collector';
    readonly ruleId: `${typeof TEST_TICK_COLLECTOR_ID}:tick`;
    readonly ruleVersion: string;
    readonly runId: string;
  };
  readonly dimensions?: Record<string, unknown>;
}

// ─── registration ──────────────────────────────────────────────────

export const testTickRegistration: MaterializerRegistration<TickPayloadV1, CodingTickObservedEvent> = {
  collector_id: TEST_TICK_COLLECTOR_ID,
  event_type: 'tick',
  current_payload_version: 1,
  versions: new Map([[1, { status: 'current' }]]),
  validate: (latest) => tickPayloadV1Schema.parse(latest),
  toClassA: (latest, env) => [
    {
      type: CODING_TICK_OBSERVED,
      payloadVersion: 1,
      emittedAt: env.emitted_at,
      tickIndex: latest.tick_index,
      ...(latest.message === undefined ? {} : { message: latest.message }),
      producedBy: {
        kind: 'collector',
        ruleId: `${TEST_TICK_COLLECTOR_ID}:tick`,
        ruleVersion: env.collector_version,
        runId: env.collector_run_id,
      },
      ...(env.dimensions === undefined ? {} : { dimensions: env.dimensions }),
    },
  ],
};

// Convenience: register with a registry instance. Used by
// runtime/companion.ts in tests + by the test-tick smoke test.
export const registerTestTick = (registry: MaterializerRegistry): void => {
  registry.register(testTickRegistration);
};

// Standalone registry preloaded with just the test-tick materializer.
// Used by spine.e2e.ts so the test harness can drive the framework
// against a known minimal surface.
export const createTestTickRegistry = (): MaterializerRegistry => {
  const registry = createMaterializerRegistry();
  registerTestTick(registry);
  return registry;
};
