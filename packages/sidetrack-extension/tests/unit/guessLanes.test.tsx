// Guess-lanes (feat/guess-lanes) — the panel half. The companion now returns
// each resolver lane's own ranked guess on every resolve; the panel must (a)
// surface all six lanes behind a disclosure, and (b) stop lying "No signal
// yet" when the FUSION abstained but individual lanes had guesses.
//
// These tests read back the two seams the panel exercises:
//   - the lenient wire parse (parseGuessLanes): absent/malformed → treated as
//     absent, never rejecting the whole resolution;
//   - the SuggestionStats render: lanes behind a disclosure with workstream
//     names + why, the "No confident pick" headline swap, and the File-here
//     one-click filing through the EXISTING onFileHere handler.

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SuggestionStats } from '../../src/sidepanel/tabsession/SuggestionStats';
import { GuessLanes } from '../../src/sidepanel/tabsession/GuessLanes';
import {
  guessLaneSignalCount,
  parseGuessLanes,
  type GuessLaneResult,
  type TabSessionResolutionResult,
  type TabSessionResolverCandidate,
  type TabSessionWorkstreamOption,
} from '../../src/sidepanel/tabsession/types';

const workstreams: readonly TabSessionWorkstreamOption[] = [
  { bac_id: 'ws-1', path: 'Research / Probability' },
  { bac_id: 'ws-2', path: 'Infra / Deploy' },
  { bac_id: 'ws-3', path: 'Reading / Longform' },
];

const fusedCandidate = (
  over: Partial<TabSessionResolverCandidate> = {},
): TabSessionResolverCandidate => ({
  workstreamId: 'ws-1',
  rawFusionLogit: 1.2,
  dominantSource: 'ppr',
  reasons: [{ source: 'ppr', summary: 'graph 0.5', anchors: [] }],
  ...over,
});

const resolution = (
  decision: TabSessionResolutionResult['decision'],
  candidates: readonly TabSessionResolverCandidate[],
  lanes?: readonly GuessLaneResult[],
): TabSessionResolutionResult => ({
  tabSessionId: 'tses_1',
  dryRun: true,
  decision,
  fusedCandidates: candidates,
  ...(lanes === undefined ? {} : { lanes }),
});

// A representative lanes payload: two lanes with signal, the rest empty with
// their own reasons — the "some signal, fusion abstained" shape.
const lanesWithSomeSignal: readonly GuessLaneResult[] = [
  {
    lane: 'graph',
    candidates: [
      { workstreamId: 'ws-1', score: 0.42, why: 'linked from a Research visit' },
      { workstreamId: 'ws-2', score: 0.18, why: 'weak edge via a shared tab' },
    ],
  },
  { lane: 'similarity', candidates: [], emptyReason: 'no similar pages indexed' },
  {
    lane: 'topic',
    candidates: [{ workstreamId: 'ws-3', score: 0.31, why: 'sits in a Reading-heavy topic' }],
  },
  { lane: 'title', candidates: [], emptyReason: 'title matched nothing' },
  { lane: 'domain', candidates: [], emptyReason: 'domain unseen' },
  { lane: 'recency', candidates: [], emptyReason: 'no recent filing' },
];

const allEmptyLanes: readonly GuessLaneResult[] = [
  { lane: 'graph', candidates: [], emptyReason: 'no related visits' },
  { lane: 'similarity', candidates: [], emptyReason: 'no similar pages' },
  { lane: 'topic', candidates: [], emptyReason: 'no topic cluster' },
  { lane: 'title', candidates: [], emptyReason: 'title matched nothing' },
  { lane: 'domain', candidates: [], emptyReason: 'domain unseen' },
  { lane: 'recency', candidates: [], emptyReason: 'no recent filing' },
];

// feat/content-lane — the 7th lane appended AFTER recency. Two shapes: a
// POPULATED content lane (with a candidate + why) and an EMPTY one (its own
// emptyReason). Both must render as their own disclosure row in array order.
const lanesWithContentSignal: readonly GuessLaneResult[] = [
  ...lanesWithSomeSignal,
  {
    lane: 'content',
    candidates: [{ workstreamId: 'ws-2', score: 0.55, why: 'page text overlaps an Infra note' }],
  },
];
const lanesWithContentEmpty: readonly GuessLaneResult[] = [
  ...lanesWithSomeSignal,
  { lane: 'content', candidates: [], emptyReason: 'no indexed page text yet' },
];

