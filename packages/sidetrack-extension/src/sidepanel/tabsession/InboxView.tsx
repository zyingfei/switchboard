import { InboxCard } from './InboxCard';
import { sliceInboxForPanel } from './inboxPriority';
import type {
  TabSessionInboxData,
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
}

export function InboxView({
  inbox,
  loading,
  error,
  workstreams,
  suggestions,
  onRefresh,
  onAttribute,
}: InboxViewProps) {
  const slice = sliceInboxForPanel(inbox.items, inbox.total);
  return (
    <section className="tab-session-inbox" data-testid="tab-session-inbox">
      <div className="sec-head">
        <span>Inbox</span>
        <span className="sec-head-actions">
          <span className="count mono">{String(inbox.total)}</span>
          <button type="button" className="btn-link sec-head-btn" onClick={onRefresh}>
            refresh
          </button>
        </span>
      </div>
      {error !== null ? <div className="banner danger">{error}</div> : null}
      {loading ? <div className="thread-empty subtle">Loading tab sessions…</div> : null}
      {!loading && slice.visible.length === 0 ? (
        <div className="thread-empty subtle">No unattributed tab sessions.</div>
      ) : null}
      <div className="tab-session-list">
        {slice.visible.map((record) => (
          <InboxCard
            key={record.tabSessionId}
            record={record}
            suggestion={suggestions[record.tabSessionId]}
            workstreams={workstreams}
            onAttribute={onAttribute}
          />
        ))}
      </div>
      {slice.hiddenCount > 0 ? (
        <div className="tab-session-cap-sentinel mono">Take a break — review more later.</div>
      ) : null}
    </section>
  );
}
