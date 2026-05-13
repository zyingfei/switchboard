import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { InboxView } from '../../../src/sidepanel/tabsession/InboxView';
import type {
  TabSessionInboxData,
  TabSessionRecord,
} from '../../../src/sidepanel/tabsession/types';

const record = (input: Partial<TabSessionRecord> & { tabSessionId: string }): TabSessionRecord => ({
  openedAt: '2026-05-10T10:00:00.000Z',
  lastActivityAt: '2026-05-10T10:05:00.000Z',
  provider: 'generic',
  attributionHistory: [],
  ...input,
});

const inbox = (items: readonly TabSessionRecord[]): TabSessionInboxData => ({
  items,
  total: items.length,
  limit: 51,
  offset: 0,
});

const workstreams = [{ bac_id: 'ws_security', path: 'Security' }];

describe('InboxView — cross-surface initialQuery', () => {
  it('pre-fills the search box and filters items when initialQuery is provided', async () => {
    const onConsumed = vi.fn();
    render(
      <InboxView
        inbox={inbox([
          record({
            tabSessionId: 'https://copy.fail/',
            latestTitle: 'Copy Fail | Hacker News',
            latestUrl: 'https://copy.fail/',
          }),
          record({
            tabSessionId: 'https://example.test/other',
            latestTitle: 'Unrelated page',
            latestUrl: 'https://example.test/other',
          }),
        ])}
        loading={false}
        error={null}
        workstreams={workstreams}
        suggestions={{}}
        onRefresh={vi.fn()}
        onAttribute={vi.fn()}
        initialQuery="copy.fail"
        onQueryConsumed={onConsumed}
      />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Search inbox')).toHaveValue('copy.fail');
    });
    // Filter applied
    expect(screen.getByText('Copy Fail | Hacker News')).toBeInTheDocument();
    expect(screen.queryByText('Unrelated page')).toBeNull();
    // Parent's request state was acknowledged
    expect(onConsumed).toHaveBeenCalled();
  });

  it('only fires onQueryConsumed once per initialQuery value', async () => {
    const onConsumed = vi.fn();
    const { rerender } = render(
      <InboxView
        inbox={inbox([])}
        loading={false}
        error={null}
        workstreams={workstreams}
        suggestions={{}}
        onRefresh={vi.fn()}
        onAttribute={vi.fn()}
        initialQuery="abc"
        onQueryConsumed={onConsumed}
      />,
    );
    await waitFor(() => {
      expect(onConsumed).toHaveBeenCalledTimes(1);
    });
    // Re-render with the same initialQuery — must NOT re-fire.
    rerender(
      <InboxView
        inbox={inbox([])}
        loading={false}
        error={null}
        workstreams={workstreams}
        suggestions={{}}
        onRefresh={vi.fn()}
        onAttribute={vi.fn()}
        initialQuery="abc"
        onQueryConsumed={onConsumed}
      />,
    );
    // Same value → still 1.
    expect(onConsumed).toHaveBeenCalledTimes(1);
    // Different value → re-fires.
    rerender(
      <InboxView
        inbox={inbox([])}
        loading={false}
        error={null}
        workstreams={workstreams}
        suggestions={{}}
        onRefresh={vi.fn()}
        onAttribute={vi.fn()}
        initialQuery="xyz"
        onQueryConsumed={onConsumed}
      />,
    );
    await waitFor(() => {
      expect(onConsumed).toHaveBeenCalledTimes(2);
    });
  });
});
