import { afterEach, describe, expect, it } from 'vitest';

import type { AcceptedEvent } from '../sync/causal.js';
import type { EventLog } from '../sync/eventLog.js';
import { THREAD_UPSERTED } from '../threads/events.js';

import { ENTITY_TITLE_ENRICHED } from './events.js';
import {
  LOCAL_LLM_ENV,
  LOCAL_LLM_MODEL_ID,
  getTitleSweepStatus,
  localLlmEnabled,
  resetTitleSweepForTest,
  selectSweepCandidates,
  startTitleSweep,
  type ChildRunner,
} from './localLlm.js';
import type { LocalLlmResult } from './localLlmChild.entry.js';

// ---- fake event log ----------------------------------------------------

// A minimal in-memory EventLog stand-in exposing exactly the methods the
// sweep touches (streamFiltered / findByClientEventId / appendServerObserved).
// Everything else throws so an accidental new dependency is caught loudly.
const makeFakeEventLog = (seed: readonly AcceptedEvent[] = []): {
  eventLog: EventLog;
  appended: AcceptedEvent[];
} => {
  const events: AcceptedEvent[] = [...seed];
  const appended: AcceptedEvent[] = [];
  let seq = 1000;
  const notImplemented = (name: string) => () => {
    throw new Error(`fake event log: ${name} not implemented`);
  };
  const eventLog = {
    streamFiltered: async (predicate: (e: AcceptedEvent) => boolean) =>
      events.filter(predicate),
    findByClientEventId: async (clientEventId: string) =>
      events.find((e) => e.clientEventId === clientEventId) ?? null,
    appendServerObserved: async (input: {
      clientEventId: string;
      aggregateId: string;
      type: string;
      payload: Record<string, unknown>;
    }) => {
      seq += 1;
      const event: AcceptedEvent = {
        clientEventId: input.clientEventId,
        dot: { replicaId: 'r-fake', seq },
        deps: {},
        aggregateId: input.aggregateId,
        type: input.type,
        payload: input.payload,
        acceptedAtMs: seq,
      };
      events.push(event);
      appended.push(event);
      return event as AcceptedEvent<Record<string, unknown>>;
    },
    appendClientObserved: notImplemented('appendClientObserved'),
    appendClient: notImplemented('appendClient'),
    appendClientObservedBatch: notImplemented('appendClientObservedBatch'),
    readMerged: async () => events,
    readMergedSince: notImplemented('readMergedSince'),
    streamEvents: notImplemented('streamEvents'),
    logSignature: async () => `sig-${String(events.length)}`,
    readReplica: notImplemented('readReplica'),
    readByAggregate: notImplemented('readByAggregate'),
  } as unknown as EventLog;
  return { eventLog, appended };
};

let seq = 0;
const threadUpsert = (bacId: string, title: string): AcceptedEvent => {
  seq += 1;
  return {
    clientEventId: `thread-${bacId}-${seq}`,
    dot: { replicaId: 'r1', seq },
    deps: {},
    aggregateId: bacId,
    type: THREAD_UPSERTED,
    payload: {
      bac_id: bacId,
      provider: 'chatgpt',
      threadUrl: `https://chatgpt.com/c/${bacId}`,
      title,
      lastSeenAt: '2026-07-26T00:00:00.000Z',
    },
    acceptedAtMs: seq,
  };
};

// A fake child runner: returns a fixed title per item — never loads a model.
const makeFakeRunner = (titleFor: (id: string) => string | null): { runner: ChildRunner } => {
  const runner: ChildRunner = async (input) => ({
    results: input.job.items.map((item) => ({
      id: item.id,
      title: titleFor(item.id),
      ms: 5,
    })),
  }) satisfies LocalLlmResult;
  return { runner };
};

const longContent = 'This is a real conversation about debugging the resolver cache. '.repeat(4);

afterEach(() => {
  resetTitleSweepForTest();
  delete process.env[LOCAL_LLM_ENV];
});

describe('local-llm — flag', () => {
  it('defaults OFF; only 1/true enables', () => {
    delete process.env[LOCAL_LLM_ENV];
    expect(localLlmEnabled()).toBe(false);
    process.env[LOCAL_LLM_ENV] = '0';
    expect(localLlmEnabled()).toBe(false);
    process.env[LOCAL_LLM_ENV] = '1';
    expect(localLlmEnabled()).toBe(true);
    process.env[LOCAL_LLM_ENV] = 'true';
    expect(localLlmEnabled()).toBe(true);
  });
});

