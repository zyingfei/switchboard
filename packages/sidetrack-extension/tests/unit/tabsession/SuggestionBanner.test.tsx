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
  it('routes yes, no, and different choices through explicit attribution actions', () => {
    const onAttribute = vi.fn();
    render(
      <SuggestionBanner
        record={record}
        suggestion={suggestion}
        workstreams={workstreams}
        onAttribute={onAttribute}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'ws_switchboard' } });
    fireEvent.click(screen.getByRole('button', { name: 'Different' }));

    expect(onAttribute).toHaveBeenNthCalledWith(1, 'tses_test', 'ws_security');
    expect(onAttribute).toHaveBeenNthCalledWith(2, 'tses_test', null);
    expect(onAttribute).toHaveBeenNthCalledWith(3, 'tses_test', 'ws_switchboard');
  });
});
