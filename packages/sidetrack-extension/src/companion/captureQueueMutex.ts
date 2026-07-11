// Serialization primitives for the capture queue.
//
// The MV3 service worker runs a single thread but interleaves at every
// `await`: a nav-triggered enqueueCapture, a workboard-poll
// replayQueuedCaptures, and a user "+ Capture" can all be mid-flight
// concurrently, each awaiting chrome.storage or the network. Without
// serialization those interleavings race on the one chrome.storage key
// — an enqueue completing while a drain awaits the network is silently
// overwritten when the drain rewrites the whole key. This module gives
// the queue two guarantees:
//
//   withQueueLock  — every mutation on the MAIN queue key runs to
//                    completion before the next one starts (a per-
//                    storage promise chain).
//   withFailedLock — same guarantee for the separate FAILED_KEY. Uses
//                    a distinct chain so callers already inside
//                    withQueueLock (e.g. drainQueueInner) can safely
//                    call withFailedLock without deadlocking.
//   singleFlight   — concurrent drain calls coalesce onto the one
//                    in-flight drain promise instead of each racing a
//                    fresh read/rewrite.
//
// All three key on the storage instance (a WeakMap) so independent
// chrome.storage-mock instances in tests never serialize against each
// other, and the real singleton chrome.storage.local gets one shared
// chain.

export interface MutexKey {
  // Marker only — any object identity works as a key. The queue passes
  // its StoragePort.
}

// Internal helper: build a serializing lock backed by a dedicated
// promise-chain WeakMap. Returns a function with the same contract as
// the public withQueueLock / withFailedLock exports. The WeakMap is
// captured in the closure, so each call to makeChainLock() produces
// an entirely independent serialization domain.
const makeChainLock = () => {
  const chains = new WeakMap<object, Promise<unknown>>();
  return async <T>(key: object, task: () => Promise<T>): Promise<T> => {
    const prior = chains.get(key) ?? Promise.resolve();
    // The chain link never rejects, so one failed task cannot wedge the
    // lock for everyone behind it. `run` still surfaces the real result
    // (or error) to this caller.
    const run = prior.then(task, task);
    chains.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  };
};

// Run `task` after every previously-enqueued task for this key has
// settled. Tasks run strictly in call order; a rejecting task does not
// break the chain for the next caller.
//
// Serializes mutations on the MAIN queue key (QUEUE_KEY, DROPPED_KEY,
// EVICTION_SCRATCH_KEY).
export const withQueueLock = makeChainLock();

// Same contract as withQueueLock, but serializes mutations on the
// FAILED queue key (FAILED_KEY) independently. Keeping the two chains
// separate means drainQueueInner — which already holds withQueueLock —
// can call withFailedLock for the failed-write without deadlocking.
export const withFailedLock = makeChainLock();

const inFlight = new WeakMap<object, Promise<unknown>>();

// Coalesce concurrent calls: while a call for `key` is in flight, every
// other caller receives that same in-flight promise instead of starting
// its own. Once it settles the slot clears, so the NEXT call starts a
// fresh run (a drain that finished must be re-runnable to pick up items
// queued after it started).
export const singleFlight = async <T>(key: object, task: () => Promise<T>): Promise<T> => {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing !== undefined) {
    return existing;
  }
  const run = task();
  inFlight.set(key, run);
  try {
    return await run;
  } finally {
    // Only clear if we're still the current in-flight run — defensive
    // against a future re-entrant reassignment.
    if (inFlight.get(key) === run) {
      inFlight.delete(key);
    }
  }
};
