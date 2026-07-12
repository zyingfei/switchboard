import { useEffect, useMemo, useRef, useState } from 'react';

import type { ConnectionNode } from '../connections/types';
import type { EntityDisplayCtx } from '../entityDisplay/format';
import { InboxCard } from './InboxCard';
import { sliceInboxForPanel } from './inboxPriority';
import type {
  TabSessionInboxData,
  TabSessionRecord,
  TabSessionResolutionResult,
  TabSessionWorkstreamOption,
} from './types';

export interface InboxViewProps {
  readonly inbox: TabSessionInboxData;
  readonly loading: boolean;
  readonly error: string | null;
  readonly workstreams: readonly TabSessionWorkstreamOption[];
  readonly suggestions: Readonly<Record<string, TabSessionResolutionResult>>;
  readonly onRefresh: () => void;
  readonly onAttribute: (tabSessionId: string, workstreamId: string | null) => void;
  readonly onOpenTab?: (record: TabSessionRecord) => void;
  readonly onPickAnother?: (tabSessionId: string) => void;
  readonly onIgnore?: (tabSessionId: string, reason: 'noise' | 'duplicate' | 'private') => void;
  readonly nodeById?: ReadonlyMap<string, ConnectionNode>;
  readonly displayCtx?: EntityDisplayCtx;
  readonly onOpenInConnections?: (canonicalUrl: string) => void;
  // Per-card refresh — re-resolves a single suggestion. Used to be
  // unnecessary because the panel polled every 4 s; with the poll
  // gone (2026-05), per-card refresh is how the user manually picks
  // up a fresher suggestion without re-fetching the whole list.
  readonly onRefreshSuggestion?: (tabSessionId: string) => void;
  // Set of tab-session ids whose refresh is currently in flight.
  readonly refreshingSuggestionIds?: ReadonlySet<string>;
  // Stage 5 polish — cross-surface jump from Connections: pre-fill
  // the Inbox search query and scroll the matching card into view.
  // `onQueryConsumed` clears the parent's request after we've
  // applied it once so back-navigation doesn't re-fire.
  readonly initialQuery?: string;
  readonly onQueryConsumed?: () => void;
  // RD2 — when the local Inbox filter returns 0, surface a link
  // that bumps the query to the global Search tab. Solves the
  // common case where the user types a URL not currently in the
  // pending Inbox queue and gets "No matches" with no obvious
  // next step.
  readonly onSearchGlobally?: (query: string) => void;
  /** True when the record's URL has a tracked chat thread (the chat-
   * turn pipeline has produced content for it). Forwarded to
   * InboxCard → PageEvidenceBadge so captured chats don't render as
   * "Metadata only" just because page-text auto-extract is off. */
  readonly isChatThreadCaptured?: (record: TabSessionRecord) => boolean;
  /** True when "Deeper page access" is granted. When false, new visits
   * earn no engagement → no similarity edges → every Inbox row resolves
   * to "No attribution". Surfacing it at the top of the Inbox (with a
   * one-click grant) turns that silent dead-end into a fix — the same
   * pattern the Current-Tab card's empty placeholder already uses. */
  readonly pageAccessGranted?: boolean;
  readonly onGrantAccess?: () => void;
}

// Stage 5 polish — Inbox-only search filter. Pure client-side, runs on
// the URL records the Inbox already loaded, no extra round-trips to the
// companion. Matches against latestTitle / latestUrl / provider on a
// case-insensitive substring.
const matchesQuery = (record: TabSessionRecord, q: string): boolean => {
  if (q.length === 0) return true;
  const lower = q.toLowerCase();
  if ((record.latestTitle ?? '').toLowerCase().includes(lower)) return true;
  if ((record.latestUrl ?? '').toLowerCase().includes(lower)) return true;
  if ((record.provider ?? '').toLowerCase().includes(lower)) return true;
  return false;
};

