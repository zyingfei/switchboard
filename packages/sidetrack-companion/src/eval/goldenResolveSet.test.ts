import { describe, expect, it } from 'bun:test';

import { USER_ORGANIZED_ITEM } from '../feedback/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import type { ConnectionsSnapshot } from '../connections/types.js';
import type { UrlResolutionResult } from '../tabsession/resolver.js';
import {
  defaultGoldenVaultRoot,
  extractGoldenPairs,
  formatGoldenReport,
  GOLDEN_SET_MAX_PAIRS,
  laneTopsOf,
  parseGoldenArgs,
  runGoldenResolveSet,
  scoreGoldenRows,
  type GoldenRow,
} from './goldenResolveSet.js';

// The live-vault harness's pure parts. The harness itself is run by hand
// against a real vault (its output contains the user's URLs and is never
// committed); what CI can and must check is that the label extraction, the
// scoring arithmetic and the report are right — a golden set that measures
// wrongly is worse than none.

let seq = 0;
const organized = (
  itemId: string,
  toContainer: string | null,
  atMs: number,
  over: { readonly action?: string; readonly itemKind?: string } = {},
): AcceptedEvent => {
  seq += 1;
  return {
    type: USER_ORGANIZED_ITEM,
    acceptedAtMs: atMs,
    dot: { replicaId: 'r1', seq },
    payload: {
      payloadVersion: 1,
      itemKind: over.itemKind ?? 'canonical-url',
      itemId,
      action: over.action ?? 'move',
      ...(toContainer === null ? { toContainer: null } : { toContainer }),
    },
  } as unknown as AcceptedEvent;
};

