import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GuessLaneResult } from './guessLanes.js';
import {
  LANE_PREQUENTIAL_ENV,
  lanePrequentialPath,
  lanePrequentialSummary,
  recordLanePredictions,
  resetLanePrequentialMemoForTest,
  scoreLanePredictions,
  type LaneFiling,
  type LanePredictionRecord,
} from './lanePrequential.js';

// LANE PREQUENTIAL — the measurement that has to exist before lane agreement
// is allowed to count for anything (review E1).
//
// The discipline under test: predict, THEN observe. A prediction is scored only
// against a filing that came after it; the panel's constant re-resolving must
// not inflate the sample count; a decline is a miss.

const rec = (u: string, l: string, w: string, t: number): LanePredictionRecord => ({ u, l, w, t });
const filing = (
  canonicalUrl: string,
  workstreamId: string | null,
  atMs: number,
): LaneFiling => ({ canonicalUrl, workstreamId, atMs });

afterEach(() => {
  delete process.env[LANE_PREQUENTIAL_ENV];
  resetLanePrequentialMemoForTest();
});

describe('lane prequential — (a) the prediction/label join', () => {
  it('scores a prediction against the filing that came AFTER it', () => {
    const summary = scoreLanePredictions(
      [rec('u1', 'content', 'ws-a', 100)],
      [filing('u1', 'ws-a', 200)],
    );
    expect(summary.scored).toBe(1);
    expect(summary.lanes).toEqual([{ lane: 'content', n: 1, hits: 1, precision: 1 }]);
  });

  it('counts a wrong pick as a miss', () => {
    const summary = scoreLanePredictions(
      [rec('u1', 'content', 'ws-a', 100)],
      [filing('u1', 'ws-b', 200)],
    );
    expect(summary.lanes[0]).toEqual({ lane: 'content', n: 1, hits: 0, precision: 0 });
  });

  it('NEVER scores a prediction made after the filing — no peeking', () => {
    // The prediction post-dates the label. Scoring it would let a re-resolve
    // after the user filed the page manufacture a perfect record.
    const summary = scoreLanePredictions(
      [rec('u1', 'content', 'ws-a', 300)],
      [filing('u1', 'ws-a', 200)],
    );
    expect(summary.scored).toBe(0);
    expect(summary.unscored).toBe(1);
  });

  it('leaves a prediction with no filing unscored — not a miss', () => {
    const summary = scoreLanePredictions([rec('u1', 'ai', 'ws-a', 100)], []);
    expect(summary.scored).toBe(0);
    expect(summary.unscored).toBe(1);
    expect(summary.lanes).toEqual([]);
  });

  it('scores a decline as a miss for every lane that named a workstream', () => {
    const summary = scoreLanePredictions(
      [rec('u1', 'content', 'ws-a', 100), rec('u1', 'ai', 'ws-a', 100)],
      [filing('u1', null, 200)],
    );
    expect(summary.scored).toBe(2);
    for (const lane of summary.lanes) expect(lane.hits).toBe(0);
  });

  it('keeps lanes independent', () => {
    const summary = scoreLanePredictions(
      [
        rec('u1', 'content', 'ws-a', 100),
        rec('u1', 'ai', 'ws-b', 100),
        rec('u1', 'title', 'ws-a', 100),
      ],
      [filing('u1', 'ws-a', 200)],
    );
    const byLane = new Map(summary.lanes.map((entry) => [entry.lane, entry]));
    expect(byLane.get('content')?.hits).toBe(1);
    expect(byLane.get('ai')?.hits).toBe(0);
    expect(byLane.get('title')?.hits).toBe(1);
  });
});

describe('lane prequential — (b) dedupe (the panel re-resolves constantly)', () => {
  it('scores ONE outcome per (url, lane) per filing, using the latest prediction', () => {
    // 40 identical re-resolves before the user files. Counting each would make
    // precision a measure of how often the panel polled.
    const records = Array.from({ length: 40 }, (_unused, index) =>
      rec('u1', 'content', 'ws-a', 100 + index),
    );
    const summary = scoreLanePredictions(records, [filing('u1', 'ws-a', 500)]);
    expect(summary.scored).toBe(1);
    expect(summary.lanes[0]?.n).toBe(1);
    expect(summary.unscored).toBe(0);
  });

  it('uses the LATEST prediction before the filing when the pick changed', () => {
    const summary = scoreLanePredictions(
      [rec('u1', 'content', 'ws-wrong', 100), rec('u1', 'content', 'ws-right', 200)],
      [filing('u1', 'ws-right', 300)],
    );
    expect(summary.scored).toBe(1);
    expect(summary.lanes[0]?.hits).toBe(1);
  });

  it('scores a second filing against predictions made after the first', () => {
    const summary = scoreLanePredictions(
      [
        rec('u1', 'content', 'ws-a', 100),
        rec('u1', 'content', 'ws-b', 300),
      ],
      [filing('u1', 'ws-a', 200), filing('u1', 'ws-b', 400)],
    );
    expect(summary.scored).toBe(2);
    expect(summary.lanes[0]).toEqual({ lane: 'content', n: 2, hits: 2, precision: 1 });
  });

  it('never re-scores a spent prediction against a later filing', () => {
    const summary = scoreLanePredictions(
      [rec('u1', 'content', 'ws-a', 100)],
      [filing('u1', 'ws-a', 200), filing('u1', 'ws-b', 300)],
    );
    expect(summary.scored).toBe(1);
  });
});

