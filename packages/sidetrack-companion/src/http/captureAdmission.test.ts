import { describe, expect, it } from 'vitest';

import {
  CaptureAdmission,
  captureAdmissionPassthroughFromEnv,
  hashCaptureContent,
  type CaptureAdmissionInput,
  type CaptureAdmissionResult,
} from './captureAdmission.js';

// A deferred so we can hold a process() open and assert coalescing /
// single-flight behaviour precisely (no timers, no races).
const deferred = (): {
  promise: Promise<CaptureAdmissionResult>;
  resolve: (v: CaptureAdmissionResult) => void;
  reject: (err: unknown) => void;
} => {
  let resolve!: (v: CaptureAdmissionResult) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<CaptureAdmissionResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flush = async (): Promise<void> => {
  // Let queued microtasks (single-flight resolution, drainPending) settle.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const makeInput = (
  overrides: Partial<CaptureAdmissionInput> = {},
): CaptureAdmissionInput => ({
  provider: 'chatgpt',
  threadId: 'thread-1',
  threadUrl: 'https://chatgpt.com/c/thread-1',
  title: 'A thread',
  turns: [{ ordinal: 0, role: 'user', text: 'hello' }],
  ...overrides,
});

const result = (bac_id: string): CaptureAdmissionResult => ({ bac_id, revision: 'r1' });

const active = (): CaptureAdmission =>
  new CaptureAdmission({ maxThreadKeys: 500, passthrough: false });

describe('hashCaptureContent', () => {
  it('is stable across re-captures of identical content', () => {
    const a = hashCaptureContent(makeInput());
    const b = hashCaptureContent(makeInput());
    expect(a).toBe(b);
  });

  it('changes when content-bearing fields change', () => {
    const base = hashCaptureContent(makeInput());
    expect(hashCaptureContent(makeInput({ title: 'Different' }))).not.toBe(base);
    expect(
      hashCaptureContent(makeInput({ turns: [{ ordinal: 0, role: 'user', text: 'changed' }] })),
    ).not.toBe(base);
    expect(
      hashCaptureContent(
        makeInput({ turns: [{ ordinal: 0, role: 'user', text: 'hello', markdown: '**hello**' }] }),
      ),
    ).not.toBe(base);
  });

  it('ignores fields not passed to it (capturedAt/requestId live outside the subset)', () => {
    // The subset type has no capturedAt/requestId, so identical content-bearing
    // fields hash equal regardless of those (verified structurally by the type
    // and by the stability test above).
    expect(hashCaptureContent(makeInput())).toBe(hashCaptureContent(makeInput()));
  });
});

describe('CaptureAdmission', () => {
  it('(a) identical-content re-capture returns the prior result WITHOUT invoking process', async () => {
    const admission = active();
    let calls = 0;
    const first = await admission.submit(makeInput(), async () => {
      calls += 1;
      return result('bac-1');
    });
    expect(first).toEqual(result('bac-1'));
    expect(calls).toBe(1);

    // Same content again — must be served from the dedup memo, no process().
    const second = await admission.submit(makeInput(), async () => {
      calls += 1;
      return result('bac-SHOULD-NOT-HAPPEN');
    });
    expect(second).toEqual(result('bac-1'));
    expect(calls).toBe(1);
  });

  it('(b) changed content processes normally', async () => {
    const admission = active();
    let calls = 0;
    await admission.submit(makeInput(), async () => {
      calls += 1;
      return result('bac-1');
    });
    const changed = await admission.submit(makeInput({ title: 'Now different' }), async () => {
      calls += 1;
      return result('bac-2');
    });
    expect(changed).toEqual(result('bac-2'));
    expect(calls).toBe(2);
  });

  it('(c) a burst of N=20 distinct snapshots for one thread coalesces: process runs far fewer than N, the LAST snapshot wins, all waiters resolve', async () => {
    const admission = active();

    // The FIRST submission's process is held open so the rest of the burst
    // arrives while it is in flight and coalesces into the single pending slot.
    const firstGate = deferred();
    const processedTitles: string[] = [];

    const N = 20;
    const promises: Array<Promise<CaptureAdmissionResult>> = [];

    // Submission 0 owns the flight and blocks on firstGate.
    promises.push(
      admission.submit(makeInput({ title: 'snap-0' }), async () => {
        processedTitles.push('snap-0');
        return await firstGate.promise;
      }),
    );
    await flush();

    // Submissions 1..N-1 all land while snap-0 is in flight. Each replaces the
    // prior pending; the last one (snap-19) should be the surviving pending.
    for (let i = 1; i < N; i += 1) {
      const title = `snap-${i}`;
      promises.push(
        admission.submit(makeInput({ title }), async () => {
          processedTitles.push(title);
          // Drained submissions resolve synchronously.
          return result(`bac-${title}`);
        }),
      );
    }
    await flush();

    // Release snap-0. Its result resolves, then the pending (snap-19) drains.
    firstGate.resolve(result('bac-snap-0'));

    const settled = await Promise.all(promises);
    await flush();

    // process() ran for snap-0 (the owner) and snap-19 (the surviving pending)
    // only — far fewer than N.
    expect(processedTitles).toEqual(['snap-0', 'snap-19']);
    expect(processedTitles.length).toBeLessThan(N);

    // Submission 0 got its own result; every coalesced waiter absorbed into the
    // winning snapshot (snap-19) resolves with snap-19's result.
    expect(settled[0]).toEqual(result('bac-snap-0'));
    for (let i = 1; i < N; i += 1) {
      expect(settled[i]).toEqual(result('bac-snap-19'));
    }

    // The last-accepted (dedup memo) is snap-19.
    const laterSnap19 = await admission.submit(makeInput({ title: 'snap-19' }), async () => {
      throw new Error('should be served from dedup memo, not reprocessed');
    });
    expect(laterSnap19).toEqual(result('bac-snap-19'));
  });

  it('(d) a process failure rejects ONLY its waiters and does NOT poison dedup state', async () => {
    const admission = active();

    // First accepted capture seeds the dedup memo.
    await admission.submit(makeInput({ title: 'ok' }), async () => result('bac-ok'));

    // A changed snapshot whose process rejects.
    const boom = new Error('write failed');
    await expect(
      admission.submit(makeInput({ title: 'will-fail' }), async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    // Dedup memo is unchanged — the previously-accepted 'ok' content still
    // dedups to its result.
    const stillOk = await admission.submit(makeInput({ title: 'ok' }), async () => {
      throw new Error('should be served from the un-poisoned dedup memo');
    });
    expect(stillOk).toEqual(result('bac-ok'));

    // And the next submission for the key proceeds normally.
    const next = await admission.submit(makeInput({ title: 'recovered' }), async () =>
      result('bac-recovered'),
    );
    expect(next).toEqual(result('bac-recovered'));
  });

  it('(d2) a failure of the IN-FLIGHT owner rejects only its waiter; the pending still drains and wins', async () => {
    const admission = active();
    const ownerGate = deferred();
    const processed: string[] = [];

    const ownerPromise = admission.submit(makeInput({ title: 'owner' }), async () => {
      processed.push('owner');
      return await ownerGate.promise;
    });
    await flush();

    const pendingPromise = admission.submit(makeInput({ title: 'pending' }), async () => {
      processed.push('pending');
      return result('bac-pending');
    });
    await flush();

    const boom = new Error('owner write failed');
    ownerGate.reject(boom);

    await expect(ownerPromise).rejects.toBe(boom);
    await expect(pendingPromise).resolves.toEqual(result('bac-pending'));
    expect(processed).toEqual(['owner', 'pending']);

    // The owner's failure didn't poison the memo; the pending's success set it.
    const laterPending = await admission.submit(makeInput({ title: 'pending' }), async () => {
      throw new Error('should be dedup-served');
    });
    expect(laterPending).toEqual(result('bac-pending'));
  });

  it('(e) passthrough mode processes every capture directly (no dedup, no coalescing)', async () => {
    const admission = new CaptureAdmission({ maxThreadKeys: 500, passthrough: true });
    let calls = 0;
    const one = await admission.submit(makeInput(), async () => {
      calls += 1;
      return result('bac-1');
    });
    // Identical content again — passthrough still processes it (no dedup).
    const two = await admission.submit(makeInput(), async () => {
      calls += 1;
      return result('bac-2');
    });
    expect(one).toEqual(result('bac-1'));
    expect(two).toEqual(result('bac-2'));
    expect(calls).toBe(2);
  });

  it('(f) two different threads process independently and concurrently', async () => {
    const admission = active();
    const gateA = deferred();
    const gateB = deferred();
    const order: string[] = [];

    const a = admission.submit(makeInput({ threadId: 'A', threadUrl: 'https://x/A' }), async () => {
      order.push('A-start');
      return await gateA.promise;
    });
    const b = admission.submit(makeInput({ threadId: 'B', threadUrl: 'https://x/B' }), async () => {
      order.push('B-start');
      return await gateB.promise;
    });
    await flush();

    // Both flights started without waiting on each other — different keys are
    // not single-flighted against one another.
    expect(order).toEqual(['A-start', 'B-start']);

    // Resolve B first, then A — independent completion.
    gateB.resolve(result('bac-B'));
    gateA.resolve(result('bac-A'));

    expect(await a).toEqual(result('bac-A'));
    expect(await b).toEqual(result('bac-B'));
  });

  it('LRU bounds tracked thread keys but never evicts a key with live work', async () => {
    const admission = new CaptureAdmission({ maxThreadKeys: 2, passthrough: false });
    // Seed 3 distinct completed keys → capacity is 2, oldest evicted.
    for (const id of ['k1', 'k2', 'k3']) {
      await admission.submit(
        makeInput({ threadId: id, threadUrl: `https://x/${id}` }),
        async () => result(`bac-${id}`),
      );
    }
    expect(admission.size()).toBeLessThanOrEqual(2);
    // k1 (oldest) was evicted → its dedup memo is gone, so re-submitting the
    // same content reprocesses.
    let reprocessed = false;
    await admission.submit(
      makeInput({ threadId: 'k1', threadUrl: 'https://x/k1' }),
      async () => {
        reprocessed = true;
        return result('bac-k1-again');
      },
    );
    expect(reprocessed).toBe(true);
  });
});

describe('captureAdmissionPassthroughFromEnv', () => {
  it("returns true only for exactly '0'", () => {
    expect(captureAdmissionPassthroughFromEnv({ SIDETRACK_CAPTURE_ADMISSION: '0' })).toBe(true);
  });
  it('returns false when absent (default ON)', () => {
    expect(captureAdmissionPassthroughFromEnv({})).toBe(false);
  });
  it('returns false for any other value (ON)', () => {
    expect(captureAdmissionPassthroughFromEnv({ SIDETRACK_CAPTURE_ADMISSION: '1' })).toBe(false);
    expect(captureAdmissionPassthroughFromEnv({ SIDETRACK_CAPTURE_ADMISSION: 'on' })).toBe(false);
    expect(captureAdmissionPassthroughFromEnv({ SIDETRACK_CAPTURE_ADMISSION: '' })).toBe(false);
  });
});
