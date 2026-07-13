import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { InboundView } from '../../entrypoints/sidepanel/components/InboundView';
import { QueuedView } from '../../entrypoints/sidepanel/components/QueuedView';
import type { InboundReminder } from '../../entrypoints/sidepanel/components/InboundCard';
import {
  groupQueueItems,
  type QueueGroup,
} from '../../src/sidepanel/queued/groupQueueItems';
import type { QueueItem } from '../../src/workboard';

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
      <InboundView reminders={reminders} onOpen={() => undefined} onDismiss={() => undefined} />,
    );
    expect(screen.getByText('State machine review')).toBeInTheDocument();
    expect(screen.getByText('Claude replied 3 minutes ago')).toBeInTheDocument();
  });

  it('fires per-card callbacks with the reminder id', () => {
    const onDismiss = vi.fn();
    const onOpen = vi.fn();
    render(<InboundView reminders={reminders} onOpen={onOpen} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledWith('r1');
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(onOpen).toHaveBeenCalledWith('r1');
  });

  it('has no "Helpful" affordance (dead trainable button removed)', () => {
    render(<InboundView reminders={reminders} onOpen={() => undefined} onDismiss={() => undefined} />);
    expect(screen.queryByText('Helpful')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Mark this reply as helpful' }),
    ).not.toBeInTheDocument();
  });

  it('renders a collapsed "Read" group when readReminders are supplied', () => {
    const read: readonly InboundReminder[] = [
      {
        bac_id: 'r-read',
        threadTitle: 'Old but read thread',
        provider: 'claude',
        providerLabel: 'Claude',
        inboundTurnAt: '2 hours ago',
        status: 'seen',
        aiAuthored: true,
      },
    ];
    render(
      <InboundView
        reminders={reminders}
        readReminders={read}
        onOpen={() => undefined}
        onDismiss={() => undefined}
      />,
    );
    // The active reply is still shown; the read reply is available in
    // the collapsed group (rendered in the DOM under <details>).
    expect(screen.getByText('State machine review')).toBeInTheDocument();
    expect(screen.getByText('Read')).toBeInTheDocument();
    expect(screen.getByText('Old but read thread')).toBeInTheDocument();
  });

  it('shows an empty state when there are no replies', () => {
    render(<InboundView reminders={[]} onOpen={() => undefined} onDismiss={() => undefined} />);
    expect(screen.getByText(/No new replies waiting/)).toBeInTheDocument();
  });
});

// One clean pending item + one blocked (tab closed) so the row's
// blocker line and action set can be asserted. The blocked item's
// lastError is the EXACT string findTabForThread writes.
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
        lastError: 'Open the chat tab; auto-send needs the conversation visible to type into.',
      },
    ],
  },
];

const noop = () => undefined;

