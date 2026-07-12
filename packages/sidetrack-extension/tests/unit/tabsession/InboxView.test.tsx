import { fireEvent, render, screen } from '@testing-library/react';
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

describe('InboxView search', () => {
  it('filters cards by title substring (case-insensitive)', () => {
    render(
      <InboxView
        inbox={inbox([
          record({
            tabSessionId: 'https://research.example/paper',
            latestTitle: 'A Paper About Caching',
            latestUrl: 'https://research.example/paper',
          }),
          record({
            tabSessionId: 'https://news.example/headline',
            latestTitle: 'Local headlines',
            latestUrl: 'https://news.example/headline',
          }),
        ])}
        loading={false}
        error={null}
        workstreams={workstreams}
        suggestions={{}}
        onRefresh={vi.fn()}
        onAttribute={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Search inbox'), {
      target: { value: 'caching' },
    });

    expect(screen.getByText('A Paper About Caching')).toBeInTheDocument();
    expect(screen.queryByText('Local headlines')).toBeNull();
  });

  it('filters cards by URL substring', () => {
    render(
      <InboxView
        inbox={inbox([
          record({
            tabSessionId: 'https://github.com/foo/pulls',
            latestTitle: 'Pull requests',
            latestUrl: 'https://github.com/foo/pulls',
          }),
          record({
            tabSessionId: 'https://example.test/page',
            latestTitle: 'Other page',
            latestUrl: 'https://example.test/page',
          }),
        ])}
        loading={false}
        error={null}
        workstreams={workstreams}
        suggestions={{}}
        onRefresh={vi.fn()}
        onAttribute={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Search inbox'), {
      target: { value: 'github.com' },
    });

    expect(screen.getByText('Pull requests')).toBeInTheDocument();
    expect(screen.queryByText('Other page')).toBeNull();
  });

  it('shows "no matches" state and clear button when query has no hits', () => {
    render(
      <InboxView
        inbox={inbox([
          record({
            tabSessionId: 'https://example.test/page',
            latestTitle: 'Only page',
            latestUrl: 'https://example.test/page',
          }),
        ])}
        loading={false}
        error={null}
        workstreams={workstreams}
        suggestions={{}}
        onRefresh={vi.fn()}
        onAttribute={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Search inbox'), {
      target: { value: 'nonexistent' },
    });

    expect(screen.getByText(/No matches for "nonexistent"/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Clear inbox search'));
    expect(screen.getByText('Only page')).toBeInTheDocument();
  });
});

describe('InboxView page-access banner', () => {
  const items = [
    record({
      tabSessionId: 'https://example.test/page',
      latestTitle: 'Only page',
      latestUrl: 'https://example.test/page',
    }),
  ];

  it('surfaces an actionable banner when page access is off and the inbox has items', () => {
    // The user's "none of my inbox has attributions" symptom: access off
    // → no engagement → resolver returns no candidates → every row reads
    // "No attribution". Name the cause + offer the one-click fix.
    const onGrantAccess = vi.fn();
    render(
      <InboxView
        inbox={inbox(items)}
        loading={false}
        error={null}
        workstreams={workstreams}
        suggestions={{}}
        onRefresh={vi.fn()}
        onAttribute={vi.fn()}
        pageAccessGranted={false}
        onGrantAccess={onGrantAccess}
      />,
    );
    expect(screen.getByTestId('inbox-page-access-banner')).toBeInTheDocument();
    expect(screen.getByText(/No attributions yet — page access is off/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('inbox-grant-access'));
    expect(onGrantAccess).toHaveBeenCalledTimes(1);
  });

  it('hides the banner when page access is granted', () => {
    render(
      <InboxView
        inbox={inbox(items)}
        loading={false}
        error={null}
        workstreams={workstreams}
        suggestions={{}}
        onRefresh={vi.fn()}
        onAttribute={vi.fn()}
        pageAccessGranted
      />,
    );
    expect(screen.queryByTestId('inbox-page-access-banner')).toBeNull();
  });

  it('hides the banner when the inbox is empty even with access off', () => {
    render(
      <InboxView
        inbox={inbox([])}
        loading={false}
        error={null}
        workstreams={workstreams}
        suggestions={{}}
        onRefresh={vi.fn()}
        onAttribute={vi.fn()}
        pageAccessGranted={false}
        onGrantAccess={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('inbox-page-access-banner')).toBeNull();
  });

  it('does not assume access state when pageAccessGranted is undefined', () => {
    render(
      <InboxView
        inbox={inbox(items)}
        loading={false}
        error={null}
        workstreams={workstreams}
        suggestions={{}}
        onRefresh={vi.fn()}
        onAttribute={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('inbox-page-access-banner')).toBeNull();
  });
});