describe('local-llm — selectSweepCandidates', () => {
  const contentFor = async (bacId: string) => (bacId === 'empty' ? null : longContent);
  const hashOf = (content: string) => `h-${String(content.length)}`;

  it('selects structurally-junk (empty / URL-shaped) titles', async () => {
    const { eventLog } = makeFakeEventLog([
      threadUpsert('t-empty', ''),
      threadUpsert('t-url', 'https://chatgpt.com/c/abc'),
      threadUpsert('t-real', 'A real descriptive thread title'),
    ]);
    const selected = await selectSweepCandidates(eventLog, contentFor, hashOf, 10);
    const ids = selected.map((c) => c.bacId).sort();
    expect(ids).toEqual(['t-empty', 't-url']);
  });

  it('selects verbatim-recurring titles (≥3 identical) but not a <3 repeat', async () => {
    const { eventLog } = makeFakeEventLog([
      threadUpsert('c1', 'ChatGPT'),
      threadUpsert('c2', 'ChatGPT'),
      threadUpsert('c3', 'ChatGPT'),
      threadUpsert('d1', 'Distinct one'),
      threadUpsert('d2', 'Distinct one'), // only 2 → not recurring
      threadUpsert('u', 'Unique title here'),
    ]);
    const selected = await selectSweepCandidates(eventLog, contentFor, hashOf, 10);
    const ids = selected.map((c) => c.bacId).sort();
    expect(ids).toEqual(['c1', 'c2', 'c3']);
  });

  it('skips a thread already enriched for its CURRENT content hash', async () => {
    const { eventLog } = makeFakeEventLog([threadUpsert('t-empty', '')]);
    // Seed an enrichment event whose clientEventId matches (thread, t-empty,
    // hash-of-current-content) so the skip fires.
    const { enrichmentClientEventId } = await import('./titleEnrichment.js');
    const hash = hashOf(longContent);
    const clientEventId = enrichmentClientEventId('thread', 't-empty', hash);
    const { eventLog: withEnrichment } = makeFakeEventLog([
      threadUpsert('t-empty', ''),
      {
        clientEventId,
        dot: { replicaId: 'r1', seq: 9 },
        deps: {},
        aggregateId: 'enrichment:thread:t-empty',
        type: ENTITY_TITLE_ENRICHED,
        payload: {},
        acceptedAtMs: 9,
      },
    ]);
    void eventLog;
    const selected = await selectSweepCandidates(withEnrichment, contentFor, hashOf, 10);
    expect(selected).toHaveLength(0);
  });

  it('respects the budget', async () => {
    const { eventLog } = makeFakeEventLog([
      threadUpsert('a', ''),
      threadUpsert('b', ''),
      threadUpsert('c', ''),
    ]);
    const selected = await selectSweepCandidates(eventLog, contentFor, hashOf, 2);
    expect(selected).toHaveLength(2);
  });

  it('skips threads whose content is missing or too thin', async () => {
    const { eventLog } = makeFakeEventLog([
      threadUpsert('empty', ''), // contentFor('empty') === null
      threadUpsert('thin', ''),
    ]);
    const thinContent = async (bacId: string) => (bacId === 'thin' ? 'tiny' : null);
    const selected = await selectSweepCandidates(eventLog, thinContent, hashOf, 10);
    expect(selected).toHaveLength(0);
  });
});