export function InboxView({
  inbox,
  loading,
  error,
  workstreams,
  suggestions,
  onRefresh,
  onAttribute,
  onOpenTab,
  onPickAnother,
  onIgnore,
  nodeById,
  displayCtx,
  onOpenInConnections,
  onRefreshSuggestion,
  refreshingSuggestionIds,
  initialQuery,
  onQueryConsumed,
  onSearchGlobally,
  isChatThreadCaptured,
  pageAccessGranted,
  onGrantAccess,
}: InboxViewProps) {
  const [query, setQuery] = useState('');
  // Cross-surface request — accept a pre-filled query exactly once,
  // applied via useEffect so re-renders with the same value don't
  // keep stomping user edits. Cleared via onQueryConsumed so the
  // parent's request state resets.
  const lastAppliedRequest = useRef<string>('');
  useEffect(() => {
    if (initialQuery === undefined || initialQuery.length === 0) return;
    if (lastAppliedRequest.current === initialQuery) return;
    lastAppliedRequest.current = initialQuery;
    setQuery(initialQuery);
    onQueryConsumed?.();
  }, [initialQuery, onQueryConsumed]);
  const trimmed = query.trim();
  const filtered = useMemo(
    () =>
      trimmed.length === 0 ? inbox.items : inbox.items.filter((r) => matchesQuery(r, trimmed)),
    [inbox.items, trimmed],
  );
  const slice = sliceInboxForPanel(filtered, inbox.total);
  // When page access IS granted but (nearly) every visible card still resolves
  // to no candidate, the user faces a silent wall of "—" rows with no guidance.
  // Surface an explainer pointing at the fix (move a few into a workstream),
  // distinct from the page-access-off banner above (mutually exclusive gate).
  const visibleNoSignalCount = slice.visible.filter(
    (record) => (suggestions[record.tabSessionId]?.fusedCandidates.length ?? 0) === 0,
  ).length;
  const showNoSignalExplainer =
    pageAccessGranted !== false &&
    trimmed.length === 0 &&
    slice.visible.length >= 5 &&
    visibleNoSignalCount >= Math.ceil(slice.visible.length * 0.8);
  return (
    <section className="tab-session-inbox" data-testid="tab-session-inbox">
      <div className="sec-head">
        <span>Inbox</span>
        <span className="sec-head-actions">
          <span className="count mono">
            {trimmed.length === 0
              ? `${String(slice.visible.length)} / ${String(inbox.total)}`
              : `${String(filtered.length)} / ${String(inbox.total)}`}
          </span>
          <button type="button" className="btn-link sec-head-btn" onClick={onRefresh}>
            refresh
          </button>
        </span>
      </div>
      <div className="tab-session-inbox-search">
        <input
          type="search"
          className="tab-session-inbox-search-input mono"
          placeholder="Search inbox by title, URL, or provider…"
          aria-label="Search inbox"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
        {trimmed.length > 0 ? (
          <button
            type="button"
            className="btn-link sec-head-btn"
            onClick={() => {
              setQuery('');
            }}
            aria-label="Clear inbox search"
          >
            clear
          </button>
        ) : null}
      </div>
      {pageAccessGranted === false && inbox.total > 0 ? (
        <div
          className="banner warning deeper-access-banner"
          role="status"
          aria-live="polite"
          data-testid="inbox-page-access-banner"
        >
          <div className="deeper-access-banner-body">
            <strong>No attributions yet — page access is off.</strong> Inbox
            items stay unattributed until Deeper page access is granted: new
            visits need it to earn engagement (focus, scroll), the signal that
            links them to related visits and workstreams.
          </div>
          {onGrantAccess !== undefined ? (
            <div className="deeper-access-banner-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={onGrantAccess}
                data-testid="inbox-grant-access"
              >
                Grant access
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {showNoSignalExplainer ? (
        <div
          className="banner deeper-access-banner"
          role="status"
          aria-live="polite"
          data-testid="inbox-no-signal-banner"
        >
          <div className="deeper-access-banner-body">
            <strong>Nothing to suggest yet.</strong> These pages aren’t linked to
            a workstream — move a few in (drag a card onto a workstream, or use
            “Pick another…”) and Sidetrack starts recognizing similar pages.
          </div>
        </div>
      ) : null}
      {error !== null ? <div className="banner danger">{error}</div> : null}
      {loading ? <div className="thread-empty subtle">Loading tab sessions…</div> : null}
      {!loading && slice.visible.length === 0 ? (
        <div className="thread-empty subtle">
          {trimmed.length === 0 ? (
            'No unattributed tab sessions.'
          ) : (
            <>
              No matches for &quot;{trimmed}&quot; in the Inbox queue.
              {onSearchGlobally !== undefined ? (
                <>
                  {' '}
                  <button
                    type="button"
                    className="btn-link inbox-search-global"
                    onClick={() => {
                      onSearchGlobally(trimmed);
                    }}
                    data-testid="inbox-search-global"
                  >
                    Search globally →
                  </button>
                </>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      <div className="tab-session-list">
        {slice.visible.map((record) => (
          <InboxCard
            key={record.tabSessionId}
            record={record}
            suggestion={suggestions[record.tabSessionId]}
            workstreams={workstreams}
            onAttribute={onAttribute}
            {...(onOpenTab === undefined ? {} : { onOpenTab })}
            {...(onPickAnother === undefined ? {} : { onPickAnother })}
            {...(onIgnore === undefined ? {} : { onIgnore })}
            {...(nodeById === undefined ? {} : { nodeById })}
            {...(displayCtx === undefined ? {} : { displayCtx })}
            {...(onOpenInConnections === undefined ? {} : { onOpenInConnections })}
            {...(onRefreshSuggestion === undefined ? {} : { onRefreshSuggestion })}
            refreshingSuggestion={refreshingSuggestionIds?.has(record.tabSessionId) === true}
            chatThreadCaptured={isChatThreadCaptured?.(record) === true}
          />
        ))}
      </div>
      {slice.hiddenCount > 0 ? (
        <div className="tab-session-cap-sentinel mono">Take a break — review more later.</div>
      ) : null}
    </section>
  );
}
