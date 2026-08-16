import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ANNOTATION_CREATED } from '../annotations/events.js';
import { nodeIdFor } from '../connections/types.js';
import { DISPATCH_RECORDED } from '../dispatches/events.js';
import { CAPTURE_RECORDED } from '../recall/events.js';
import { createCaptureTextFtsStore } from './captureTextFtsStore.js';
import { matchesWholeWordQuery } from './searchTextMatch.js';
import type { AcceptedEvent } from '../sync/causal.js';

const sqliteIt = process.versions['bun'] === undefined ? it.skip : it;

// dot.seq is scoped PER REPLICA — a shared global counter would
// silently misrepresent multi-replica fixtures, so track one counter
// per replicaId (mirrors searchQueryIndexStore.test.ts).
let seqCounters = new Map<string, number>();
const nextSeq = (replicaId: string): number => {
  const next = (seqCounters.get(replicaId) ?? 0) + 1;
  seqCounters.set(replicaId, next);
  return next;
};

const captureEvent = (input: {
  readonly replicaId: string;
  readonly bacId: string;
  readonly threadId: string;
  readonly acceptedAtMs: number;
  readonly turns: readonly { text: string; markdown?: string; formattedText?: string }[];
}): AcceptedEvent => {
  const seq = nextSeq(input.replicaId);
  return {
    clientEventId: `capture-${input.replicaId}-${String(seq)}`,
    dot: { replicaId: input.replicaId, seq },
    deps: {},
    aggregateId: `capture.recorded:${input.bacId}`,
    type: CAPTURE_RECORDED,
    payload: {
      bac_id: input.bacId,
      threadId: input.threadId,
      capturedAt: new Date(input.acceptedAtMs).toISOString(),
      turns: input.turns,
      payloadVersion: 1,
    },
    acceptedAtMs: input.acceptedAtMs,
  };
};

const dispatchEvent = (input: {
  readonly replicaId: string;
  readonly bacId: string;
  readonly body: string;
  readonly acceptedAtMs: number;
}): AcceptedEvent => {
  const seq = nextSeq(input.replicaId);
  return {
    clientEventId: `dispatch-${input.replicaId}-${String(seq)}`,
    dot: { replicaId: input.replicaId, seq },
    deps: {},
    aggregateId: `dispatch.recorded:${input.bacId}`,
    type: DISPATCH_RECORDED,
    payload: {
      bac_id: input.bacId,
      target: { provider: 'chatgpt' },
      createdAt: new Date(input.acceptedAtMs).toISOString(),
      body: input.body,
      payloadVersion: 1,
    },
    acceptedAtMs: input.acceptedAtMs,
  };
};

const annotationEvent = (input: {
  readonly replicaId: string;
  readonly bacId: string;
  readonly note: string;
  readonly acceptedAtMs: number;
}): AcceptedEvent => {
  const seq = nextSeq(input.replicaId);
  return {
    clientEventId: `annotation-${input.replicaId}-${String(seq)}`,
    dot: { replicaId: input.replicaId, seq },
    deps: {},
    aggregateId: `annotation.created:${input.bacId}`,
    type: ANNOTATION_CREATED,
    payload: {
      bac_id: input.bacId,
      url: 'https://example.com/page',
      note: input.note,
      anchor: {
        textQuote: { exact: 'x', prefix: '', suffix: '' },
        textPosition: { start: 0, end: 1 },
        cssSelector: 'body',
      },
      payloadVersion: 1,
    },
    acceptedAtMs: input.acceptedAtMs,
  };
};

const irrelevantEvent = (replicaId: string, acceptedAtMs: number): AcceptedEvent => {
  const seq = nextSeq(replicaId);
  return {
    clientEventId: `priv-${replicaId}-${String(seq)}`,
    dot: { replicaId, seq },
    deps: {},
    aggregateId: 'privacy',
    type: 'privacy.gate.flipped',
    payload: { payloadVersion: 1, gate: 'timeline', state: 'open' },
    acceptedAtMs,
  };
};

