// Hand the event loop back for one macrotask.
//
// bun:sqlite is fully SYNCHRONOUS, so a route that touches sqlite N times in a
// loop holds the thread that serves every other request for the whole run.
// Awaiting this between iterations does not make the work cheaper — it caps
// how long a single tick can hold the loop, which is what a client timeout
// actually measures. setImmediate (not a microtask) so pending I/O callbacks
// genuinely get a turn: a microtask (queueMicrotask / Promise.resolve) drains
// BEFORE the loop ever reaches the poll phase, so it would yield to nothing.
// Mirrors the reconcile phase yields in connectionsMaterializer.ts.
//
// EXTRACTED to its own module (was a local const in http/server.ts) because the
// same helper is now needed in three places on the same hot path — the
// batch-resolve route, the content/ai lane phases (tabsession/contentLane.ts)
// and the deferred resolver-cache drain (http/resolverCacheDefer.ts) — and
// three copies of a scheduling primitive is how they drift.
//
// MEASURED, 25-url POST /v1/visits/batch-resolve, native `sample` of the live
// companion: ~90% of main-thread samples inside sqlite3 (sqlite3VdbeExec,
// BtreeTableMoveto, FTS, sqlite3BtreeInsert). Adding between-URL yields took
// the max single tick from 89,716ms to 3,008ms — a real fix for "the whole
// batch is one tick", and still 12x over the 250ms stall watchdog threshold,
// which is why the finer phase yields inside the lane exist.
//
// ZERO imports on purpose: every module on the request path can import this
// without any cycle risk.

export const yieldToEventLoop = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
