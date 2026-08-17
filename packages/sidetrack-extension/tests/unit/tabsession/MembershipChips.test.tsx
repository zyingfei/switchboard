import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MembershipChips } from '../../../src/sidepanel/tabsession/MembershipChips';
import type { TabSessionRecord } from '../../../src/sidepanel/tabsession/types';

const record = (input: Partial<TabSessionRecord> = {}): TabSessionRecord => ({
  tabSessionId: 'tses_test',
  openedAt: '2026-05-10T10:00:00.000Z',
  lastActivityAt: '2026-05-10T10:05:00.000Z',
  attributionHistory: [],
  ...input,
});

const workstreams = [
  { bac_id: 'ws_security', path: 'Security' },
  { bac_id: 'ws_research', path: 'Research' },
];

describe('MembershipChips', () => {
  it('renders no chips when there are no memberships, but still shows the (disabled-by-default) add affordance', () => {
    render(<MembershipChips record={record()} workstreams={workstreams} />);
    expect(screen.queryByText('Also in:')).toBeNull();
    const addButton = screen.getByRole('button', { name: 'Add to another workstream' });
    expect(addButton).toBeDisabled();
  });

  it('renders a secondary membership as a chip, excluding the primary workstream', () => {
    render(
      <MembershipChips
        record={record({
          currentAttribution: {
            workstreamId: 'ws_security',
            source: 'user_asserted',
            observedAt: '2026-05-10T10:06:00.000Z',
            clientEventId: 'evt-1',
          },
          memberships: [
            { workstreamId: 'ws_security', role: 'primary', provenance: 'user-filed', acceptedAtMs: 1 },
            { workstreamId: 'ws_research', role: 'secondary', provenance: 'user-filed', acceptedAtMs: 2 },
          ],
        })}
        workstreams={workstreams}
      />,
    );
    expect(screen.getByText('Also in:')).toBeInTheDocument();
    expect(screen.getByText('Research')).toBeInTheDocument();
    // The primary's own workstream never double-renders as a chip too.
    expect(screen.queryByText('Security')).toBeNull();
  });

  it('falls back to "(removed)" for a membership whose workstream no longer exists', () => {
    render(
      <MembershipChips
        record={record({
          memberships: [
            { workstreamId: 'ws_gone', role: 'secondary', provenance: 'user-filed', acceptedAtMs: 1 },
          ],
        })}
        workstreams={workstreams}
      />,
    );
    expect(screen.getByText('(removed)')).toBeInTheDocument();
  });

  it('calls onAdd with the tabSessionId when the "+" affordance is clicked', () => {
    const onAdd = vi.fn();
    render(<MembershipChips record={record()} workstreams={workstreams} onAdd={onAdd} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add to another workstream' }));
    expect(onAdd).toHaveBeenCalledWith('tses_test');
  });

  it('calls onRemove with (tabSessionId, workstreamId) when a chip\'s remove button is clicked', () => {
    const onRemove = vi.fn();
    render(
      <MembershipChips
        record={record({
          memberships: [
            { workstreamId: 'ws_research', role: 'secondary', provenance: 'user-filed', acceptedAtMs: 1 },
          ],
        })}
        workstreams={workstreams}
        onRemove={onRemove}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove from Research' }));
    expect(onRemove).toHaveBeenCalledWith('tses_test', 'ws_research');
  });

  it('renders chips read-only (no remove button) when onRemove is omitted', () => {
    render(
      <MembershipChips
        record={record({
          memberships: [
            { workstreamId: 'ws_research', role: 'secondary', provenance: 'user-filed', acceptedAtMs: 1 },
          ],
        })}
        workstreams={workstreams}
      />,
    );
    expect(screen.getByText('Research')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove from Research' })).toBeNull();
  });
});
