import { useMemo, useState } from 'react';

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
  readonly onIgnore?: (
    tabSessionId: string,
    reason: 'noise' | 'duplicate' | 'private',
  ) => void;
  readonly nodeById?: ReadonlyMap<string, ConnectionNode>;
  readonly displayCtx?: EntityDisplayCtx;
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
}: InboxViewProps) {
  const [query, setQuery] = useState('');
  const trimmed = query.trim();
  const filtered = useMemo(
    () => (trimmed.length === 0 ? inbox.items : inbox.items.filter((r) => matchesQuery(r, trimmed))),
    [inbox.items, trimmed],
  );
  const slice = sliceInboxForPanel(filtered, inbox.total);
  return (
    <section className="tab-session-inbox" data-testid="tab-session-inbox">
      <div className="sec-head">
        <span>Inbox</span>
        <span className="sec-head-actions">
          <span className="count mono">
            {trimmed.length === 0
              ? String(inbox.total)
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
      {error !== null ? <div className="banner danger">{error}</div> : null}
      {loading ? <div className="thread-empty subtle">Loading tab sessions…</div> : null}
      {!loading && slice.visible.length === 0 ? (
        <div className="thread-empty subtle">
          {trimmed.length === 0
            ? 'No unattributed tab sessions.'
            : `No matches for "${trimmed}".`}
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
          />
        ))}
      </div>
      {slice.hiddenCount > 0 ? (
        <div className="tab-session-cap-sentinel mono">Take a break — review more later.</div>
      ) : null}
    </section>
  );
}
