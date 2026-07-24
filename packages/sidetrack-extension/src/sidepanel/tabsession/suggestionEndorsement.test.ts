import { describe, expect, it } from 'vitest';

import {
  dominantSourceLabel,
  endorsementFor,
  hostFromUrl,
  isAggregatorHost,
  reasonChipsFor,
} from './suggestionEndorsement';
import type {
  TabSessionPageEvidenceSummary,
  TabSessionResolutionResult,
  TabSessionResolverCandidate,
} from './types';

const candidate = (
  over: Partial<TabSessionResolverCandidate> = {},
): TabSessionResolverCandidate => ({
  workstreamId: 'ws-1',
  rawFusionLogit: 1.5,
  dominantSource: 'ppr',
  reasons: [],
  ...over,
});

const resolution = (
  over: Partial<TabSessionResolutionResult['decision']>,
  candidates: readonly TabSessionResolverCandidate[] = [],
): TabSessionResolutionResult => ({
  tabSessionId: 'tses_1',
  dryRun: true,
  decision: { action: 'inbox', margin: 0, ...over },
  fusedCandidates: candidates,
});

describe('endorsementFor', () => {
  it('returns none when there is no suggestion', () => {
    expect(endorsementFor(undefined).level).toBe('none');
  });

  it('returns none when the resolver returned no candidates', () => {
    const e = endorsementFor(resolution({ action: 'inbox', margin: 0 }, []));
    expect(e.level).toBe('none');
    expect(e.workstreamId).toBeUndefined();
  });

  it('treats a suggest decision as endorsed and reads the decision workstream', () => {
    const e = endorsementFor(
      resolution({ action: 'suggest', workstreamId: 'ws-9', margin: 0.8 }, [
        candidate({ workstreamId: 'ws-9' }),
      ]),
    );
    expect(e.level).toBe('endorsed');
    expect(e.workstreamId).toBe('ws-9');
    expect(e.margin).toBe(0.8);
  });

  it('treats an auto-apply decision as endorsed', () => {
    const e = endorsementFor(
      resolution({ action: 'auto-apply', workstreamId: 'ws-3', margin: 1.2 }, [
        candidate({ workstreamId: 'ws-3' }),
      ]),
    );
    expect(e.level).toBe('endorsed');
    expect(e.workstreamId).toBe('ws-3');
  });

  it('treats an inbox decision WITH a candidate as a weak guess (the -0.62 bug)', () => {
    const e = endorsementFor(
      resolution({ action: 'inbox', margin: -0.62 }, [candidate({ workstreamId: 'ws-weak' })]),
    );
    expect(e.level).toBe('weak-guess');
    // Lean comes from the fused candidate, not decision.workstreamId (absent).
    expect(e.workstreamId).toBe('ws-weak');
    expect(e.margin).toBe(-0.62);
  });
});

describe('reasonChipsFor', () => {
  const withVector: TabSessionPageEvidenceSummary = {
    tier: 'full',
    vector: { modelId: 'm', modelVersion: '1', dimensions: 384 },
  };
  const titleOnly: TabSessionPageEvidenceSummary = { tier: 'metadata' };

  it('maps ppr → graph proximity', () => {
    const chips = reasonChipsFor(
      candidate({ reasons: [{ source: 'ppr', summary: 'x', anchors: [] }] }),
      undefined,
    );
    expect(chips.map((c) => c.kind)).toEqual(['graph']);
    expect(chips[0]?.label).toBe('via graph proximity');
  });

  it('maps similarity → content match when a content vector exists', () => {
    const chips = reasonChipsFor(
      candidate({ reasons: [{ source: 'similarity', summary: 'x', anchors: [] }] }),
      withVector,
    );
    expect(chips.map((c) => c.kind)).toEqual(['content']);
  });

  it('maps similarity → title match when only title/metadata is indexed', () => {
    const chips = reasonChipsFor(
      candidate({ reasons: [{ source: 'similarity', summary: 'x', anchors: [] }] }),
      titleOnly,
    );
    expect(chips.map((c) => c.kind)).toEqual(['title']);
  });

  it('de-duplicates and orders graph → content → topic', () => {
    const chips = reasonChipsFor(
      candidate({
        reasons: [
          { source: 'cluster', summary: 'x', anchors: [] },
          { source: 'ppr', summary: 'y', anchors: [] },
          { source: 'similarity', summary: 'z', anchors: [] },
          { source: 'ppr', summary: 'dup', anchors: [] },
        ],
      }),
      withVector,
    );
    expect(chips.map((c) => c.kind)).toEqual(['graph', 'content', 'topic']);
  });

  it('returns no chips for an undefined candidate', () => {
    expect(reasonChipsFor(undefined, undefined)).toEqual([]);
  });
});

describe('isAggregatorHost', () => {
  it('matches registrable-domain platforms across subdomains', () => {
    expect(isAggregatorHost('news.ycombinator.com')).toBe(true);
    expect(isAggregatorHost('old.reddit.com')).toBe(true);
    expect(isAggregatorHost('www.youtube.com')).toBe(true);
    expect(isAggregatorHost('gemini.google.com')).toBe(true);
  });

  it('does not match ordinary sites or bare TLDs', () => {
    expect(isAggregatorHost('www.janestreet.com')).toBe(false);
    expect(isAggregatorHost('example.org')).toBe(false);
    expect(isAggregatorHost('com')).toBe(false);
    expect(isAggregatorHost(undefined)).toBe(false);
  });
});

describe('hostFromUrl', () => {
  it('extracts a host and returns undefined for junk', () => {
    expect(hostFromUrl('https://news.ycombinator.com/item?id=1')).toBe('news.ycombinator.com');
    expect(hostFromUrl('not a url')).toBeUndefined();
    expect(hostFromUrl(undefined)).toBeUndefined();
  });
});

describe('dominantSourceLabel', () => {
  it('maps the resolver enum to plain, concrete words', () => {
    expect(dominantSourceLabel('ppr')).toBe('browsing path');
    expect(dominantSourceLabel('similarity')).toBe('similar pages');
    expect(dominantSourceLabel('cluster')).toBe('topic');
    expect(dominantSourceLabel('none')).toBe('no clear signal');
  });
});
