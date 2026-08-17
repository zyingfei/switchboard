import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { createEventLog, type EventLog } from '../sync/eventLog.js';
import { loadOrCreateReplica } from '../sync/replicaId.js';
import { WORKSTREAM_PROTOTYPE_GENERATED, isPrototypeGeneratedSnapshot } from './events.js';
import type { WorkstreamEvidenceItem } from './prototypeEvidence.js';
import {
  computeEvidenceWatermark,
  decideDirty,
  foldLatestPrototypeGenerations,
  generatePrototypesForWorkstream,
  MAX_STALE_MS,
  MIN_EVIDENCE_FOR_GENERATION,
  MIN_NEW_EVIDENCE_SINCE_LAST,
  produceWorkstreamPrototypes,
  prototypeGenerationCountFor,
  PROTOTYPE_EMBEDDING_SCHEMA_VERSION,
  PROTOTYPE_GENERATION_COUNT_MATURE,
  PROTOTYPE_GENERATION_COUNT_SPARSE,
  type AppleFmClient,
  type EmbedFn,
  type PrototypeStore,
  type WorkstreamGenerationState,
} from './prototypeGeneration.js';

// PROTOTYPE GENERATION v2 — unit tests with a FAKE engine ONLY. The real
// Apple FM engine (appleFmEngine.ts) is never called from this file — every
// test injects a deterministic stub, matching appleFmEngine.test.ts's own
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

// Identical embeddings for every text — keeps medoid selection deterministic
// in these orchestration tests (the medoid ALGORITHM itself, incl. outlier
// exclusion, is covered exhaustively by prototypeMedoids.test.ts against a
// non-degenerate embedding space; this file is about the ORCHESTRATION
// around it — dirty-marking, engine wiring, event/store writes).
const fakeEmbed: EmbedFn = async (texts) => texts.map(() => new Float32Array(4).fill(1));

// ---- decideDirty --------------------------------------------------------

const genState = (over: Partial<WorkstreamGenerationState> = {}): WorkstreamGenerationState => ({
  workstreamId: 'ws-1',
  evidenceWatermark: '5:abc',
  generatedAt: 1000,
  generatorModelId: 'apple-fm#reason=ok',
  method: 'generated',
  prototypeIds: ['p1'],
  embeddingSchemaVersion: PROTOTYPE_EMBEDDING_SCHEMA_VERSION,
  ...over,
});