describe('golden resolve set — pair extraction', () => {
  it('extracts (canonicalUrl → workstreamId) from canonical-url moves', () => {
    const pairs = extractGoldenPairs([organized('https://a.test/x', 'ws-1', 1_000)]);
    expect(pairs).toEqual([
      { canonicalUrl: 'https://a.test/x', workstreamId: 'ws-1', atMs: 1_000 },
    ]);
  });

  it('keeps the users FINAL answer per URL, not every intermediate one', () => {
    const pairs = extractGoldenPairs([
      organized('https://a.test/x', 'ws-old', 1_000),
      organized('https://a.test/x', 'ws-new', 2_000),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.workstreamId).toBe('ws-new');
  });

  it('excludes declines — a refusal is a different question', () => {
    const pairs = extractGoldenPairs([
      organized('https://a.test/filed', 'ws-1', 1_000),
      organized('https://a.test/declined', null, 1_000),
    ]);
    expect(pairs.map((pair) => pair.canonicalUrl)).toEqual(['https://a.test/filed']);
  });

  it('excludes a URL whose LATEST answer was a decline', () => {
    const pairs = extractGoldenPairs([
      organized('https://a.test/x', 'ws-1', 1_000),
      organized('https://a.test/x', null, 2_000),
    ]);
    expect(pairs).toEqual([]);
  });

  it('ignores non-canonical-url kinds and non-move actions', () => {
    const pairs = extractGoldenPairs([
      organized('visit-1', 'ws-1', 1_000, { itemKind: 'visit' }),
      organized('https://a.test/x', 'ws-1', 1_000, { action: 'promote' }),
    ]);
    expect(pairs).toEqual([]);
  });

  it('takes the NEWEST pairs when capped', () => {
    const events = Array.from({ length: 10 }, (_unused, index) =>
      organized(`https://a.test/${String(index)}`, 'ws-1', 1_000 + index),
    );
    const pairs = extractGoldenPairs(events, 3);
    expect(pairs.map((pair) => pair.atMs)).toEqual([1_009, 1_008, 1_007]);
  });

  it('defaults to the review’s cap of 200', () => {
    expect(GOLDEN_SET_MAX_PAIRS).toBe(200);
  });
});

describe('golden resolve set — scoring', () => {
  const row = (over: Partial<GoldenRow> = {}): GoldenRow => ({
    canonicalUrl: 'https://a.test/x',
    expected: 'ws-right',
    fusionTop: 'ws-right',
    action: 'suggest',
    gateReason: 'cleared-suggest',
    laneTops: { graph: 'ws-right', domain: 'ws-wrong' },
    ...over,
  });

  it('computes precision over ANSWERED pairs and coverage over all pairs', () => {
    const result = scoreGoldenRows(
      [
        row(),
        row({ fusionTop: 'ws-wrong' }),
        // Abstained: counts against coverage, not against precision.
        row({ fusionTop: null, action: 'inbox', gateReason: 'no-candidates' }),
      ],
      '/vault',
      '2026-07-29T00:00:00.000Z',
    );
    expect(result.pairs).toBe(3);
    expect(result.fusion.answered).toBe(2);
    expect(result.fusion.hits).toBe(1);
    expect(result.fusion.precision).toBe(0.5);
    expect(result.fusion.coverage).toBeCloseTo(1 / 3, 6);
  });

  it('scores each lane independently', () => {
    const result = scoreGoldenRows([row(), row()], '/vault', 'now');
    const byLane = new Map(result.lanes.map((lane) => [lane.arm, lane]));
    expect(byLane.get('graph')?.precision).toBe(1);
    expect(byLane.get('domain')?.precision).toBe(0);
  });

  it('reports null precision — never a fabricated 0 — for an arm that never answered', () => {
    const result = scoreGoldenRows([row({ fusionTop: null, laneTops: {} })], '/vault', 'now');
    expect(result.fusion.precision).toBeNull();
    expect(result.lanes).toEqual([]);
  });

  it('tallies gate reasons so a run says WHERE picks die', () => {
    const result = scoreGoldenRows(
      [
        row({ gateReason: 'corroboration' }),
        row({ gateReason: 'corroboration' }),
        row({ gateReason: 'cleared-suggest' }),
        row({ gateReason: null }),
      ],
      '/vault',
      'now',
    );
    expect(result.gateReasons).toEqual({ corroboration: 2, 'cleared-suggest': 1, none: 1 });
  });

  it('renders a table naming every arm and the peeking caveat', () => {
    const text = formatGoldenReport(scoreGoldenRows([row()], '/vault', 'now'));
    expect(text).toContain('fusion');
    expect(text).toContain('graph');
    expect(text).toContain('gate reasons');
    // The caveat is load-bearing: this number must never be quoted as accuracy.
    expect(text).toContain('regression net, not a forecast');
    expect(text).toContain('live prequential');
  });
});

describe('golden resolve set — lane tops', () => {
  it('takes each populated lane’s first candidate and skips typed-empty lanes', () => {
    expect(
      laneTopsOf([
        { lane: 'graph', candidates: [{ workstreamId: 'ws-a', score: 0.5, why: 'x' }] },
        { lane: 'similarity', candidates: [], emptyReason: 'no similar pages' },
      ]),
    ).toEqual({ graph: 'ws-a' });
  });

  it('is empty when lanes are absent (guess lanes off)', () => {
    expect(laneTopsOf(undefined)).toEqual({});
  });
});

describe('golden resolve set — CLI + wiring', () => {
  it('parses --vault, --limit and --no-persist', () => {
    expect(parseGoldenArgs(['--vault', '/v', '--limit', '25', '--no-persist'])).toEqual({
      vaultRoot: '/v',
      limit: 25,
      persist: false,
    });
    expect(parseGoldenArgs([])).toEqual({});
    // A junk limit is ignored rather than producing a zero-pair run.
    expect(parseGoldenArgs(['--limit', 'abc'])).toEqual({});
  });

  it('defaults to SIDETRACK_VAULT, else the TEST vault — never the live one', () => {
    expect(defaultGoldenVaultRoot({ SIDETRACK_VAULT: '/from/env' })).toBe('/from/env');
    expect(defaultGoldenVaultRoot({ HOME: '/home/u' })).toBe('/home/u/.sidetrack-vault-test');
  });

  it('replays pairs through an injected resolver and scores them end to end', async () => {
    const snapshot = { nodes: [], edges: [] } as unknown as ConnectionsSnapshot;
    const result = await runGoldenResolveSet({
      vaultRoot: '/vault',
      persist: false,
      now: () => new Date('2026-07-29T12:00:00.000Z'),
      readEvents: async () => [
        organized('https://a.test/hit', 'ws-right', 2_000),
        organized('https://a.test/miss', 'ws-right', 1_000),
      ],
      readSnapshot: async () => snapshot,
      resolve: async (_vaultRoot, pair) =>
        ({
          canonicalUrl: pair.canonicalUrl,
          dryRun: true,
          policyMode: 'balanced',
          decision: {
            action: 'suggest',
            margin: 1,
            gate: { reason: 'cleared-suggest', detail: 'x' },
          },
          fusedCandidates: [
            {
              workstreamId: pair.canonicalUrl.endsWith('hit') ? 'ws-right' : 'ws-wrong',
              pprScore: 0,
              simTopScore: 0,
              simMeanScore: 0,
              simAgreement: 0,
              simMargin: 0,
              clusterPosterior: 0,
              corroborationCount: 1,
              rawFusionLogit: 1.5,
              dominantSource: 'similarity',
              reasons: [],
            },
          ],
          reasons: {
            dependencyKey: 'k',
            modelRevision: 'm',
            graphRevision: 'g',
            evidenceHash: 'h',
            targetAnchors: [],
            topContributingAnchors: [],
          },
          lanes: [{ lane: 'graph', candidates: [{ workstreamId: 'ws-right', score: 1, why: 'x' }] }],
        }) as unknown as UrlResolutionResult,
    });
    expect(result.pairs).toBe(2);
    expect(result.fusion).toMatchObject({ answered: 2, hits: 1, precision: 0.5 });
    expect(result.lanes[0]).toMatchObject({ arm: 'graph', answered: 2, hits: 2, precision: 1 });
    expect(result.generatedAt).toBe('2026-07-29T12:00:00.000Z');
  });

  it('records an unresolvable URL as an abstention instead of losing the run', async () => {
    const result = await runGoldenResolveSet({
      vaultRoot: '/vault',
      persist: false,
      readEvents: async () => [organized('https://a.test/boom', 'ws-right', 1_000)],
      readSnapshot: async () => ({ nodes: [], edges: [] }) as unknown as ConnectionsSnapshot,
      resolve: async () => {
        throw new Error('resolver blew up');
      },
    });
    expect(result.pairs).toBe(1);
    expect(result.fusion.answered).toBe(0);
    expect(result.gateReasons).toEqual({ 'resolve-failed': 1 });
  });

  it('fails loudly when the vault has no connections snapshot', async () => {
    await expect(
      runGoldenResolveSet({
        vaultRoot: '/vault',
        persist: false,
        readEvents: async () => [],
        readSnapshot: async () => null,
      }),
    ).rejects.toThrow('No connections snapshot');
  });
});
