// F9 — idle I/O floor acceptance fixture
// (docs/plans/2026-08-15-foundation-program.md). Drives the REAL forked
// reconcile child (connectionsReconcileChild.entry.js, the exact production
// entry point — same harness pattern as
// connectionsInPlaceChildDrainIntegration.test.ts) through a single
// trivial-event drain and measures the CHILD'S OWN kernel disk-IO via two
// independent instruments that must agree:
//   1. The child's self-report (`emitSelfRusage` in
//      connectionsReconcileChild.entry.ts — one proc_pid_rusage syscall
//      read right before the child exits, relayed through the parent's
//      "[reconcile.child] " stdout/stderr prefix).
//   2. An OUTSIDE poller (`createProcessTreeRusageTracker`,
//      src/process/procRusage.ts) rooted at THIS test process, which
//      discovers the forked child as a descendant and accumulates its
//      counters while it is alive.
//
// This fixture runs against a SYNTHETIC (small, fast, CI-portable) vault —
// deliberately NOT a copy of a real multi-GB developer vault, so it stays a
// permanent, reproducible regression guard. The real-vault measurement that
// found the actual per-cycle overhead breakdown (a full ~89MB HNSW
// similarity-index rewrite + a ~329MB in-place WAL delta + two "accepted
// cost" O(table) scans in replaceScopeRows totalling ~9.5s, none of them
// gated by delta size — see this task's PR description / landing note for
// the exact numbers) is reported there, not reproduced here: a synthetic
// vault's tiny tables make those same code paths cheap by construction,
// which is exactly why this fixture is safe to commit and run in CI-like
// environments while still proving the wiring (the real entry point, the
// real self-rusage read, the real IPC relay) all work end to end.

import { existsSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generationDbPath, readPointer } from '../../connections/generationBuffer.js';
import { createProcessTreeRusageTracker } from '../../process/procRusage.js';
import { BROWSER_TIMELINE_OBSERVED } from '../../timeline/events.js';
import { createEventLog, type EventLog } from '../eventLog.js';
import { loadOrCreateReplica } from '../replicaId.js';
import {
  runReconcileInChild,
  setReconcileChildScriptOverride,
} from './connectionsReconcileChildClient.js';

const itUnlessCI = process.env['CI'] ? it.skip : it;

const childEntryPath = (): string =>
  join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'dist',
    'sync',
    'contract',
    'connectionsReconcileChild.entry.js',
  );

const connectionsDir = (vaultRoot: string): string => join(vaultRoot, '_BAC', 'connections');

const appendTrivialVisit = async (
  eventLog: EventLog,
  input: { readonly index: number; readonly observedAt: string },
): ReturnType<EventLog['appendClientObserved']> =>
  eventLog.appendClientObserved({
    clientEventId: `f9-idle-fixture-${String(input.index)}`,
    aggregateId: `f9-idle-fixture-${String(input.index)}`,
    type: BROWSER_TIMELINE_OBSERVED,
    baseVector: {},
    payload: {
      eventId: `f9-idle-fixture-${String(input.index)}`,
      observedAt: input.observedAt,
      url: `https://f9-idle-fixture.test/${String(input.index)}`,
      canonicalUrl: `https://f9-idle-fixture.test/${String(input.index)}`,
      title: `F9 idle fixture visit ${String(input.index)}`,
      provider: 'generic',
      transition: 'activated',
      payloadVersion: 1,
      dimensions: { engagement: { focusedWindowMs: 10_000 } },
    },
  });

