import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { InboxCard } from '../../../src/sidepanel/tabsession/InboxCard';
import { sliceInboxForPanel } from '../../../src/sidepanel/tabsession/inboxPriority';
import type {
  TabSessionRecord,
  TabSessionResolutionResult,
} from '../../../src/sidepanel/tabsession/types';

const record = (input: Partial<TabSessionRecord> = {}): TabSessionRecord => ({
  tabSessionId: 'tses_test',
  openedAt: '2026-05-10T10:00:00.000Z',
  lastActivityAt: '2026-05-10T10:05:00.000Z',
  latestUrl: 'https://example.test/research',
  latestTitle: 'Research page',
  provider: 'generic',
  attributionHistory: [],
  ...input,
});

const workstreams = [
  { bac_id: 'ws_security', path: 'Security' },
  { bac_id: 'ws_switchboard', path: 'Switchboard' },
];

const suggestion = (): TabSessionResolutionResult => ({
  tabSessionId: 'tses_test',
  dryRun: true,
  decision: { action: 'suggest', workstreamId: 'ws_switchboard', margin: 1.4 },
  fusedCandidates: [
    {
      workstreamId: 'ws_switchboard',
      rawFusionLogit: 3.2,
      dominantSource: 'ppr',
      reasons: [
        {
          source: 'ppr',
          summary: 'Signed graph score 0.8',
          anchors: ['timeline-visit:https://example.test/research'],
        },
      ],
    },
  ],
});

describe('InboxCard', () => {
  it('confirms the suggested workstream via "Yes, that\'s right"', () => {
    const onAttribute = vi.fn();
    render(
      <InboxCard
        record={record()}
        suggestion={suggestion()}
        workstreams={workstreams}
        onAttribute={onAttribute}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: "Yes, that's right" }));
    expect(onAttribute).toHaveBeenCalledWith('tses_test', 'ws_switchboard');
  });

  it('opens the workstream picker via "Pick another…"', () => {
    const onAttribute = vi.fn();
    const onPickAnother = vi.fn();
    render(
      <InboxCard
        record={record()}
        workstreams={workstreams}
        onAttribute={onAttribute}
        onPickAnother={onPickAnother}
      />,
    );

    expect(screen.getByTitle('No attribution')).toHaveTextContent('?');
    fireEvent.click(screen.getByRole('button', { name: 'Pick another…' }));

    expect(onPickAnother).toHaveBeenCalledWith('tses_test');
    expect(onAttribute).not.toHaveBeenCalled();
  });

  it('dismisses with null attribution via "Not in any stream"', () => {
    const onAttribute = vi.fn();
    render(
      <InboxCard
        record={record({
          currentAttribution: {
            workstreamId: 'ws_security',
            source: 'user_asserted',
            observedAt: '2026-05-10T10:06:00.000Z',
            clientEventId: 'evt-1',
          },
        })}
        workstreams={workstreams}
        onAttribute={onAttribute}
      />,
    );

    expect(screen.getByTitle('Moved here by you: Security')).toHaveTextContent('Security');
    fireEvent.click(screen.getByRole('button', { name: 'Not in any stream' }));

    expect(onAttribute).toHaveBeenCalledWith('tses_test', null);
  });

  it('writes a urls.ignored event via "Ignore (admin / noise)"', () => {
    const onAttribute = vi.fn();
    const onIgnore = vi.fn();
    render(
      <InboxCard
        record={record()}
        workstreams={workstreams}
        onAttribute={onAttribute}
        onIgnore={onIgnore}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Ignore (admin / noise)' }));
    expect(onIgnore).toHaveBeenCalledWith('tses_test', 'noise');
    expect(onAttribute).not.toHaveBeenCalled();
  });

  it('hides "Yes, that\'s right" when the URL is already attributed', () => {
    render(
      <InboxCard
        record={record({
          currentAttribution: {
            workstreamId: 'ws_security',
            source: 'user_asserted',
            observedAt: '2026-05-10T10:06:00.000Z',
            clientEventId: 'evt-1',
          },
        })}
        suggestion={suggestion()}
        workstreams={workstreams}
        onAttribute={vi.fn()}
      />,
    );
    // The other three flat actions remain so the user can still
    // reorganize, dismiss, or ignore from any state.
    expect(screen.queryByRole('button', { name: "Yes, that's right" })).toBeNull();
    expect(screen.getByRole('button', { name: 'Pick another…' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not in any stream' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ignore (admin / noise)' })).toBeInTheDocument();
  });

  it('renders resolver suggestions as outlined attribution + provenance line', () => {
    render(
      <InboxCard
        record={record()}
        suggestion={suggestion()}
        workstreams={workstreams}
        onAttribute={vi.fn()}
      />,
    );

    expect(screen.getByTitle('Suggested by Sidetrack: Switchboard')).toHaveTextContent(
      'Switchboard',
    );
    expect(screen.getByText(/Suggested: Switchboard · ppr/)).toBeInTheDocument();
  });

  it('caps inbox rendering at 50 records per panel session', () => {
    // Distinct URLs so dedupe by URL doesn't collapse them — the cap
    // contract is "show 50 unique URLs and report the rest as hidden".
    const records = Array.from({ length: 55 }, (_, index) =>
      record({
        tabSessionId: `tses_${String(index).padStart(2, '0')}`,
        latestUrl: `https://example.test/research/${String(index)}`,
      }),
    );

    const slice = sliceInboxForPanel(records, records.length);

    expect(slice.visible).toHaveLength(50);
    expect(slice.hiddenCount).toBe(5);
  });

  it('dedupes same-URL tab sessions in the Inbox slice (keeps most recent)', () => {
    const records: TabSessionRecord[] = [
      record({
        tabSessionId: 'tses_stale',
        latestUrl: 'https://github.com/zyingfei/switchboard/pulls',
        latestTitle: 'github.com/zyingfei/switchboard/pulls',
        lastActivityAt: '2026-05-10T00:55:00.000Z',
      }),
      record({
        tabSessionId: 'tses_fresh',
        latestUrl: 'https://github.com/zyingfei/switchboard/pulls',
        latestTitle: 'Pull requests · zyingfei/switchboard · GitHub',
        lastActivityAt: '2026-05-10T01:06:00.000Z',
      }),
    ];
    const slice = sliceInboxForPanel(records, records.length);
    expect(slice.visible).toHaveLength(1);
    expect(slice.visible[0]?.tabSessionId).toBe('tses_fresh');
  });

  it('hides file:// pages from the Inbox triage queue', () => {
    const records: TabSessionRecord[] = [
      record({
        tabSessionId: 'tses_launchpad',
        latestUrl: 'file:///tmp/launchpad.html',
        latestTitle: 'launchpad.html',
      }),
      record({
        tabSessionId: 'tses_real',
        latestUrl: 'https://example.test/article',
        latestTitle: 'Article',
      }),
    ];
    const slice = sliceInboxForPanel(records, records.length);
    expect(slice.visible).toHaveLength(1);
    expect(slice.visible[0]?.tabSessionId).toBe('tses_real');
  });
});
