import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { createEventLog, type EventLog } from '../sync/eventLog.js';
import { loadOrCreateReplica } from '../sync/replicaId.js';
import { WORKSTREAM_PROTOTYPE_GENERATED } from './events.js';
import type { WorkstreamEvidenceItem } from './prototypeEvidence.js';
import {
  computeEvidenceWatermark,
  decideDirty,
  foldLatestPrototypeGenerations,
  generatePrototypesForWorkstream,
  MAX_STALE_MS,
  MIN_EVIDENCE_FOR_GENERATION,
  MIN_NEW_EVIDENCE_SINCE_LAST,
  producePrototypeTexts,
  type AppleFmClient,
  type EmbedFn,
  type PrototypeStore,
  type WorkstreamGenerationState,
} from './prototypeGeneration.js';

// PROTOTYPE GENERATION — unit tests with a FAKE engine ONLY. The real Apple
// FM engine (appleFmEngine.ts) is never called from this file — every test
// injects a deterministic stub, matching appleFmEngine.test.ts's own
// hermeticity discipline (a test's result must never depend on whether
// `apfel --serve` happens to be running on the machine executing it).

const item = (
  canonicalUrl: string,
  opts: { readonly title?: string; readonly gist?: string; readonly atMs?: number } = {},
): WorkstreamEvidenceItem => ({
  canonicalUrl,
  title: opts.title ?? null,
  gist: opts.gist ?? null,
  firstSeenAtMs: opts.atMs ?? 1_700_000_000_000,
});

const ENGLISH_ITEMS: readonly WorkstreamEvidenceItem[] = [
  item('https://a.test/1', {
    gist: 'A deep dive into KV-cache compression for transformer inference.',
  }),
  item('https://a.test/2', {
    gist: 'Benchmarking speculative decoding against vanilla autoregressive sampling.',
  }),
  item('https://a.test/3', { title: 'Paged attention and memory-efficient serving' }),
  item('https://a.test/4', {
    gist: 'Notes on quantizing the KV cache to int8 without quality loss.',
  }),
  item('https://a.test/5', { title: 'A survey of long-context inference tricks' }),
];

const CHINESE_GIST =
  '这是一篇关于机器学习模型训练与优化方法的详细文章，讨论了梯度下降与正则化技术。';
const CHINESE_ITEMS: readonly WorkstreamEvidenceItem[] = Array.from({ length: 5 }, (_unused, i) =>
  item(`https://zh.test/${String(i)}`, { gist: CHINESE_GIST }),
);

// ---- decideDirty --------------------------------------------------------

describe('decideDirty — pure dirty-marking, no full-pass sweeps', () => {
  it('below the cold-start floor: never dirty regardless of watermark/last state', () => {
    const decision = decideDirty(MIN_EVIDENCE_FOR_GENERATION - 1, 'w1', undefined, 0);
    expect(decision).toEqual({ dirty: false, reason: 'below-floor' });
  });

  it('first generation once the floor is cleared and nothing has run yet', () => {
    const decision = decideDirty(MIN_EVIDENCE_FOR_GENERATION, 'w1', undefined, 0);
    expect(decision).toEqual({ dirty: true, reason: 'first-generation' });
  });

  it('unchanged evidence (same watermark) is never dirty — no full re-generation on a no-op tick', () => {
    const last: WorkstreamGenerationState = {
      workstreamId: 'ws-1',
      evidenceWatermark: '5:abc',
      generatedAt: 1000,
      generatorModelId: 'apple-fm#reason=ok',
      method: 'generated',
      prototypeIds: ['p1'],
    };
    const decision = decideDirty(5, '5:abc', last, 1000);
    expect(decision).toEqual({ dirty: false, reason: 'unchanged' });
  });

  it(`fires once evidence grows by >= ${String(MIN_NEW_EVIDENCE_SINCE_LAST)} since the last generation`, () => {
    const last: WorkstreamGenerationState = {
      workstreamId: 'ws-1',
      evidenceWatermark: '5:abc',
      generatedAt: 1000,
      generatorModelId: 'apple-fm#reason=ok',
      method: 'generated',
      prototypeIds: ['p1'],
    };
    const grown = 5 + MIN_NEW_EVIDENCE_SINCE_LAST;
    const decision = decideDirty(grown, `${String(grown)}:def`, last, 1000);
    expect(decision).toEqual({ dirty: true, reason: 'evidence-grew' });
  });

  it('debounces a small evidence change under the growth threshold and under the staleness ceiling', () => {
    const last: WorkstreamGenerationState = {
      workstreamId: 'ws-1',
      evidenceWatermark: '5:abc',
      generatedAt: 1_000_000,
      generatorModelId: 'apple-fm#reason=ok',
      method: 'generated',
      prototypeIds: ['p1'],
    };
    const grown = 5 + MIN_NEW_EVIDENCE_SINCE_LAST - 1; // one short of the growth trigger
    const decision = decideDirty(grown, `${String(grown)}:def`, last, last.generatedAt + 1000);
    expect(decision).toEqual({ dirty: false, reason: 'debounced' });
  });

  it(`fires after ${String(MAX_STALE_MS / (24 * 60 * 60 * 1000))} days even with no evidence growth`, () => {
    const last: WorkstreamGenerationState = {
      workstreamId: 'ws-1',
      evidenceWatermark: '5:abc',
      generatedAt: 1_000_000,
      generatorModelId: 'apple-fm#reason=ok',
      method: 'generated',
      prototypeIds: ['p1'],
    };
    const decision = decideDirty(5, '5:xyz', last, last.generatedAt + MAX_STALE_MS);
    expect(decision).toEqual({ dirty: true, reason: 'stale' });
  });
});