describe('decideDirty — pure dirty-marking, no full-pass sweeps', () => {
  it('below the cold-start floor: never dirty regardless of watermark/last state', () => {
    const decision = decideDirty(MIN_EVIDENCE_FOR_GENERATION - 1, 'w1', undefined, 0);
    expect(decision).toEqual({ dirty: false, reason: 'below-floor' });
  });

  it('first generation once the floor is cleared and nothing has run yet', () => {
    const decision = decideDirty(MIN_EVIDENCE_FOR_GENERATION, 'w1', undefined, 0);
    expect(decision).toEqual({ dirty: true, reason: 'first-generation' });
  });

  it('unchanged evidence (same watermark, same version) is never dirty — no full re-generation on a no-op tick', () => {
    const last = genState({ evidenceWatermark: '5:abc' });
    const decision = decideDirty(5, '5:abc', last, 1000);
    expect(decision).toEqual({ dirty: false, reason: 'unchanged' });
  });

  it(`fires once evidence grows by >= ${String(MIN_NEW_EVIDENCE_SINCE_LAST)} since the last generation`, () => {
    const last = genState({ evidenceWatermark: '5:abc' });
    const grown = 5 + MIN_NEW_EVIDENCE_SINCE_LAST;
    const decision = decideDirty(grown, `${String(grown)}:def`, last, 1000);
    expect(decision).toEqual({ dirty: true, reason: 'evidence-grew' });
  });

  it('debounces a small evidence change under the growth threshold and under the staleness ceiling', () => {
    const last = genState({ evidenceWatermark: '5:abc', generatedAt: 1_000_000 });
    const grown = 5 + MIN_NEW_EVIDENCE_SINCE_LAST - 1; // one short of the growth trigger
    const decision = decideDirty(grown, `${String(grown)}:def`, last, last.generatedAt + 1000);
    expect(decision).toEqual({ dirty: false, reason: 'debounced' });
  });

  it(`fires after ${String(MAX_STALE_MS / (24 * 60 * 60 * 1000))} days even with no evidence growth`, () => {
    const last = genState({ evidenceWatermark: '5:abc', generatedAt: 1_000_000 });
    const decision = decideDirty(5, '5:xyz', last, last.generatedAt + MAX_STALE_MS);
    expect(decision).toEqual({ dirty: true, reason: 'stale' });
  });

  it('a scoring-version mismatch fires regardless of an otherwise-unchanged watermark (the v1->v2 migration trigger)', () => {
    const last = genState({ evidenceWatermark: '5:abc', embeddingSchemaVersion: 1 });
    const decision = decideDirty(5, '5:abc', last, 1000, 2);
    expect(decision).toEqual({ dirty: true, reason: 'version-bumped' });
  });

  it('a version mismatch below the evidence floor still reports below-floor — nothing to regenerate from', () => {
    const last = genState({ embeddingSchemaVersion: 1 });
    const decision = decideDirty(MIN_EVIDENCE_FOR_GENERATION - 1, 'w1', last, 1000, 2);
    expect(decision).toEqual({ dirty: false, reason: 'below-floor' });
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

// ---- prototypeGenerationCountFor (sparse-workstream boost) ---------------

describe('prototypeGenerationCountFor — sparse-workstream generation boost', () => {
  it('boosts K_gen for a sparse workstream (below the boost-below threshold)', () => {
    expect(prototypeGenerationCountFor(3)).toBe(PROTOTYPE_GENERATION_COUNT_SPARSE);
  });

  it('drops to K_gen=1 for a mature workstream (at/above the threshold)', () => {
    expect(prototypeGenerationCountFor(8)).toBe(PROTOTYPE_GENERATION_COUNT_MATURE);
    expect(prototypeGenerationCountFor(100)).toBe(PROTOTYPE_GENERATION_COUNT_MATURE);
  });
});

// ---- produceWorkstreamPrototypes (medoid tier always-on, generation as expansion) --

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
      return generateImpl ? generateImpl() : 'a plausible new excerpt using different wording';
    },
  };
};

describe('produceWorkstreamPrototypes — medoid tier (always-on) + generation tier (expansion)', () => {
  it('produces K_medoid medoids PLUS the boosted K_gen generated siblings for a sparse english workstream', async () => {
    const client = fakeClient(true);
    const outcome = await produceWorkstreamPrototypes(ENGLISH_ITEMS, 4, { embed: fakeEmbed, client });
    expect(outcome.kind).toBe('produced');
    if (outcome.kind !== 'produced') throw new Error('unreachable');
    const medoids = outcome.prototypes.filter((p) => p.angle === 'medoid');
    const generated = outcome.prototypes.filter((p) => p.angle === 'synthetic-sibling');
    expect(medoids).toHaveLength(4);
    expect(medoids.every((p) => p.method === 'selected')).toBe(true);
    expect(medoids.every((p) => p.sourceMemberUrl !== undefined)).toBe(true);
    // ENGLISH_ITEMS.length (5) < the default boost-below threshold (8).
    expect(generated).toHaveLength(PROTOTYPE_GENERATION_COUNT_SPARSE);
    expect(generated.every((p) => p.method === 'generated')).toBe(true);
    expect(outcome.generationSkippedReason).toBeNull();
    expect(client.statusCalls).toBe(1);
    expect(client.generateCalls).toBe(PROTOTYPE_GENERATION_COUNT_SPARSE);
  });

  it(
    'ZH-DOMINANT EVIDENCE: the medoid tier still runs (real excerpts), generation is never probed ' +
      '(design doc §3 hazard — a broken/English-leaking generated prototype must never be produced)',
    async () => {
      const client = fakeClient(true, () => {
        throw new Error('generate() must never be called for zh-dominant evidence');
      });
      const outcome = await produceWorkstreamPrototypes(CHINESE_ITEMS, 4, { embed: fakeEmbed, client });
      expect(outcome.kind).toBe('produced');
      if (outcome.kind !== 'produced') throw new Error('unreachable');
      expect(outcome.prototypes.length).toBeGreaterThan(0);
      expect(outcome.prototypes.every((p) => p.angle === 'medoid')).toBe(true);
      expect(outcome.prototypes.every((p) => p.method === 'selected')).toBe(true);
      // Every selected text IS a real evidence excerpt — never invented.
      expect(outcome.prototypes.every((p) => p.text === CHINESE_GIST)).toBe(true);
      expect(outcome.generationSkippedReason).toContain('zh');
      expect(client.statusCalls).toBe(0); // never even probed
      expect(client.generateCalls).toBe(0);
    },
  );

  it('mixed-en-zh evidence ALSO skips generation (appleCanServe is english-only) but still medoids', async () => {
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
    const outcome = await produceWorkstreamPrototypes(mixed, 3, { embed: fakeEmbed, client });
    expect(outcome.kind).toBe('produced');
    if (outcome.kind !== 'produced') throw new Error('unreachable');
    expect(outcome.prototypes.every((p) => p.angle === 'medoid')).toBe(true);
    expect(client.generateCalls).toBe(0);
  });

  it('Apple FM unavailable: medoids still land, generation degrades non-fatally', async () => {
    const client = fakeClient(false);
    const outcome = await produceWorkstreamPrototypes(ENGLISH_ITEMS, 4, { embed: fakeEmbed, client });
    expect(outcome.kind).toBe('produced');
    if (outcome.kind !== 'produced') throw new Error('unreachable');
    expect(outcome.prototypes.length).toBeGreaterThan(0);
    expect(outcome.prototypes.every((p) => p.angle === 'medoid')).toBe(true);
    expect(outcome.generationSkippedReason).not.toBeNull();
  });

  it('every generation call failing degrades non-fatally — medoids still land', async () => {
    const client = fakeClient(true, () => null);
    const outcome = await produceWorkstreamPrototypes(ENGLISH_ITEMS, 3, { embed: fakeEmbed, client });
    expect(outcome.kind).toBe('produced');
    if (outcome.kind !== 'produced') throw new Error('unreachable');
    expect(outcome.prototypes.every((p) => p.angle === 'medoid')).toBe(true);
    expect(outcome.generationSkippedReason).toContain('every generation failed');
  });

  it('total embedder failure is the one fatal outcome — nothing can be produced without vectors', async () => {
    const brokenEmbed: EmbedFn = async () => []; // wrong count
    const outcome = await produceWorkstreamPrototypes(ENGLISH_ITEMS, 4, {
      embed: brokenEmbed,
      client: fakeClient(true),
    });
    expect(outcome.kind).toBe('embedder-unavailable');
  });
});

// ---- generatePrototypesForWorkstream (end-to-end, fake engine + store) --

const fakePrototypeStore = (): PrototypeStore & {
  readonly rows: Map<
    string,
    {
      readonly workstreamId: string;
      readonly generatedText: string;
      readonly angle?: 'medoid' | 'synthetic-sibling';
      readonly sourceMemberUrl?: string;
    }
  >;
  deleteCalls: number;
} => {
  const rows = new Map<
    string,
    {
      readonly workstreamId: string;
      readonly generatedText: string;
      readonly angle?: 'medoid' | 'synthetic-sibling';
      readonly sourceMemberUrl?: string;
    }
  >();
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
        ...(row.angle === undefined ? {} : { angle: row.angle }),
        ...(row.sourceMemberUrl === undefined ? {} : { sourceMemberUrl: row.sourceMemberUrl }),
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
          ...(row.angle === undefined ? {} : { angle: row.angle }),
          ...(row.sourceMemberUrl === undefined ? {} : { sourceMemberUrl: row.sourceMemberUrl }),
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

  it('first generation: appends one event per prototype (medoid + generated), writes the store, angle/provenance persisted', async () => {
    const store = fakePrototypeStore();
    const client = fakeClient(true);
    const result = await generatePrototypesForWorkstream(
      { workstreamId: 'ws-kv-cache', items: ENGLISH_ITEMS, last: undefined, nowMs: 1000, count: 4 },
      { eventLog, embed: fakeEmbed, store, client },
    );
    expect(result.outcome).toBe('regenerated');
    expect(result.medoidCount).toBe(4);
    expect(result.generatedCount).toBe(PROTOTYPE_GENERATION_COUNT_SPARSE);
    expect(result.prototypeCount).toBe(4 + PROTOTYPE_GENERATION_COUNT_SPARSE);
    expect(store.rows.size).toBe(4 + PROTOTYPE_GENERATION_COUNT_SPARSE);
    for (const row of store.rows.values()) expect(row.workstreamId).toBe('ws-kv-cache');

    // Angle/source provenance persisted on the STORE rows.
    const medoidRows = [...store.rows.values()].filter((r) => r.angle === 'medoid');
    const generatedRows = [...store.rows.values()].filter((r) => r.angle === 'synthetic-sibling');
    expect(medoidRows).toHaveLength(4);
    expect(generatedRows).toHaveLength(PROTOTYPE_GENERATION_COUNT_SPARSE);
    expect(medoidRows.every((r) => r.sourceMemberUrl !== undefined)).toBe(true);
    expect(generatedRows.every((r) => r.sourceMemberUrl === undefined)).toBe(true);

    // Angle/source provenance ALSO persisted on the durable EVENT log — the
    // brief's "tag every prototype row with angle provenance" and "provenance
    // (member url, evidence watermark)" requirements.
    const events = (await eventLog.readMerged()).filter(
      (e) => e.type === WORKSTREAM_PROTOTYPE_GENERATED,
    );
    expect(events).toHaveLength(4 + PROTOTYPE_GENERATION_COUNT_SPARSE);
    for (const event of events) {
      if (!isPrototypeGeneratedSnapshot(event.payload)) throw new Error('bad payload');
      expect(event.payload.angle === 'medoid' || event.payload.angle === 'synthetic-sibling').toBe(
        true,
      );
      expect(event.payload.embeddingSchemaVersion).toBe(PROTOTYPE_EMBEDDING_SCHEMA_VERSION);
      if (event.payload.angle === 'medoid') {
        expect(event.payload.sourceMemberUrl).toBeDefined();
        expect(ENGLISH_ITEMS.some((i) => i.canonicalUrl === event.payload.sourceMemberUrl)).toBe(
          true,
        );
      } else {
        expect(event.payload.sourceMemberUrl).toBeUndefined();
      }
    }
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
    // circuits before produceWorkstreamPrototypes runs at all.
    expect(client.statusCalls).toBe(1);
    expect(client.generateCalls).toBe(PROTOTYPE_GENERATION_COUNT_SPARSE);
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

  it('engine unavailable: medoid tier STILL refreshes (selection anchors regardless of generation)', async () => {
    const store = fakePrototypeStore();
    await generatePrototypesForWorkstream(
      { workstreamId: 'ws-kv-cache', items: ENGLISH_ITEMS, last: undefined, nowMs: 1000, count: 4 },
      { eventLog, embed: fakeEmbed, store, client: fakeClient(true) },
    );
    expect(store.rows.size).toBe(4 + PROTOTYPE_GENERATION_COUNT_SPARSE);

    // Dirty via evidence growth (>= MIN_NEW_EVIDENCE_SINCE_LAST new items)
    // but the engine is down this time.
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
    // Medoids still refresh — v2's "selection anchors regardless of
    // generation" behavior, a deliberate departure from v1 (where engine-
    // down made the WHOLE regeneration a no-op).
    expect(result.outcome).toBe('regenerated');
    expect(result.medoidCount).toBe(4);
    expect(result.generatedCount).toBe(0);
    expect(result.generationSkippedReason).toBeDefined();
    expect(store.rows.size).toBe(4); // replaced with the fresh medoid-only batch
  });

  it('a scoring-version bump alone (byte-identical evidence) triggers exactly one regeneration', async () => {
    const store = fakePrototypeStore();
    const client = fakeClient(true);
    await generatePrototypesForWorkstream(
      { workstreamId: 'ws-kv-cache', items: ENGLISH_ITEMS, last: undefined, nowMs: 1000, count: 4 },
      { eventLog, embed: fakeEmbed, store, client },
    );
    const priorEvents = await eventLog.readMerged();
    const real = foldLatestPrototypeGenerations(priorEvents).get('ws-kv-cache')!;
    // Simulate a pre-v2 persisted state: same watermark, OLD version.
    const legacyLast: WorkstreamGenerationState = { ...real, embeddingSchemaVersion: 1 };

    const result = await generatePrototypesForWorkstream(
      { workstreamId: 'ws-kv-cache', items: ENGLISH_ITEMS, last: legacyLast, nowMs: 2000, count: 4 },
      { eventLog, embed: fakeEmbed, store, client },
    );
    expect(result.outcome).toBe('regenerated');
    expect(store.deleteCalls).toBe(2); // first generation + the version-bump regen
  });

  it('a mature workstream (>= the boost-below threshold) gets K_gen=1, not the sparse boost', async () => {
    const store = fakePrototypeStore();
    const client = fakeClient(true);
    const matureItems: readonly WorkstreamEvidenceItem[] = Array.from({ length: 10 }, (_unused, i) =>
      item(`https://mature.test/${String(i)}`, { gist: `Evidence excerpt number ${String(i)}.` }),
    );
    const result = await generatePrototypesForWorkstream(
      { workstreamId: 'ws-mature', items: matureItems, last: undefined, nowMs: 1000, count: 4 },
      { eventLog, embed: fakeEmbed, store, client },
    );
    expect(result.outcome).toBe('regenerated');
    expect(result.generatedCount).toBe(PROTOTYPE_GENERATION_COUNT_MATURE);
  });
});

// ---- sentence vectors (§12) — persisted at generation time --------------

interface SentenceVectorCall {
  readonly ownerKind: 'page' | 'prototype';
  readonly ownerId: string;
  readonly sentences: readonly { readonly sentenceIndex: number; readonly source: string; readonly text: string }[];
}

const fakePrototypeStoreWithSentences = (): PrototypeStore & {
  readonly rows: Map<string, { readonly workstreamId: string; readonly generatedText: string; readonly angle?: 'medoid' | 'synthetic-sibling' }>;
  readonly sentenceCalls: SentenceVectorCall[];
} => {
  const rows = new Map<string, { readonly workstreamId: string; readonly generatedText: string; readonly angle?: 'medoid' | 'synthetic-sibling' }>();
  const sentenceCalls: SentenceVectorCall[] = [];
  return {
    rows,
    sentenceCalls,
    vectorBackendAvailable: true,
    upsertPrototype(row) {
      rows.set(row.prototypeId, {
        workstreamId: row.workstreamId,
        generatedText: row.generatedText,
        ...(row.angle === undefined ? {} : { angle: row.angle }),
      });
    },
    deletePrototypesForWorkstream(workstreamId) {
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
          ...(row.angle === undefined ? {} : { angle: row.angle }),
        }));
    },
    allPrototypeWorkstreamIds() {
      return new Set([...rows.values()].map((r) => r.workstreamId));
    },
    queryPrototypeVector() {
      return [];
    },
    replaceSentenceVectors(ownerKind, ownerId, sentences) {
      sentenceCalls.push({
        ownerKind,
        ownerId,
        sentences: sentences.map((s) => ({ sentenceIndex: s.sentenceIndex, source: s.source, text: s.text })),
      });
    },
  };
};