describe('CaptureTextFtsStore', () => {
  const dirs: string[] = [];
  // Per-replica seq counters are module-level; reset per-test so
  // watermark assertions are test-local.
  beforeEach(() => {
    seqCounters = new Map();
  });
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  const tempVault = async (): Promise<string> => {
    const d = await mkdtemp(join(tmpdir(), 'capture-text-fts-'));
    dirs.push(d);
    await mkdir(join(d, '_BAC', 'connections'), { recursive: true });
    return d;
  };

  sqliteIt('indexes capture/dispatch/annotation text and matches whole words', async () => {
    const vault = await tempVault();
    const store = await createCaptureTextFtsStore(vault);
    store.ingestMany([
      captureEvent({
        replicaId: 'replica-a',
        bacId: 'cap-1',
        threadId: 'thread-1',
        acceptedAtMs: Date.parse('2026-08-16T10:00:00.000Z'),
        turns: [{ text: 'I looked up GraphQL federation patterns.' }],
      }),
      dispatchEvent({
        replicaId: 'replica-a',
        bacId: 'disp-1',
        body: 'Please summarize GraphQL federation for me.',
        acceptedAtMs: Date.parse('2026-08-16T10:05:00.000Z'),
      }),
      annotationEvent({
        replicaId: 'replica-a',
        bacId: 'anno-1',
        note: 'GraphQL federation is relevant here.',
        acceptedAtMs: Date.parse('2026-08-16T10:10:00.000Z'),
      }),
    ]);
    const matches = store.matchWholeWord('graphql federation');
    store.close();
    expect(matches).toHaveLength(3);
    const byKind = new Map(matches.map((m) => [m.docKind, m]));
    expect(byKind.get('capture')?.nodeId).toBe(nodeIdFor('thread', 'thread-1'));
    expect(byKind.get('capture')?.docId).toBe('cap-1');
    expect(byKind.get('capture')?.eventType).toBe(CAPTURE_RECORDED);
    expect(byKind.get('dispatch')?.nodeId).toBe(nodeIdFor('dispatch', 'disp-1'));
    expect(byKind.get('annotation')?.nodeId).toBe(nodeIdFor('annotation', 'anno-1'));
  });

  sqliteIt('does not index events with empty text', async () => {
    const vault = await tempVault();
    const store = await createCaptureTextFtsStore(vault);
    const minted = store.ingestMany([
      captureEvent({
        replicaId: 'replica-a',
        bacId: 'cap-empty',
        threadId: 'thread-1',
        acceptedAtMs: Date.parse('2026-08-16T10:00:00.000Z'),
        turns: [{ text: '' }],
      }),
      irrelevantEvent('replica-a', Date.parse('2026-08-16T10:01:00.000Z')),
    ]);
    store.close();
    expect(minted).toBe(0);
  });

  sqliteIt('substring trap: "go" does not match "google" (whole-word only)', async () => {
    const vault = await tempVault();
    const store = await createCaptureTextFtsStore(vault);
    store.ingestMany([
      captureEvent({
        replicaId: 'replica-a',
        bacId: 'cap-1',
        threadId: 'thread-1',
        acceptedAtMs: Date.parse('2026-08-16T10:00:00.000Z'),
        turns: [{ text: 'google search results for rust' }],
      }),
    ]);
    const goMatches = store.matchWholeWord('go');
    const rustMatches = store.matchWholeWord('rust');
    store.close();
    expect(goMatches).toHaveLength(0);
    expect(rustMatches).toHaveLength(1);
  });

  sqliteIt('ingest is idempotent by (replicaId, seq): re-ingest does not duplicate rows', async () => {
    const vault = await tempVault();
    const store = await createCaptureTextFtsStore(vault);
    const events = [
      captureEvent({
        replicaId: 'replica-a',
        bacId: 'cap-1',
        threadId: 'thread-1',
        acceptedAtMs: Date.parse('2026-08-16T10:00:00.000Z'),
        turns: [{ text: 'idempotent reingest test' }],
      }),
    ];
    store.ingestMany(events);
    const before = store.matchWholeWord('idempotent');
    const beforeWatermark = store.watermark();
    store.ingestMany(events);
    store.ingestMany(events);
    const after = store.matchWholeWord('idempotent');
    const afterWatermark = store.watermark();
    store.close();
    expect(after).toEqual(before);
    expect(after).toHaveLength(1);
    expect(afterWatermark).toEqual(beforeWatermark);
  });

  sqliteIt('multi-replica watermark independence', async () => {
    const vault = await tempVault();
    const store = await createCaptureTextFtsStore(vault);
    store.ingestMany([
      captureEvent({
        replicaId: 'replica-a',
        bacId: 'cap-a-1',
        threadId: 'thread-1',
        acceptedAtMs: Date.parse('2026-08-16T10:00:00.000Z'),
        turns: [{ text: 'alpha' }],
      }),
      captureEvent({
        replicaId: 'replica-a',
        bacId: 'cap-a-2',
        threadId: 'thread-1',
        acceptedAtMs: Date.parse('2026-08-16T10:01:00.000Z'),
        turns: [{ text: 'beta' }],
      }),
      dispatchEvent({
        replicaId: 'replica-b',
        bacId: 'disp-b-1',
        body: 'gamma',
        acceptedAtMs: Date.parse('2026-08-16T10:02:00.000Z'),
      }),
    ]);
    const wm = store.watermark();
    store.close();
    expect(wm['replica-a']).toBe(2);
    expect(wm['replica-b']).toBe(1);
  });

  sqliteIt('catchUp ingests only events past the watermark', async () => {
    const vault = await tempVault();
    const store = await createCaptureTextFtsStore(vault);
    const events = [
      captureEvent({
        replicaId: 'replica-a',
        bacId: 'cap-1',
        threadId: 'thread-1',
        acceptedAtMs: Date.parse('2026-08-16T10:00:00.000Z'),
        turns: [{ text: 'first document' }],
      }),
      captureEvent({
        replicaId: 'replica-a',
        bacId: 'cap-2',
        threadId: 'thread-1',
        acceptedAtMs: Date.parse('2026-08-16T10:01:00.000Z'),
        turns: [{ text: 'second document' }],
      }),
    ];
    store.ingestMany(events.slice(0, 1));
    const added = await store.catchUp(events);
    const matches = store.matchWholeWord('document');
    store.close();
    expect(added).toBe(1);
    expect(matches).toHaveLength(2);
  });

  sqliteIt('rebuildFromJsonl reproduces the same index from the raw log', async () => {
    const vault = await tempVault();
    const events = [
      captureEvent({
        replicaId: 'replica-a',
        bacId: 'cap-1',
        threadId: 'thread-1',
        acceptedAtMs: Date.parse('2026-08-16T10:00:00.000Z'),
        turns: [{ text: 'rebuild target document' }],
      }),
    ];
    const logRoot = join(vault, '_BAC', 'log');
    await mkdir(join(logRoot, 'replica-a'), { recursive: true });
    await writeFile(
      join(logRoot, 'replica-a', '0001.jsonl'),
      `${events.map((e) => JSON.stringify(e)).join('\n')}\nnot-json\n`,
      'utf8',
    );
    const store = await createCaptureTextFtsStore(vault);
    await store.rebuildFromJsonl(logRoot);
    const matches = store.matchWholeWord('rebuild');
    const wm = store.watermark();
    store.close();
    expect(matches).toHaveLength(1);
    expect(wm['replica-a']).toBe(1);
  });

  // AMENDMENT 1 (docs/plans/2026-08-16-f8-ivm-designs.md, W2 section):
  // FTS5 MATCH prefilter + JS whole-word postfilter must return
  // EXACTLY the set a brute-force JS scan over the same corpus would
  // return, across unicode / punctuation / case / substring-trap
  // cases. `expectedDocText` below reproduces (outside the store) the
  // exact same per-doc text the store derives on ingest, so the
  // brute-force comparison exercises the SAME extraction the store
  // performs on each event.
  describe('FTS + postfilter parity vs. brute-force JS scan', () => {
    interface Doc {
      readonly docId: string;
      readonly text: string;
    }
    const docs: readonly Doc[] = [
      { docId: 'plain', text: 'I love GraphQL apis and GraphQL tooling.' },
      { docId: 'substring-trap', text: 'google search results, going nowhere, goggles' },
      { docId: 'case', text: 'SEARCH engines vs search engines vs Search Engines' },
      { docId: 'punctuation', text: 'cost is $5 today, (discounted), state-of-the-art pricing' },
      // Accented word at a whitespace/punctuation edge — the documented
      // JS \b-vs-Unicode quirk (see searchTextMatch.test.ts).
      { docId: 'unicode-edge', text: 'I love café. It is my favorite café' },
      // Accented word with ASCII edges on both sides.
      { docId: 'unicode-phrase', text: 'ordering a café au lait today' },
      // CJK sandwiched between ASCII word characters.
      { docId: 'cjk-sandwiched', text: 'the file is named x东京y.txt' },
      // CJK surrounded by whitespace only.
      { docId: 'cjk-isolated', text: 'the city 东京 is large' },
      { docId: 'empty-ish', text: '   ...   ---   ' },
      { docId: 'diacritic-fold', text: 'the cafe down the street (no accent in the doc)' },
      // "cat" is a substring of "concatenated"/"catalog" but not a
      // whole word there — exercises the trigram prefilter
      // over-recalling (all three contain the literal substring
      // "cat") and the JS postfilter correctly narrowing to just the
      // standalone occurrence.
      { docId: 'embedded-substring', text: 'the cat sat on the concatenated mat, catalog included' },
    ];
    const queries = [
      'graphql',
      'go',
      'google',
      'search',
      '$5',
      '(discounted)',
      'state-of-the-art',
      'café',
      'café au lait',
      '东京',
      '!!!',
      '',
      'cafe',
      'cat',
    ];

    const bruteForce = (query: string): readonly string[] => {
      const normalized = query.trim().toLowerCase();
      if (normalized.length === 0) return [];
      return docs
        .filter((doc) => matchesWholeWordQuery(doc.text, normalized))
        .map((doc) => doc.docId)
        .sort();
    };

    sqliteIt('matchWholeWord matches a brute-force scan for every query in the corpus', async () => {
      const vault = await tempVault();
      const store = await createCaptureTextFtsStore(vault);
      let t = Date.parse('2026-08-16T10:00:00.000Z');
      store.ingestMany(
        docs.map((doc) =>
          captureEvent({
            replicaId: 'replica-a',
            bacId: doc.docId,
            threadId: `thread-${doc.docId}`,
            acceptedAtMs: (t += 1000),
            turns: [{ text: doc.text }],
          }),
        ),
      );
      for (const query of queries) {
        const expected = bruteForce(query);
        const actual = store
          .matchWholeWord(query)
          .map((m) => m.docId)
          .sort();
        expect(actual, `query=${JSON.stringify(query)}`).toEqual(expected);
      }
      store.close();
    });
  });
});
