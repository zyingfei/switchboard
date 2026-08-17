// Producer-to-render contract (task #29). This is the test that would have
// caught BOTH live incidents — the 'ai' lane silently dropped by the parse
// allowlist, and the 'prototype' lane silently dropped by the strip's render
// order — the day each lane shipped server-side, instead of a day (or more)
// later via a live bug report.
//
// For EVERY lane registered in laneRegistry.ts, this builds a synthetic
// companion resolve payload containing ONLY that lane (as it would arrive
// on the wire — a plain JSON value, not a typed literal), runs it through
// the REAL parser (parseGuessLanes) and the REAL render surfaces
// (GuessLanes' disclosure, PipelineStrip's dots row), and asserts:
//   (a) the parser keeps the lane (VALID_LANES allowlist doesn't drop it);
//   (b) the disclosure renders a row for it, correctly labeled, with the
//       candidate's workstream name and `why` text;
//   (c) the pipeline strip renders a FILLED chip for it, correctly
//       short-labeled, with the candidate's workstream name in its
//       title/aria description.
// A lane added to laneRegistry.ts without matching render support fails
// (b)/(c) immediately; a lane added to the wire without a laneRegistry.ts
// entry fails (a) (parseGuessLanes drops it — see types.test coverage) and
// is impossible to even parameterize here (this test only iterates
// REGISTERED lanes — the mirror test in laneRegistry.test.ts is what catches
// a registry that itself omits a lane the companion actually sends).

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { GuessLanes } from '../../src/sidepanel/tabsession/GuessLanes';
import { ALL_LANE_IDS, ATTRIBUTION_LANES } from '../../src/sidepanel/tabsession/laneRegistry';
import { PipelineStrip } from '../../src/sidepanel/tabsession/PipelineStrip';
import { parseGuessLanes, type TabSessionWorkstreamOption } from '../../src/sidepanel/tabsession/types';

const getDotsButton = (): HTMLElement =>
  screen.getByRole('button', { name: /(Show|Hide) lane breakdown/u });

describe.each(ALL_LANE_IDS)('all-lanes render contract — lane %s', (laneId) => {
  const definition = ATTRIBUTION_LANES[laneId];
  const workstreamName = `Test / ${laneId}`;
  const workstreams: readonly TabSessionWorkstreamOption[] = [
    { bac_id: 'ws-under-test', path: workstreamName },
  ];

  // The wire payload — deliberately typed `unknown` and built as a plain
  // object literal (not a `GuessLaneResult` literal), so this exercises the
  // ACTUAL untyped-JSON parse path a live companion response takes, not a
  // TypeScript-checked fixture that could silently diverge from the wire
  // shape parseGuessLaneResult actually validates.
  const rawWire: unknown = [
    {
      lane: laneId,
      candidates: [{ workstreamId: 'ws-under-test', score: 0.77, why: `synthetic ${laneId} why` }],
    },
  ];

  it('(a) parseGuessLanes keeps the lane — the allowlist does not drop it', () => {
    const parsed = parseGuessLanes(rawWire);
    expect(parsed).toBeDefined();
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]?.lane).toBe(laneId);
    expect(parsed?.[0]?.candidates).toHaveLength(1);
  });

  it('(b) GuessLanes disclosure renders a labeled row for the lane', () => {
    const parsed = parseGuessLanes(rawWire);
    expect(parsed).toBeDefined();
    render(
      <GuessLanes lanes={parsed ?? []} workstreams={workstreams} open onToggle={vi.fn()} />,
    );
    // The lane's long label (from the registry) must appear.
    expect(screen.getAllByText(definition.longLabel).length).toBeGreaterThanOrEqual(1);
    // The candidate's workstream name and why text must appear.
    expect(screen.getByText(workstreamName)).toBeDefined();
    expect(screen.getByText(`synthetic ${laneId} why`)).toBeDefined();
  });

  it('(c) PipelineStrip renders a FILLED chip for the lane', () => {
    const parsed = parseGuessLanes(rawWire);
    expect(parsed).toBeDefined();
    render(
      <PipelineStrip
        lanes={parsed ?? []}
        workstreams={workstreams}
        fusedCount={0}
        open={false}
        onToggle={vi.fn()}
      />,
    );
    const button = getDotsButton();
    const description = `${definition.shortLabel}: ${workstreamName}`;
    // aria-label (not just title) carries the same description — matches the
    // assertion style of the pre-existing PipelineStrip tests.
    const chip = within(button).getByLabelText(description);
    expect(chip.classList.contains('is-filled')).toBe(true);
  });
});
