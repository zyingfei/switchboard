import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { pageContentStatusLabel, PageTextPanel } from './PageTextPanel';
import type { PageContentCoverage } from '../../companion/pageContentClient';

// Regression net for the "Page text says metadata only while the header
// says Indexed chunks" report (2026-08-15). Root cause: coverage === null
// (fetch not yet returned / raced an in-flight first-visit auto-capture)
// rendered the SAME label as a real fetched metadata-only record. A null
// coverage must read as a neutral loading state instead — 'metadata only'
// is reserved for an actually-fetched record whose state is genuinely
// metadata-only.

const baseProps = {
  canonicalUrl: 'https://x/y',
  open: true,
  onToggleOpen: () => undefined,
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

describe('pageContentStatusLabel', () => {
  it('renders a neutral loading label for null coverage, NOT "metadata only"', () => {
    expect(pageContentStatusLabel(null)).toBe('checking…');
  });

  it('still renders "metadata only" for a real fetched metadata-only record', () => {
    const metadataOnly: PageContentCoverage = {
      canonicalUrl: 'https://x/y',
      state: 'metadata_only_legacy',
    };
    expect(pageContentStatusLabel(metadataOnly)).toBe('metadata only');
  });
});

describe('PageTextPanel — coverage-loading label (2026-08-15 regression)', () => {
  it('shows "checking…" in the header while coverage is null, not "metadata only"', () => {
    render(<PageTextPanel {...baseProps} coverage={null} />);
    const toggle = screen.getByTestId('current-tab-summary-toggle');
    expect(toggle).toHaveTextContent('checking…');
    expect(toggle).not.toHaveTextContent('metadata only');
  });

  it('shows "metadata only" for a real fetched metadata-only coverage record', () => {
    render(
      <PageTextPanel
        {...baseProps}
        coverage={{ canonicalUrl: 'https://x/y', state: 'metadata_only_legacy' }}
      />,
    );
    expect(screen.getByTestId('current-tab-summary-toggle')).toHaveTextContent('metadata only');
  });

  it('shows the real tier once coverage resolves to indexed', () => {
    render(
      <PageTextPanel
        {...baseProps}
        coverage={{
          canonicalUrl: 'https://x/y',
          state: 'indexed',
          quality: 'high',
          chunkCount: 12,
        }}
      />,
    );
    const toggle = screen.getByTestId('current-tab-summary-toggle');
    expect(toggle).toHaveTextContent('high');
    expect(toggle).not.toHaveTextContent('checking…');
  });
});
