import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { InboxCard } from '../../../src/sidepanel/tabsession/InboxCard';
import type { TabSessionRecord } from '../../../src/sidepanel/tabsession/types';

const record = (input: Partial<TabSessionRecord> = {}): TabSessionRecord => ({
  tabSessionId: 'https://news.ycombinator.com/item?id=47952181',
  openedAt: '2026-05-10T10:00:00.000Z',
  lastActivityAt: '2026-05-10T10:05:00.000Z',
  latestUrl: 'https://news.ycombinator.com/item?id=47952181',
  latestTitle: 'Copy Fail | Hacker News',
  provider: 'generic',
  attributionHistory: [],
  ...input,
});

const workstreams = [{ bac_id: 'ws_security', path: 'Security' }];

describe('InboxCard — cross-surface "Graph" jump', () => {
  it('renders the Graph button when onOpenInConnections is provided + URL exists', () => {
    const onOpen = vi.fn();
    render(
      <InboxCard
        record={record()}
        workstreams={workstreams}
        onAttribute={vi.fn()}
        onOpenInConnections={onOpen}
      />,
    );
    const btn = screen.getByLabelText('Open in Connections');
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalledWith('https://news.ycombinator.com/item?id=47952181');
  });

  it('does not render the Graph button when onOpenInConnections is omitted', () => {
    render(<InboxCard record={record()} workstreams={workstreams} onAttribute={vi.fn()} />);
    expect(screen.queryByLabelText('Open in Connections')).toBeNull();
  });

  it('does not render the Graph button when the record has no URL', () => {
    render(
      <InboxCard
        record={record({ latestUrl: undefined })}
        workstreams={workstreams}
        onAttribute={vi.fn()}
        onOpenInConnections={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText('Open in Connections')).toBeNull();
  });
});
