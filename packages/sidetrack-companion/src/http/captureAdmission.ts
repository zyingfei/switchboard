// Capture-admission gate for POST /v1/events (chat-thread snapshots).
//
// WHY (the capture-flood, verified): each extension capture payload is a
// FULL-THREAD SNAPSHOT — every turn, every time. An active/idle ChatGPT tab
// produced 552 captures in one hour, mostly byte-identical content or
// streaming snapshots where each supersedes the previous. Every ACCEPTED
// capture triggers ~15-18s of downstream materializer work on Bun's single
// thread, so the serial write path collapsed (56-minute POST latencies).
//
// KEY INSIGHT: per thread, only the NEWEST snapshot carries information value.
// Identical snapshots carry none. So we admit captures through two gates
// before any vault write / event-log mirror / materializer work runs:
//
//   1. CONTENT DEDUP — a stable content hash over exactly the fields that
//      affect downstream processing (provider, threadId, threadUrl, title,
//      and per-turn ordinal/role/text/markdown/formattedText/modelName). If a
//      submission's hash equals the last SUCCESSFULLY-accepted hash for its
//      thread, we return the previously-accepted result immediately — no
//      write, no mirror, no materializer work. capturedAt/requestId are
//      EXCLUDED from the hash: they change on every re-capture of identical
//      content and would defeat the dedup.
//
//   2. PER-THREAD LATEST-WINS SINGLE-FLIGHT — keyed per thread. While one
//      capture for a key is in flight, a newer submission is stashed as the
//      single "pending next" for that key (replacing any earlier pending; the
//      replaced one's waiters re-attach to the newer pending, since snapshots
//      supersede). When the in-flight finishes, the pending is processed
//      (after re-checking dedup against the just-accepted hash). This bounds
//      per-thread queue depth at 1 BY CONSTRUCTION — no tuning constants, no
//      timers.
//
// Error semantics: a failed process() rejects exactly the waiters attached to
// that submission and does NOT update the last-accepted hash/result; the next
// submission for the key proceeds normally (dedup state is not poisoned).
//
// Memory is bounded by an LRU over thread keys (dedup state + in-flight
// bookkeeping evicted oldest-first past the cap).
//
// This module is transport-agnostic and side-effect-free apart from its own
// in-memory maps: the hash function and process() are injected so the whole
// admission behaviour is unit-testable with no timers and no HTTP.

import { createHash } from 'node:crypto';

/** The successful outcome of processing a capture. */
export interface CaptureAdmissionResult {
  readonly bac_id: string;
  readonly revision: string;
}

/**
 * The subset of a capture payload the admission layer inspects. This is a
 * structural subset of `CaptureEventInput` (schemas.ts) — only the fields
 * that (a) key a thread or (b) affect downstream processing appear here, so
 * the hash is stable across re-captures of identical content.
 */
export interface CaptureAdmissionInput {
  readonly provider: string;
  readonly threadId?: string | undefined;
  readonly threadUrl: string;
  readonly title?: string | undefined;
  readonly turns: ReadonlyArray<{
    readonly ordinal: number;
    readonly role: string;
    readonly text: string;
    readonly markdown?: string | undefined;
    readonly formattedText?: string | undefined;
    readonly modelName?: string | undefined;
  }>;
}

export interface CaptureAdmissionOptions {
  /**
   * Hard cap on tracked thread keys; oldest-touched evicted past this so a
   * long-lived process can't accumulate unbounded dedup state.
   */
  readonly maxThreadKeys: number;
  /**
   * Passthrough mode: when true, EVERY submission is processed directly with
   * no dedup and no coalescing (the kill switch). Wired from the
   * SIDETRACK_CAPTURE_ADMISSION env flag by the composition root.
   */
  readonly passthrough: boolean;
}

/** Per-thread admission state. */
interface ThreadState {
  /** Hash + result of the last SUCCESSFULLY-accepted capture (dedup memo). */
  lastAcceptedHash: string | null;
  lastAcceptedResult: CaptureAdmissionResult | null;
  /** Set while a process() is running for this key (single-flight guard). */
  inFlight: boolean;
  /** The single stashed "next" submission, or null. Newest supersedes. */
  pending: PendingSubmission | null;
}

