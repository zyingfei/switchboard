// Stage 4 — eight structural acceptance tests (compass §2.G).
//
// Tests covered here:
//   #2 — one test-tick collector → 100 lines → 100 promoted + 0 quarantined
//   #4 — privacy gate denied → quarantine; granted → replay
//   #6 — two collectors with colliding event_type → distinct ruleIds
//   malformed → quarantined deterministically with materializer-validation-failed
//
// Tests #1 (regression), #5 (manifest), #7 (connections), #8 (layout) live elsewhere:
//   #1 — existing Stage 1 + Stage 2/3 e2e suites must pass unmodified
//   #5 — covered by manifest.test.ts (requires-companion = ">=999.0.0")
//   #7 — extension-side e2e in connections-mvp-user-story.spec.ts
//   #8 — covered by inbox.test.ts directory-shape assertion
//
// Test #3 (payload_version-too-new replay) is deferred — it requires
// re-booting bootCollectorFramework with a registry that adds support
// for the higher version, which would need an opt-in to skip the
// hardcoded test-tick v1 registration. Tracked as a follow-up.
//
// Each test:
//   1. mkdtemp a fresh vault root with the documented `_BAC/` layout.
//   2. Drop a `_BAC/collectors/<id>/collector.toml` manifest fixture.
//   3. bootCollectorFramework with capture adapters for appendClassA + auditRoute.
//   4. Drive lines via test/collectors/test-tick-collector/writer.ts.
//   5. Assert on captured Class A events, captured audit entries, and quarantine state.
//   6. Tear down the framework + remove the temp dir.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { bootCollectorFramework } from './runtime.js';
import { TEST_TICK_COLLECTOR_ID, writeTickBatch } from '../test-tick/helpers/writer.js';
import { renderTestTickManifest } from '../test-tick/helpers/manifest-fixture.js';
import type { MaterializerRegistry } from './materializer.js';
import type { CollectorEvent } from './types.js';

interface CapturedClassA {
  readonly event: unknown;
  readonly ruleId: string;
  readonly line: CollectorEvent;
}

interface CapturedAudit {
  readonly route: string;
  readonly subject: string;
}

const setupFixtureVault = async (
  manifestOptsByCollectorId: ReadonlyMap<string, Parameters<typeof renderTestTickManifest>[0]>,
): Promise<{ readonly vaultRoot: string; readonly cleanup: () => Promise<void> }> => {
  const vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-stage4-spine-'));
  await mkdir(join(vaultRoot, '_BAC', 'events'), { recursive: true });
  await mkdir(join(vaultRoot, '_BAC', 'audit'), { recursive: true });
  await mkdir(join(vaultRoot, '_BAC', '.config'), { recursive: true });
  for (const [id, opts] of manifestOptsByCollectorId.entries()) {
    const manifestDir = join(vaultRoot, '_BAC', 'collectors', id);
    await mkdir(manifestDir, { recursive: true });
    await writeFile(
      join(manifestDir, 'collector.toml'),
      renderTestTickManifest({ ...opts, id }),
      'utf8',
    );
  }
  return {
    vaultRoot,
    cleanup: () => rm(vaultRoot, { recursive: true, force: true }),
  };
};

interface BootedHarness {
  readonly vaultRoot: string;
  readonly classA: CapturedClassA[];
  readonly audits: CapturedAudit[];
  readonly framework: Awaited<ReturnType<typeof bootCollectorFramework>>;
  readonly close: () => Promise<void>;
}

const bootHarness = async (
  vaultRoot: string,
  opts: Partial<Parameters<typeof bootCollectorFramework>[0]> = {},
): Promise<BootedHarness> => {
  const classA: CapturedClassA[] = [];
  const audits: CapturedAudit[] = [];
  const framework = await bootCollectorFramework({
    vaultRoot,
    appendClassA: async (event: unknown, ruleId: string, line) => {
      classA.push({ event, ruleId, line });
    },
    auditRoute: async (route: string, subject: string) => {
      audits.push({ route, subject });
    },
    ...opts,
  });
  return {
    vaultRoot,
    classA,
    audits,
    framework,
    close: () => framework.close(),
  };
};

