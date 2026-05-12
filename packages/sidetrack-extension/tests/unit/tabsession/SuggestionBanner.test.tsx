import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SuggestionBanner } from '../../../src/sidepanel/tabsession/SuggestionBanner';
import type {
  TabSessionRecord,
  TabSessionResolutionResult,
} from '../../../src/sidepanel/tabsession/types';

const record: TabSessionRecord = {
  tabSessionId: 'tses_test',
  openedAt: '2026-05-10T10:00:00.000Z',
  lastActivityAt: '2026-05-10T10:05:00.000Z',
  latestUrl: 'https://example.test/research',
  latestTitle: 'Research page',
  attributionHistory: [],
};

const suggestion: TabSessionResolutionResult = {
  tabSessionId: 'tses_test',
  dryRun: true,
  decision: { action: 'suggest', workstreamId: 'ws_security', margin: 1.2 },
  fusedCandidates: [
    {
      workstreamId: 'ws_security',
      rawFusionLogit: 2.4,
      dominantSource: 'ppr',
      reasons: [],
    },
  ],
};

const workstreams = [
  { bac_id: 'ws_security', path: 'Security' },
  { bac_id: 'ws_switchboard', path: 'Switchboard' },
];

describe('SuggestionBanner', () => {
  it('routes all 4 flat action choices through the right callbacks', () => {
    const onAttribute = vi.fn();
    const onPickAnother = vi.fn();
    const onIgnore = vi.fn();
    render(
      <SuggestionBanner
        record={record}
        suggestion={suggestion}
        workstreams={workstreams}
        onAttribute={onAttribute}
        onPickAnother={onPickAnother}
        onIgnore={onIgnore}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: "Yes, that's right" }));
    fireEvent.click(screen.getByRole('button', { name: 'Pick another…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Not in any stream' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ignore (admin / noise)' }));

    expect(onAttribute).toHaveBeenNthCalledWith(1, 'tses_test', 'ws_security');
    expect(onPickAnother).toHaveBeenCalledWith('tses_test');
    expect(onAttribute).toHaveBeenNthCalledWith(2, 'tses_test', null);
    expect(onIgnore).toHaveBeenCalledWith('tses_test', 'noise');
  });

  it('disables Pick another / Ignore when their callbacks are absent', () => {
    render(
      <SuggestionBanner
        record={record}
        suggestion={suggestion}
        workstreams={workstreams}
        onAttribute={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Pick another…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Ignore (admin / noise)' })).toBeDisabled();
  });
});
