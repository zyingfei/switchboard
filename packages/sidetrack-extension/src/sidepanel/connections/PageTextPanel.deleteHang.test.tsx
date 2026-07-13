import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PageTextPanel } from './PageTextPanel';
import type { PageContentCoverage } from '../../companion/pageContentClient';

// Regression net for the "Delete text hangs" report. These pin the
// PRESENTATIONAL invariants the host relies on: (1) delete stays offered
// on a paused/blocked page (deleting already-captured data is a privacy
// action), (2) a visible error surfaces when the host passes one, and
// (3) while busy the actions go inert but the delete affordance still
// exists (it is only hidden when there is nothing indexed to delete).

const indexedCoverage: PageContentCoverage = {
  canonicalUrl: 'https://x/y',
  state: 'indexed',
  quality: 'medium',
  chunkCount: 2,
};

const baseProps = {
  canonicalUrl: 'https://x/y',
  open: true,
  onToggleOpen: () => undefined,
  coverage: indexedCoverage,
  busy: null as 'index' | 'selection' | 'delete' | null,
  bulkBusy: null as 'preview' | 'index' | null,
  error: null as string | null,
  bulkPreview: null,
  onIndexPage: () => undefined,
  onIndexSelection: () => undefined,
  onDelete: () => undefined,
  onBulkPreview: () => undefined,
  onBulkIndex: () => undefined,
  onBulkCancel: () => undefined,
  testIdPrefix: 'current-tab',
} as const;

describe('PageTextPanel — delete-hang regression', () => {
  it('offers Delete text on a captured page and fires onDelete', () => {
    const onDelete = vi.fn();
    render(<PageTextPanel {...baseProps} onDelete={onDelete} />);
    const btn = screen.getByRole('button', { name: 'Delete text' });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('KEEPS Delete text on a paused/blocked page (privacy: delete already-captured data)', () => {
    const onDelete = vi.fn();
    render(
      <PageTextPanel
        {...baseProps}
        captureDisabledReason="Capture paused — see the lamp above."
        onDelete={onDelete}
      />,
    );
    // Index actions go inert…
    expect(screen.getByRole('button', { name: 'Index page' })).toBeDisabled();
    // …but Delete text stays enabled and works.
    const del = screen.getByRole('button', { name: 'Delete text' });
    expect(del).not.toBeDisabled();
    fireEvent.click(del);
    expect(onDelete).toHaveBeenCalledTimes(1);
    // And the state DISPLAY is suppressed (no stale tier/chunk leak).
    expect(screen.getByText('not captured')).toBeTruthy();
    expect(screen.queryByText('2 chunks')).toBeNull();
  });

  it('surfaces a host error message instead of failing silently', () => {
    render(
      <PageTextPanel {...baseProps} error="Companion did not respond within 15s — it may be busy." />,
    );
    expect(
      screen.getByText('Companion did not respond within 15s — it may be busy.'),
    ).toBeTruthy();
  });

  it('while a delete is in flight the delete button is inert (single-shot), still rendered', () => {
    render(<PageTextPanel {...baseProps} busy="delete" />);
    const del = screen.getByRole('button', { name: 'Delete text' });
    expect(del).toBeDisabled();
  });

  it('hides Delete text only when there is nothing indexed to delete', () => {
    render(
      <PageTextPanel
        {...baseProps}
        coverage={{ canonicalUrl: 'https://x/y', state: 'metadata_only_legacy' }}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Delete text' })).toBeNull();
  });
});
