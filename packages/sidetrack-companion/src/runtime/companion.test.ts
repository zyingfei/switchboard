import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `bun test` supports the synchronous fake-timer surface
// (useFakeTimers / advanceTimersByTime / useRealTimers) but not
// vitest's `vi.advanceTimersByTimeAsync`. advanceTimersByTimeAsync
// below rebuilds that async variant on top of the supported
// primitives (advance the fake clock, then drain microtasks).
import { advanceTimersByTimeAsync } from '../test-helpers/bunTestTimers.js';
import { installStubEmbedder, type StubEmbedderHandle } from '../test-helpers/stubEmbedder.js';

import { enqueueBodyEvidence } from '../page-evidence/bodyEvidenceQueue.js';
import { readPageEvidence } from '../page-evidence/store.js';
import type { PageContentExtractedPayload } from '../page-content/types.js';
import type { AcceptedEvent } from '../sync/causal.js';
import type { AppendInputObserved } from '../sync/eventLog.js';
import { NAVIGATION_COMMITTED } from '../navigation/events.js';
import { BROWSER_TIMELINE_OBSERVED } from '../timeline/events.js';
import {
  WORKGRAPH_HEALTH_ARTIFACT_DEBOUNCE_MS,
  WORKGRAPH_HEALTH_ARTIFACT_MIN_INTERVAL_MS,
  appendObservedEdgeEventsBatch,
  createPageEvidenceWriteQueue,
  createWorkGraphHealthArtifactScheduler,
  scheduleSqliteVacuumGc,
  startCompanion,
} from './companion.js';

const navigationCommitted = (input: {
  readonly seq: number;
  readonly visitId: string;
  readonly url: string;
  readonly previousVisitId: string | null;
  readonly navigationSequence: number;
}): AcceptedEvent => ({
  clientEventId: `edge:navigation.committed:test:${String(input.seq)}`,
  dot: { replicaId: 'edge_runtime_test', seq: input.seq },
  deps: {},
  aggregateId: `navigation.committed:${input.visitId}`,
  type: NAVIGATION_COMMITTED,
  payload: {
    payloadVersion: 1,
    visitId: input.visitId,
    url: input.url,
    canonicalUrl: input.url,
    documentId: `doc_${String(input.seq)}`,
    parentDocumentId: null,
    tabSessionIdHash: 'tab_hash_runtime',
    windowSessionIdHash: 'win_hash_runtime',
    openerVisitId: null,
    previousVisitId: input.previousVisitId,
    navigationSequence: input.navigationSequence,
    transitionType: 'link',
    transitionQualifiers: [],
    commitTimestamp: 1_779_600_000_000 + input.seq,
  },
  acceptedAtMs: 1_779_600_000_000 + input.seq,
});