describe('generatePrototypesForWorkstream — sentence vectors (§12) persisted at generation time', () => {
  let vaultRoot: string;
  let eventLog: EventLog;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-prototype-sentences-'));
    const replica = await loadOrCreateReplica(vaultRoot);
    eventLog = createEventLog(vaultRoot, replica);
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('splits + embeds every produced prototype text and calls replaceSentenceVectors per prototype', async () => {
    const store = fakePrototypeStoreWithSentences();
    const client = fakeClient(true, () => 'A generated sibling excerpt in different words.');
    const multiSentenceItems: readonly WorkstreamEvidenceItem[] = ENGLISH_ITEMS.map((entry, i) =>
      i === 0
        ? { ...entry, gist: 'First claim about KV caches. Second claim about memory usage.' }
        : entry,
    );
    const result = await generatePrototypesForWorkstream(
      { workstreamId: 'ws-sentences', items: multiSentenceItems, last: undefined, nowMs: 1000, count: 4 },
      { eventLog, embed: fakeEmbed, store, client },
    );
    expect(result.outcome).toBe('regenerated');
    // One replaceSentenceVectors call per produced prototype (medoid + generated).
    expect(store.sentenceCalls.length).toBe(store.rows.size);
    expect(store.sentenceCalls.every((call) => call.ownerKind === 'prototype')).toBe(true);
    // The multi-sentence medoid's excerpt split into 2 sentences.
    const multiSentenceCall = store.sentenceCalls.find((call) => call.sentences.length > 1);
    expect(multiSentenceCall).toBeDefined();
    expect(multiSentenceCall!.sentences[0]!.text).toContain('First claim');
    expect(multiSentenceCall!.sentences[1]!.text).toContain('Second claim');
  });

  it('regeneration clears the PRIOR generation batch\'s sentence rows via deletePrototypesForWorkstream (owner ids differ per watermark)', async () => {
    const store = fakePrototypeStoreWithSentences();
    const client = fakeClient(true);
    await generatePrototypesForWorkstream(
      { workstreamId: 'ws-regen', items: ENGLISH_ITEMS, last: undefined, nowMs: 1000, count: 4 },
      { eventLog, embed: fakeEmbed, store, client },
    );
    const firstBatchCalls = store.sentenceCalls.length;
    expect(firstBatchCalls).toBeGreaterThan(0);
    const priorEvents = await eventLog.readMerged();
    const last = foldLatestPrototypeGenerations(priorEvents).get('ws-regen');
    const grown = [
      ...ENGLISH_ITEMS,
      item('https://a.test/6', { gist: 'A sixth piece of evidence to force regeneration.' }),
      item('https://a.test/7', { gist: 'A seventh piece of evidence to force regeneration.' }),
      item('https://a.test/8', { gist: 'An eighth piece of evidence to force regeneration.' }),
      item('https://a.test/9', { gist: 'A ninth piece of evidence to force regeneration.' }),
      item('https://a.test/10', { gist: 'A tenth piece of evidence to force regeneration.' }),
    ];
    await generatePrototypesForWorkstream(
      { workstreamId: 'ws-regen', items: grown, last, nowMs: 2000, count: 4 },
      { eventLog, embed: fakeEmbed, store, client },
    );
    // A fresh batch of replaceSentenceVectors calls landed for the NEW
    // prototypeIds (each regeneration's ids embed the evidence watermark, so
    // they never collide with the prior batch's ids).
    expect(store.sentenceCalls.length).toBeGreaterThan(firstBatchCalls);
  });

  it('a store without replaceSentenceVectors (pre-§12 fixture) is skipped without error', async () => {
    const store = fakePrototypeStore(); // the ORIGINAL fixture — no replaceSentenceVectors
    const client = fakeClient(true);
    const result = await generatePrototypesForWorkstream(
      { workstreamId: 'ws-legacy-store', items: ENGLISH_ITEMS, last: undefined, nowMs: 1000, count: 4 },
      { eventLog, embed: fakeEmbed, store, client },
    );
    expect(result.outcome).toBe('regenerated');
  });

  it('a failing embed for sentences never blocks prototype generation itself', async () => {
    const store = fakePrototypeStoreWithSentences();
    const client = fakeClient(true);
    let calls = 0;
    const flakyEmbed: EmbedFn = async (texts) => {
      calls += 1;
      if (calls > 1) throw new Error('embed down');
      return texts.map(() => new Float32Array(4).fill(1));
    };
    const result = await generatePrototypesForWorkstream(
      { workstreamId: 'ws-flaky-embed', items: ENGLISH_ITEMS, last: undefined, nowMs: 1000, count: 4 },
      { eventLog, embed: flakyEmbed, store, client },
    );
    expect(result.outcome).toBe('regenerated');
    expect(store.rows.size).toBeGreaterThan(0);
  });
});