describe('QueuedView — actionable rows (§3.3)', () => {
  it('renders grouped rows with a target header and total count', () => {
    render(
      <QueuedView groups={groups} onOpen={noop} onSendNow={noop} onEdit={noop} onRemove={noop} />,
    );
    expect(screen.getByText('State machine review')).toBeInTheDocument();
    expect(screen.getByText('Critique the design')).toBeInTheDocument();
    expect(screen.getByText('Compare with the alternative')).toBeInTheDocument();
  });

  it('names the blocker and offers [Open] when the tab is closed', () => {
    const onOpen = vi.fn();
    render(
      <QueuedView
        groups={groups}
        onOpen={onOpen}
        onSendNow={noop}
        onEdit={noop}
        onRemove={noop}
      />,
    );
    // §3.3: the tab-closed drain reason maps to the plain blocker line.
    expect(screen.getByText('The chat tab is closed.')).toBeInTheDocument();
    // [Open] shows on both rows (the fix for a closed tab, and the
    // reopen affordance generally). The tab-closed row is the one that
    // does NOT offer [Send now] (the tab isn't open yet). The blocked
    // row's [Open] is the second one (clean row q1 renders first).
    const opens = screen.getAllByRole('button', { name: 'Open' });
    expect(opens).toHaveLength(2);
    fireEvent.click(opens[1]);
    expect(onOpen).toHaveBeenCalledWith('t1', 'q2');
    // Send now only on the clean (unblocked) row — the tab-closed row
    // suppresses it (Open handles reopening).
    const sendNows = screen.getAllByRole('button', { name: 'Send now' });
    expect(sendNows).toHaveLength(1);
  });

  it('fires [Send now] with the target + item id for an unblocked row', () => {
    const onSendNow = vi.fn();
    render(
      <QueuedView
        groups={groups}
        onOpen={noop}
        onSendNow={onSendNow}
        onEdit={noop}
        onRemove={noop}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
    expect(onSendNow).toHaveBeenCalledWith('t1', 'q1');
  });

  it('offers [Edit] on every row and [Remove] on every row', () => {
    const onRemove = vi.fn();
    render(
      <QueuedView
        groups={groups}
        onOpen={noop}
        onSendNow={noop}
        onEdit={noop}
        onRemove={onRemove}
      />,
    );
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(2);
    const removes = screen.getAllByRole('button', { name: 'Remove' });
    expect(removes).toHaveLength(2);
    fireEvent.click(removes[0]);
    expect(onRemove).toHaveBeenCalledWith('q1');
  });

  it('[Edit] opens an inline editor that saves the rewritten text', () => {
    const onEdit = vi.fn();
    render(
      <QueuedView
        groups={groups}
        onOpen={noop}
        onSendNow={noop}
        onEdit={onEdit}
        onRemove={noop}
      />,
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    const textarea = screen.getByDisplayValue('Critique the design');
    fireEvent.change(textarea, { target: { value: 'Shorter ask' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onEdit).toHaveBeenCalledWith('q1', 'Shorter ask');
  });

  it('shows the §3.3 empty state when nothing is queued', () => {
    render(
      <QueuedView groups={[]} onOpen={noop} onSendNow={noop} onEdit={noop} onRemove={noop} />,
    );
    expect(screen.getByText(/Nothing queued yet/)).toBeInTheDocument();
  });

  it('shows the non-thread banner when pre-existing non-thread items exist (D6)', () => {
    render(
      <QueuedView
        groups={groups}
        hasNonThreadItems
        onOpen={noop}
        onSendNow={noop}
        onEdit={noop}
        onRemove={noop}
      />,
    );
    expect(screen.getByText(/isn.t tied to an open chat/)).toBeInTheDocument();
  });

  it('still groups any legacy workstream/global items by target', () => {
    const queueItem = (over: Partial<QueueItem> & Pick<QueueItem, 'bac_id'>): QueueItem => ({
      text: 'ask',
      scope: 'thread',
      status: 'pending',
      createdAt: '2026-07-11T10:00:00.000Z',
      updatedAt: '2026-07-11T10:00:00.000Z',
      ...over,
    });
    const grouped = groupQueueItems(
      [
        queueItem({ bac_id: 'q1', scope: 'thread', targetId: 't1', createdAt: 'a' }),
        queueItem({ bac_id: 'q2', scope: 'workstream', targetId: 'w1', createdAt: 'b' }),
        queueItem({ bac_id: 'q3', scope: 'global', targetId: undefined, createdAt: 'c' }),
      ],
      [{ bac_id: 't1', title: 'State machine review', provider: 'claude' }],
      [{ bac_id: 'w1', title: 'MVP PRD' }],
    );
    expect(grouped.map((g) => g.scope).sort()).toEqual(['global', 'thread', 'workstream']);
    render(
      <QueuedView
        groups={grouped}
        onOpen={noop}
        onSendNow={noop}
        onEdit={noop}
        onRemove={noop}
      />,
    );
    expect(screen.getByText('State machine review')).toBeInTheDocument();
    expect(screen.getByText('MVP PRD')).toBeInTheDocument();
    expect(screen.getByText('Anywhere')).toBeInTheDocument();
  });
});