// ---- computeEvidenceWatermark -------------------------------------------

describe('computeEvidenceWatermark', () => {
  it('is order-independent (a same-set evidence corpus always hashes identically)', () => {
    const forward = computeEvidenceWatermark(ENGLISH_ITEMS);
    const shuffled = computeEvidenceWatermark([...ENGLISH_ITEMS].reverse());
    expect(forward).toBe(shuffled);
  });

  it('encodes the evidence count as a parseable prefix', () => {
    const watermark = computeEvidenceWatermark(ENGLISH_ITEMS);
    expect(watermark.startsWith(`${String(ENGLISH_ITEMS.length)}:`)).toBe(true);
  });

  it('changes when any excerpt text changes, even at the same count', () => {
    const changed = [...ENGLISH_ITEMS];
    changed[0] = item('https://a.test/1', { gist: 'A totally different summary now.' });
    expect(computeEvidenceWatermark(changed)).not.toBe(computeEvidenceWatermark(ENGLISH_ITEMS));
  });
});

// ---- producePrototypeTexts (the language gate) --------------------------

const fakeClient = (
  available: boolean,
  generateImpl?: () => string | null,
): AppleFmClient & { statusCalls: number; generateCalls: number } => {
  const counts = { statusCalls: 0, generateCalls: 0 };
  return {
    get statusCalls() {
      return counts.statusCalls;
    },
    get generateCalls() {
      return counts.generateCalls;
    },
    status: async () => {
      counts.statusCalls += 1;
      return available
        ? { available: true, contextTokens: 4096, modelId: 'apple-foundationmodel', reason: 'ok' }
        : {
            available: false,
            contextTokens: 4096,
            modelId: 'apple-foundationmodel',
            reason: 'not-running',
          };
    },
    generate: async () => {
      counts.generateCalls += 1;
      return generateImpl ? generateImpl() : 'a generated example about this collection';
    },
  };
};