describe('lane prequential — (c) the trailing window', () => {
  it('keeps only the newest `window` scored pairs, by answer time', () => {
    const records = Array.from({ length: 10 }, (_unused, index) =>
      rec(`u${String(index)}`, 'content', index < 5 ? 'ws-wrong' : 'ws-a', 100),
    );
    const filings = Array.from({ length: 10 }, (_unused, index) =>
      filing(`u${String(index)}`, 'ws-a', 200 + index),
    );
    // Window 5 keeps the LAST five answers — all of which were correct.
    const summary = scoreLanePredictions(records, filings, 5);
    expect(summary.scored).toBe(5);
    expect(summary.window).toBe(5);
    expect(summary.lanes[0]).toEqual({ lane: 'content', n: 5, hits: 5, precision: 1 });
  });
});

describe('lane prequential — (d) the writer', () => {
  const lanes: readonly GuessLaneResult[] = [
    { lane: 'graph', candidates: [], emptyReason: 'no graph path' },
    { lane: 'content', candidates: [{ workstreamId: 'ws-a', score: 0.6, why: '3 matches' }] },
    { lane: 'ai', candidates: [{ workstreamId: 'ws-a', score: 0.7, why: '2 matches' }] },
  ];

  const withVault = async (run: (vaultRoot: string) => Promise<void>): Promise<void> => {
    const vaultRoot = await mkdtemp(join(tmpdir(), 'lane-prequential-'));
    try {
      await run(vaultRoot);
    } finally {
      await rm(vaultRoot, { recursive: true, force: true });
    }
  };

  it('writes one line per lane WITH a top pick, and nothing for typed-empty lanes', async () => {
    await withVault(async (vaultRoot) => {
      const written = await recordLanePredictions(
        vaultRoot,
        [{ canonicalUrl: 'https://a.test/x', lanes }],
        1_700_000_000_000,
      );
      // 'graph' abstained — an abstention is not a prediction.
      expect(written).toBe(2);
      const text = await readFile(lanePrequentialPath(vaultRoot), 'utf8');
      const parsed = text
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(parsed.map((row) => row['l'])).toEqual(['content', 'ai']);
      expect(parsed[0]).toEqual({
        u: 'https://a.test/x',
        l: 'content',
        w: 'ws-a',
        t: 1_700_000_000_000,
      });
    });
  });

  it('appends across calls rather than truncating', async () => {
    await withVault(async (vaultRoot) => {
      await recordLanePredictions(vaultRoot, [{ canonicalUrl: 'u1', lanes }], 1);
      await recordLanePredictions(vaultRoot, [{ canonicalUrl: 'u2', lanes }], 2);
      const text = await readFile(lanePrequentialPath(vaultRoot), 'utf8');
      expect(text.split('\n').filter((line) => line.length > 0)).toHaveLength(4);
    });
  });

  it('writes nothing when the lanes are absent (guess lanes off)', async () => {
    await withVault(async (vaultRoot) => {
      const written = await recordLanePredictions(vaultRoot, [
        { canonicalUrl: 'u1', lanes: undefined },
      ]);
      expect(written).toBe(0);
      await expect(stat(lanePrequentialPath(vaultRoot))).rejects.toThrow();
    });
  });

  it('is a no-op when SIDETRACK_LANE_PREQUENTIAL=0', async () => {
    await withVault(async (vaultRoot) => {
      process.env[LANE_PREQUENTIAL_ENV] = '0';
      expect(await recordLanePredictions(vaultRoot, [{ canonicalUrl: 'u1', lanes }])).toBe(0);
      await expect(stat(lanePrequentialPath(vaultRoot))).rejects.toThrow();
    });
  });

  it('summarises what it wrote, and reports "off" rather than a fake zero', async () => {
    await withVault(async (vaultRoot) => {
      await recordLanePredictions(vaultRoot, [{ canonicalUrl: 'u1', lanes }], 1);
      // No filings in this (empty) vault ⇒ everything unscored, nothing claimed.
      const summary = await lanePrequentialSummary(vaultRoot);
      expect(summary.status).toBe('ok');
      expect(summary.scored).toBe(0);
      expect(summary.unscored).toBe(2);

      process.env[LANE_PREQUENTIAL_ENV] = '0';
      resetLanePrequentialMemoForTest();
      const off = await lanePrequentialSummary(vaultRoot);
      expect(off.status).toBe('off');
      expect(off.lanes).toEqual([]);
    });
  });

  it('never throws on a missing vault — a measurement cannot break a probe', async () => {
    const summary = await lanePrequentialSummary(join(tmpdir(), 'does-not-exist-sidetrack'));
    expect(summary.scored).toBe(0);
    expect(summary.lanes).toEqual([]);
  });
});
