// Client-parse acceptance test (the user's ask, verified at the seam the
// panel reads): the resolver hands a FULL ranked `fusedCandidates[]`, and the
// side-panel client parse must NOT truncate it to the top pick. These read
// back the exact guard + URL→tabsession adapter the App uses on the batch /
// single resolve paths.

import { describe, expect, it } from 'vitest';

import {
  isTabSessionResolutionResult,
  tabSessionResolutionFromUrl,
} from '../../entrypoints/sidepanel/App';
import type {
  TabSessionResolverCandidate,
  UrlResolutionResult,
} from '../../src/sidepanel/tabsession/types';

const candidate = (workstreamId: string): TabSessionResolverCandidate => ({
  workstreamId,
  rawFusionLogit: 1,
  dominantSource: 'ppr',
  reasons: [{ source: 'ppr', summary: 'graph', anchors: [] }],
});

describe('resolve client parse — the full ranked candidate list survives', () => {
  it('isTabSessionResolutionResult accepts a resolution with N candidates and keeps them all', () => {
    const wire = {
      tabSessionId: 'tses_1',
      dryRun: true,
      decision: { action: 'inbox', margin: -0.2 },
      fusedCandidates: ['ws-1', 'ws-2', 'ws-3', 'ws-4', 'ws-5'].map(candidate),
    };
    expect(isTabSessionResolutionResult(wire)).toBe(true);
    // The guard is a type predicate — the parsed value is the SAME object,
    // untruncated. Read back the count the panel will see.
    if (isTabSessionResolutionResult(wire)) {
      expect(wire.fusedCandidates).toHaveLength(5);
      expect(wire.fusedCandidates.map((c) => c.workstreamId)).toEqual([
        'ws-1',
        'ws-2',
        'ws-3',
        'ws-4',
        'ws-5',
      ]);
    }
  });

  it('tabSessionResolutionFromUrl is a verbatim passthrough of fusedCandidates (no top-1 truncation)', () => {
    const url: UrlResolutionResult = {
      canonicalUrl: 'https://example.com/a',
      dryRun: true,
      decision: { action: 'suggest', workstreamId: 'ws-1', margin: 0.4 },
      fusedCandidates: ['ws-1', 'ws-2', 'ws-3'].map(candidate),
    };
    const adapted = tabSessionResolutionFromUrl(url);
    expect(adapted.fusedCandidates).toBe(url.fusedCandidates);
    expect(adapted.fusedCandidates).toHaveLength(3);
  });
});

describe('resolve client parse — guess-lanes normalization', () => {
  it('preserves well-formed lanes through the guard', () => {
    const wire = {
      tabSessionId: 'tses_1',
      dryRun: true,
      decision: { action: 'inbox', margin: 0 },
      fusedCandidates: [candidate('ws-1')],
      lanes: [
        {
          lane: 'graph',
          candidates: [{ workstreamId: 'ws-1', score: 0.5, why: 'edge' }],
        },
        { lane: 'domain', candidates: [], emptyReason: 'unseen' },
      ],
    };
    expect(isTabSessionResolutionResult(wire)).toBe(true);
    if (isTabSessionResolutionResult(wire)) {
      expect(wire.lanes).toBeDefined();
      expect(wire.lanes).toHaveLength(2);
      expect(wire.lanes?.[0]?.lane).toBe('graph');
    }
  });

  it('degrades MALFORMED lanes to absent WITHOUT rejecting the whole resolution', () => {
    const wire = {
      tabSessionId: 'tses_1',
      dryRun: true,
      decision: { action: 'inbox', margin: 0 },
      fusedCandidates: [candidate('ws-1')],
      // Not an array → the whole lanes field is treated as absent.
      lanes: 'garbage',
    };
    // The resolution itself is still accepted — a bad lanes field never
    // sinks the result (the "handle undefined gracefully" contract).
    expect(isTabSessionResolutionResult(wire)).toBe(true);
    if (isTabSessionResolutionResult(wire)) {
      expect(wire.lanes).toBeUndefined();
      expect(wire.fusedCandidates).toHaveLength(1);
    }
  });

  it('carries lanes through the URL→tabSession adapter', () => {
    const url: UrlResolutionResult = {
      canonicalUrl: 'https://example.com/a',
      dryRun: true,
      decision: { action: 'inbox', margin: 0 },
      fusedCandidates: [candidate('ws-1')],
      lanes: [
        { lane: 'recency', candidates: [{ workstreamId: 'ws-1', score: 0.3, why: 'recent' }] },
      ],
    };
    const adapted = tabSessionResolutionFromUrl(url);
    expect(adapted.lanes).toBe(url.lanes);
    expect(adapted.lanes).toHaveLength(1);
  });
});
