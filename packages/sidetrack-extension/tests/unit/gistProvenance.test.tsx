import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ContentEnrichmentAction,
  type EnrichmentTarget,
} from '../../src/sidepanel/nano/ContentEnrichmentAction';
import type { EngineAvailability } from '../../src/sidepanel/nano/language';
import { GuessLanes } from '../../src/sidepanel/tabsession/GuessLanes';
import {
  GIST_QUERY_FRAMING,
  gistInfluenceFrom,
  gistProvenanceLine,
  whyUsedGist,
} from '../../src/sidepanel/tabsession/gistProvenance';
import type {
  GuessLaneResult,
  TabSessionWorkstreamOption,
} from '../../src/sidepanel/tabsession/types';

// DEFECT 2 — "don't know how gist's output provide guess line output from ui".
//
// The connection ran only one way and invisibly: the companion appended ' ·
// gist' to the content lane's `why` and nothing told the user that the gist
// they had just generated was the thing being referred to. These tests pin the
// connection in BOTH directions, and pin the honesty of the claim: the gist is
// part of the Content lane's QUERY TEXT. Any copy that says the gist produced
// the ranking is a fabrication this suite must fail on.

const STORE_KEY = 'sidetrack.enrichment.gists.v1';
const TARGET: EnrichmentTarget = { kind: 'url', canonicalUrl: 'https://example.com/a' };

const workstreams: readonly TabSessionWorkstreamOption[] = [
  { bac_id: 'ws-1', path: 'Research / Probability' },
  { bac_id: 'ws-2', path: 'Infra / Deploy' },
];

const availability = (): EngineAvailability => ({
  nanoReady: true,
  webGpuLoaded: false,
  webGpuLoading: false,
  webGpuSupported: true,
});

const installStoredGist = (gist = 'A gist about deploy pipelines.') => {
  const data: Record<string, unknown> = {
    [STORE_KEY]: { 'url:https://example.com/a': { gist, savedAt: '2026-07-26T10:00:00.000Z' } },
  };
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (key: string) => (key in data ? { [key]: data[key] } : {}),
        set: async (entries: Record<string, unknown>) => {
          Object.assign(data, entries);
        },
        remove: async (key: string) => {
          delete data[key];
        },
      },
    },
  });
};

const renderRow = (props: Partial<React.ComponentProps<typeof ContentEnrichmentAction>> = {}) =>
  render(
    <ContentEnrichmentAction
      target={TARGET}
      port={17_373}
      bridgeKey="k"
      availability={availability()}
      workstreams={workstreams}
      fetchText={async () => null}
      {...props}
    />,
  );

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('gist provenance — the honest reading of the lane marker', () => {
  it('reads the ` · gist` marker the companion appends, and nothing else', () => {
    expect(whyUsedGist('3 matches (Deploy notes) · gist')).toBe(true);
    expect(whyUsedGist('3 matches (Deploy notes) · title-vector')).toBe(false);
    // A workstream that happens to be ABOUT gists is not a gist marker.
    expect(whyUsedGist('2 matches (gist experiments)')).toBe(false);
  });

  it('names the guesses the gist is feeding, and refuses the causal upgrade', () => {
    const lanes: readonly GuessLaneResult[] = [
      {
        lane: 'content',
        candidates: [
          { workstreamId: 'ws-2', score: 0.61, why: '3 matches (Deploy runbook) · gist' },
          { workstreamId: 'ws-1', score: 0.2, why: '1 match (Sampling) · title-vector' },
        ],
      },
    ];
    const influence = gistInfluenceFrom(lanes, workstreams);
    expect(influence.state).toBe('feeding');
    expect(influence.workstreamNames).toEqual(['Infra / Deploy']);
    const line = gistProvenanceLine(influence);
    expect(line).toContain('Infra / Deploy');
    expect(line).toContain(GIST_QUERY_FRAMING);
    // The claim stops at "part of the query text" — never "produced" / "decided".
    expect(line).not.toMatch(/produced|decided|because of the gist|caused/iu);
  });

  it('says plainly when the gist is feeding nothing, for each honest reason', () => {
    expect(gistProvenanceLine(gistInfluenceFrom(undefined, workstreams))).toContain(
      'Not influencing any guess yet',
    );
    expect(gistInfluenceFrom(undefined, workstreams).state).toBe('lane-absent');
    const empty: readonly GuessLaneResult[] = [
      { lane: 'content', candidates: [], emptyReason: 'no indexed page text yet' },
    ];
    expect(gistInfluenceFrom(empty, workstreams).state).toBe('lane-empty');
    const unused: readonly GuessLaneResult[] = [
      {
        lane: 'content',
        candidates: [{ workstreamId: 'ws-1', score: 0.3, why: '2 matches · title-vector' }],
      },
    ];
    expect(gistInfluenceFrom(unused, workstreams).state).toBe('lane-unused');
    for (const lanes of [undefined, empty, unused]) {
      const line = gistProvenanceLine(gistInfluenceFrom(lanes, workstreams));
      expect(line).toContain('Not influencing any guess yet');
      expect(line).toContain(GIST_QUERY_FRAMING);
    }
  });
});