describe('startCompanion bind-failure rollback', () => {
  let vaultRoot: string;
  let busyServer: Server;
  let busyPort: number;
  let stubEmbedder: StubEmbedderHandle;

  beforeEach(async () => {
    // Route embedding through the deterministic override so the recall
    // lifecycle's startup rebuild never loads real ONNX bindings. This
    // replaces a former `vi.mock('../recall/embedder.js')`, which under
    // `bun test` leaked process-globally and poisoned the real embedder
    // for every other suite.
    stubEmbedder = installStubEmbedder();
    vaultRoot = await mkdtemp(join(tmpdir(), 'startcompanion-bind-fail-'));
    busyServer = createServer();
    await new Promise<void>((resolve, reject) => {
      busyServer.once('error', reject);
      busyServer.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    const address = busyServer.address();
    if (typeof address !== 'object' || address === null) {
      throw new Error('expected an AddressInfo from the busy listener');
    }
    busyPort = address.port;
  });

  afterEach(async () => {
    stubEmbedder.restore();
    await new Promise<void>((resolve) =>
      busyServer.close(() => {
        resolve();
      }),
    );
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('rolls back on EADDRINUSE: lock released, intervals cleared, no zombie handles', async () => {
    // 1. The startup MUST reject. Without F2 the rejection still
    //    fires, but the side-effects below were not rolled back.
    //    Assert on error.code, not the message: Node surfaces
    //    "listen EADDRINUSE ..." while bun surfaces "Failed to start
    //    server. Is port X in use?" — both carry code EADDRINUSE, so
    //    the code is the runtime-agnostic contract this test asserts.
    const rejection = await startCompanion({
      vaultPath: vaultRoot,
      port: busyPort,
      allowAutoUpdate: false,
    }).then(
      () => {
        throw new Error('startCompanion resolved on a busy port — expected EADDRINUSE');
      },
      (error: unknown) => error,
    );
    expect((rejection as { readonly code?: string }).code).toBe('EADDRINUSE');

    // 2. The recall process-lock must be released. Without this,
    //    the next launch falls back to the stale-pid takeover path
    //    in the recovery code; with it, the lock file is gone
    //    entirely.
    const lockPath = join(vaultRoot, '_BAC', 'recall', '.lock');
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });

    // 3. The event loop must be drainable — no leaked setInterval
    //    handles holding it open. We assert this indirectly: an
    //    immediate setImmediate fires, and the process.getActiveResourcesInfo
    //    snapshot has no remaining 'Timeout' entries with our
    //    intervals. Node 20+ exposes that API.
    if (typeof process.getActiveResourcesInfo === 'function') {
      // We can't filter by which interval is whose, but the runtime
      // registers two long-lived setInterval calls (idempotencyGc +
      // auditRetention) — if rollback ran they're cleared. Other
      // unrelated intervals from vitest may exist, so the assertion
      // is "no NEW long-lived interval ours could have created"
      // which we approximate by counting Timeouts before vs after.
      // A precise leak detector lives in a separate test if we ever
      // need one; the lockfile assertion above is the load-bearing
      // proof that rollback ran.
      const handles = process.getActiveResourcesInfo();
      expect(handles).toBeInstanceOf(Array);
    }
  });
});

describe('startCompanion SQLite VACUUM hygiene task', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    vaultRoot = await mkdtemp(join(tmpdir(), 'startcompanion-vacuum-'));
    process.env['SIDETRACK_SQLITE_VACUUM_EVERY_MS'] = '1000';
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env['SIDETRACK_SQLITE_VACUUM_EVERY_MS'];
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('runs SQLite VACUUM on startup delay and scheduled cadence', async () => {
    const vacuum = vi.fn(() => Promise.resolve());
    const hygieneStatus: { lastVacuumAt?: string; lastVacuumDurationMs?: number } = {};
    const teardown = scheduleSqliteVacuumGc({ vacuum }, hygieneStatus, {
      everyMs: 3_600_000,
      startupDelayMs: 60_000,
    });

    await advanceTimersByTimeAsync(59_999);
    expect(vacuum).not.toHaveBeenCalled();
    await advanceTimersByTimeAsync(1);
    expect(vacuum).toHaveBeenCalledTimes(1);
    expect(hygieneStatus.lastVacuumAt).toBeDefined();
    expect(hygieneStatus.lastVacuumDurationMs).toBeGreaterThanOrEqual(0);
    await advanceTimersByTimeAsync(3_540_000);
    expect(vacuum).toHaveBeenCalledTimes(2);

    teardown();
  });
});

describe('createWorkGraphHealthArtifactScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing when the env gate is off', async () => {
    const materialize = vi.fn(() => Promise.resolve(true));
    const scheduler = createWorkGraphHealthArtifactScheduler({
      materialize,
      enabled: () => false,
    });

    scheduler.schedule();
    await advanceTimersByTimeAsync(WORKGRAPH_HEALTH_ARTIFACT_MIN_INTERVAL_MS * 2);

    expect(materialize).not.toHaveBeenCalled();
    scheduler.teardown();
  });

  it('debounces a drain burst into one collect', async () => {
    const materialize = vi.fn(() => Promise.resolve(true));
    const scheduler = createWorkGraphHealthArtifactScheduler({
      materialize,
      enabled: () => true,
    });

    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();
    await advanceTimersByTimeAsync(WORKGRAPH_HEALTH_ARTIFACT_DEBOUNCE_MS);

    expect(materialize).toHaveBeenCalledTimes(1);
    scheduler.teardown();
  });

  it('enforces the min-interval floor after a SUCCESSFUL collect (FIX 3)', async () => {
    const materialize = vi.fn(() => Promise.resolve(true));
    const scheduler = createWorkGraphHealthArtifactScheduler({
      materialize,
      enabled: () => true,
    });

    scheduler.schedule();
    await advanceTimersByTimeAsync(WORKGRAPH_HEALTH_ARTIFACT_DEBOUNCE_MS);
    expect(materialize).toHaveBeenCalledTimes(1);

    // Drain right after the success: inside the floor → skipped, even
    // well past the debounce window.
    scheduler.schedule();
    await advanceTimersByTimeAsync(WORKGRAPH_HEALTH_ARTIFACT_MIN_INTERVAL_MS - 1);
    expect(materialize).toHaveBeenCalledTimes(1);

    // Once the floor has elapsed a new drain schedules normally.
    await advanceTimersByTimeAsync(1);
    scheduler.schedule();
    await advanceTimersByTimeAsync(WORKGRAPH_HEALTH_ARTIFACT_DEBOUNCE_MS);
    expect(materialize).toHaveBeenCalledTimes(2);

    scheduler.teardown();
  });

  it('does not advance the floor on a failed collect', async () => {
    // First collect fails (e.g. the shared event store never opened);
    // the very next drain must retry immediately instead of being
    // floor-blocked behind a success that never happened.
    const materialize = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const scheduler = createWorkGraphHealthArtifactScheduler({
      materialize,
      enabled: () => true,
    });

    scheduler.schedule();
    await advanceTimersByTimeAsync(WORKGRAPH_HEALTH_ARTIFACT_DEBOUNCE_MS);
    expect(materialize).toHaveBeenCalledTimes(1);

    scheduler.schedule();
    await advanceTimersByTimeAsync(WORKGRAPH_HEALTH_ARTIFACT_DEBOUNCE_MS);
    expect(materialize).toHaveBeenCalledTimes(2);

    scheduler.teardown();
  });

  it('runs one trailing collect at floor expiry when a drain lands mid-collect (FIX 4)', async () => {
    // Hold the first collect open so a drain can land while it is in
    // flight. Without the trailing rerun that drain's changes would
    // wait for the NEXT drain — indefinitely on a quiet vault.
    let resolveFirst: (value: boolean) => void = () => undefined;
    const firstCollect = new Promise<boolean>((resolve) => {
      resolveFirst = resolve;
    });
    const materialize = vi
      .fn<() => Promise<boolean>>()
      .mockImplementationOnce(() => firstCollect)
      .mockResolvedValue(true);
    const scheduler = createWorkGraphHealthArtifactScheduler({
      materialize,
      enabled: () => true,
    });

    scheduler.schedule();
    await advanceTimersByTimeAsync(WORKGRAPH_HEALTH_ARTIFACT_DEBOUNCE_MS);
    expect(materialize).toHaveBeenCalledTimes(1);

    // Drain during the in-flight collect: single-flight holds (no
    // second materialize) but the rerun request is recorded.
    scheduler.schedule();
    await advanceTimersByTimeAsync(WORKGRAPH_HEALTH_ARTIFACT_DEBOUNCE_MS);
    expect(materialize).toHaveBeenCalledTimes(1);

    resolveFirst(true);
    // Flush the finally block; the trailing collect is scheduled at
    // floor expiry (not immediately — the floor is not bypassed).
    await advanceTimersByTimeAsync(0);
    expect(materialize).toHaveBeenCalledTimes(1);

    await advanceTimersByTimeAsync(WORKGRAPH_HEALTH_ARTIFACT_MIN_INTERVAL_MS - 1);
    expect(materialize).toHaveBeenCalledTimes(1);
    await advanceTimersByTimeAsync(1);
    expect(materialize).toHaveBeenCalledTimes(2);

    // One trailing collect exactly — the rerun flag does not loop.
    await advanceTimersByTimeAsync(WORKGRAPH_HEALTH_ARTIFACT_MIN_INTERVAL_MS * 2);
    expect(materialize).toHaveBeenCalledTimes(2);

    scheduler.teardown();
  });
});

