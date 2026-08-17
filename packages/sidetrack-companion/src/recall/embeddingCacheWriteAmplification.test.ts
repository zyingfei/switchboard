// Regression coverage for the 2026-08-17 write-amplification fix.
//
// USER-TRACED LIVE EVIDENCE: a 60s fs trace on the test companion showed
// ~350MB/min of writes dominated by _BAC/recall/embed-cache.bin (14MB) and
// _BAC/recall/v2/index.sqlite(+WAL). The hypothesis — confirmed by reading
// embeddingCache.ts's OLD `putMany`/`put` — was that every call rewrote the
// WHOLE cache file (read full file, replace one entry in the in-memory map,
// tmp-write + rename the entire map back out), so a backlog drain calling
// `putMany`+`put` once per record cost TWO full-file rewrites PER RECORD:
// O(cache-size) work to persist O(1) new data.
//
// The fix (see embeddingCache.ts's "WRITE PATH" doc comment): when the
// model identity is unchanged, `putMany`/`put` now APPEND only the
// incoming batch's encoded bytes to the end of the file, with periodic
// compaction once accumulated stale (superseded) bytes cross a threshold.
// This suite proves the write volume is O(batch), not O(cache-size), and
// that the append path survives a truncated (crash-mid-append) file
// without losing entries that were fully written before the crash.
import { mkdtemp, readFile, rm, stat, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { __resetEmbeddingCacheMemo, createEmbeddingCache, embedTextHash } from './embeddingCache.js';

const DIM = 384;
const MODEL = { modelId: 'write-amp-test', modelRevision: 'r1' };

const makeVector = (seed: number): Float32Array => {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i += 1) v[i] = (seed + i) / 1000;
  return v;
};

const cachePath = (vault: string): string => join(vault, '_BAC', 'recall', 'embed-cache.bin');

// One record's on-disk size: 4 (hash length) + 64 (sha256 hex) + dim*4
// (float32 vector).
const RECORD_BYTES = 4 + 64 + DIM * 4;

