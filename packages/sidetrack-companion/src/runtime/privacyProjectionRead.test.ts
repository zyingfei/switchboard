import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { AcceptedEvent } from '../sync/causal.js';
import { createEventStore, type EventStore } from '../sync/eventStore.js';
import {
  PRIVACY_GATE_FLIPPED,
  PRIVACY_PERMISSION_GRANTED,
  PRIVACY_PERMISSION_REVOKED,
} from '../privacy/events.js';
import { projectPrivacy, type PrivacyProjection } from '../privacy/projection.js';

// Pins the store-backed read inside companion.ts's
// refreshPrivacyProjectionFromLog. That read used to be an UNTYPED
// store.forEachChunk full scan — it materialised (JSON.parse'd) every row
// in a ~450k-event store just to keep the handful of privacy events, and
// it ran in the boot path that the 'collector-framework' watchdog phase
// measures. It is now forEachChunkOfTypes over the same three needles,
// pushed down to the events_type_idx index.
//
// What this pins:
//   1. The three needles are exactly what projectPrivacy consumes — the
//      expected projection below depends on ALL THREE (drop any one and a
//      different field goes wrong).
//   2. Ordering is store order — (replica_id, seq) — NOT accepted-time
//      order. projectPrivacy's gate fold is last-write-wins, so the two
//      orders are deliberately made to disagree here.
//   3. The typed read is byte-for-byte substitutable for the old untyped
//      scan (inline oracle below), and only touches matching rows.

const sqliteIt = process.versions['bun'] === undefined ? it.skip : it;

const PRIVACY_TYPES = [
  PRIVACY_GATE_FLIPPED,
  PRIVACY_PERMISSION_GRANTED,
  PRIVACY_PERMISSION_REVOKED,
] as const;

const SCOPE = { domain: 'example.test' } as const;

const evt = (input: {
  readonly replicaId: string;
  readonly seq: number;
  readonly type: string;
  readonly acceptedAtMs: number;
  readonly payload: Record<string, unknown>;
}): AcceptedEvent => ({
  clientEventId: `${input.replicaId}-${String(input.seq)}`,
  dot: { replicaId: input.replicaId, seq: input.seq },
  deps: {},
  aggregateId: `agg-${input.replicaId}`,
  type: input.type,
  payload: input.payload,
  acceptedAtMs: input.acceptedAtMs,
});

// MIXED store: 6 privacy events across 3 replicas, interleaved with 3
// noise events of the types that actually dominate a real log. The
// noisiest one carries the HIGHEST acceptedAtMs, so a leaked type would
// be visible in the projection's updatedAtMs.
const buildMixedEvents = (): readonly AcceptedEvent[] => [
  // replica-a
  evt({
    replicaId: 'replica-a',
    seq: 1,
    type: PRIVACY_GATE_FLIPPED,
    acceptedAtMs: 900,
    payload: { gate: 'capture', state: 'open', actor: 'user' },
  }),
  evt({
    replicaId: 'replica-a',
    seq: 2,
    type: 'engagement.interval.observed',
    acceptedAtMs: 5_000,
    payload: { focusedMs: 1_000 },
  }),
  evt({
    replicaId: 'replica-a',
    seq: 3,
    type: PRIVACY_PERMISSION_GRANTED,
    acceptedAtMs: 500,
    payload: { permission: 'page-access', scope: SCOPE },
  }),
  evt({
    replicaId: 'replica-a',
    seq: 4,
    type: 'engagement.interval.observed',
    acceptedAtMs: 600,
    payload: { focusedMs: 2_000 },
  }),
  // replica-b
  evt({
    replicaId: 'replica-b',
    seq: 1,
    type: PRIVACY_GATE_FLIPPED,
    acceptedAtMs: 300,
    payload: { gate: 'capture', state: 'closed', actor: 'system' },
  }),
  evt({
    replicaId: 'replica-b',
    seq: 2,
    type: 'browser.timeline.observed',
    acceptedAtMs: 200,
    payload: { url: 'https://example.test/a' },
  }),
  evt({
    replicaId: 'replica-b',
    seq: 3,
    type: PRIVACY_PERMISSION_REVOKED,
    acceptedAtMs: 800,
    payload: { permission: 'page-access', scope: SCOPE, retroactiveMask: true },
  }),
  // replica-c — LAST in (replica_id, seq) order but OLDEST in wall time,
  // which is what makes the gate fold order-discriminating.
  evt({
    replicaId: 'replica-c',
    seq: 1,
    type: PRIVACY_GATE_FLIPPED,
    acceptedAtMs: 100,
    payload: { gate: 'capture', state: 'closed', actor: 'user' },
  }),
  evt({
    replicaId: 'replica-c',
    seq: 2,
    type: PRIVACY_PERMISSION_GRANTED,
    acceptedAtMs: 700,
    payload: { permission: 'clipboard', scope: SCOPE },
  }),
];