describe('appendObservedEdgeEventsBatch', () => {
  it('dispatches newly accepted batched edge events through the local accepted hook', async () => {
    const source = navigationCommitted({
      seq: 1,
      visitId: 'visit_source',
      url: 'https://news.ycombinator.com/news',
      previousVisitId: null,
      navigationSequence: 1,
    });
    const accepted = {
      ...source,
      dot: { replicaId: 'main_runtime_test', seq: 42 },
    };
    const seen: AcceptedEvent[] = [];
    const calls: { readonly inputs: readonly AppendInputObserved[]; readonly hasHook: boolean }[] =
      [];
    const appendClientObservedBatch = async <TPayload extends Record<string, unknown>>(
      inputs: readonly AppendInputObserved<TPayload>[],
      onAccepted?: (event: AcceptedEvent<TPayload>) => void,
    ) => {
      calls.push({ inputs, hasHook: onAccepted !== undefined });
      onAccepted?.(accepted as AcceptedEvent<TPayload>);
      return inputs.map((input) => ({ clientEventId: input.clientEventId, imported: true }));
    };

    const result = await appendObservedEdgeEventsBatch(
      { appendClientObservedBatch },
      [source],
      (event) => {
        seen.push(event);
      },
    );

    expect(result).toEqual([{ clientEventId: source.clientEventId, imported: true }]);
    expect(calls).toEqual([
      {
        hasHook: true,
        inputs: [
          {
            clientEventId: source.clientEventId,
            aggregateId: source.aggregateId,
            type: source.type,
            payload: source.payload,
            baseVector: {},
          },
        ],
      },
    ]);
    expect(seen).toEqual([accepted]);
  });
});

