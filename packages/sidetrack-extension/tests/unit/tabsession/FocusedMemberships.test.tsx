import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FocusedMemberships } from '../../../src/sidepanel/tabsession/FocusedMemberships';
import type { TabSessionRecord } from '../../../src/sidepanel/tabsession/types';

const record = (input: Partial<TabSessionRecord> = {}): TabSessionRecord => ({
  tabSessionId: 'https://duckdb.org/2026/05/12/quack-remote-protocol',
  openedAt: '2026-05-10T10:00:00.000Z',
  lastActivityAt: '2026-05-10T10:05:00.000Z',
  attributionHistory: [],
  ...input,
});

const workstreams = [
  { bac_id: 'ws_databases', path: 'Databases' },
  { bac_id: 'ws_research', path: 'Research' },
];

describe('FocusedMemberships (main-card wiring)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('unfiled page — no chips, but the "+" add affordance is present and enabled', () => {
    const onAdd = vi.fn();
    render(<FocusedMemberships record={record()} workstreams={workstreams} onAdd={onAdd} />);
    expect(screen.queryByText('Also in:')).toBeNull();
    const addButton = screen.getByRole('button', { name: 'Add to another workstream' });
    expect(addButton).toBeEnabled();
    fireEvent.click(addButton);
    expect(onAdd).toHaveBeenCalledWith(record().tabSessionId);
  });

  it('primary-only page — no secondary chips render, add affordance still present', () => {
    render(
      <FocusedMemberships
        record={record({
          currentAttribution: {
            workstreamId: 'ws_databases',
            source: 'user_asserted',
            observedAt: '2026-05-10T10:06:00.000Z',
            clientEventId: 'evt-1',
          },
          memberships: [
            {
              workstreamId: 'ws_databases',
              role: 'primary',
              provenance: 'user-filed',
              acceptedAtMs: 1,
            },
          ],
        })}
        workstreams={workstreams}
      />,
    );
    expect(screen.queryByText('Also in:')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add to another workstream' })).toBeInTheDocument();
  });

  it('primary + secondaries — renders "Also in:" chips for every non-primary membership', () => {
    render(
      <FocusedMemberships
        record={record({
          currentAttribution: {
            workstreamId: 'ws_databases',
            source: 'user_asserted',
            observedAt: '2026-05-10T10:06:00.000Z',
            clientEventId: 'evt-1',
          },
          memberships: [
            {
              workstreamId: 'ws_databases',
              role: 'primary',
              provenance: 'user-filed',
              acceptedAtMs: 1,
            },
            {
              workstreamId: 'ws_research',
              role: 'secondary',
              provenance: 'user-filed',
              acceptedAtMs: 2,
            },
          ],
        })}
        workstreams={workstreams}
      />,
    );
    expect(screen.getByText('Also in:')).toBeInTheDocument();
    expect(screen.getByText('Research')).toBeInTheDocument();
    // The primary never double-renders as a chip.
    expect(screen.queryByText('Databases')).toBeNull();
  });

  it('calls onRemove with (tabSessionId, workstreamId) when a secondary chip\'s "x" is clicked', () => {
    const onRemove = vi.fn();
    render(
      <FocusedMemberships
        record={record({
          memberships: [
            {
              workstreamId: 'ws_research',
              role: 'secondary',
              provenance: 'user-filed',
              acceptedAtMs: 1,
            },
          ],
        })}
        workstreams={workstreams}
        onRemove={onRemove}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove from Research' }));
    expect(onRemove).toHaveBeenCalledWith(record().tabSessionId, 'ws_research');
  });

  it('fetch-error — renders a muted "—" fallback instead of a silent empty chip row, and logs audibly', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    render(<FocusedMemberships record={record()} workstreams={workstreams} fetchFailed />);
    expect(screen.getByTestId('focused-memberships-fallback')).toHaveTextContent('—');
    // Never render nothing: the "+" affordance from the normal path must
    // NOT be present alongside the fallback (that would silently imply
    // "confirmed empty", which is the falsehood we're avoiding).
    expect(screen.queryByRole('button', { name: 'Add to another workstream' })).toBeNull();
    expect(debugSpy).toHaveBeenCalled();
  });

  it('does not render the fallback or log when fetchFailed is false', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    render(<FocusedMemberships record={record()} workstreams={workstreams} />);
    expect(screen.queryByTestId('focused-memberships-fallback')).toBeNull();
    expect(debugSpy).not.toHaveBeenCalled();
  });
});
