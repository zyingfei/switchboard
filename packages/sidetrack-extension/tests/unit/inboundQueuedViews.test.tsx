import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { InboundView } from '../../entrypoints/sidepanel/components/InboundView';
import { QueuedView } from '../../entrypoints/sidepanel/components/QueuedView';
import type { InboundReminder } from '../../entrypoints/sidepanel/components/InboundCard';
import type { QueueGroup } from '../../src/sidepanel/queued/groupQueueItems';

const reminders: readonly InboundReminder[] = [
  {
    bac_id: 'r1',
    threadTitle: 'State machine review',
    provider: 'claude',
    providerLabel: 'Claude',
    inboundTurnAt: '3 minutes ago',
    status: 'unseen',
    aiAuthored: true,
  },
];

describe('InboundView — §13 steps 3/9', () => {
  it('renders an InboundCard per reminder with the relative timestamp', () => {
    render(
      <InboundView
        reminders={reminders}
        onOpen={() => undefined}
        onMarkRelevant={() => undefined}
        onDismiss={() => undefined}
      />,
    );
    expect(screen.getByText('State machine review')).toBeInTheDocument();
    expect(screen.getByText('Claude replied 3 minutes ago')).toBeInTheDocument();
  });

  it('fires per-card callbacks with the reminder id', () => {
    const onDismiss = vi.fn();
    const onMarkRelevant = vi.fn();
    render(
      <InboundView
        reminders={reminders}
        onOpen={() => undefined}
        onMarkRelevant={onMarkRelevant}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledWith('r1');
    fireEvent.click(screen.getByRole('button', { name: 'Mark relevant' }));
    expect(onMarkRelevant).toHaveBeenCalledWith('r1');
  });

  it('shows an empty state when there are no replies', () => {
    render(
      <InboundView
        reminders={[]}
        onOpen={() => undefined}
        onMarkRelevant={() => undefined}
        onDismiss={() => undefined}
      />,
    );
    expect(screen.getByText(/No new replies waiting/)).toBeInTheDocument();
  });
});

const groups: readonly QueueGroup[] = [
  {
    key: 'thread:t1',
    scope: 'thread',
    targetId: 't1',
    label: 'State machine review',
    provider: 'claude',
    items: [
      {
        bac_id: 'q1',
        text: 'Critique the design',
        scope: 'thread',
        targetId: 't1',
        status: 'pending',
        createdAt: 'a',
        updatedAt: 'a',
      },
      {
        bac_id: 'q2',
        text: 'Compare with the alternative',
        scope: 'thread',
        targetId: 't1',
        status: 'pending',
        createdAt: 'b',
        updatedAt: 'b',
        lastError: 'chat tab closed',
      },
    ],
  },
];

describe('QueuedView — §13 step 9', () => {
  it('renders grouped rows with a target header and total count', () => {
    render(
      <QueuedView groups={groups} onDismiss={() => undefined} onRetry={() => undefined} />,
    );
    expect(screen.getByText('State machine review')).toBeInTheDocument();
    expect(screen.getByText('Critique the design')).toBeInTheDocument();
    expect(screen.getByText('Compare with the alternative')).toBeInTheDocument();
  });

  it('offers Retry only for failed items and Dismiss for all', () => {
    const onRetry = vi.fn();
    const onDismiss = vi.fn();
    render(<QueuedView groups={groups} onDismiss={onDismiss} onRetry={onRetry} />);
    const retryButtons = screen.getAllByRole('button', { name: 'Retry' });
    expect(retryButtons).toHaveLength(1);
    fireEvent.click(retryButtons[0]);
    expect(onRetry).toHaveBeenCalledWith('q2');
    const dismissButtons = screen.getAllByRole('button', { name: 'Dismiss' });
    expect(dismissButtons).toHaveLength(2);
  });

  it('shows an empty state when nothing is queued', () => {
    render(<QueuedView groups={[]} onDismiss={() => undefined} onRetry={() => undefined} />);
    expect(screen.getByText(/Nothing queued/)).toBeInTheDocument();
  });
});