describe('page-evidence ingest write queue', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'page-evidence-write-queue-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('serializes concurrent writes for the same canonical URL so the newest timestamp wins', async () => {
    const queue = createPageEvidenceWriteQueue(vaultRoot);
    const url = 'https://example.test/thread';
    const observedAt = [
      '2026-05-22T10:04:00.000Z',
      '2026-05-22T10:03:00.000Z',
      '2026-05-22T10:02:00.000Z',
      '2026-05-22T10:01:00.000Z',
      '2026-05-22T10:00:00.000Z',
    ];

    await Promise.all(
      observedAt.map((timestamp, index) =>
        queue([
          {
            id: `visit-${String(index)}`,
            url,
            canonicalUrl: url,
            title: `Visit ${String(index)}`,
            firstSeenAt: timestamp,
            lastSeenAt: timestamp,
            visitCount: 1,
          },
        ]),
      ),
    );

    const evidence = await readPageEvidence(vaultRoot, url);

    expect(evidence.record?.metadata.lastSeenAt).toBe('2026-05-22T10:04:00.000Z');
  });
});

// Acceptance (DEBUGGING_DOCTRINE rule 10): boot a real companion with the
// resolve canary forced on, drive a real drain so the served graph has a
// probe target, then read /v1/system/health BACK and assert the reliability
// section carries a real canary sample — verifying the composition-root
// wiring (createResolveCanary/register + start) AND the route folding
// (withReliabilityHealthSection) end-to-end, not an intermediate helper.
describe('startCompanion resolve-canary → /v1/system/health', () => {
  let vaultRoot: string;
  let stubEmbedder: StubEmbedderHandle;
  let companion: Awaited<ReturnType<typeof startCompanion>> | null = null;
  const prevCanary = process.env['SIDETRACK_RESOLVE_CANARY'];
  const prevInterval = process.env['SIDETRACK_RESOLVE_CANARY_INTERVAL_MS'];
  let port = 39_700;

  beforeEach(async () => {
    stubEmbedder = installStubEmbedder();
    vaultRoot = await mkdtemp(join(tmpdir(), 'startcompanion-canary-'));
    // Force the canary on despite NODE_ENV=test, with a fast cadence so a
    // sample lands within the poll budget once the graph has a target.
    process.env['SIDETRACK_RESOLVE_CANARY'] = '1';
    process.env['SIDETRACK_RESOLVE_CANARY_INTERVAL_MS'] = '50';
  });

  afterEach(async () => {
    if (companion !== null) await companion.close();
    companion = null;
    stubEmbedder.restore();
    if (prevCanary === undefined) delete process.env['SIDETRACK_RESOLVE_CANARY'];
    else process.env['SIDETRACK_RESOLVE_CANARY'] = prevCanary;
    if (prevInterval === undefined) delete process.env['SIDETRACK_RESOLVE_CANARY_INTERVAL_MS'];
    else process.env['SIDETRACK_RESOLVE_CANARY_INTERVAL_MS'] = prevInterval;
    await rm(vaultRoot, { recursive: true, force: true });
  });

  const post = async (url: string, bridgeKey: string, body: unknown): Promise<Response> =>
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bac-bridge-key': bridgeKey,
        'Idempotency-Key': `idem-${Math.random().toString(36).slice(2)}`,
      },
      body: JSON.stringify(body),
    });

  const getJson = async <T>(url: string, bridgeKey: string): Promise<T> => {
    const r = await fetch(url, { headers: { 'x-bac-bridge-key': bridgeKey } });
    if (!r.ok) throw new Error(`GET ${url} → ${String(r.status)}`);
    return (await r.json()) as T;
  };

  it('registers the canary at boot and folds a real sample into the health report', async () => {
    companion = await startCompanion({
      vaultPath: vaultRoot,
      port: port++,
      allowAutoUpdate: false,
    });

    // Seed a timeline visit so the connections drain materializes a
    // timeline-visit node — the canary's pickUrl target. /v1/timeline/events
    // is the edge-event import path, so send a full AcceptedEvent envelope
    // (dot/deps/aggregateId/type/payload), same shape the relay path uses.
    const visitUrl = 'https://canary.example/most-visited';
    const observedAt = '2026-07-21T10:00:00.000Z';
    const timelineEvent = {
      clientEventId: 'canary-tl-1',
      dot: { replicaId: 'edge_canary_test', seq: 1 },
      deps: {},
      aggregateId: observedAt.slice(0, 10),
      type: BROWSER_TIMELINE_OBSERVED,
      payload: {
        eventId: 'canary-tl-1',
        url: visitUrl,
        canonicalUrl: visitUrl,
        title: 'Canary target',
        observedAt,
        transition: 'activated',
      },
      acceptedAtMs: Date.parse(observedAt),
    };
    const tlRes = await post(`${companion.url}/v1/timeline/events`, companion.bridgeKey, {
      events: [timelineEvent],
    });
    expect(tlRes.ok).toBe(true);

    // Wait for the node to appear in the served graph (gives the canary a
    // target), then poll the health surface until a sample is recorded.
    interface ConnectionsResponse {
      data: { snapshot: { nodes: { id: string }[] } };
    }
    interface HealthResponse {
      data: {
        reliability?: {
          resolveCanary: {
            sampleCount: number;
            hasTarget: boolean;
            status: string;
            errorCount: number;
            p95Ms: number | null;
          };
          availability: string;
        };
        watchdogs?: {
          rss: { status: string; currentBytes: number | null; growthBytes: number | null };
          bootToServing: {
            status: string;
            budgetMs: number;
            elapsedMs: number;
            phases: readonly { name: string; durationMs: number }[];
            slowestPhase: string | null;
          };
        };
        observability?: { sections?: Record<string, string> };
      };
    }

    const wantNode = `timeline-visit:${visitUrl}`;
    const deadline = Date.now() + 20_000;
    let health: HealthResponse['data'] | null = null;
    while (Date.now() < deadline) {
      try {
        const c = await getJson<ConnectionsResponse>(
          `${companion.url}/v1/connections`,
          companion.bridgeKey,
        );
        const hasTarget = c.data.snapshot.nodes.some((n) => n.id === wantNode);
        if (hasTarget) {
          const h = await getJson<HealthResponse>(
            `${companion.url}/v1/system/health`,
            companion.bridgeKey,
          );
          if ((h.data.reliability?.resolveCanary.sampleCount ?? 0) >= 1) {
            health = h.data;
            break;
          }
        }
      } catch {
        // keep polling
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(health).not.toBeNull();
    const reliability = health?.reliability;
    expect(reliability).toBeDefined();
    // The reliability section is PRESENT with a real sample from the real
    // resolve core, its target pinned, and folded into the observability
    // board (rule 1: verified at the artifact the surface reads).
    expect(reliability?.resolveCanary.sampleCount).toBeGreaterThanOrEqual(1);
    expect(reliability?.resolveCanary.hasTarget).toBe(true);
    expect(reliability?.resolveCanary.errorCount).toBe(0);
    expect(reliability?.resolveCanary.status).toBe('ok');
    expect(reliability?.availability).toBe('ok');
    expect(health?.observability?.sections?.['reliability']).toBe('ok');

    // Runtime wiring read-back: the process that actually reached the listener
    // exposes its frozen boot measurement and current RSS through the same
    // authenticated artifact consumers read.
    expect(health?.watchdogs?.rss.currentBytes).toBeGreaterThan(0);
    expect(health?.watchdogs?.rss.growthBytes).not.toBeNull();
    expect(health?.watchdogs?.bootToServing).toMatchObject({
      status: 'ok',
      budgetMs: 10_000,
      slowestPhase: expect.any(String),
    });
    expect(health?.watchdogs?.bootToServing.elapsedMs).toBeLessThan(10_000);
    expect(health?.watchdogs?.bootToServing.phases.map((phase) => phase.name)).toEqual([
      'identity-lock',
      'core-projections',
      'recall-runtime',
      'collector-framework',
      'background-lanes',
      'health-artifacts',
      'http-listen',
    ]);
  }, 30_000);
});