describe('producePrototypeTexts — Apple FM for English, ReDE-RF selection otherwise', () => {
  it('generates m texts on Apple FM for english-dominant evidence', async () => {
    const client = fakeClient(true);
    const outcome = await producePrototypeTexts(ENGLISH_ITEMS, 4, client);
    expect(outcome.kind).toBe('texts');
    if (outcome.kind !== 'texts') throw new Error('unreachable');
    expect(outcome.texts).toHaveLength(4);
    expect(outcome.texts.every((t) => t.method === 'generated')).toBe(true);
    expect(outcome.generatorModelId.startsWith('apple-fm')).toBe(true);
    expect(client.statusCalls).toBe(1);
    expect(client.generateCalls).toBe(4);
  });

  it(
    'ZH-DOMINANT EVIDENCE SKIPS GENERATION ENTIRELY: the engine is never probed or called ' +
      '(design doc §3 hazard — a broken/English-leaking zh prototype must never be produced)',
    async () => {
      const client = fakeClient(true, () => {
        throw new Error('generate() must never be called for zh-dominant evidence');
      });
      const outcome = await producePrototypeTexts(CHINESE_ITEMS, 4, client);
      expect(outcome.kind).toBe('texts');
      if (outcome.kind !== 'texts') throw new Error('unreachable');
      expect(outcome.texts.every((t) => t.method === 'selected')).toBe(true);
      // Every selected text IS a real evidence excerpt — never invented.
      expect(outcome.texts.every((t) => t.text === CHINESE_GIST)).toBe(true);
      expect(outcome.generatorModelId).toBe('evidence-selection#reason=zh');
      expect(client.statusCalls).toBe(0); // never even probed
      expect(client.generateCalls).toBe(0);
    },
  );

  it('mixed-en-zh evidence ALSO selects rather than generates (appleCanServe is english-only)', async () => {
    const mixed: readonly WorkstreamEvidenceItem[] = [
      item('https://mix.test/1', {
        gist: 'Notes on 深度学习模型 with English commentary mixed in.',
      }),
      item('https://mix.test/2', {
        gist: 'More 神经网络架构 notes, mostly English prose around it.',
      }),
      item('https://mix.test/3', { gist: 'A third excerpt on 强化学习方法 in English sentences.' }),
      item('https://mix.test/4', { gist: 'Fourth excerpt on 卷积神经网络设计, English-led.' }),
      item('https://mix.test/5', { gist: 'Fifth excerpt on 优化算法研究, mostly English again.' }),
    ];
    const client = fakeClient(true, () => {
      throw new Error('generate() must never be called for mixed-en-zh evidence');
    });
    const outcome = await producePrototypeTexts(mixed, 3, client);
    expect(outcome.kind).toBe('texts');
    if (outcome.kind !== 'texts') throw new Error('unreachable');
    expect(outcome.texts.every((t) => t.method === 'selected')).toBe(true);
    expect(client.generateCalls).toBe(0);
  });

  it('reports engine-unavailable (not an error) when Apple FM is not reachable', async () => {
    const client = fakeClient(false);
    const outcome = await producePrototypeTexts(ENGLISH_ITEMS, 4, client);
    expect(outcome.kind).toBe('engine-unavailable');
    if (outcome.kind !== 'engine-unavailable') throw new Error('unreachable');
    expect(outcome.reason.length).toBeGreaterThan(0);
  });

  it('reports engine-unavailable when every generation call fails', async () => {
    const client = fakeClient(true, () => null);
    const outcome = await producePrototypeTexts(ENGLISH_ITEMS, 3, client);
    expect(outcome.kind).toBe('engine-unavailable');
  });
});

// ---- generatePrototypesForWorkstream (end-to-end, fake engine + store) --

const fakePrototypeStore = (): PrototypeStore & {
  readonly rows: Map<string, { readonly workstreamId: string; readonly generatedText: string }>;
  deleteCalls: number;
} => {
  const rows = new Map<string, { readonly workstreamId: string; readonly generatedText: string }>();
  let deleteCalls = 0;
  return {
    get deleteCalls() {
      return deleteCalls;
    },
    set deleteCalls(v: number) {
      deleteCalls = v;
    },
    rows,
    vectorBackendAvailable: true,
    upsertPrototype(row) {
      rows.set(row.prototypeId, {
        workstreamId: row.workstreamId,
        generatedText: row.generatedText,
      });
    },
    deletePrototypesForWorkstream(workstreamId) {
      deleteCalls += 1;
      for (const [id, row] of rows) {
        if (row.workstreamId === workstreamId) rows.delete(id);
      }
    },
    listPrototypesForWorkstream(workstreamId) {
      return [...rows.entries()]
        .filter(([, row]) => row.workstreamId === workstreamId)
        .map(([prototypeId, row]) => ({
          prototypeId,
          generatedText: row.generatedText,
          generatorModelId: 'apple-fm#reason=ok',
          method: 'generated' as const,
          generatedAt: 0,
          evidenceWatermark: '',
        }));
    },
    allPrototypeWorkstreamIds() {
      return new Set([...rows.values()].map((r) => r.workstreamId));
    },
    queryPrototypeVector() {
      return [];
    },
  };
};

const fakeEmbed: EmbedFn = async (texts) => texts.map(() => new Float32Array(4).fill(1));