// Hand-computed fold over the 6 privacy events in (replica_id, seq) order:
//   a1 gate capture=open        → gateStates.capture = 'open'
//   a3 grant page-access        → granted = {page-access}
//   b1 gate capture=closed      → gateStates.capture = 'closed'
//   b3 revoke page-access (mask)→ granted = {}, masks = {page-access}
//   c1 gate capture=closed      → gateStates.capture = 'closed'  (final)
//   c2 grant clipboard          → granted = {clipboard}
// updatedAtMs = max acceptedAtMs over PRIVACY events only = 900 (a1);
// the 5_000 engagement event must not reach the fold.
//
// Under accepted-time order the gate would settle 'open' (c1 100 closed →
// b1 300 closed → a1 900 open), so this expectation fails if the read ever
// stops being store-ordered.
const EXPECTED_PROJECTION: PrivacyProjection = {
  gateStates: { capture: 'closed' },
  gateEventCount: 3,
  grantedPermissions: [{ permission: 'clipboard', scope: SCOPE }],
  retroactiveMasks: [{ permission: 'page-access', scope: SCOPE }],
  updatedAtMs: 900,
};

/** Inline reimplementation of the pre-fix untyped full scan (the oracle). */
const readPrivacyViaUntypedScan = async (store: EventStore): Promise<AcceptedEvent[]> => {
  const events: AcceptedEvent[] = [];
  await store.forEachChunk((chunk) => {
    for (const event of chunk) {
      if (
        event.type === PRIVACY_GATE_FLIPPED ||
        event.type === PRIVACY_PERMISSION_GRANTED ||
        event.type === PRIVACY_PERMISSION_REVOKED
      ) {
        events.push(event);
      }
    }
  }, 2000);
  return events;
};

/** The shipped read: companion.ts refreshPrivacyProjectionFromLog. */
const readPrivacyViaTypedScan = async (
  store: EventStore,
  chunkSize = 2000,
): Promise<AcceptedEvent[]> => {
  const events: AcceptedEvent[] = [];
  await store.forEachChunkOfTypes(
    [...PRIVACY_TYPES],
    (chunk) => {
      for (const event of chunk) events.push(event);
    },
    chunkSize,
  );
  return events;
};

describe('privacy projection refresh — typed store read', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  const seededStore = async (): Promise<EventStore> => {
    const vault = await mkdtemp(join(tmpdir(), 'privacy-typed-read-'));
    dirs.push(vault);
    await mkdir(join(vault, '_BAC', 'connections'), { recursive: true });
    const store = await createEventStore(vault);
    store.ingestMany(buildMixedEvents());
    return store;
  };

  sqliteIt('folds to the hand-computed projection from a mixed-type store', async () => {
    const store = await seededStore();
    expect(store.count()).toBe(9);

    const typed = await readPrivacyViaTypedScan(store);
    expect(typed.map((e) => e.clientEventId)).toEqual([
      'replica-a-1',
      'replica-a-3',
      'replica-b-1',
      'replica-b-3',
      'replica-c-1',
      'replica-c-2',
    ]);
    expect(projectPrivacy(typed)).toEqual(EXPECTED_PROJECTION);
    store.close();
  });

  sqliteIt('is substitutable for the untyped full scan it replaced', async () => {
    const store = await seededStore();

    const oracle = await readPrivacyViaUntypedScan(store);
    const typed = await readPrivacyViaTypedScan(store);

    // Same events, same order — so the same projection, which is the only
    // thing the caller keeps.
    expect(typed).toEqual(oracle);
    expect(projectPrivacy(typed)).toEqual(projectPrivacy(oracle));
    expect(projectPrivacy(oracle)).toEqual(EXPECTED_PROJECTION);
    store.close();
  });

  sqliteIt('touches only matching rows and keeps the chunk-yield cadence', async () => {
    const store = await seededStore();

    let untypedRows = 0;
    await store.forEachChunk((chunk) => {
      untypedRows += chunk.length;
    }, 2000);

    let typedRows = 0;
    const typedChunkSizes: number[] = [];
    await store.forEachChunkOfTypes(
      [...PRIVACY_TYPES],
      (chunk) => {
        typedRows += chunk.length;
        typedChunkSizes.push(chunk.length);
      },
      2,
    );

    // The whole point of the fix: 9 rows parsed before, 6 after — and on a
    // real vault the ratio is the ~450k-to-a-handful that blew the boot
    // watchdog budget.
    expect(untypedRows).toBe(9);
    expect(typedRows).toBe(6);
    // Cadence: the typed reader still pages at the requested chunk size and
    // yields between pages, so a large fold stays interruptible.
    expect(typedChunkSizes).toEqual([2, 2, 2]);
    store.close();
  });

  sqliteIt('every needle is load-bearing — dropping one changes the projection', async () => {
    const store = await seededStore();

    for (const dropped of PRIVACY_TYPES) {
      const partial: AcceptedEvent[] = [];
      await store.forEachChunkOfTypes(
        PRIVACY_TYPES.filter((type) => type !== dropped),
        (chunk) => {
          for (const event of chunk) partial.push(event);
        },
        2000,
      );
      expect(projectPrivacy(partial), `dropping ${dropped} must change the fold`).not.toEqual(
        EXPECTED_PROJECTION,
      );
    }
    store.close();
  });
});
