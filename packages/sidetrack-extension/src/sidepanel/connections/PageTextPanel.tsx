import type { ReactElement } from 'react';

import type { PageContentOpenTabPreview } from '../../messages';
import type { PageContentCoverage } from '../../companion/pageContentClient';

// Page-text / index controls. Extracted verbatim from the inline
// block in ConnectionsView so the SAME panel can also mount on the
// Inbox current-tab card (task #50). Purely presentational — every
// action + the open/coverage/busy state is owned by the host, so the
// two mount sites can drive different targets (the Connections anchor
// vs the live current tab) with one component.

export const pageContentStatusLabel = (coverage: PageContentCoverage | null): string => {
  if (coverage === null) return 'metadata only';
  if (coverage.state === 'indexed') return coverage.quality ?? 'indexed';
  if (coverage.state === 'indexed_low_quality') return 'low quality';
  if (coverage.state === 'stale_index') return 'stale';
  if (coverage.state === 'tombstoned') return 'deleted';
  if (coverage.state === 'metadata_only_error') return 'not indexed';
  return 'metadata only';
};

export interface PageTextPanelProps {
  /** When null the panel renders nothing (no page to act on). */
  readonly canonicalUrl: string | null;
  readonly open: boolean;
  readonly onToggleOpen: () => void;
  readonly coverage: PageContentCoverage | null;
  readonly busy: 'index' | 'selection' | 'delete' | null;
  readonly bulkBusy: 'preview' | 'index' | null;
  readonly error: string | null;
  readonly bulkPreview: readonly PageContentOpenTabPreview[] | null;
  readonly onIndexPage: () => void;
  readonly onIndexSelection: () => void;
  readonly onDelete: () => void;
  readonly onBulkPreview: () => void;
  readonly onBulkIndex: () => void;
  readonly onBulkCancel: () => void;
  /** data-testid namespace; default keeps the Connections ids stable. */
  readonly testIdPrefix?: string;
}

export const PageTextPanel = ({
  canonicalUrl,
  open,
  onToggleOpen,
  coverage,
  busy,
  bulkBusy,
  error,
  bulkPreview,
  onIndexPage,
  onIndexSelection,
  onDelete,
  onBulkPreview,
  onBulkIndex,
  onBulkCancel,
  testIdPrefix = 'connections',
}: PageTextPanelProps): ReactElement | null => {
  if (canonicalUrl === null) return null;
  const canDelete =
    coverage?.state === 'indexed' ||
    coverage?.state === 'indexed_low_quality' ||
    coverage?.state === 'stale_index';
  return (
    <div
      className={'cx-page-content-card' + (open ? '' : ' is-collapsed')}
      data-testid={`${testIdPrefix}-page-content-card`}
    >
      <button
        type="button"
        className="cx-summary-toggle cx-mono cx-dim"
        onClick={onToggleOpen}
        aria-expanded={open}
        data-testid={`${testIdPrefix}-summary-toggle`}
      >
        {open ? '▾' : '▸'} Page text
      </button>
      <div className="cx-page-content-main">
        <span className="cx-page-content-label">Page text</span>
        <span className="cx-page-content-state">{pageContentStatusLabel(coverage)}</span>
        {coverage?.chunkCount !== undefined ? (
          <span className="cx-page-content-meta">{String(coverage.chunkCount)} chunks</span>
        ) : null}
      </div>
      <div className="cx-page-content-actions">
        <button
          type="button"
          className="cx-mini-btn"
          onClick={onIndexPage}
          disabled={busy !== null}
          title="Index readable text from the active page"
        >
          {busy === 'index' ? 'Indexing' : 'Index page'}
        </button>
        <button
          type="button"
          className="cx-mini-btn"
          onClick={onIndexSelection}
          disabled={busy !== null}
          title="Index the currently selected text on the active page"
        >
          {busy === 'selection' ? 'Indexing' : 'Index selection'}
        </button>
        <button
          type="button"
          className="cx-mini-btn"
          onClick={onBulkPreview}
          disabled={busy !== null || bulkBusy !== null}
          title="Preview currently open tabs before indexing their page text"
        >
          {bulkBusy === 'preview' ? 'Checking' : 'Index open tabs'}
        </button>
        {canDelete ? (
          <button
            type="button"
            className="cx-mini-btn danger"
            onClick={onDelete}
            disabled={busy !== null}
            title="Delete indexed text for this page"
          >
            Delete text
          </button>
        ) : null}
      </div>
      {error !== null ? <div className="cx-page-content-error">{error}</div> : null}
      {bulkPreview !== null ? (
        <div className="cx-page-content-bulk" data-testid={`${testIdPrefix}-page-content-bulk`}>
          <div className="cx-page-content-bulk-head">
            <span>
              {String(bulkPreview.filter((tab) => tab.eligible).length)} open tabs eligible
            </span>
            <span className="cx-page-content-meta">{String(bulkPreview.length)} checked</span>
          </div>
          <div className="cx-page-content-bulk-list">
            {bulkPreview.slice(0, 6).map((tab) => (
              <div
                key={`${String(tab.tabId)}:${tab.url}`}
                className={`cx-page-content-bulk-row${tab.eligible ? '' : ' muted'}`}
                title={tab.url}
              >
                <span>{tab.title}</span>
                <small>{tab.eligible ? 'Eligible' : (tab.reason ?? 'Skipped')}</small>
              </div>
            ))}
          </div>
          <div className="cx-page-content-bulk-actions">
            <button
              type="button"
              className="cx-mini-btn"
              onClick={onBulkIndex}
              disabled={
                bulkBusy !== null || bulkPreview.filter((tab) => tab.eligible).length === 0
              }
            >
              {bulkBusy === 'index' ? 'Indexing tabs' : 'Confirm'}
            </button>
            <button
              type="button"
              className="cx-mini-btn"
              onClick={onBulkCancel}
              disabled={bulkBusy !== null}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
};