// feat/ai-lane — the 8th lane appended AFTER content. The disclosure renders in
// array order, so it needs no per-lane branch; what it DID need was for the
// client parse to stop dropping the lane (types.ts VALID_LANES), which is why
// the live 8-lane payload showed no AI row at all.
const lanesWithAiSignal: readonly GuessLaneResult[] = [
  ...lanesWithContentSignal,
  {
    lane: 'ai',
    candidates: [{ workstreamId: 'ws-3', score: 0.48, why: '3 matches (CVE triage)' }],
  },
];

describe('guess-lanes — SuggestionStats render', () => {
  it('(1) renders the lanes behind a disclosure with workstream names + why', () => {
    render(
      <SuggestionStats
        // Abstaining fusion (empty fusedCandidates) so the lanes carry the story.
        suggestion={resolution({ action: 'inbox', margin: 0 }, [], lanesWithSomeSignal)}
        workstreams={workstreams}
        showEmptyPlaceholder
        pageAccessGranted
      />,
    );
    // Disclosure summary counts lanes-with-signal (graph + topic = 2 of 6).
    const summary = screen.getByText('Guess lanes · 2 of 6 with signal');
    expect(summary).toBeDefined();
    const details = summary.closest('details');
    expect(details).not.toBeNull();
    // The lane rows resolve workstream ids to NAMES, not raw bac_ids.
    expect(screen.getByText('Research / Probability')).toBeDefined();
    expect(screen.getByText('Reading / Longform')).toBeDefined();
    // The lane `why` line is shown verbatim.
    expect(screen.getByText('linked from a Research visit')).toBeDefined();
    expect(screen.getByText('sits in a Reading-heavy topic')).toBeDefined();
    // All six lanes are listed — empty ones surface their own emptyReason.
    expect(screen.getByText('no similar pages indexed')).toBeDefined();
    expect(screen.getByText('domain unseen')).toBeDefined();
    // The lane label text is present for every lane. ("Graph" now appears
    // twice — the pipeline-strip chip AND the disclosure's lane label — so
    // assert at least one; "Recently active" is unique to the disclosure.)
    expect(screen.getAllByText('Graph').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Recently active')).toBeDefined();
  });

  it('(2) abstained-with-lane-signal shows the "No confident pick" headline, NOT "No signal yet"', () => {
    render(
      <SuggestionStats
        suggestion={resolution({ action: 'inbox', margin: 0 }, [], lanesWithSomeSignal)}
        workstreams={workstreams}
        showEmptyPlaceholder
        pageAccessGranted
      />,
    );
    expect(screen.getByText('No confident pick — lane guesses below')).toBeDefined();
    // The old lie must be gone.
    expect(screen.queryByText('No signal yet')).toBeNull();
    expect(screen.queryByText('No connections yet')).toBeNull();
  });

  it('(2b) keeps the honest "No confident pick" headline even for a REVISIT with lane signal', () => {
    render(
      <SuggestionStats
        suggestion={resolution({ action: 'inbox', margin: 0 }, [], lanesWithSomeSignal)}
        workstreams={workstreams}
        showEmptyPlaceholder
        pageAccessGranted
        visitCount={7}
      />,
    );
    expect(screen.getByText('No confident pick — lane guesses below')).toBeDefined();
    expect(screen.queryByText('No connections yet')).toBeNull();
  });

  it('(3) lanes ABSENT → exact legacy behavior ("No signal yet" / "No connections yet")', () => {
    // First visit, no lanes field → the legacy first-seen copy, unchanged.
    const first = render(
      <SuggestionStats
        suggestion={resolution({ action: 'inbox', margin: 0 }, [])}
        workstreams={workstreams}
        showEmptyPlaceholder
        pageAccessGranted
      />,
    );
    expect(screen.getByText('No signal yet')).toBeDefined();
    expect(screen.queryByText(/Guess lanes/)).toBeNull();
    expect(screen.queryByText('No confident pick — lane guesses below')).toBeNull();
    first.unmount();

    // Revisit, no lanes field → the legacy "No connections yet" copy, unchanged.
    render(
      <SuggestionStats
        suggestion={resolution({ action: 'inbox', margin: 0 }, [])}
        workstreams={workstreams}
        showEmptyPlaceholder
        pageAccessGranted
        visitCount={4}
      />,
    );
    expect(screen.getByText('No connections yet')).toBeDefined();
    expect(screen.queryByText(/Guess lanes/)).toBeNull();
  });

  it('(4) all-lanes-empty → legacy empty headline PLUS the lanes disclosure showing empty reasons', () => {
    render(
      <SuggestionStats
        suggestion={resolution({ action: 'inbox', margin: 0 }, [], allEmptyLanes)}
        workstreams={workstreams}
        showEmptyPlaceholder
        pageAccessGranted
      />,
    );
    // Zero lane signal → the honest legacy headline stands (NOT "No confident pick").
    expect(screen.getByText('No signal yet')).toBeDefined();
    expect(screen.queryByText('No confident pick — lane guesses below')).toBeNull();
    // But the disclosure still renders so every lane accounts for itself.
    expect(screen.getByText('Guess lanes · 0 of 6 with signal')).toBeDefined();
    expect(screen.getByText('no related visits')).toBeDefined();
    expect(screen.getByText('no topic cluster')).toBeDefined();
  });

  it('(5) File-here on a lane candidate calls onFileHere with the candidate workstreamId', () => {
    const onFileHere = vi.fn();
    render(
      <SuggestionStats
        suggestion={resolution({ action: 'inbox', margin: 0 }, [], lanesWithSomeSignal)}
        workstreams={workstreams}
        showEmptyPlaceholder
        pageAccessGranted
        onFileHere={onFileHere}
      />,
    );
    // The topic lane's top candidate is ws-3 (Reading / Longform).
    const laneRow = screen.getByText('Reading / Longform').closest('li');
    expect(laneRow).not.toBeNull();
    const fileButton = within(laneRow as HTMLElement).getByRole('button', { name: 'File here' });
    fireEvent.click(fileButton);
    expect(onFileHere).toHaveBeenCalledTimes(1);
    expect(onFileHere).toHaveBeenCalledWith('ws-3');
  });

  it('renders lane rows read-only (no File-here button) when onFileHere is omitted', () => {
    render(
      <SuggestionStats
        suggestion={resolution({ action: 'inbox', margin: 0 }, [], lanesWithSomeSignal)}
        workstreams={workstreams}
        showEmptyPlaceholder
        pageAccessGranted
      />,
    );
    expect(screen.getByText('Guess lanes · 2 of 6 with signal')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'File here' })).toBeNull();
  });

  it('(7) renders the Content lane row when the payload carries it — populated', () => {
    render(
      <SuggestionStats
        suggestion={resolution({ action: 'inbox', margin: 0 }, [], lanesWithContentSignal)}
        workstreams={workstreams}
        showEmptyPlaceholder
        pageAccessGranted
      />,
    );
    // The summary counts the 7 lanes (graph + topic + content = 3 with signal).
    expect(screen.getByText('Guess lanes · 3 of 7 with signal')).toBeDefined();
    // The full label + the candidate + the why line all render.
    expect(screen.getByText('Content match')).toBeDefined();
    expect(screen.getByText('page text overlaps an Infra note')).toBeDefined();
    // ws-2 resolves to a NAME in the content lane row.
    const contentRow = screen.getByText('Content match').closest('li');
    expect(contentRow).not.toBeNull();
    expect(within(contentRow as HTMLElement).getByText('Infra / Deploy')).toBeDefined();
  });

  it('(7b) renders the Content lane row with its emptyReason when the payload carries it empty', () => {
    render(
      <SuggestionStats
        suggestion={resolution({ action: 'inbox', margin: 0 }, [], lanesWithContentEmpty)}
        workstreams={workstreams}
        showEmptyPlaceholder
        pageAccessGranted
      />,
    );
    // 7 lanes, still only graph + topic with signal (content is empty).
    expect(screen.getByText('Guess lanes · 2 of 7 with signal')).toBeDefined();
    expect(screen.getByText('Content match')).toBeDefined();
    expect(screen.getByText('no indexed page text yet')).toBeDefined();
  });

  it('(7d) renders the AI lane row as the 8th entry when the payload carries it', () => {
    render(
      <SuggestionStats
        suggestion={resolution({ action: 'inbox', margin: 0 }, [], lanesWithAiSignal)}
        workstreams={workstreams}
        showEmptyPlaceholder
        pageAccessGranted
      />,
    );
    // 8 lanes now, 4 of them with signal (graph + topic + content + ai).
    expect(screen.getByText('Guess lanes · 4 of 8 with signal')).toBeDefined();
    // The lane's own label + why + workstream name all render …
    const aiRow = screen.getByText('AI gist match').closest('li');
    expect(aiRow).not.toBeNull();
    expect(within(aiRow as HTMLElement).getByText('Reading / Longform')).toBeDefined();
    expect(within(aiRow as HTMLElement).getByText('3 matches (CVE triage)')).toBeDefined();
    // … and it sits LAST, after the Content row (the disclosure renders in
    // array order, which is the wire order).
    const rows = Array.from(
      (aiRow as HTMLElement).closest('ul')?.querySelectorAll('.guess-lane-label') ?? [],
    ).map((el) => el.textContent);
    expect(rows[rows.length - 2]).toBe('Content match');
    expect(rows[rows.length - 1]).toBe('AI gist match');
  });

  it('(7c) 6-lane payload (old companion / lane disabled) shows NO Content row', () => {
    render(
      <SuggestionStats
        suggestion={resolution({ action: 'inbox', margin: 0 }, [], lanesWithSomeSignal)}
        workstreams={workstreams}
        showEmptyPlaceholder
        pageAccessGranted
      />,
    );
    expect(screen.getByText('Guess lanes · 2 of 6 with signal')).toBeDefined();
    expect(screen.queryByText('Content match')).toBeNull();
  });

  it('surfaces the lanes disclosure under a CONFIDENT (populated) suggestion too', () => {
    render(
      <SuggestionStats
        suggestion={resolution(
          { action: 'suggest', workstreamId: 'ws-1', margin: 0.9 },
          [fusedCandidate({ workstreamId: 'ws-1', rawFusionLogit: 2.5 })],
          lanesWithSomeSignal,
        )}
        workstreams={workstreams}
        showEmptyPlaceholder
      />,
    );
    // The endorsed headline is shown (ws-1 also appears as the graph lane's
    // top candidate, so getAllByText tolerates the duplicate) …
    expect(screen.getAllByText('Research / Probability').length).toBeGreaterThanOrEqual(1);
    // … AND the lane breakdown disclosure is available behind a click.
    expect(screen.getByText('Guess lanes · 2 of 6 with signal')).toBeDefined();
  });
});

