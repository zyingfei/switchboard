// Sole-writer crash supervision.
//
// The companion is the ONLY process that writes the vault. Before this
// module, it handled SIGINT/SIGTERM (graceful) but had NO
// uncaughtException / unhandledRejection handler: an unexpected throw
// killed the process mid-operation with no post-mortem, and — worse —
// could leave a corrupt process limping on if some ambient catch
// swallowed it. Policy here is deliberate: a corrupt process must EXIT,
// not keep writing. We log a structured post-mortem to stderr, make a
// best-effort durable crash record under _BAC/diagnostics/, then exit
// non-zero.
//
// The handler must be crash-safe itself: it runs synchronously (no
// awaited I/O that a subsequent process.exit would abort mid-flush) and
// is re-entrancy guarded so a throw INSIDE the handler cannot recurse.

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Non-zero so supervisors (launchd/systemd) see the abnormal exit.
export const CRASH_EXIT_CODE = 70;

export interface CrashHandlerDeps {
  // Where to root the crash record. Optional: an uncaught throw can
  // fire before the vault path is resolved, in which case we still log
  // to stderr and skip the file write.
  readonly getVaultRoot?: () => string | undefined;
  // Ambient request/phase id, if the runtime can supply one cheaply.
  readonly getPhaseId?: () => string | undefined;
  // Injected for tests. Defaults hit the real process/clock/fs.
  readonly exit?: (code: number) => void;
  readonly writeStderr?: (text: string) => void;
  readonly now?: () => Date;
  // Best-effort durable record writer. Default writes
  // _BAC/diagnostics/crash-<timestamp>.json synchronously.
  readonly writeCrashRecord?: (vaultRoot: string, record: CrashRecord) => void;
}

export interface CrashRecord {
  readonly kind: 'uncaughtException' | 'unhandledRejection';
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly timestamp: string;
  readonly phaseId?: string;
}

const errorFrom = (value: unknown): { name: string; message: string; stack?: string } => {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack === undefined ? {} : { stack: value.stack }),
    };
  }
  // Non-Error throws (strings, objects, rejected non-Error values).
  return { name: 'NonError', message: typeof value === 'string' ? value : safeStringify(value) };
};

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

const defaultWriteCrashRecord = (vaultRoot: string, record: CrashRecord): void => {
  const dir = join(vaultRoot, '_BAC', 'diagnostics');
  // Sync writes: a following process.exit must not race an async flush.
  mkdirSync(dir, { recursive: true });
  // Colons are illegal in filenames on some hosts; use the ms epoch +
  // ISO-safe stamp so the record is unambiguous and sortable.
  const stamp = record.timestamp.replace(/[:.]/g, '-');
  const path = join(dir, `crash-${stamp}.json`);
  // Append (not writeFile) so two crashes in the same millisecond can't
  // clobber each other; each record is one self-contained JSON line.
  appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8' });
};

// Build the handler function without registering it — the seam the
// tests drive directly (invoke with a synthetic error, assert on the
// mocked exit + record writer). Re-entrancy is guarded so a throw
// inside the record write / stderr write still terminates cleanly.
export const createCrashHandler = (
  deps: CrashHandlerDeps = {},
): ((kind: CrashRecord['kind'], error: unknown) => void) => {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const writeStderr = deps.writeStderr ?? ((text: string) => void process.stderr.write(text));
  const now = deps.now ?? (() => new Date());
  const writeCrashRecord = deps.writeCrashRecord ?? defaultWriteCrashRecord;
  let handled = false;

  return (kind: CrashRecord['kind'], error: unknown): void => {
    // Re-entrancy guard: if the handler itself throws (or a second
    // uncaught fires while we're exiting) we must not recurse — force
    // the exit and return.
    if (handled) {
      try {
        exit(CRASH_EXIT_CODE);
      } catch {
        // Nothing left to do.
      }
      return;
    }
    handled = true;

    const info = errorFrom(error);
    const phaseId = (() => {
      try {
        return deps.getPhaseId?.();
      } catch {
        return undefined;
      }
    })();
    const record: CrashRecord = {
      kind,
      name: info.name,
      message: info.message,
      ...(info.stack === undefined ? {} : { stack: info.stack }),
      timestamp: now().toISOString(),
      ...(phaseId === undefined ? {} : { phaseId }),
    };

    // 1. Structured post-mortem to stderr — always, even if the file
    //    write below fails or the vault root is unknown.
    try {
      writeStderr(`[crash] ${JSON.stringify(record)}\n`);
    } catch {
      // stderr may be closed; the durable record below is the backstop.
    }

    // 2. Best-effort durable record under _BAC/diagnostics/.
    try {
      const vaultRoot = deps.getVaultRoot?.();
      if (vaultRoot !== undefined && vaultRoot.length > 0) {
        writeCrashRecord(vaultRoot, record);
      }
    } catch {
      // Never let the record write mask the exit — a corrupt process
      // must still terminate.
    }

    // 3. Exit non-zero. Do NOT swallow-and-continue.
    exit(CRASH_EXIT_CODE);
  };
};

// Register the handler on `process`. Returns an unregister function so
// tests / graceful shutdown can detach the listeners.
export const installCrashHandlers = (
  deps: CrashHandlerDeps = {},
): (() => void) => {
  const handle = createCrashHandler(deps);
  const onUncaught = (error: unknown): void => {
    handle('uncaughtException', error);
  };
  const onUnhandled = (reason: unknown): void => {
    handle('unhandledRejection', reason);
  };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUnhandled);
  return () => {
    process.removeListener('uncaughtException', onUncaught);
    process.removeListener('unhandledRejection', onUnhandled);
  };
};