describe('local-llm — startTitleSweep', () => {
  const hashOf = (content: string) => `h-${String(content.length)}`;

  it('generates titles and appends one enrichment event per accepted title', async () => {
    const { eventLog, appended } = makeFakeEventLog([
      threadUpsert('t-1', ''),
      threadUpsert('t-2', 'https://x/y'),
    ]);
    const { runner } = makeFakeRunner((id) => `Synth for ${id}`);
    const status = await startTitleSweep({
      vaultRoot: '/tmp/does-not-matter',
      eventLog,
      childRunner: runner,
      contentFor: async () => longContent,
      hashOf,
      now: () => new Date('2026-07-26T00:00:00.000Z'),
    });
    // Returned immediately in running state.
    expect(status.state === 'running' || status.state === 'idle').toBe(true);
    // Let the detached driver finish.
    await waitFor(() => getTitleSweepStatus().state === 'done');
    const final = getTitleSweepStatus();
    expect(final.accepted).toBe(2);
    expect(final.generated).toBe(2);
    expect(final.results).toHaveLength(2);
    expect(final.results[0]?.after).toContain('Synth for');
    expect(final.modelId).toBe(LOCAL_LLM_MODEL_ID);
    const enrichEvents = appended.filter((e) => e.type === ENTITY_TITLE_ENRICHED);
    expect(enrichEvents).toHaveLength(2);
    expect((enrichEvents[0]?.payload as { model?: string }).model).toBe(LOCAL_LLM_MODEL_ID);
  });

  it('is a singleton: a second start while running returns the running status without a second run', async () => {
    const { eventLog } = makeFakeEventLog([threadUpsert('t-1', '')]);
    let resolveRunner: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      resolveRunner = r;
    });
    let runnerCalls = 0;
    const slowRunner: ChildRunner = async (input) => {
      runnerCalls += 1;
      await gate; // block until released
      return {
        results: input.job.items.map((it) => ({ id: it.id, title: 'X title here', ms: 1 })),
      };
    };
    const first = await startTitleSweep({
      vaultRoot: '/tmp/x',
      eventLog,
      childRunner: slowRunner,
      contentFor: async () => longContent,
      hashOf,
    });
    // Give the driver a tick to reach the (blocked) runner.
    await waitFor(() => runnerCalls === 1);
    const second = await startTitleSweep({
      vaultRoot: '/tmp/x',
      eventLog,
      childRunner: slowRunner,
      contentFor: async () => longContent,
      hashOf,
    });
    expect(first.state).toBe('running');
    expect(second.state).toBe('running');
    expect(runnerCalls).toBe(1); // second did NOT spawn another run
    resolveRunner?.();
    await waitFor(() => getTitleSweepStatus().state === 'done');
    expect(runnerCalls).toBe(1);
  });

  it('idempotent append: two sweeps over the same content accept once, then skip', async () => {
    const seed = [threadUpsert('t-1', '')];
    const { eventLog, appended } = makeFakeEventLog(seed);
    const { runner } = makeFakeRunner(() => 'Stable title here');
    await startTitleSweep({
      vaultRoot: '/tmp/x',
      eventLog,
      childRunner: runner,
      contentFor: async () => longContent,
      hashOf,
    });
    await waitFor(() => getTitleSweepStatus().state === 'done');
    expect(getTitleSweepStatus().accepted).toBe(1);
    resetTitleSweepForTest();
    // Second sweep: the selection skip (already-enriched hash) fires, so no
    // candidate survives → done with 0 accepted, and no new event appended.
    await startTitleSweep({
      vaultRoot: '/tmp/x',
      eventLog,
      childRunner: runner,
      contentFor: async () => longContent,
      hashOf,
    });
    await waitFor(() => getTitleSweepStatus().state === 'done');
    expect(getTitleSweepStatus().accepted).toBe(0);
    expect(appended.filter((e) => e.type === ENTITY_TITLE_ENRICHED)).toHaveLength(1);
  });

  it('caps the results list at 20', async () => {
    const seed = Array.from({ length: 25 }, (_v, i) => threadUpsert(`t-${String(i).padStart(2, '0')}`, ''));
    const { eventLog } = makeFakeEventLog(seed);
    const { runner } = makeFakeRunner((id) => `Title ${id}`);
    await startTitleSweep({
      vaultRoot: '/tmp/x',
      eventLog,
      budget: 25,
      childRunner: runner,
      contentFor: async () => longContent,
      hashOf,
    });
    await waitFor(() => getTitleSweepStatus().state === 'done');
    const final = getTitleSweepStatus();
    expect(final.accepted).toBe(25);
    expect(final.results.length).toBe(20); // capped
  });

  it('records an error state when the child runner throws', async () => {
    const { eventLog } = makeFakeEventLog([threadUpsert('t-1', '')]);
    const throwingRunner: ChildRunner = async () => {
      throw new Error('child boom');
    };
    await startTitleSweep({
      vaultRoot: '/tmp/x',
      eventLog,
      childRunner: throwingRunner,
      contentFor: async () => longContent,
      hashOf,
    });
    await waitFor(() => getTitleSweepStatus().state === 'error');
    expect(getTitleSweepStatus().error).toContain('child boom');
  });

  it('a null title (SKIP) is counted skipped only — generated means a REAL title', async () => {
    // `generated` is the honest count of titles the model actually
    // produced; a null (SKIP / thin / per-item error) row must not
    // inflate it (the first live sweep reported "generated: 4" with the
    // model never loaded — the accounting this pins down).
    const { eventLog, appended } = makeFakeEventLog([threadUpsert('t-1', '')]);
    const { runner } = makeFakeRunner(() => null);
    await startTitleSweep({
      vaultRoot: '/tmp/x',
      eventLog,
      childRunner: runner,
      contentFor: async () => longContent,
      hashOf,
    });
    await waitFor(() => getTitleSweepStatus().state === 'done');
    const final = getTitleSweepStatus();
    expect(final.generated).toBe(0);
    expect(final.accepted).toBe(0);
    expect(final.skipped).toBeGreaterThanOrEqual(1);
    expect(appended.filter((e) => e.type === ENTITY_TITLE_ENRICHED)).toHaveLength(0);
  });

  it('a child load failure surfaces as state=error, never a quiet zero-title done', async () => {
    const { eventLog, appended } = makeFakeEventLog([threadUpsert('t-1', '')]);
    const loadFailRunner = async () => ({
      results: [],
      loadError: 'could not load model on any dtype',
    });
    await startTitleSweep({
      vaultRoot: '/tmp/x',
      eventLog,
      childRunner: loadFailRunner,
      contentFor: async () => longContent,
      hashOf,
    });
    await waitFor(() => getTitleSweepStatus().state !== 'running');
    const final = getTitleSweepStatus();
    expect(final.state).toBe('error');
    expect(final.error).toContain('model load failed');
    expect(appended.filter((e) => e.type === ENTITY_TITLE_ENRICHED)).toHaveLength(0);
  });
});

const waitFor = async (predicate: () => boolean, timeoutMs = 3000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise<void>((r) => {
      setTimeout(r, 5);
    });
  }
};
