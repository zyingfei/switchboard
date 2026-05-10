import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { InboxCard } from '../../../src/sidepanel/tabsession/InboxCard';
import { sliceInboxForPanel } from '../../../src/sidepanel/tabsession/inboxPriority';
import type { TabSessionRecord } from '../../../src/sidepanel/tabsession/types';

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

describe('InboxCard', () => {
  it('moves a tab session to the selected workstream', () => {
    const onAttribute = vi.fn();
    render(<InboxCard record={record()} workstreams={workstreams} onAttribute={onAttribute} />);

    expect(screen.getByTitle('No tab-session attribution')).toHaveTextContent('?');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'ws_switchboard' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));

    expect(onAttribute).toHaveBeenCalledWith('tses_test', 'ws_switchboard');
  });

  it('dismisses a tab session back to the inbox with a null attribution', () => {
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

    expect(screen.getByTitle('Attributed by you to Security')).toHaveTextContent('Security');
    fireEvent.click(screen.getByRole('button', { name: 'Not in any workstream' }));

    expect(onAttribute).toHaveBeenCalledWith('tses_test', null);
  });

  it('caps inbox rendering at 50 records per panel session', () => {
    const records = Array.from({ length: 55 }, (_, index) =>
      record({ tabSessionId: `tses_${String(index).padStart(2, '0')}` }),
    );

    const slice = sliceInboxForPanel(records, records.length);

    expect(slice.visible).toHaveLength(50);
    expect(slice.hiddenCount).toBe(5);
  });
});
