// Per-process kernel disk-IO counters via proc_pid_rusage (macOS libproc,
// no root needed). F9 — idle I/O floor (docs/plans/2026-08-15-foundation-
// program.md): the connections reconcile child forks fresh per drain and
// exits immediately after posting its result, so the only way to attribute
// bytes to it is to have the CHILD read its own counters right before it
// exits — a dead pid can no longer be queried. This module is that
// self-report primitive, plus a process-tree poller for tests that need to
// observe a child's counters from the OUTSIDE while it is still alive.
//
// DARWIN-ONLY, BY DESIGN — proc_pid_rusage is a macOS/BSD libproc API with
// no Linux equivalent implemented here. `readProcRusage` returns `null` on
// every other platform (checked below) rather than throwing, so a CI run on
// Linux gets an honest "no data" instead of a crash.
//
// Deliberately a SEPARATE, minimal port of scripts/lib/procRusage.ts's
// `readProcRusage`/`listDescendantPids`/`createProcessTreeRusageTracker`
// (ops/proc-rusage-telemetry, 2026-08-17 user-validated methodology), not a
// shared import: tsconfig.build.json's `rootDir` is `src`, and
// connectionsReconcileChild.entry.ts (this module's production consumer) is
// compiled into dist/ by that build — a script under scripts/ is outside
// that root and cannot be imported from anything the build emits. Keep the
// two in sync if the struct-offset comments below ever change; scripts/lib/
// procRusage.ts is the harness-only sibling, untouched by this change.
//
// struct rusage_info_v4 layout (relevant prefix, all read as u64 words
// after the 16-byte ri_uuid, which occupies words 0-1) — offsets verified
// against /usr/include/sys/resource.h in the local macOS SDK, not guessed:
//   18  ri_diskio_bytesread
//   19  ri_diskio_byteswritten
//
// bun:ffi has no type declarations under this package's build tsconfig
// (types: ["node", "vitest"] — see tsconfig.json) — mirrors the manual
// inline typing already established in connectionsReconcileChild.entry.ts's
// setiopolicy_np call, the only other production bun:ffi/Darwin-syscall
// precedent in this repo.

import { spawnSync } from 'node:child_process';

export interface ProcDiskIoRusage {
  readonly pid: number;
  readonly diskioBytesRead: number;
  readonly diskioBytesWritten: number;
}

const RUSAGE_INFO_V4 = 4;
// 32 u64 words comfortably covers rusage_info_v4 (24 words) with margin for
// future kernel versions appending fields (v5/v6 only grow the struct,
// never reorder existing offsets).
const WORD_COUNT = 32;

interface BunFfiLib {
  readonly symbols: {
    readonly proc_pid_rusage: (pid: number, flavor: number, buf: unknown) => number;
  };
}

let libproc: BunFfiLib | null = null;
let ffiLoadFailed = false;

const loadLibproc = (): BunFfiLib | null => {
  if (libproc !== null || ffiLoadFailed) return libproc;
  if (process.platform !== 'darwin') {
    ffiLoadFailed = true;
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { dlopen, FFIType } = require('bun:ffi') as {
      readonly dlopen: (
        lib: string,
        symbols: Record<string, { readonly args: readonly number[]; readonly returns: number }>,
      ) => BunFfiLib;
      readonly FFIType: { readonly i32: number; readonly ptr: number };
    };
    libproc = dlopen('/usr/lib/libproc.dylib', {
      proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    });
    return libproc;
  } catch {
    ffiLoadFailed = true;
    return null;
  }
};

/** Read one pid's current kernel disk-IO counters. Returns null (never
 *  throws) when the pid is gone, unreadable, or this platform has no
 *  proc_pid_rusage — callers must treat a null sample as "no data", not as
 *  zero. */
export const readProcRusage = (pid: number): ProcDiskIoRusage | null => {
  const lib = loadLibproc();
  if (lib === null) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ptr } = require('bun:ffi') as { readonly ptr: (view: BigUint64Array) => unknown };
    const buf = new BigUint64Array(WORD_COUNT);
    const rc = lib.symbols.proc_pid_rusage(pid, RUSAGE_INFO_V4, ptr(buf));
    if (rc !== 0) return null;
    return {
      pid,
      diskioBytesRead: Number(buf[18] ?? 0n),
      diskioBytesWritten: Number(buf[19] ?? 0n),
    };
  } catch {
    return null;
  }
};