describe('guess-lanes — lenient wire parse (parseGuessLanes)', () => {
  it('(6) malformed lanes in the wire are treated as ABSENT (undefined), never rejected', () => {
    // A non-array lanes field → the whole thing degrades to "no lanes".
    expect(parseGuessLanes('nonsense')).toBeUndefined();
    expect(parseGuessLanes({ lane: 'graph' })).toBeUndefined();
    expect(parseGuessLanes(undefined)).toBeUndefined();
    expect(parseGuessLanes(null)).toBeUndefined();
    // An array of entirely-malformed entries → nothing survives → undefined.
    expect(
      parseGuessLanes([
        { lane: 'not-a-lane', candidates: [] },
        { candidates: [] },
        42,
        null,
      ]),
    ).toBeUndefined();
  });

  it('drops a bad candidate but keeps the surviving good ones in the same lane', () => {
    const parsed = parseGuessLanes([
      {
        lane: 'graph',
        candidates: [
          { workstreamId: 'ws-1', score: 0.5, why: 'ok' },
          { workstreamId: 42, score: 0.4, why: 'bad id' }, // dropped
          { score: 0.3, why: 'no id' }, // dropped
          { workstreamId: 'ws-2', score: 0.2, why: 'ok too' },
        ],
      },
    ]);
    expect(parsed).toBeDefined();
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]?.candidates.map((c) => c.workstreamId)).toEqual(['ws-1', 'ws-2']);
  });

  it('caps candidates at 3 per lane (the wire contract) and drops unknown-lane entries', () => {
    const parsed = parseGuessLanes([
      { lane: 'unknownlane', candidates: [{ workstreamId: 'ws-1', score: 0.9, why: 'x' }] },
      {
        lane: 'recency',
        candidates: [
          { workstreamId: 'ws-1', score: 0.9, why: 'a' },
          { workstreamId: 'ws-2', score: 0.8, why: 'b' },
          { workstreamId: 'ws-3', score: 0.7, why: 'c' },
          { workstreamId: 'ws-4', score: 0.6, why: 'd' },
        ],
      },
    ]);
    // The unknown lane is dropped; only the valid 'recency' lane survives.
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]?.lane).toBe('recency');
    expect(parsed?.[0]?.candidates).toHaveLength(3);
  });

  it("parses the 7th 'content' and 8th 'ai' lanes as valid while still dropping unknown lanes", () => {
    // THE MISSING-DOT BUG: 'ai' was absent from VALID_LANES, so this parse
    // silently deleted the lane the companion had sent and every renderer
    // downstream (strip AND disclosure) saw a 7-lane array.
    const parsed = parseGuessLanes([
      { lane: 'recency', candidates: [], emptyReason: 'no recent filing' },
      { lane: 'content', candidates: [{ workstreamId: 'ws-1', score: 0.5, why: 'text overlap' }] },
      { lane: 'ai', candidates: [{ workstreamId: 'ws-2', score: 0.48, why: 'gist match' }] },
      // Anything beyond the known 8 is still dropped leniently.
      { lane: 'brand-new-lane', candidates: [{ workstreamId: 'ws-9', score: 0.9, why: 'x' }] },
    ]);
    expect(parsed).toHaveLength(3);
    expect(parsed?.map((lane) => lane.lane)).toEqual(['recency', 'content', 'ai']);
    expect(parsed?.[2]?.candidates).toHaveLength(1);
    expect(guessLaneSignalCount(parsed)).toBe(2);
  });

  it('keeps an empty lane with its emptyReason (all-empty lanes still parse)', () => {
    const parsed = parseGuessLanes([
      { lane: 'domain', candidates: [], emptyReason: 'domain unseen' },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]?.candidates).toHaveLength(0);
    expect(parsed?.[0]?.emptyReason).toBe('domain unseen');
    expect(guessLaneSignalCount(parsed)).toBe(0);
  });

  it('guessLaneSignalCount totals candidates across lanes (undefined → 0)', () => {
    expect(guessLaneSignalCount(undefined)).toBe(0);
    expect(guessLaneSignalCount(lanesWithSomeSignal)).toBe(3); // 2 (graph) + 1 (topic)
    expect(guessLaneSignalCount(allEmptyLanes)).toBe(0);
  });
});

