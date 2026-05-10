import { useState } from 'react';

import type {
  TabSessionRecord,
  TabSessionResolutionResult,
  TabSessionWorkstreamOption,
} from './types';

const blankToUndefined = (input: string | undefined): string | undefined => {
  if (input === undefined) return undefined;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const displayTitle = (record: TabSessionRecord): string =>
  blankToUndefined(record.latestTitle) ??
  blankToUndefined(record.latestUrl) ??
  record.tabSessionId;

const displayUrl = (record: TabSessionRecord): string | undefined =>
  blankToUndefined(record.latestUrl);

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
}

export function SuggestionBanner({
  record,
  suggestion,
  workstreams,
  onAttribute,
}: SuggestionBannerProps) {
  const suggestedWorkstreamId = suggestion.decision.workstreamId;
  const fallbackWorkstreamId = workstreams.length > 0 ? workstreams[0].bac_id : '';
  const defaultWorkstreamId = suggestedWorkstreamId ?? fallbackWorkstreamId;
  const [selectedWorkstreamId, setSelectedWorkstreamId] = useState(defaultWorkstreamId);
  if (suggestion.decision.action !== 'suggest' || suggestedWorkstreamId === undefined) {
    return null;
  }
  return (
    <section className="tab-session-suggestion-banner" aria-label="Tab-session suggestion">
      <div className="tab-session-suggestion-copy">
        <b>{workstreamLabel(suggestedWorkstreamId, workstreams)}</b>
        <span className="tab-session-suggestion-title">{displayTitle(record)}</span>
        {displayUrl(record) !== undefined && displayUrl(record) !== displayTitle(record) ? (
          <span className="mono tab-session-suggestion-url">{displayUrl(record)}</span>
        ) : null}
      </div>
      <div className="tab-session-suggestion-actions">
        <button
          type="button"
          className="tab-session-action"
          onClick={() => {
            onAttribute(record.tabSessionId, suggestedWorkstreamId);
          }}
        >
          Yes
        </button>
        <button
          type="button"
          className="tab-session-action subtle"
          onClick={() => {
            onAttribute(record.tabSessionId, null);
          }}
        >
          No
        </button>
        <label className="tab-session-picker">
          <span className="sr-only">Different workstream</span>
          <select
            value={selectedWorkstreamId}
            onChange={(event) => {
              setSelectedWorkstreamId(event.target.value);
            }}
            disabled={workstreams.length === 0}
          >
            {workstreams.map((workstream) => (
              <option key={workstream.bac_id} value={workstream.bac_id}>
                {workstream.path}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="tab-session-action"
          disabled={selectedWorkstreamId.length === 0}
          onClick={() => {
            onAttribute(record.tabSessionId, selectedWorkstreamId);
          }}
        >
          Different
        </button>
      </div>
    </section>
  );
}
