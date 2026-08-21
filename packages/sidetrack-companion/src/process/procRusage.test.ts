import { describe, expect, it } from 'vitest';

import {
  createProcessTreeRusageTracker,
  listDescendantPids,
  readOwnDiskIoRusage,
  readProcRusage,
} from './procRusage.js';

const isDarwin = process.platform === 'darwin';
const itDarwin = isDarwin ? it : it.skip;

describe('procRusage', () => {
  it('readProcRusage returns null (never throws) for a bogus pid on any platform', () => {
    expect(() => readProcRusage(-1)).not.toThrow();
    expect(readProcRusage(-1)).toBeNull();
  });

  it('readOwnDiskIoRusage never throws regardless of platform', () => {
    expect(() => readOwnDiskIoRusage()).not.toThrow();
  });

  it('listDescendantPids never throws and returns an array', () => {
    const result = listDescendantPids(process.pid);
    expect(Array.isArray(result)).toBe(true);
  });

  itDarwin('readOwnDiskIoRusage returns real non-negative counters on Darwin', () => {
    const sample = readOwnDiskIoRusage();
    expect(sample).not.toBeNull();
    if (sample === null) return;
    expect(sample.pid).toBe(process.pid);
    expect(sample.diskioBytesRead).toBeGreaterThanOrEqual(0);
    expect(sample.diskioBytesWritten).toBeGreaterThanOrEqual(0);
  });

  itDarwin('listDescendantPids finds a spawned child process', async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn('sleep', ['0.3'], { stdio: 'ignore' });
    // Give the OS a beat to register the new pid under ps.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const descendants = listDescendantPids(process.pid);
    expect(descendants).toContain(child.pid);
    await new Promise((resolve) => child.once('exit', resolve));
  });

  itDarwin(
    'createProcessTreeRusageTracker reports the ROOT as a delta since creation, not raw cumulative',
    async () => {
      // Inflate this process's own cumulative diskio-bytes-written BEFORE
      // creating the tracker, simulating a long-lived root (e.g. a shared
      // test-runner process that already ran hundreds of unrelated tests)
      // — the fix under test is that totals() must not include this
      // pre-existing amount, only what happens AFTER the tracker exists.
      const { writeFile, rm, mkdtemp } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const dir = await mkdtemp(join(tmpdir(), 'procrusage-baseline-'));
      const bigFile = join(dir, 'inflate.bin');
      try {
        await writeFile(bigFile, Buffer.alloc(20 * 1024 * 1024, 1));
        const before = readOwnDiskIoRusage();
        expect(before).not.toBeNull();
        expect(before!.diskioBytesWritten).toBeGreaterThan(0);

        const tracker = createProcessTreeRusageTracker(process.pid);
        tracker.poll();
        const totals = tracker.totals();
        // Nothing new happens between tracker creation and this poll — the
        // root's delta-contribution must be tiny, far below the ~20MB
        // already written before the tracker existed.
        expect(totals.diskioBytesWritten).toBeLessThan(2 * 1024 * 1024);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  itDarwin('createProcessTreeRusageTracker accumulates a short-lived child counters', async () => {
    const { spawn } = await import('node:child_process');
    const tracker = createProcessTreeRusageTracker(process.pid);
    const child = spawn('sleep', ['0.2'], { stdio: 'ignore' });
    const pollInterval = setInterval(() => tracker.poll(), 20);
    await new Promise((resolve) => child.once('exit', resolve));
    tracker.poll();
    clearInterval(pollInterval);
    const totals = tracker.totals();
    // The child does no disk IO of its own, so bytes may legitimately be 0 —
    // this asserts the tracker ran without throwing and returned a
    // well-formed, non-negative total, not a specific byte count.
    expect(totals.diskioBytesRead).toBeGreaterThanOrEqual(0);
    expect(totals.diskioBytesWritten).toBeGreaterThanOrEqual(0);
  });
});