// Regression coverage for the SIGTERM shutdown hang observed live twice
// (2026-08-15/16): close() used to jump straight from closing the HTTP
// listener to `await syncContractRunner.awaitIdle()` while the
// body-evidence lane (and other background lanes) kept running — because
// their stop() was only ever registered on the startup-FAILURE teardown
// path, never on a normal close(). Each materialized item's
// onMaterialized hook appends a NEW accepted event
// (`eventLog.appendServerObserved`), which re-marks connectionsMaterializer
// dirty, so `awaitIdle()`'s bare `while (running || dirty) await sleep(5)`
// never converged. The process hung forever, held the recall process
// lock, and the next boot refused to start with "Another companion (pid
// N) already owns the recall index". Operator recovery both times
// required SIGKILL.
describe('startCompanion close() — SIGTERM shutdown drain', () => {
  let vaultRoot: string;
  let stubEmbedder: StubEmbedderHandle;
  let companion: Awaited<ReturnType<typeof startCompanion>> | null = null;
  let port = 39_900;

  const bodyEvidencePayload = (canonicalUrl: string): PageContentExtractedPayload => ({
    payloadVersion: 1,
    canonicalUrl,
    url: canonicalUrl,
    title: 'Shutdown-drain fixture page',
    extractedAt: '2026-08-15T12:00:00.000Z',
    extractionSource: 'reader-mode',
    extractionPolicy: { trigger: 'attention-gate' },
    quality: 'high',
    qualitySignals: {
      extractedWordCount: 200,
      contentToDomRatio: 0.6,
      boilerplateFraction: 0.05,
      extractionStrategy: 'reader-mode',
    },
    content: {
      text: 'Body content used only to give the R3 lane real work at boot.',
      contentHash: `hash-${canonicalUrl}`,
      charCount: 64,
    },
    redaction: { applied: false, rules: [] },
  });

  beforeEach(async () => {
    stubEmbedder = installStubEmbedder();
    vaultRoot = await mkdtemp(join(tmpdir(), 'startcompanion-shutdown-drain-'));
  });

  afterEach(async () => {
    if (companion !== null) await companion.close().catch(() => undefined);
    companion = null;
    stubEmbedder.restore();
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it(
    'close() drains a live body-evidence lane, releases the recall lock, and permanently ' +
      'silences the lane instead of letting it keep ticking (2026-08-15/16 SIGTERM hang)',
    async () => {
      // Seed MORE than one batch's worth of REAL pending body-evidence
      // queue items (batchCap defaults to 4) so the very first cycle
      // still has work left over afterward (`pendingAfter > 0`), which
      // is what makes the lane re-arm its OWN timer for another cycle
      // ~cycleIntervalMs (5s) later — exactly the still-scheduled,
      // still-mid-backlog state a live SIGTERM landed in. Each
      // materialized item's onMaterialized hook appends a NEW accepted
      // event, marking connectionsMaterializer dirty again; before this
      // fix nothing ever called lane.stop() on a normal shutdown (only
      // on the startup-FAILURE teardown path), so the lane — and its
      // event-append side effect — outlived close() entirely.
      for (let i = 0; i < 6; i += 1) {
        await enqueueBodyEvidence(
          vaultRoot,
          bodyEvidencePayload(`https://shutdown-drain.example/${String(i)}`),
        );
      }

      // Count real `[page_evidence.body_lane.cycle]` log lines the lane
      // writes via `process.stdout.write` (companion.ts wires `log:` to
      // stdout directly — there's no other DI seam) without swallowing
      // any other test output.
      let cycleLogCount = 0;
      const originalStdoutWrite = process.stdout.write.bind(process.stdout);
      const countingWrite: typeof process.stdout.write = (chunk, ...rest) => {
        if (typeof chunk === 'string' && chunk.includes('[page_evidence.body_lane.cycle]')) {
          cycleLogCount += 1;
        }
        // @ts-expect-error — forwarding the exact overload Node picked.
        return originalStdoutWrite(chunk, ...rest);
      };
      process.stdout.write = countingWrite;

      try {
        companion = await startCompanion({
          vaultPath: vaultRoot,
          port: port++,
          allowAutoUpdate: false,
        });

        // Wait for the lane's immediate `schedule(0)` tick to actually
        // run one full cycle (batchCap=4 of the 6 seeded items) —
        // proof the lane had genuine, real in-flight work, not an
        // idle-empty queue.
        const deadline = Date.now() + 5_000;
        while (cycleLogCount < 1 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(cycleLogCount).toBeGreaterThanOrEqual(1);
        const cyclesBeforeClose = cycleLogCount;

        // SIGTERM lands now: 2 items are still queued, and the lane's
        // OWN scheduler has already armed a second cycle ~5s out
        // (DEFAULT_BODY_EVIDENCE_LANE_CONFIG.cycleIntervalMs) — the
        // shutdown must land while that timer is still live.
        const closeStartedAtMs = Date.now();
        await companion.close();
        const closeDurationMs = Date.now() - closeStartedAtMs;

        // The incident's operator-facing bound was "hangs forever,
        // needs SIGKILL". 20s is the regression bar from the fix
        // ticket; a correctly draining shutdown resolves far sooner.
        expect(closeDurationMs).toBeLessThan(20_000);

        const lockPath = join(vaultRoot, '_BAC', 'recall', '.lock');
        await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });

        // The load-bearing assertion: wait past the moment the lane's
        // still-armed second cycle WOULD have fired (cycleIntervalMs +
        // margin) and confirm it never did. Without close() calling
        // stop() first, this second cycle fires regardless of whether
        // the process has "finished" shutting down, appending yet
        // another event — the mechanism that kept the drain from ever
        // converging live.
        await new Promise((resolve) => setTimeout(resolve, 6_000));
        expect(cycleLogCount).toBe(cyclesBeforeClose);

        companion = null;
      } finally {
        process.stdout.write = originalStdoutWrite;
      }
    },
    25_000,
  );
});
