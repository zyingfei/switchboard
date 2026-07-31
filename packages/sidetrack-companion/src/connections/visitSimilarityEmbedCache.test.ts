import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { buildVisitSimilarity, type VisitSimilarityEntry } from './visitSimilarity.js';

// P0-A regression net. buildVisitSimilarity embeds passage+query text for EVERY
// eligible visit. Live 2026-07-27: that path ran ~100% CPU for 11+ minutes in
// the reconcile child, starving the parent that serves the panel (resolve p95
// 17.5s against a 15s client timeout). The corpus barely changes between
// drains, so nearly all of it was recomputing identical vectors.
//
// These tests pin the cache CONTRACT, not an implementation detail: the second
// build over the same corpus must not re-embed, and a changed corpus must.

const DIM = 384;
const vectorFor = (seed: number): Float32Array => {
  const v = new Float32Array(DIM);
  // Distinct, normalized-ish vectors so similarity math stays well-defined.
  v[seed % DIM] = 1;
  return v;
};

// Entry shape copied from the working fixture in similarityContentCorpus.test:
// buildVisitSimilarity consumes TIMELINE entries, and engagement lives under
// dimensions.engagement.focusedWindowMs (the eligibility gate).
const entriesOf = (corpora: readonly string[]): VisitSimilarityEntry[] =>
  corpora.map((corpus, i) => {
    const url = `https://example.test/${String(i)}`;
    return {
      id: url,
      firstSeenAt: '2026-05-07T10:00:00.000Z',
      lastSeenAt: '2026-05-07T10:00:00.000Z',
      url,
      canonicalUrl: url,
      title: corpus,
      provider: 'generic',
      visitCount: 1,
      dimensions: { engagement: { focusedWindowMs: 60_000 } },
    } as unknown as VisitSimilarityEntry;
  });

describe('visit similarity — corpus embedding cache', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-embed-cache-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('re-embeds the whole corpus on every build when no vaultRoot is given (prior behaviour)', async () => {
    const corpora = ['alpha document text', 'beta document text'];
    let embedCalls = 0;
    const embed = async (texts: readonly string[]): Promise<readonly Float32Array[]> => {
      embedCalls += texts.length;
      return texts.map((_, i) => vectorFor(i));
    };
    await buildVisitSimilarity(entriesOf(corpora), embed, {});
    const first = embedCalls;
    await buildVisitSimilarity(entriesOf(corpora), embed, {});
    // No cache: the second build pays the same cost as the first.
    expect(embedCalls).toBe(first * 2);
  });

  it('embeds each corpus text ONCE across builds when the cache is enabled', async () => {
    const corpora = ['alpha document text', 'beta document text'];
    let embedded: string[] = [];
    const embed = async (texts: readonly string[]): Promise<readonly Float32Array[]> => {
      embedded = [...embedded, ...texts];
      return texts.map((_, i) => vectorFor(i));
    };
    await buildVisitSimilarity(entriesOf(corpora), embed, { vaultRoot });
    const afterFirst = embedded.length;
    expect(afterFirst).toBeGreaterThan(0);

    await buildVisitSimilarity(entriesOf(corpora), embed, { vaultRoot });
    // Second build over an UNCHANGED corpus must embed nothing new — this is
    // the whole point: minutes of ONNX become a cache read.
    expect(embedded.length).toBe(afterFirst);
  });

  it('embeds only the CHANGED text when one visit\'s corpus changes', async () => {
    const embedTexts: string[] = [];
    const embed = async (texts: readonly string[]): Promise<readonly Float32Array[]> => {
      embedTexts.push(...texts);
      return texts.map((_, i) => vectorFor(i));
    };
    await buildVisitSimilarity(entriesOf(['alpha text', 'beta text']), embed, { vaultRoot });
    const baseline = embedTexts.length;

    embedTexts.length = 0;
    await buildVisitSimilarity(entriesOf(['alpha text', 'GAMMA text changed']), embed, {
      vaultRoot,
    });
    // Only the changed document's passage+query variants are recomputed, not
    // the full corpus.
    expect(embedTexts.length).toBeGreaterThan(0);
    expect(embedTexts.length).toBeLessThan(baseline);
    expect(embedTexts.every((t) => t.includes('GAMMA'))).toBe(true);
  });

  it('falls back to embedding when the cache cannot be used (never throws into a drain)', async () => {
    let calls = 0;
    const embed = async (texts: readonly string[]): Promise<readonly Float32Array[]> => {
      calls += texts.length;
      return texts.map((_, i) => vectorFor(i));
    };
    // A path that cannot host a cache file: the build must still succeed.
    const revision = await buildVisitSimilarity(entriesOf(['alpha', 'beta']), embed, {
      vaultRoot: '/dev/null/not-a-directory',
    });
    expect(calls).toBeGreaterThan(0);
    expect(revision).toBeDefined();
  });
});