describe('generatePrototypesForWorkstream — end-to-end with a fake engine + fake store', () => {
  let vaultRoot: string;
  let eventLog: EventLog;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-prototype-gen-'));
    const replica = await loadOrCreateReplica(vaultRoot);
    eventLog = createEventLog(vaultRoot, replica);
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('below the cold-start floor: no event, no store write', async () => {
    const store = fakePrototypeStore();
    const client = fakeClient(true);
    const result = await generatePrototypesForWorkstream(
      {
        workstreamId: 'ws-thin',
        items: ENGLISH_ITEMS.slice(0, 2),
        last: undefined,
        nowMs: 1000,
        count: 4,
      },
      { eventLog, embed: fakeEmbed, store, client },
    );
    expect(result.outcome).toBe('below-floor');
    expect(store.rows.size).toBe(0);
  });

  it('first generation: appends one event per prototype and writes the store', async () => {
    const store = fakePrototypeStore();
    const client = fakeClient(true);
    const result = await generatePrototypesForWorkstream(
      { workstreamId: 'ws-kv-cache', items: ENGLISH_ITEMS, last: undefined, nowMs: 1000, count: 4 },
      { eventLog, embed: fakeEmbed, store, client },
    );
    expect(result.outcome).toBe('regenerated');
    expect(result.prototypeCount).toBe(4);
    expect(store.rows.size).toBe(4);
    for (const row of store.rows.values()) expect(row.workstreamId).toBe('ws-kv-cache');

    const events = (await eventLog.readMerged()).filter(
      (e) => e.type === WORKSTREAM_PROTOTYPE_GENERATED,
    );
    expect(events).toHaveLength(4);
  });

  it('unchanged evidence on the next tick: no regeneration, no duplicate writes', async () => {
    const store = fakePrototypeStore();
    const client = fakeClient(true);
    await generatePrototypesForWorkstream(
      { workstreamId: 'ws-kv-cache', items: ENGLISH_ITEMS, last: undefined, nowMs: 1000, count: 4 },
      { eventLog, embed: fakeEmbed, store, client },
    );
    const priorEvents = await eventLog.readMerged();
    const last = foldLatestPrototypeGenerations(priorEvents).get('ws-kv-cache');
    expect(last).toBeDefined();

    const result = await generatePrototypesForWorkstream(
      { workstreamId: 'ws-kv-cache', items: ENGLISH_ITEMS, last, nowMs: 2000, count: 4 },
      { eventLog, embed: fakeEmbed, store, client },
    );
    expect(result.outcome).toBe('unchanged');
    // The engine was never touched a second time — the debounce short-
    // circuits before producePrototypeTexts runs at all.
    expect(client.statusCalls).toBe(1);
    expect(client.generateCalls).toBe(4);
    expect(store.deleteCalls).toBe(1); // only from the first (real) generation
  });

  it('embedder failure degrades to embedder-unavailable — no event, no store write', async () => {
    const store = fakePrototypeStore();
    const client = fakeClient(true);
    const brokenEmbed: EmbedFn = async () => []; // wrong count
    const result = await generatePrototypesForWorkstream(
      {
        workstreamId: 'ws-broken-embed',
        items: ENGLISH_ITEMS,
        last: undefined,
        nowMs: 1000,
        count: 4,
      },
      { eventLog, embed: brokenEmbed, store, client },
    );
    expect(result.outcome).toBe('embedder-unavailable');
    expect(store.rows.size).toBe(0);
    const events = (await eventLog.readMerged()).filter(
      (e) => e.type === WORKSTREAM_PROTOTYPE_GENERATED,
    );
    expect(events).toHaveLength(0);
  });

  it('engine unavailable: prior standing prototypes are left untouched', async () => {
    const store = fakePrototypeStore();
    await generatePrototypesForWorkstream(
      { workstreamId: 'ws-kv-cache', items: ENGLISH_ITEMS, last: undefined, nowMs: 1000, count: 4 },
      { eventLog, embed: fakeEmbed, store, client: fakeClient(true) },
    );
    expect(store.rows.size).toBe(4);

    // Dirty via evidence growth (>= MIN_NEW_EVIDENCE_SINCE_LAST new items)
    // but the engine is down this time — must not touch the ALREADY-
    // standing prototypes above.
    const grown = [
      ...ENGLISH_ITEMS,
      ...Array.from({ length: MIN_NEW_EVIDENCE_SINCE_LAST }, (_unused, i) =>
        item(`https://a.test/new-${String(i)}`, { title: `new evidence ${String(i)}` }),
      ),
    ];
    const priorEvents = await eventLog.readMerged();
    const last = foldLatestPrototypeGenerations(priorEvents).get('ws-kv-cache');
    const result = await generatePrototypesForWorkstream(
      { workstreamId: 'ws-kv-cache', items: grown, last, nowMs: 2000, count: 4 },
      { eventLog, embed: fakeEmbed, store, client: fakeClient(false) },
    );
    expect(result.outcome).toBe('engine-unavailable');
    expect(store.rows.size).toBe(4); // untouched, not deleted
  });
});
