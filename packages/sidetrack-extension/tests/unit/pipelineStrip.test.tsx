// Pipeline strip (feat/pipeline-strip) — the compact two-line pipeline
// visualization on the attribution card. These tests read back the seams the
// strip exercises:
//   - the six lane dots reflect populated/empty per the FIXED wire order;
//   - the verdict line derives from decision.gate (held detail, cleared
//     suggest/auto) and falls back to a count-based read when the gate is
//     absent (old companion) or malformed;
//   - the dots row is the toggle button for the GuessLanes disclosure.

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PipelineStrip } from '../../src/sidepanel/tabsession/PipelineStrip';
import { SuggestionStats } from '../../src/sidepanel/tabsession/SuggestionStats';
import {
  parseGuessGate,
  pipelineVerdictLine,
  type GuessGate,
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

// Two lanes with signal (graph, topic), the rest empty — the "some signal,
// fusion abstained" shape. Fixed wire order graph→recency.
const lanesWithSomeSignal: readonly GuessLaneResult[] = [
  {
    lane: 'graph',
    candidates: [{ workstreamId: 'ws-1', score: 0.42, why: 'linked from a Research visit' }],
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

// feat/content-lane — the 7th lane, appended AFTER recency. One populated
// (Content dot filled) and one empty (Content dot hollow but PRESENT).
const lanesWithContentFilled: readonly GuessLaneResult[] = [
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

// feat/ai-lane — the 8th lane, appended AFTER content. This is the live JFrog
// shape (2026-07-27): six structural lanes empty, content + ai both carrying
// candidates. The strip rendered SEVEN dots for it — no AI dot at all — because
// the client parse dropped the unknown 'ai' lane (types.ts VALID_LANES) and the
// strip had no branch to append an 8th chip. Both are pinned below.
const lanesWithAiFilled: readonly GuessLaneResult[] = [
  ...lanesWithContentFilled,
  {
    lane: 'ai',
    candidates: [{ workstreamId: 'ws-3', score: 0.48, why: '3 matches (CVE triage)' }],
  },
];
const lanesWithAiEmpty: readonly GuessLaneResult[] = [
  ...lanesWithContentFilled,
  { lane: 'ai', candidates: [], emptyReason: 'no gist for this page yet' },
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

// The strip's dots-row button carries an accessible name that flips with open;
// this locates it regardless of open state.
const getDotsButton = (): HTMLElement =>
  screen.getByRole('button', { name: /(Show|Hide) lane breakdown/u });

describe('PipelineStrip — lane dots', () => {
  it('(1) renders six dots in the fixed order, filled for populated lanes and hollow for empty', () => {
    render(
      <PipelineStrip
        lanes={lanesWithSomeSignal}
        workstreams={workstreams}
        fusedCount={0}
        open={false}
        onToggle={vi.fn()}
      />,
    );
    const button = getDotsButton();
    // Six chips, in wire order.
    const labels = ['Graph', 'Similar', 'Topic', 'Title', 'Domain', 'Recent'];
    for (const label of labels) {
      expect(within(button).getByText(label)).toBeDefined();
    }
    // The chip text order matches the fixed wire order.
    const renderedLabels = Array.from(button.querySelectorAll('.pipeline-chip-label')).map(
      (el) => el.textContent,
    );
    expect(renderedLabels).toEqual(labels);
    // graph + topic populated → filled; the other four hollow.
    const chips = Array.from(button.querySelectorAll('.pipeline-chip'));
    const filledIndexes = chips
      .map((c, i) => (c.classList.contains('is-filled') ? i : -1))
      .filter((i) => i >= 0);
    // graph = index 0, topic = index 2.
    expect(filledIndexes).toEqual([0, 2]);
  });

  it('(1b) 7-lane payload (content present, populated) renders a 7th filled Content dot', () => {
    render(
      <PipelineStrip
        lanes={lanesWithContentFilled}
        workstreams={workstreams}
        fusedCount={0}
        open={false}
        onToggle={vi.fn()}
      />,
    );
    const button = getDotsButton();
    const renderedLabels = Array.from(button.querySelectorAll('.pipeline-chip-label')).map(
      (el) => el.textContent,
    );
    // Exactly SEVEN chips, Content appended last.
    expect(renderedLabels).toEqual(['Graph', 'Similar', 'Topic', 'Title', 'Domain', 'Recent', 'Content']);
    const chips = Array.from(button.querySelectorAll('.pipeline-chip'));
    expect(chips).toHaveLength(7);
    // graph (0), topic (2), content (6) populated → filled.
    const filledIndexes = chips
      .map((c, i) => (c.classList.contains('is-filled') ? i : -1))
      .filter((i) => i >= 0);
    expect(filledIndexes).toEqual([0, 2, 6]);
    // The content chip's aria names its top candidate's workstream.
    expect(screen.getByLabelText('Content: Infra / Deploy')).toBeDefined();
  });

  it('(1c) 7-lane payload (content present, EMPTY) still renders the Content dot, hollow', () => {
    render(
      <PipelineStrip
        lanes={lanesWithContentEmpty}
        workstreams={workstreams}
        fusedCount={0}
        open={false}
        onToggle={vi.fn()}
      />,
    );
    const button = getDotsButton();
    const chips = Array.from(button.querySelectorAll('.pipeline-chip'));
    expect(chips).toHaveLength(7);
    // Content is the 7th chip, hollow, and names its own emptyReason.
    expect(within(button).getByText('Content')).toBeDefined();
    expect(chips[6]?.classList.contains('is-empty')).toBe(true);
    expect(screen.getByLabelText('Content: no indexed page text yet')).toBeDefined();
  });

  it('(1e) 8-lane payload renders an 8th AI dot after Content — the live missing-dot bug', () => {
    render(
      <PipelineStrip
        lanes={lanesWithAiFilled}
        workstreams={workstreams}
        fusedCount={0}
        open={false}
        onToggle={vi.fn()}
      />,
    );
    const button = getDotsButton();
    const renderedLabels = Array.from(button.querySelectorAll('.pipeline-chip-label')).map(
      (el) => el.textContent,
    );
    // Exactly EIGHT chips, AI appended last (after Content).
    expect(renderedLabels).toEqual([
      'Graph',
      'Similar',
      'Topic',
      'Title',
      'Domain',
      'Recent',
      'Content',
      'AI',
    ]);
    const chips = Array.from(button.querySelectorAll('.pipeline-chip'));
    expect(chips).toHaveLength(8);
    // graph (0), topic (2), content (6), ai (7) populated → filled.
    const filledIndexes = chips
      .map((c, i) => (c.classList.contains('is-filled') ? i : -1))
      .filter((i) => i >= 0);
    expect(filledIndexes).toEqual([0, 2, 6, 7]);
    // The AI chip's aria names its top candidate's workstream.
    expect(screen.getByLabelText('AI: Reading / Longform')).toBeDefined();
  });

  it('(1f) an EMPTY ai lane still renders its dot, hollow, naming its own reason', () => {
    render(
      <PipelineStrip
        lanes={lanesWithAiEmpty}
        workstreams={workstreams}
        fusedCount={0}
        open={false}
        onToggle={vi.fn()}
      />,
    );
    const button = getDotsButton();
    const chips = Array.from(button.querySelectorAll('.pipeline-chip'));
    expect(chips).toHaveLength(8);
    expect(chips[7]?.classList.contains('is-empty')).toBe(true);
    expect(screen.getByLabelText('AI: no gist for this page yet')).toBeDefined();
  });

  it('(1d) 6-lane payload (old companion / lane disabled) renders exactly 6 dots — no phantom Content', () => {
    render(
      <PipelineStrip
        lanes={lanesWithSomeSignal}
        workstreams={workstreams}
        fusedCount={0}
        open={false}
        onToggle={vi.fn()}
      />,
    );
    const button = getDotsButton();
    const chips = Array.from(button.querySelectorAll('.pipeline-chip'));
    expect(chips).toHaveLength(6);
    expect(within(button).queryByText('Content')).toBeNull();
  });

  it('a filled chip aria/title names the lane top candidate; a hollow one names the emptyReason', () => {
    render(
      <PipelineStrip
        lanes={lanesWithSomeSignal}
        workstreams={workstreams}
        fusedCount={0}
        open={false}
        onToggle={vi.fn()}
      />,
    );
    // Graph is filled → describes its top candidate's workstream NAME.
    expect(screen.getByLabelText('Graph: Research / Probability')).toBeDefined();
    // Similar is empty → describes its own emptyReason.
    expect(screen.getByLabelText('Similar: no similar pages indexed')).toBeDefined();
  });
});

describe('PipelineStrip — verdict line', () => {
  it('(2) held gate → renders "→ held: {gate.detail}" verbatim', () => {
    const gate: GuessGate = { reason: 'below-suggest', detail: 'top 0.82 < 1.2 suggest bar' };
    render(
      <PipelineStrip
        lanes={lanesWithSomeSignal}
        workstreams={workstreams}
        gate={gate}
        fusedCount={2}
        open={false}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText('→ held: top 0.82 < 1.2 suggest bar')).toBeDefined();
  });

  it('(3) cleared-suggest → "→ suggested"; cleared-auto → "→ auto-filed"', () => {
    const suggestGate: GuessGate = { reason: 'cleared-suggest', detail: 'top 1.4 ≥ 1.2 bar' };
    const first = render(
      <PipelineStrip
        lanes={lanesWithSomeSignal}
        workstreams={workstreams}
        gate={suggestGate}
        fusedCount={2}
        open={false}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText('→ suggested')).toBeDefined();
    first.unmount();

    const autoGate: GuessGate = { reason: 'cleared-auto', detail: 'top 2.1, margin 0.9' };
    render(
      <PipelineStrip
        lanes={lanesWithSomeSignal}
        workstreams={workstreams}
        gate={autoGate}
        fusedCount={2}
        open={false}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText('→ auto-filed')).toBeDefined();
  });

  it('(4) absent gate → count fallback: >0 fused → "held below the bar", 0 → "nothing corroborated"', () => {
    const withCandidates = render(
      <PipelineStrip
        lanes={lanesWithSomeSignal}
        workstreams={workstreams}
        fusedCount={2}
        open={false}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText('→ held below the bar')).toBeDefined();
    withCandidates.unmount();

    render(
      <PipelineStrip
        lanes={lanesWithSomeSignal}
        workstreams={workstreams}
        fusedCount={0}
        open={false}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText('→ nothing corroborated')).toBeDefined();
  });

  it('pipelineVerdictLine covers each gate reason + the fallbacks (pure)', () => {
    expect(pipelineVerdictLine({ reason: 'cleared-auto', detail: 'x' }, 3)).toBe('→ auto-filed');
    expect(pipelineVerdictLine({ reason: 'cleared-suggest', detail: 'x' }, 3)).toBe('→ suggested');
    for (const reason of [
      'no-candidates',
      'corroboration',
      'below-suggest',
      'margin-tie',
      'regret-budget',
    ] as const) {
      expect(pipelineVerdictLine({ reason, detail: 'why-num' }, 1)).toBe('→ held: why-num');
    }
    expect(pipelineVerdictLine(undefined, 2)).toBe('→ held below the bar');
    expect(pipelineVerdictLine(undefined, 0)).toBe('→ nothing corroborated');
  });
});

describe('PipelineStrip — toggles the lanes disclosure', () => {
  it('(5) clicking the dots row calls onToggle', () => {
    const onToggle = vi.fn();
    render(
      <PipelineStrip
        lanes={lanesWithSomeSignal}
        workstreams={workstreams}
        fusedCount={0}
        open={false}
        onToggle={onToggle}
      />,
    );
    fireEvent.click(getDotsButton());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('(5b) mounted in SuggestionStats, the dots row opens the GuessLanes disclosure', () => {
    render(
      <SuggestionStats
        suggestion={resolution({ action: 'inbox', margin: 0 }, [], lanesWithSomeSignal)}
        workstreams={workstreams}
        showEmptyPlaceholder
        pageAccessGranted
      />,
    );
    // The lanes disclosure is closed at rest.
    const summary = screen.getByText('Guess lanes · 2 of 6 with signal');
    const details = summary.closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    // Clicking the strip's dots row opens it (controlled by the strip).
    fireEvent.click(getDotsButton());
    expect(details.open).toBe(true);
    // And clicking again closes it.
    fireEvent.click(getDotsButton());
    expect(details.open).toBe(false);
  });
});

describe('PipelineStrip — malformed gate degrades to absent (via parse)', () => {
  it('(6) a malformed gate parses to undefined → the strip uses the count fallback', () => {
    // The parse choke point (parseGuessGate) is what SuggestionStats runs on
    // decision.gate; a malformed gate collapses to undefined.
    expect(parseGuessGate({ reason: 'not-a-reason', detail: 'x' })).toBeUndefined();
    expect(parseGuessGate({ reason: 'below-suggest' })).toBeUndefined();
    expect(parseGuessGate({ detail: 'x' })).toBeUndefined();
    expect(parseGuessGate('nonsense')).toBeUndefined();
    expect(parseGuessGate(null)).toBeUndefined();
    expect(parseGuessGate(undefined)).toBeUndefined();

    // End-to-end: SuggestionStats given a malformed gate falls back to the
    // count-based verdict (fused candidates present → "held below the bar").
    render(
      <SuggestionStats
        suggestion={resolution(
          // A malformed gate on the wire — cast through unknown since the type
          // only admits well-formed gates.
          { action: 'inbox', margin: 0, gate: { reason: 'bogus' } as unknown as GuessGate },
          [fusedCandidate()],
          lanesWithSomeSignal,
        )}
        workstreams={workstreams}
        showEmptyPlaceholder
        pageAccessGranted
      />,
    );
    expect(screen.getByText('→ held below the bar')).toBeDefined();
    expect(screen.queryByText(/→ held: /u)).toBeNull();
  });

  it('a WELL-FORMED gate on a SuggestionStats resolution renders its held detail', () => {
    render(
      <SuggestionStats
        suggestion={resolution(
          { action: 'inbox', margin: 0, gate: { reason: 'corroboration', detail: 'only 1 arm agreed (need 2)' } },
          [],
          lanesWithSomeSignal,
        )}
        workstreams={workstreams}
        showEmptyPlaceholder
        pageAccessGranted
      />,
    );
    expect(screen.getByText('→ held: only 1 arm agreed (need 2)')).toBeDefined();
  });
});
