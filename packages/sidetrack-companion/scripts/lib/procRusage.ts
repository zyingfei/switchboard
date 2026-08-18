// Per-process kernel disk-IO + memory counters via proc_pid_rusage
// (macOS libproc, no root needed). Reused pattern from
// docs/runbooks/sidetrack-diskwear-hourly.sh (ops/proc-rusage-telemetry,
// 2026-08-17 user-validated methodology) — that script established
// offsets 18/19 (BigUint64Array words) as ri_diskio_bytesread /
// ri_diskio_byteswritten for RUSAGE_INFO_V4 (flavor 4). This module adds
// resident_size / phys_footprint (words 8/9) for RSS attribution and a
// process-tree walker, because the connections materializer reconcile
// runs in a FORKED CHILD by default (cli.ts: SIDETRACK_CONNECTIONS_CHILD
// defaults to '1' unless a test opts out) — measuring only the parent
// pid would silently drop most of the connections-generation-db read
// volume during a real catch-up/drain.
//
// struct rusage_info_v4 layout (relevant prefix, all read as u64 words
// after the 16-byte ri_uuid, which occupies words 0-1) — offsets
// verified against /usr/include/sys/resource.h in the local macOS SDK
// (`grep -n ri_ .../sys/resource.h`), not guessed from memory:
//   2  ri_user_time            8  ri_resident_size   <- RSS
//   3  ri_system_time          9  ri_phys_footprint   <- macOS "memory" figure
//   4  ri_pkg_idle_wkups      10  ri_proc_start_abstime
//   5  ri_interrupt_wkups     11  ri_proc_exit_abstime
//   6  ri_pageins             12  ri_child_user_time
//   7  ri_wired_size          ...
//  18  ri_diskio_bytesread
//  19  ri_diskio_byteswritten

import { spawnSync } from 'node:child_process';

export interface ProcRusageSample {
  readonly pid: number;
  readonly diskioBytesRead: number;
  readonly diskioBytesWritten: number;
  readonly residentSizeBytes: number;
  readonly physFootprintBytes: number;
}

const RUSAGE_INFO_V4 = 4;
// 32 u64 words comfortably covers rusage_info_v4 (24 words) with margin
// for future kernel versions appending fields (v5/v6 only grow the
// struct, never reorder existing offsets).
const WORD_COUNT = 32;

let ffi: {
  readonly symbols: {
    readonly proc_pid_rusage: (pid: number, flavor: number, buf: unknown) => number;
  };
} | null = null;
let ffiLoadFailed = false;

const loadFfi = (): typeof ffi => {
  if (ffi !== null || ffiLoadFailed) return ffi;
  if (process.platform !== 'darwin') {
    ffiLoadFailed = true;
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { dlopen, FFIType } = require('bun:ffi') as typeof import('bun:ffi');
    const lib = dlopen('/usr/lib/libproc.dylib', {
      proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    });
    ffi = lib as unknown as typeof ffi;
    return ffi;
  } catch {
    ffiLoadFailed = true;
    return null;
  }
};

/** Read one pid's current kernel disk-IO + memory counters. Returns null
 *  (never throws) when the pid is gone, unreadable (e.g. a different
 *  user's process), or this platform has no proc_pid_rusage — callers
 *  must treat a null sample as "drop this pid from the running total",
 *  not as zero. */
export const readProcRusage = (pid: number): ProcRusageSample | null => {
  const lib = loadFfi();
  if (lib === null) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ptr } = require('bun:ffi') as typeof import('bun:ffi');
    const buf = new BigUint64Array(WORD_COUNT);
    const rc = lib.symbols.proc_pid_rusage(pid, RUSAGE_INFO_V4, ptr(buf));
    if (rc !== 0) return null;
    return {
      pid,
      residentSizeBytes: Number(buf[8] ?? 0n),
      physFootprintBytes: Number(buf[9] ?? 0n),
      diskioBytesRead: Number(buf[18] ?? 0n),
      diskioBytesWritten: Number(buf[19] ?? 0n),
    };
  } catch {
    return null;
  }
};

/** All live descendant pids of `rootPid` (not including rootPid itself),
 *  found by walking a single `ps -Ao pid,ppid` snapshot — cheap (one
 *  process spawn) and correct for multi-level forks (a reconcile child
 *  that itself forks a grandchild). Best-effort: returns [] on any `ps`
 *  failure rather than throwing, since this is diagnostic tooling. */
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

/** Accumulates disk-IO bytes across a process TREE that churns over time
 *  (children fork and exit repeatedly — e.g. the connections reconcile
 *  child, which restarts per drain cycle). proc_pid_rusage counters are
 *  per-pid lifetime; naively re-summing "current live pids" at each poll
 *  silently drops any pid that has already exited between polls. This
 *  tracker keeps each exited pid's LAST known counters in a running
 *  total instead of discarding them. Call `poll()` periodically (the
 *  harness calls it every ~1.5s during active phases); read `totals()`
 *  at any point for the tree's cumulative counters since the tracker was
 *  created. */
export const createProcessTreeRusageTracker = (rootPid: number) => {
  const lastKnownByPid = new Map<number, ProcRusageSample>();
  const exitedTotals = { diskioBytesRead: 0, diskioBytesWritten: 0 };
  let peakResidentSizeBytes = 0;
  let peakPhysFootprintBytes = 0;

  const poll = (): void => {
    const livePids = new Set<number>([rootPid, ...listDescendantPids(rootPid)]);
    // Retire pids that vanished since the last poll: fold their last
    // known counters into the exited total so the running sum never
    // regresses when a short-lived child disappears.
    for (const [pid, sample] of lastKnownByPid) {
      if (!livePids.has(pid)) {
        exitedTotals.diskioBytesRead += sample.diskioBytesRead;
        exitedTotals.diskioBytesWritten += sample.diskioBytesWritten;
        lastKnownByPid.delete(pid);
      }
    }
    let liveResident = 0;
    let livePhys = 0;
    for (const pid of livePids) {
      const sample = readProcRusage(pid);
      if (sample === null) continue;
      lastKnownByPid.set(pid, sample);
      liveResident += sample.residentSizeBytes;
      livePhys += sample.physFootprintBytes;
    }
    if (liveResident > peakResidentSizeBytes) peakResidentSizeBytes = liveResident;
    if (livePhys > peakPhysFootprintBytes) peakPhysFootprintBytes = livePhys;
  };

  const totals = (): {
    readonly diskioBytesRead: number;
    readonly diskioBytesWritten: number;
    readonly peakResidentSizeBytes: number;
    readonly peakPhysFootprintBytes: number;
    readonly livePidCount: number;
  } => {
    let liveRead = 0;
    let liveWritten = 0;
    for (const sample of lastKnownByPid.values()) {
      liveRead += sample.diskioBytesRead;
      liveWritten += sample.diskioBytesWritten;
    }
    return {
      diskioBytesRead: exitedTotals.diskioBytesRead + liveRead,
      diskioBytesWritten: exitedTotals.diskioBytesWritten + liveWritten,
      peakResidentSizeBytes,
      peakPhysFootprintBytes,
      livePidCount: lastKnownByPid.size,
    };
  };

  // Prime immediately so a caller diffing totals() across a very short
  // phase still has a t0 reading.
  poll();

  return { poll, totals };
};