describe('visit similarity — embed-cache resumability (the 2026-07-29 outage shape)', () => {
  // The full-rebuild fallback handed the cache the WHOLE corpus cold; one
  // giant embed ran past the reconcile child's 10-minute watchdog; SIGKILL
  // landed before any cache write; every retry restarted from zero. The vault
  // showed `connections: never / pending` for 18 hours. These pin the two
  // properties that make that impossible: writes land per chunk, so a killed
  // run leaves durable progress, and the next run only embeds the remainder.

  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-embed-resume-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('a run killed mid-way leaves its finished chunks in the cache', async () => {
    // >64 entries so there are at least two chunks; the embedder dies on the
    // second call, simulating the watchdog SIGKILL between chunks.
    const corpora = Array.from({ length: 70 }, (_, i) => `document text number ${String(i)}`);
    let calls = 0;
    const dyingEmbed = async (texts: readonly string[]): Promise<readonly Float32Array[]> => {
      calls += 1;
      if (calls > 1) throw new Error('killed (simulated SIGKILL)');
      return texts.map((_, i) => vectorFor(i));
    };
    await buildVisitSimilarity(entriesOf(corpora), dyingEmbed, { vaultRoot }).catch(() => undefined);

    // Second run with a healthy embedder: everything the first run finished
    // must come from the cache — only the REMAINDER is embedded.
    const embeddedNow: string[] = [];
    const healthyEmbed = async (texts: readonly string[]): Promise<readonly Float32Array[]> => {
      embeddedNow.push(...texts);
      return texts.map((_, i) => vectorFor(i));
    };
    await buildVisitSimilarity(entriesOf(corpora), healthyEmbed, { vaultRoot });
    expect(embeddedNow.length).toBeGreaterThan(0);
    // 70 docs × (passage+query) = 140 texts; the first run's surviving chunk
    // (64) must be gone from the workload. Exact split depends on internal
    // ordering, so pin the property, not the arithmetic: strictly less than
    // the full corpus by at least one chunk.
    expect(embeddedNow.length).toBeLessThanOrEqual(140 - 64);
  });

  it('retries CONVERGE: each killed run strictly shrinks the remaining work', async () => {
    const corpora = Array.from({ length: 96 }, (_, i) => `converging corpus item ${String(i)}`);
    const perRun: number[] = [];
    for (let run = 0; run < 4; run += 1) {
      let sentThisRun = 0;
      let calls = 0;
      const embedOnceThenDie = async (texts: readonly string[]): Promise<readonly Float32Array[]> => {
        calls += 1;
        if (calls > 1) throw new Error('killed');
        sentThisRun += texts.length;
        return texts.map((_, i) => vectorFor(i));
      };
      await buildVisitSimilarity(entriesOf(corpora), embedOnceThenDie, { vaultRoot }).catch(() => undefined);
      perRun.push(sentThisRun);
      if (sentThisRun === 0) break;
    }
    // Every run does at most one chunk, and the workload shrinks monotonically
    // until nothing is left — the exact opposite of the outage, where every
    // run re-embedded the full corpus and none finished.
    for (let i = 1; i < perRun.length; i += 1) {
      expect(perRun[i]!).toBeLessThanOrEqual(perRun[i - 1]!);
    }
    expect(perRun[perRun.length - 1]).toBe(0);
  });
});
