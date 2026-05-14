import { tabSessionDisplayTitle, tabSessionDisplayUrl } from './displayTitle';
import type {
  TabSessionRecord,
  TabSessionResolutionResult,
  TabSessionWorkstreamOption,
} from './types';

const workstreamLabel = (
  workstreamId: string | undefined,
  workstreams: readonly TabSessionWorkstreamOption[],
): string => {
  if (workstreamId === undefined) return 'unknown';
  return (
    workstreams.find((workstream) => workstream.bac_id === workstreamId)?.path ?? '(removed)'
  );
};

export interface SuggestionBannerProps {
  readonly record: TabSessionRecord;
  readonly suggestion: TabSessionResolutionResult;
  readonly workstreams: readonly TabSessionWorkstreamOption[];
  readonly onAttribute: (tabSessionId: string, workstreamId: string | null) => void;
  // Stage 5 polish — aligns SuggestionBanner with the Current Tab and
  // InboxCard 4-action flat layout. When omitted, the corresponding
  // affordances render disabled so the banner still draws but doesn't
  // misbehave silently.
  readonly onPickAnother?: (tabSessionId: string) => void;
  readonly onIgnore?: (
    tabSessionId: string,
    reason: 'noise' | 'duplicate' | 'private',
  ) => void;
}

export function SuggestionBanner({
  record,
  suggestion,
  workstreams,
  onAttribute,
  onPickAnother,
  onIgnore,
}: SuggestionBannerProps) {
  const suggestedWorkstreamId = suggestion.decision.workstreamId;
  if (suggestion.decision.action !== 'suggest' || suggestedWorkstreamId === undefined) {
    return null;
  }
  return (
    <section className="tab-session-suggestion-banner" aria-label="Tab-session suggestion">
      <div className="tab-session-suggestion-copy">
        <b>{workstreamLabel(suggestedWorkstreamId, workstreams)}</b>
        <span className="tab-session-suggestion-title">{tabSessionDisplayTitle(record)}</span>
        {tabSessionDisplayUrl(record) !== undefined &&
        tabSessionDisplayUrl(record) !== tabSessionDisplayTitle(record) ? (
          <span className="mono tab-session-suggestion-url">{tabSessionDisplayUrl(record)}</span>
        ) : null}
      </div>
      <div className="tab-session-suggestion-actions">
        <button
          type="button"
          className="tab-session-action primary"
          onClick={() => {
            onAttribute(record.tabSessionId, suggestedWorkstreamId);
          }}
          title="Confirm the suggested workstream"
        >
          Yes, that's right
        </button>
        <button
          type="button"
          className="tab-session-action"
          disabled={onPickAnother === undefined}
          onClick={() => {
            onPickAnother?.(record.tabSessionId);
          }}
          title="Pick a different workstream"
        >
          Pick another…
        </button>
        <button
          type="button"
          className="tab-session-action"
          onClick={() => {
            onAttribute(record.tabSessionId, null);
          }}
          title="This page is meaningful but doesn't belong to any workstream"
        >
          Not in any stream
        </button>
        <button
          type="button"
          className="tab-session-action"
          disabled={onIgnore === undefined}
          onClick={() => {
            onIgnore?.(record.tabSessionId, 'noise');
          }}
          title="Mute this URL — don't bother me about it again"
        >
          Ignore (admin / noise)
        </button>
      </div>
    </section>
  );
}