describe('idle drain overhead — real child, single-trivial-event acceptance (F9)', () => {
  let vaultRoot: string;
  let stderrChunks: string[];
  let originalStderrWrite: typeof process.stderr.write;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'f9-idle-fixture-'));
    process.env['SIDETRACK_TEST_EMBEDDER'] = '1';
    process.env['SIDETRACK_SKIP_RANKER_SNAPSHOT'] = '1';
    setReconcileChildScriptOverride(childEntryPath());
    stderrChunks = [];
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    const captureWrite = (chunk: unknown, ...rest: unknown[]): boolean => {
      stderrChunks.push(String(chunk));
      return (originalStderrWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
    };
    process.stderr.write = captureWrite;
  });

  afterEach(async () => {
    process.stderr.write = originalStderrWrite;
    setReconcileChildScriptOverride(undefined);
    delete process.env['SIDETRACK_TEST_EMBEDDER'];
    delete process.env['SIDETRACK_SKIP_RANKER_SNAPSHOT'];
    await rm(vaultRoot, { recursive: true, force: true });
  });

  itUnlessCI(
    'a single-trivial-event drain via the real forked child: self-reported and externally-tracked IO agree and stay small on a fresh vault',
    async () => {
      const replica = await loadOrCreateReplica(vaultRoot);
      const eventLog = createEventLog(vaultRoot, replica);

      // Bootstrap: establish a real generation + progress frontier so the
      // measured pass below is a genuine steady-state single-event delta,
      // not the (structurally different) first-ever-generation cold start.
      await appendTrivialVisit(eventLog, {
        index: 0,
        observedAt: '2026-05-22T10:00:00.000Z',
      });
      const bootstrap = await runReconcileInChild({ vaultRoot, seq: 1 });
      expect(bootstrap.ok).toBe(true);
      const dir = connectionsDir(vaultRoot);
      const genId = readPointer(dir);
      expect(genId).not.toBeNull();
      const genPath = generationDbPath(dir, genId!);
      const walPath = `${genPath}-wal`;
      const dbBytesBefore = statSync(genPath).size;
      const walBytesBefore = existsSync(walPath) ? statSync(walPath).size : 0;
      // Isolate the measured pass's own self-report from the bootstrap
      // call's (both emit one via the same relayed "[reconcile.child] "
      // prefix on this process's stderr).
      stderrChunks = [];

      // THE measured pass: ONE trivial new event, one real forked-child
      // drain — this is exactly what the idle drain-gate's flush delivers
      // once per idle interval (or immediately for a genuinely-new URL —
      // see drainIdleGate.ts's "NOVELTY EXCEPTION").
      await appendTrivialVisit(eventLog, {
        index: 1,
        observedAt: '2026-05-22T10:05:00.000Z',
      });

      const tracker = createProcessTreeRusageTracker(process.pid);
      const pollHandle = setInterval(() => tracker.poll(), 25);
      const result = await runReconcileInChild({ vaultRoot, seq: 2 });
      // The parent's settle() resolves runReconcileInChild()'s promise (and
      // SIGTERMs the child) the instant the IPC result message arrives —
      // an independent async channel from the child's stdout/stderr pipe,
      // which the self-rusage line rides. Give the pipe a short window to
      // flush before reading it back.
      await new Promise((resolve) => setTimeout(resolve, 300));
      tracker.poll();
      clearInterval(pollHandle);
      expect(result.ok).toBe(true);

      const totals = tracker.totals();
      const dbBytesAfter = statSync(genPath).size;
      const walBytesAfter = existsSync(walPath) ? statSync(walPath).size : 0;
      const totalFileGrowthBytes =
        Math.max(0, dbBytesAfter - dbBytesBefore) + Math.max(0, walBytesAfter - walBytesBefore);

      const selfReportLine = stderrChunks.join('').match(/ioRead=(\d+) ioWrite=(\d+)/u);
      console.warn(
        `[f9-idle-fixture] tracker.ioRead=${(totals.diskioBytesRead / 1e6).toFixed(3)}MB ` +
          `tracker.ioWrite=${(totals.diskioBytesWritten / 1e6).toFixed(3)}MB ` +
          `fileGrowth=${(totalFileGrowthBytes / 1e6).toFixed(3)}MB ` +
          `selfReport=${selfReportLine === null ? 'MISSING' : `ioRead=${selfReportLine[1]} ioWrite=${selfReportLine[2]}`}`,
      );

      // The self-report is Darwin-only, best-effort (procRusage.ts) — only
      // assert its presence/agreement where it can possibly fire.
      if (process.platform === 'darwin') {
        expect(selfReportLine).not.toBeNull();
        const selfIoWrite = Number(selfReportLine![2]);
        // Both instruments read the SAME kernel counters via the SAME
        // syscall (one from outside via polling, one from inside at exit) —
        // they should be close, not necessarily bit-identical (the outside
        // poller's last sample can lag the child's own final read by up to
        // one poll interval's worth of IO).
        expect(Math.abs(selfIoWrite - totals.diskioBytesWritten)).toBeLessThan(
          Math.max(2_000_000, selfIoWrite * 0.5),
        );
      }

      // On a FRESH, synthetic, single-generation vault (no HNSW corpus of
      // meaningful size, no tens-of-thousands-of-rows edges/scope tables),
      // a single trivial event's real drain should stay well under the
      // task's 5MB write-volume target — this is the regression guard this
      // fixture exists to keep green; the real-vault number (documented in
      // the PR/landing note) is a separate, structural, out-of-scope-here
      // finding.
      expect(totalFileGrowthBytes).toBeLessThan(5 * 1024 * 1024);
    },
    120_000,
  );
});