describe('gist provenance — from the gist, on the Now card', () => {
  it('states which guess the shown gist is feeding, with the query-text framing', async () => {
    installStoredGist();
    const lanes: readonly GuessLaneResult[] = [
      {
        lane: 'content',
        candidates: [{ workstreamId: 'ws-2', score: 0.61, why: '3 matches (Deploy runbook) · gist' }],
      },
    ];
    renderRow({ lanes });
    await waitFor(() => {
      expect(screen.getByTestId('now-enrich-gist-provenance')).toBeInTheDocument();
    });
    const provenance = screen.getByTestId('now-enrich-gist-provenance');
    expect(provenance).toHaveTextContent('Infra / Deploy');
    expect(provenance).toHaveTextContent("Content lane's query text");
    expect(provenance.textContent ?? '').not.toMatch(/produced|decided|caused/iu);
  });

  it('says the gist is influencing nothing yet when no lane used it', async () => {
    installStoredGist();
    renderRow({
      lanes: [{ lane: 'content', candidates: [], emptyReason: 'no indexed page text yet' }],
    });
    await waitFor(() => {
      expect(screen.getByTestId('now-enrich-gist-provenance')).toHaveTextContent(
        'Not influencing any guess yet',
      );
    });
    expect(screen.getByTestId('now-enrich-gist-provenance')).toHaveTextContent(
      "Content lane's query text",
    );
  });
});

describe('gist provenance — from the lane, in the guess-lanes breakdown', () => {
  it('marks a content lane whose evidence used the gist, in words, without losing the raw why', () => {
    const lanes: readonly GuessLaneResult[] = [
      {
        lane: 'content',
        candidates: [{ workstreamId: 'ws-2', score: 0.64, why: 'semantic match 0.64 · gist' }],
      },
    ];
    render(<GuessLanes lanes={lanes} workstreams={workstreams} />);
    fireEvent.click(screen.getByText(/Guess lanes/u));
    const row = screen.getByText('Content match').closest('li');
    expect(row).not.toBeNull();
    // The companion's raw why still renders verbatim…
    expect(within(row as HTMLElement).getByText('semantic match 0.64 · gist')).toBeInTheDocument();
    // …and the marker is now legible English that points at the gist above.
    const marker = screen.getByTestId('guess-lane-gist-marker');
    expect(marker).toHaveTextContent('used the gist you generated');
    expect(marker.getAttribute('title') ?? '').toContain("query text");
    expect(marker.getAttribute('title') ?? '').toContain('on-device AI row');
  });

  it('does NOT mark a content lane that did not use a gist', () => {
    const lanes: readonly GuessLaneResult[] = [
      {
        lane: 'content',
        candidates: [{ workstreamId: 'ws-2', score: 0.64, why: 'semantic match 0.64 · title-vector' }],
      },
      {
        lane: 'topic',
        candidates: [{ workstreamId: 'ws-1', score: 0.5, why: 'sits in a Research topic' }],
      },
    ];
    render(<GuessLanes lanes={lanes} workstreams={workstreams} />);
    fireEvent.click(screen.getByText(/Guess lanes/u));
    expect(screen.queryByTestId('guess-lane-gist-marker')).toBeNull();
  });
});