/** A submission waiting behind an in-flight process() for its key. */
interface PendingSubmission {
  input: CaptureAdmissionInput;
  hash: string;
  process: () => Promise<CaptureAdmissionResult>;
  /** Every caller absorbed into this pending; all resolve with the winner. */
  waiters: Array<Deferred<CaptureAdmissionResult>>;
}

interface Deferred<T> {
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

/**
 * Compute a stable content hash over the fields that affect downstream
 * processing. capturedAt and requestId are DELIBERATELY excluded — they change
 * on every re-capture of identical content and would defeat dedup. Turn
 * fields are emitted in a fixed order with a normalized shape so two payloads
 * with the same content but different optional-field key ordering still hash
 * equal.
 */
export const hashCaptureContent = (input: CaptureAdmissionInput): string => {
  const canonical = {
    provider: input.provider,
    threadId: input.threadId ?? null,
    threadUrl: input.threadUrl,
    title: input.title ?? null,
    turns: input.turns.map((turn) => ({
      ordinal: turn.ordinal,
      role: turn.role,
      text: turn.text,
      markdown: turn.markdown ?? null,
      formattedText: turn.formattedText ?? null,
      modelName: turn.modelName ?? null,
    })),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
};

/** Thread key: provider + ':' + (threadId ?? threadUrl). */
const threadKeyFor = (input: CaptureAdmissionInput): string =>
  `${input.provider}:${input.threadId ?? input.threadUrl}`;

/**
 * The capture-admission gate. One instance is attached to the server and
 * persists across requests (see server.ts composition root). Callers submit a
 * capture with a `process()` that performs the real work (vault write +
 * event-log mirror); the gate decides whether to dedup, coalesce, or process.
 */
export class CaptureAdmission {
  /** LRU over thread keys: insertion order = touch order (re-set on touch). */
  private readonly threads = new Map<string, ThreadState>();
  private readonly maxThreadKeys: number;
  private readonly passthrough: boolean;

  constructor(options: CaptureAdmissionOptions) {
    this.maxThreadKeys = Math.max(1, Math.floor(options.maxThreadKeys));
    this.passthrough = options.passthrough;
  }

  /**
   * Submit a capture for admission.
   *
   * @param input   the dedup-relevant subset of the capture payload
   * @param process performs the real work (write + mirror) and resolves with
   *                the accepted result. Invoked at most once per winning
   *                submission; NOT invoked on a dedup hit.
   *
   * Resolves with the accepted result — either freshly processed, a dedup
   * replay of the last-accepted result, or (for a coalesced submission) the
   * result of the winning snapshot that superseded it.
   */
  async submit(
    input: CaptureAdmissionInput,
    process: () => Promise<CaptureAdmissionResult>,
  ): Promise<CaptureAdmissionResult> {
    if (this.passthrough) {
      // Kill switch: no dedup, no coalescing — process every capture directly.
      return await process();
    }

    const key = threadKeyFor(input);
    const hash = hashCaptureContent(input);
    const state = this.touch(key);

    // Gate 1 — content dedup against the last successfully-accepted capture.
    if (state.lastAcceptedHash === hash && state.lastAcceptedResult !== null) {
      return state.lastAcceptedResult;
    }

    // Gate 2 — per-thread latest-wins single-flight.
    if (state.inFlight) {
      // A capture for this key is already processing. Stash THIS submission as
      // the single pending-next, absorbing any earlier pending's waiters
      // (snapshots supersede — only the newest has information value).
      return await new Promise<CaptureAdmissionResult>((resolve, reject) => {
        const deferred: Deferred<CaptureAdmissionResult> = { resolve, reject };
        const carried = state.pending?.waiters ?? [];
        state.pending = {
          input,
          hash,
          process,
          waiters: [...carried, deferred],
        };
      });
    }

    // No in-flight for this key — process immediately (this submission owns
    // the flight). Any submissions arriving during processing coalesce into
    // state.pending and are drained when this flight completes.
    return await this.runFlight(key, state, input, hash, process, []);
  }

  /**
   * Run a single flight for `key`, then drain the pending-next (if any) in a
   * loop so a burst never recurses deep. `extraWaiters` are callers already
   * attached to THIS submission (the coalesced ones re-attached when they were
   * promoted from pending).
   */
  private async runFlight(
    key: string,
    state: ThreadState,
    input: CaptureAdmissionInput,
    hash: string,
    process: () => Promise<CaptureAdmissionResult>,
    extraWaiters: Array<Deferred<CaptureAdmissionResult>>,
  ): Promise<CaptureAdmissionResult> {
    state.inFlight = true;
    let ownResult: CaptureAdmissionResult;
    let ownError: unknown;
    let ownFailed = false;
    try {
      ownResult = await process();
      // Success: pin this as the last-accepted (dedup memo) and settle the
      // coalesced waiters with the winning result.
      state.lastAcceptedHash = hash;
      state.lastAcceptedResult = ownResult;
      for (const w of extraWaiters) w.resolve(ownResult);
    } catch (err) {
      // Failure: reject EXACTLY this submission's waiters and do NOT touch the
      // dedup memo (no poisoning — the next submission proceeds normally).
      ownError = err;
      ownFailed = true;
      for (const w of extraWaiters) w.reject(err);
    } finally {
      state.inFlight = false;
    }

    // Drain the pending-next chain iteratively. Each iteration promotes the
    // latest stashed snapshot to the in-flight slot; further submissions that
    // land mid-drain re-populate state.pending.
    await this.drainPending(key, state);

    if (ownFailed) throw ownError;
    // Non-null after a successful process() (the only path that skips the
    // throw above).
    return ownResult!;
  }

  /**
   * Drain the single pending-next submission for `key`, looping until no more
   * pending remains. Each promoted submission re-checks dedup against the
   * just-accepted hash first (the winning snapshot may have already produced
   * identical content).
   */
  private async drainPending(key: string, state: ThreadState): Promise<void> {
    while (state.pending !== null) {
      const next = state.pending;
      state.pending = null;

      // Re-check dedup: the just-accepted snapshot may already equal this
      // pending's content. If so, settle its waiters with the last-accepted
      // result WITHOUT processing.
      if (state.lastAcceptedHash === next.hash && state.lastAcceptedResult !== null) {
        for (const w of next.waiters) w.resolve(state.lastAcceptedResult);
        continue;
      }

      state.inFlight = true;
      try {
        const result = await next.process();
        state.lastAcceptedHash = next.hash;
        state.lastAcceptedResult = result;
        for (const w of next.waiters) w.resolve(result);
      } catch (err) {
        // A failed drained submission rejects only its own waiters and leaves
        // the dedup memo untouched.
        for (const w of next.waiters) w.reject(err);
      } finally {
        state.inFlight = false;
      }
    }
  }

  /**
   * Get-or-create the thread state and mark it most-recently-used (LRU: delete
   * + re-insert so Map iteration order tracks recency). Evicts the oldest key
   * past the cap, but never a key with an in-flight or pending submission
   * (dropping those would strand waiters).
   */
  private touch(key: string): ThreadState {
    const existing = this.threads.get(key);
    if (existing !== undefined) {
      this.threads.delete(key);
      this.threads.set(key, existing);
      return existing;
    }
    const state: ThreadState = {
      lastAcceptedHash: null,
      lastAcceptedResult: null,
      inFlight: false,
      pending: null,
    };
    this.threads.set(key, state);
    this.evictIfNeeded();
    return state;
  }

  private evictIfNeeded(): void {
    if (this.threads.size <= this.maxThreadKeys) return;
    for (const [k, v] of this.threads) {
      if (this.threads.size <= this.maxThreadKeys) break;
      // Never evict a key with live work — its waiters must still settle.
      if (v.inFlight || v.pending !== null) continue;
      this.threads.delete(k);
    }
  }

  /** Test/diagnostic hooks. */
  size(): number {
    return this.threads.size;
  }
  peek(key: string): { lastAcceptedHash: string | null; inFlight: boolean; hasPending: boolean } | undefined {
    const s = this.threads.get(key);
    if (s === undefined) return undefined;
    return {
      lastAcceptedHash: s.lastAcceptedHash,
      inFlight: s.inFlight,
      hasPending: s.pending !== null,
    };
  }
}

/**
 * Read the SIDETRACK_CAPTURE_ADMISSION kill switch the way neighboring flags
 * are read: absent or any value other than '0' = ON (admission active); '0' =
 * passthrough (process every capture directly).
 */
export const captureAdmissionPassthroughFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): boolean => env['SIDETRACK_CAPTURE_ADMISSION'] === '0';