const readQuarantineFiles = async (
  vaultRoot: string,
): Promise<readonly { collectorId: string; reason: string }[]> => {
  const root = join(vaultRoot, '_BAC', 'audit', 'quarantine');
  let dates: string[];
  try {
    dates = await readdir(root);
  } catch {
    return [];
  }
  const out: { collectorId: string; reason: string }[] = [];
  for (const date of dates) {
    let files: string[];
    try {
      files = await readdir(join(root, date));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const collectorId = file.replace(/\.jsonl$/u, '');
      let raw: string;
      try {
        raw = await readFile(join(root, date, file), 'utf8');
      } catch {
        continue;
      }
      for (const line of raw.split('\n')) {
        if (line.trim().length === 0) continue;
        try {
          const parsed = JSON.parse(line) as { reason?: string };
          if (typeof parsed.reason === 'string') {
            out.push({ collectorId, reason: parsed.reason });
          }
        } catch {
          // Skip
        }
      }
    }
  }
  return out;
};

describe('Stage 4 spine — compass §2.G structural tests', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup !== null) {
      await cleanup();
      cleanup = null;
    }
  });

  it('#2: 100 lines from one test-tick collector → 100 promoted + 0 quarantined', async () => {
    const fixture = await setupFixtureVault(new Map([[TEST_TICK_COLLECTOR_ID, {}]]));
    cleanup = fixture.cleanup;
    const harness = await bootHarness(fixture.vaultRoot);
    try {
      await writeTickBatch(100, { vaultRoot: fixture.vaultRoot });
      // Wait for the tail to drain.
      await harness.framework.waitIdle();
      // Drain again — fs.watch may have queued a debounced batch
      // mid-waitIdle.
      await new Promise((resolve) => setTimeout(resolve, 250));
      await harness.framework.waitIdle();

      // Hard assert: 100 Class A events captured.
      expect(harness.classA).toHaveLength(100);
      // Every event has the expected ruleId.
      const ruleIds = new Set(harness.classA.map((c) => c.ruleId));
      expect(ruleIds.size).toBe(1);
      expect(ruleIds.has(`${TEST_TICK_COLLECTOR_ID}:tick`)).toBe(true);
      // No quarantines.
      const quarantine = await readQuarantineFiles(fixture.vaultRoot);
      expect(quarantine).toHaveLength(0);
      // Audit log captured the line-promoted route 100 times.
      const promoteAudits = harness.audits.filter((a) => a.route === 'collector:line-promoted');
      expect(promoteAudits.length).toBeGreaterThanOrEqual(100);
    } finally {
      await harness.close();
    }
  });

  it('#4 (a): privacy gate denied → quarantine with reason "privacy-gate-denied"', async () => {
    const fixture = await setupFixtureVault(
      new Map([
        [
          TEST_TICK_COLLECTOR_ID,
          {
            readsPaths: ['/tmp/test'],
            defaultEnabled: false,
          },
        ],
      ]),
    );
    cleanup = fixture.cleanup;
    const harness = await bootHarness(fixture.vaultRoot, {
      // Force the gate to 'pending' (i.e. not 'granted') so every
      // line quarantines under reason 'privacy-gate-denied'.
      resolveGate: () => 'pending',
    });
    try {
      await writeTickBatch(50, { vaultRoot: fixture.vaultRoot });
      await harness.framework.waitIdle();
      await new Promise((resolve) => setTimeout(resolve, 250));
      await harness.framework.waitIdle();

      // No Class A events.
      expect(harness.classA).toHaveLength(0);
      // 50 quarantine entries with privacy-gate-denied.
      const quarantine = await readQuarantineFiles(fixture.vaultRoot);
      expect(quarantine).toHaveLength(50);
      expect(quarantine.every((q) => q.reason === 'privacy-gate-denied')).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('#4 (b): grant flips replay → quarantine drains, Class A receives lines', async () => {
    const fixture = await setupFixtureVault(
      new Map([
        [
          TEST_TICK_COLLECTOR_ID,
          {
            readsPaths: ['/tmp/test'],
            defaultEnabled: false,
          },
        ],
      ]),
    );
    cleanup = fixture.cleanup;

    // Phase 1: gate denied → quarantine.
    const phase1 = await bootHarness(fixture.vaultRoot, {
      resolveGate: () => 'pending',
    });
    try {
      await writeTickBatch(10, { vaultRoot: fixture.vaultRoot });
      await phase1.framework.waitIdle();
      await new Promise((resolve) => setTimeout(resolve, 250));
      await phase1.framework.waitIdle();
      const phase1Quarantine = await readQuarantineFiles(fixture.vaultRoot);
      expect(phase1Quarantine.length).toBeGreaterThanOrEqual(10);
    } finally {
      await phase1.close();
    }

    // Phase 2: gate granted → replay-on-startup promotes the queued lines.
    const phase2 = await bootHarness(fixture.vaultRoot, {
      resolveGate: () => 'granted',
    });
    try {
      // Replay-on-startup runs synchronously inside bootCollectorFramework,
      // but waitIdle drains any tail-loop work that follows.
      await phase2.framework.waitIdle();
      // At least 10 events promoted via replay.
      expect(phase2.classA.length).toBeGreaterThanOrEqual(10);
      const replayPromoteRoutes = phase2.audits.filter(
        (a) => a.route === 'collector:line-promoted',
      );
      expect(replayPromoteRoutes.length).toBeGreaterThanOrEqual(10);
    } finally {
      await phase2.close();
    }
  });

  it('#6: two collectors with colliding event_type → distinct ruleIds', async () => {
    const idA = 'sidetrack.test-tick-a';
    const idB = 'sidetrack.test-tick-b';
    const fixture = await setupFixtureVault(
      new Map([
        [idA, {}],
        [idB, {}],
      ]),
    );
    cleanup = fixture.cleanup;

    // Both collectors register against the SAME test-tick materializer
    // (event_type='tick', payload_version=1). The framework's
    // built-in registration is keyed on (collector_id, event_type,
    // payload_version), but the test-tick built-in only knows about
    // 'sidetrack.test-tick'. We register the two manifest ids by
    // injecting via extraMaterializers.
    const harness = await bootHarness(fixture.vaultRoot, {
      extraMaterializers: [
        (registry: MaterializerRegistry) => {
          for (const collectorId of [idA, idB]) {
            registry.register<{ tick_index: number }, unknown>({
              collector_id: collectorId,
              event_type: 'tick',
              current_payload_version: 1,
              versions: new Map([[1, { status: 'current' }]]),
              validate: (latest: unknown) => latest as { tick_index: number },
              toClassA: (latest: { tick_index: number }, env: CollectorEvent) => [
                {
                  type: 'coding.tick.observed',
                  payloadVersion: 1,
                  emittedAt: env.emitted_at,
                  tickIndex: latest.tick_index,
                  producedBy: {
                    kind: 'collector',
                    ruleId: `${env.collector_id}:${env.event_type}`,
                    ruleVersion: env.collector_version,
                    runId: env.collector_run_id,
                  },
                },
              ],
            });
          }
        },
      ],
    });
    try {
      // Re-issue the manifest discovery by triggering the discovery's
      // initial scan which already happened in bootCollectorFramework
      // — the per-collector tail starts via onLoaded. Wait briefly.
      await new Promise((resolve) => setTimeout(resolve, 100));
      await writeTickBatch(5, { vaultRoot: fixture.vaultRoot, collectorId: idA });
      await writeTickBatch(5, { vaultRoot: fixture.vaultRoot, collectorId: idB });
      await harness.framework.waitIdle();
      await new Promise((resolve) => setTimeout(resolve, 300));
      await harness.framework.waitIdle();

      // 5 + 5 = 10 promoted events.
      expect(harness.classA.length).toBeGreaterThanOrEqual(10);
      // Two distinct ruleIds.
      const ruleIds = new Set(harness.classA.map((c) => c.ruleId));
      expect(ruleIds.has(`${idA}:tick`)).toBe(true);
      expect(ruleIds.has(`${idB}:tick`)).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('malformed line → deterministically quarantined with materializer-validation-failed', async () => {
    const fixture = await setupFixtureVault(new Map([[TEST_TICK_COLLECTOR_ID, {}]]));
    cleanup = fixture.cleanup;
    const harness = await bootHarness(fixture.vaultRoot);
    try {
      // Write a hand-crafted JSONL file with one valid line + one
      // malformed (not parseable as JSON).
      const inboxFile = join(
        fixture.vaultRoot,
        '_BAC',
        'inbox',
        TEST_TICK_COLLECTOR_ID,
        `${new Date().toISOString().slice(0, 10)}.jsonl`,
      );
      await mkdir(join(inboxFile, '..'), { recursive: true });
      const valid = JSON.stringify({
        collector_id: TEST_TICK_COLLECTOR_ID,
        event_type: 'tick',
        payload_version: 1,
        emitted_at: new Date().toISOString(),
        collector_version: '0.1.0',
        collector_run_id: 'run-mal-1',
        source_record_id: 'run-mal-1:00000000',
        payload: { tick_index: 0 },
      });
      const malformed = '{this-is-not-json}';
      await writeFile(inboxFile, `${valid}\n${malformed}\n`, 'utf8');

      await harness.framework.waitIdle();
      await new Promise((resolve) => setTimeout(resolve, 300));
      await harness.framework.waitIdle();

      // Valid line promoted.
      expect(harness.classA.length).toBeGreaterThanOrEqual(1);
      // Malformed line quarantined with the canonical reason.
      const quarantine = await readQuarantineFiles(fixture.vaultRoot);
      expect(quarantine.length).toBeGreaterThanOrEqual(1);
      expect(quarantine.some((q) => q.reason === 'materializer-validation-failed')).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('Patch 2: two lines with identical emitted_at + runId but distinct source_record_id both promote', async () => {
    // Drives the source_record_id-first idempotency rule: a
    // collector batching two events within the same millisecond +
    // same run must still produce two distinct Class A entries.
    // Earlier signature (event, ruleId) only had emittedAt + runId
    // to derive a clientEventId — those collide here. The new
    // (event, ruleId, line) signature uses line.source_record_id as
    // the primary key.
    const fixture = await setupFixtureVault(new Map([[TEST_TICK_COLLECTOR_ID, {}]]));
    cleanup = fixture.cleanup;
    const harness = await bootHarness(fixture.vaultRoot);
    try {
      // Hand-write a JSONL file with two lines that share
      // emitted_at AND collector_run_id but differ in source_record_id.
      // The fixture writer emits monotonically-incrementing
      // emitted_at values so we bypass it.
      const inboxFile = join(
        fixture.vaultRoot,
        '_BAC',
        'inbox',
        TEST_TICK_COLLECTOR_ID,
        `${new Date().toISOString().slice(0, 10)}.jsonl`,
      );
      await mkdir(join(inboxFile, '..'), { recursive: true });
      const sharedEmittedAt = new Date('2026-05-08T12:00:00.000Z').toISOString();
      const sharedRunId = 'shared-run-id-01';
      const lineA = JSON.stringify({
        collector_id: TEST_TICK_COLLECTOR_ID,
        event_type: 'tick',
        payload_version: 1,
        emitted_at: sharedEmittedAt,
        collector_version: '0.1.0',
        collector_run_id: sharedRunId,
        source_record_id: `${sharedRunId}:00000000`,
        payload: { tick_index: 0 },
      });
      const lineB = JSON.stringify({
        collector_id: TEST_TICK_COLLECTOR_ID,
        event_type: 'tick',
        payload_version: 1,
        emitted_at: sharedEmittedAt,
        collector_version: '0.1.0',
        collector_run_id: sharedRunId,
        source_record_id: `${sharedRunId}:00000001`,
        payload: { tick_index: 1 },
      });
      await writeFile(inboxFile, `${lineA}\n${lineB}\n`, 'utf8');

      await harness.framework.waitIdle();
      await new Promise((resolve) => setTimeout(resolve, 250));
      await harness.framework.waitIdle();

      // Both lines must have surfaced in classA.
      expect(harness.classA).toHaveLength(2);
      // Source record ids on the captured line objects must differ.
      const sourceIds = harness.classA.map((c) => c.line.source_record_id);
      expect(new Set(sourceIds).size).toBe(2);
      // 0 quarantines.
      const quarantine = await readQuarantineFiles(fixture.vaultRoot);
      expect(quarantine).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it('Patch 2 fallback: two lines WITHOUT source_record_id, identical envelope, distinct payload → both promote', async () => {
    // Earlier the fallback clientEventId hashed only
    // (ruleId + emittedAt + runId + type). Two lines sharing the
    // entire envelope but carrying distinct payloads collided to
    // the same id and only one would promote. The fix hashes the
    // FULL CollectorEvent line (envelope + payload + dimensions),
    // so distinct payloads always produce distinct ids.
    //
    // bootHarness here uses the capture adapter (not production
    // eventLog) — so we register a custom appendClassA that mirrors
    // the production formula and asserts the fallback ids differ.
    const fixture = await setupFixtureVault(new Map([[TEST_TICK_COLLECTOR_ID, {}]]));
    cleanup = fixture.cleanup;
    const { createHash } = await import('node:crypto');
    const fallbackClientEventId = (ruleId: string, line: CollectorEvent): string => {
      if (line.source_record_id !== undefined && line.source_record_id.length > 0) {
        return `collector:${ruleId}:${line.source_record_id}`;
      }
      const lineDigest = createHash('sha256')
        .update(
          JSON.stringify({
            collector_id: line.collector_id,
            event_type: line.event_type,
            payload_version: line.payload_version,
            emitted_at: line.emitted_at,
            collector_version: line.collector_version,
            collector_run_id: line.collector_run_id,
            payload: line.payload,
            dimensions: line.dimensions,
          }),
          'utf8',
        )
        .digest('hex')
        .slice(0, 24);
      return `collector:${ruleId}:fallback:${lineDigest}`;
    };

    const fallbackIds = new Set<string>();
    let collisionCount = 0;
    const capturedClassA: CapturedClassA[] = [];
    const harness = await bootHarness(fixture.vaultRoot, {
      appendClassA: async (event: unknown, ruleId: string, line: CollectorEvent) => {
        const id = fallbackClientEventId(ruleId, line);
        if (fallbackIds.has(id)) {
          collisionCount += 1;
        }
        fallbackIds.add(id);
        capturedClassA.push({ event, ruleId, line });
      },
    });
    try {
      const inboxFile = join(
        fixture.vaultRoot,
        '_BAC',
        'inbox',
        TEST_TICK_COLLECTOR_ID,
        `${new Date().toISOString().slice(0, 10)}.jsonl`,
      );
      await mkdir(join(inboxFile, '..'), { recursive: true });
      const sharedEmittedAt = new Date('2026-05-08T12:30:00.000Z').toISOString();
      const sharedRunId = 'no-source-record-run';
      // Two lines: NO source_record_id, identical envelope, distinct payload.
      const lineA = JSON.stringify({
        collector_id: TEST_TICK_COLLECTOR_ID,
        event_type: 'tick',
        payload_version: 1,
        emitted_at: sharedEmittedAt,
        collector_version: '0.1.0',
        collector_run_id: sharedRunId,
        payload: { tick_index: 100, message: 'first' },
      });
      const lineB = JSON.stringify({
        collector_id: TEST_TICK_COLLECTOR_ID,
        event_type: 'tick',
        payload_version: 1,
        emitted_at: sharedEmittedAt,
        collector_version: '0.1.0',
        collector_run_id: sharedRunId,
        payload: { tick_index: 101, message: 'second' },
      });
      await writeFile(inboxFile, `${lineA}\n${lineB}\n`, 'utf8');

      await harness.framework.waitIdle();
      await new Promise((resolve) => setTimeout(resolve, 250));
      await harness.framework.waitIdle();

      // Both lines must promote.
      expect(capturedClassA).toHaveLength(2);
      // The fallback clientEventIds must differ (no collisions).
      expect(fallbackIds.size).toBe(2);
      expect(collisionCount).toBe(0);
      // Sanity: distinct payloads landed.
      const payloads = capturedClassA.map(
        (c) => (c.line.payload as { tick_index?: number }).tick_index,
      );
      expect(new Set(payloads)).toEqual(new Set([100, 101]));
    } finally {
      await harness.close();
    }
  });

  it('Blocker 3: discovery boots empty, then manifest+inbox dropped post-boot → tail starts and promotes', async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-stage4-spine-'));
    cleanup = () => rm(vaultRoot, { recursive: true, force: true });
    await mkdir(join(vaultRoot, '_BAC', 'events'), { recursive: true });
    await mkdir(join(vaultRoot, '_BAC', 'audit'), { recursive: true });
    await mkdir(join(vaultRoot, '_BAC', '.config'), { recursive: true });

    // Boot framework with NO collectors.
    const harness = await bootHarness(vaultRoot);
    try {
      expect(harness.framework.loadedCollectors()).toHaveLength(0);

      // Drop a manifest after boot — discovery's fs.watch + onLoaded
      // callback should start a tail loop within the debounce window
      // (200 ms).
      const manifestDir = join(vaultRoot, '_BAC', 'collectors', TEST_TICK_COLLECTOR_ID);
      await mkdir(manifestDir, { recursive: true });
      await writeFile(
        join(manifestDir, 'collector.toml'),
        renderTestTickManifest({ id: TEST_TICK_COLLECTOR_ID }),
        'utf8',
      );

      // Wait for fs.watch debounce + manifest-load + onLoaded fire.
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Now write a line.
      await writeTickBatch(3, { vaultRoot });
      await harness.framework.waitIdle();
      await new Promise((resolve) => setTimeout(resolve, 300));
      await harness.framework.waitIdle();

      // Assert promotion happened despite the post-boot discovery.
      expect(harness.classA.length).toBeGreaterThanOrEqual(3);
    } finally {
      await harness.close();
    }
  });
});