// feat/webgpu-enrichment — the companion appends provenance to a lane `why`
// when the winning signal came from an enriched title/gist (' · synthesized
// title', ' · gist'). `why` is free text on the extension side (no parsing),
// but the row must render the longer string verbatim and gracefully — no
// truncation, no overflow class swallowing it. This reads back that render.
describe('guess-lanes — enriched provenance in why renders verbatim', () => {
  it('renders a lane why annotated with "· synthesized title"', () => {
    const lanes: readonly GuessLaneResult[] = [
      {
        lane: 'content',
        candidates: [
          {
            workstreamId: 'ws-1',
            score: 0.71,
            why: 'content vector cosine 0.71 · synthesized title',
          },
        ],
      },
    ];
    render(<GuessLanes lanes={lanes} workstreams={workstreams} />);
    // The disclosure is collapsed by default; open it, then assert the full
    // annotated why is present (free text rendered verbatim).
    fireEvent.click(screen.getByText(/Guess lanes/u));
    expect(
      screen.getByText('content vector cosine 0.71 · synthesized title'),
    ).toBeInTheDocument();
  });

  it('renders a lane why annotated with "· gist"', () => {
    const lanes: readonly GuessLaneResult[] = [
      {
        lane: 'content',
        candidates: [{ workstreamId: 'ws-2', score: 0.64, why: 'semantic match 0.64 · gist' }],
      },
    ];
    render(<GuessLanes lanes={lanes} workstreams={workstreams} />);
    fireEvent.click(screen.getByText(/Guess lanes/u));
    expect(screen.getByText('semantic match 0.64 · gist')).toBeInTheDocument();
  });
});