/** This process's own kernel disk-IO counters since process start. Cheap
 *  (one syscall via libproc); best-effort, never throws. Intended for a
 *  short-lived child to call once right before it exits, since a dead pid
 *  can no longer be queried from the outside. */
export const readOwnDiskIoRusage = (): ProcDiskIoRusage | null => readProcRusage(process.pid);

/** All live descendant pids of `rootPid` (not including rootPid itself),
 *  found by walking a single `ps -Ao pid,ppid` snapshot. Best-effort:
 *  returns [] on any `ps` failure rather than throwing. */
export const listDescendantPids = (rootPid: number): readonly number[] => {
  const result = spawnSync('ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000 });
  if (result.status !== 0 || typeof result.stdout !== 'string') return [];
  const childrenByParent = new Map<number, number[]>();
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parts = trimmed.split(/\s+/u);
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    const list = childrenByParent.get(ppid) ?? [];
    list.push(pid);
    childrenByParent.set(ppid, list);
  }
  const out: number[] = [];
  const queue = [rootPid];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const parent = queue.shift() as number;
    for (const child of childrenByParent.get(parent) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
};

export interface ProcessTreeRusageTotals {
  readonly diskioBytesRead: number;
  readonly diskioBytesWritten: number;
  readonly livePidCount: number;
}

/** Accumulates disk-IO bytes across a process TREE that churns over time
 *  (a forked child that exits between polls). proc_pid_rusage counters are
 *  per-pid lifetime; naively re-summing "current live pids" at each poll
 *  silently drops any pid that already exited. This tracker keeps each
 *  exited pid's LAST known counters in a running total instead. Call
 *  `poll()` frequently while the tree is expected to be active; read
 *  `totals()` at any point. */
/** `rootPid`'s OWN contribution is reported as a DELTA since the tracker
 *  was created, not its raw cumulative counters — rusage counters are
 *  cumulative for the process's entire lifetime, and a long-lived root
 *  (e.g. a shared test-runner process that has already run hundreds of
 *  unrelated tests) would otherwise swamp a small, freshly-measured
 *  operation with unrelated prior I/O. Descendant pids need no such
 *  baseline: a forked child discovered by this tracker is by construction
 *  new (it didn't exist before the fork), so its full lifetime counters
 *  ARE the operation's own cost. */
export const createProcessTreeRusageTracker = (
  rootPid: number,
): { readonly poll: () => void; readonly totals: () => ProcessTreeRusageTotals } => {
  const lastKnownByPid = new Map<number, ProcDiskIoRusage>();
  const exitedTotals = { diskioBytesRead: 0, diskioBytesWritten: 0 };
  const rootBaseline = readProcRusage(rootPid);

  const poll = (): void => {
    const livePids = new Set<number>([rootPid, ...listDescendantPids(rootPid)]);
    for (const [pid, sample] of lastKnownByPid) {
      if (!livePids.has(pid)) {
        exitedTotals.diskioBytesRead += sample.diskioBytesRead;
        exitedTotals.diskioBytesWritten += sample.diskioBytesWritten;
        lastKnownByPid.delete(pid);
      }
    }
    for (const pid of livePids) {
      const sample = readProcRusage(pid);
      if (sample === null) continue;
      lastKnownByPid.set(pid, sample);
    }
  };

  const totals = (): ProcessTreeRusageTotals => {
    let liveRead = 0;
    let liveWritten = 0;
    for (const [pid, sample] of lastKnownByPid) {
      if (pid === rootPid) {
        liveRead += Math.max(0, sample.diskioBytesRead - (rootBaseline?.diskioBytesRead ?? 0));
        liveWritten += Math.max(
          0,
          sample.diskioBytesWritten - (rootBaseline?.diskioBytesWritten ?? 0),
        );
        continue;
      }
      liveRead += sample.diskioBytesRead;
      liveWritten += sample.diskioBytesWritten;
    }
    return {
      diskioBytesRead: exitedTotals.diskioBytesRead + liveRead,
      diskioBytesWritten: exitedTotals.diskioBytesWritten + liveWritten,
      livePidCount: lastKnownByPid.size,
    };
  };

  poll();
  return { poll, totals };
};