describe('embedding cache — write amplification (O(batch), not O(cache-size))', () => {
  let vault: string;

  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), 'sidetrack-embed-cache-writeamp-'));
    __resetEmbeddingCacheMemo();
  });

  afterEach(async () => {
    __resetEmbeddingCacheMemo();
    await rm(vault, { recursive: true, force: true });
  });

  it('20 sequential embeds write O(entries), not 20x the file size', async () => {
    const cache = createEmbeddingCache(vault, DIM, { compactionStaleBytesThreshold: 0 });
    // Seed a non-trivial baseline (200 pre-existing entries) so the file is
    // already large before the measured writes — this is what makes the
    // O(cache-size) regression visible: a full-rewrite-per-put design would
    // pay for these 200 entries again on EVERY one of the 20 measured puts.
    const seed = Array.from({ length: 200 }, (_unused, i) => {
      const hash = embedTextHash(`seed-doc-${String(i)}`);
      return [hash, makeVector(i)] as const;
    });
    await cache.putMany(MODEL, seed);

    const before = await stat(cachePath(vault));

    // 20 separate PUT calls — the real call shape: the embed lane persists
    // one record (or a small chunk batch) per embedded page, not one giant
    // batch for the whole backlog.
    for (let i = 0; i < 20; i += 1) {
      const hash = embedTextHash(`fresh-doc-${String(i)}`);
      await cache.put({ ...MODEL, embedTextHash: hash }, makeVector(1000 + i));
    }

    const after = await stat(cachePath(vault));
    const bytesWritten = after.size - before.size;

    // A full-rewrite-per-put design would write ~20 * before.size (each put
    // re-serializes the whole 200+i-entry map). The append design writes
    // ~20 new records worth of bytes. Assert well below the O(cache-size)
    // bound and close to the O(batch) bound.
    const fullRewriteBound = 20 * before.size;
    const appendOnlyBound = 20 * RECORD_BYTES * 1.5; // headroom for header-ish overhead
    expect(bytesWritten).toBeLessThan(appendOnlyBound);
    expect(bytesWritten).toBeLessThan(fullRewriteBound / 50); // nowhere near quadratic

    // Correctness: every entry (seeded + fresh) is still readable.
    const freshHashes = Array.from({ length: 20 }, (_unused, i) => embedTextHash(`fresh-doc-${String(i)}`));
    const got = await cache.getMany(MODEL, freshHashes);
    expect(got.size).toBe(20);
    const seededHashes = seed.map(([hash]) => hash);
    const gotSeeded = await cache.getMany(MODEL, seededHashes);
    expect(gotSeeded.size).toBe(200);
  });

  it('a single put after a large cache writes close to one record, not the whole file', async () => {
    const cache = createEmbeddingCache(vault, DIM, { compactionStaleBytesThreshold: 0 });
    const seed = Array.from({ length: 500 }, (_unused, i) => {
      const hash = embedTextHash(`bulk-${String(i)}`);
      return [hash, makeVector(i)] as const;
    });
    await cache.putMany(MODEL, seed);
    const before = await stat(cachePath(vault));
    expect(before.size).toBeGreaterThan(500 * RECORD_BYTES); // sanity: cache is genuinely large

    await cache.put({ ...MODEL, embedTextHash: embedTextHash('one-more') }, makeVector(9999));
    const after = await stat(cachePath(vault));
    const delta = after.size - before.size;

    // One record's worth of bytes, not anything close to the 500-entry file.
    expect(delta).toBeLessThan(RECORD_BYTES * 2);
    expect(delta).toBeLessThan(before.size / 10);
  });

  it('compaction reclaims space once accumulated stale bytes cross the threshold', async () => {
    // A tiny threshold forces compaction after two overwrites (2 stale
    // records) so the trigger is deterministic in a unit test: one stale
    // record must NOT be enough (else the second put would compact instead
    // of appending, and the test below couldn't observe the append growth).
    const cache = createEmbeddingCache(vault, DIM, {
      compactionStaleBytesThreshold: RECORD_BYTES * 1.5,
    });
    const hash = embedTextHash('overwritten-many-times');
    await cache.put({ ...MODEL, embedTextHash: hash }, makeVector(1));
    const afterFirst = await stat(cachePath(vault));

    // Overwrite the SAME hash repeatedly — each overwrite appends a new
    // record and marks the prior one stale. Once staleBytes >=
    // threshold, the next write compacts instead of appending.
    await cache.put({ ...MODEL, embedTextHash: hash }, makeVector(2));
    const afterSecond = await stat(cachePath(vault));
    expect(afterSecond.size).toBeGreaterThan(afterFirst.size); // appended, grew

    await cache.put({ ...MODEL, embedTextHash: hash }, makeVector(3));
    const afterThird = await stat(cachePath(vault));
    // Compaction should have reclaimed the dead (superseded) records — the
    // file shrinks back down toward a single-entry size instead of growing
    // unbounded with every overwrite.
    expect(afterThird.size).toBeLessThan(afterSecond.size);

    const got = await cache.get({ ...MODEL, embedTextHash: hash });
    expect(got).not.toBeNull();
    expect(got![0]).toBeCloseTo(3 / 1000, 5);
  });

  it('emits a throttled, attributable flush log line', async () => {
    const lines: string[] = [];
    const cache = createEmbeddingCache(vault, DIM, {
      log: (message) => lines.push(message),
      flushLogIntervalMs: 0, // log every flush, deterministically
    });
    await cache.put({ ...MODEL, embedTextHash: embedTextHash('a') }, makeVector(1));
    await cache.put({ ...MODEL, embedTextHash: embedTextHash('b') }, makeVector(2));

    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      expect(line).toMatch(/^\[embed-cache] flushed entries=\d+ bytes=\d+ kind=\S+ path=.+$/);
    }
    // First write (no file yet) is a full/"compact" write; the second is a
    // plain append since the model is unchanged.
    expect(lines[0]).toContain('kind=compact');
    expect(lines[1]).toContain('kind=append');
  });

  it('throttling coalesces rapid flushes into one line with the cumulative total', async () => {
    const lines: string[] = [];
    const cache = createEmbeddingCache(vault, DIM, {
      log: (message) => lines.push(message),
      flushLogIntervalMs: 60_000, // effectively "never" within this test
    });
    for (let i = 0; i < 5; i += 1) {
      await cache.put({ ...MODEL, embedTextHash: embedTextHash(`t${String(i)}`) }, makeVector(i));
    }
    // Only the FIRST flush's line was emitted (the rest were within the
    // throttle window) — but disk writes still happened for all 5 (checked
    // via file size / read-back below), so no write silently went missing.
    expect(lines).toHaveLength(1);
    const got = await cache.getMany(
      MODEL,
      Array.from({ length: 5 }, (_unused, i) => embedTextHash(`t${String(i)}`)),
    );
    expect(got.size).toBe(5);
  });

  it('survives a truncated trailing record (simulated crash mid-append)', async () => {
    const cache = createEmbeddingCache(vault, DIM, { compactionStaleBytesThreshold: 0 });
    const hashA = embedTextHash('safe-entry-a');
    const hashB = embedTextHash('safe-entry-b');
    await cache.put({ ...MODEL, embedTextHash: hashA }, makeVector(1)); // full write (first)
    await cache.put({ ...MODEL, embedTextHash: hashB }, makeVector(2)); // append

    const fullBuffer = await readFile(cachePath(vault));
    // Chop off the tail of the file mid-record — simulates a crash during
    // the appendFile() call for hashB's record (or its trailing bytes).
    const truncatedSize = fullBuffer.length - 20;
    await truncate(cachePath(vault), truncatedSize);

    __resetEmbeddingCacheMemo(); // force a real re-parse, not the process memo

    // Must not throw, and must still return the entry that was fully
    // written before the truncated tail.
    const gotA = await cache.get({ ...MODEL, embedTextHash: hashA });
    expect(gotA).not.toBeNull();
    expect(gotA![0]).toBeCloseTo(1 / 1000, 5);

    // The truncated record is simply absent — not corrupting the read, and
    // not throwing.
    const gotB = await cache.get({ ...MODEL, embedTextHash: hashB });
    expect(gotB === null || gotB[0] === 2 / 1000).toBe(true);

    // The cache is still writable after a truncated read — a crash never
    // permanently wedges the cache; it just costs a re-embed for the lost
    // tail (acceptable: this file is a cache, not the source of truth).
    const hashC = embedTextHash('post-crash-entry');
    await cache.put({ ...MODEL, embedTextHash: hashC }, makeVector(3));
    const gotC = await cache.get({ ...MODEL, embedTextHash: hashC });
    expect(gotC).not.toBeNull();
  });

  it('a header-region truncation (empty/garbage file) degrades to an absent cache, not a throw', async () => {
    const cache = createEmbeddingCache(vault, DIM, { compactionStaleBytesThreshold: 0 });
    await cache.put({ ...MODEL, embedTextHash: embedTextHash('x') }, makeVector(1));
    // Truncate into the middle of the JSON header itself.
    await truncate(cachePath(vault), 3);
    __resetEmbeddingCacheMemo();
    const got = await cache.get({ ...MODEL, embedTextHash: embedTextHash('x') });
    expect(got).toBeNull(); // absent, not a thrown error
    // Still writable — a subsequent put starts a fresh, valid cache.
    await cache.put({ ...MODEL, embedTextHash: embedTextHash('y') }, makeVector(2));
    const got2 = await cache.get({ ...MODEL, embedTextHash: embedTextHash('y') });
    expect(got2).not.toBeNull();
  });
});
