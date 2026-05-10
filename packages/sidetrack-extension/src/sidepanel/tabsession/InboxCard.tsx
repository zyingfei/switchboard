import { useMemo, useState } from 'react';

import { formatRelative } from '../../util/time';
import { AttributionBadge } from './AttributionBadge';
import { AttributionProvenance } from './AttributionProvenance';
import {
  TAB_SESSION_DRAG_MIME,
  type TabSessionRecord,
  type TabSessionResolutionResult,
  type TabSessionWorkstreamOption,
} from './types';

const hostFor = (record: TabSessionRecord): string => {
  const raw = record.latestUrl;
  if (raw === undefined) return record.provider ?? 'unknown';
  try {
    return new URL(raw).host;
  } catch {
    return raw;
  }
};

const titleFor = (record: TabSessionRecord): string =>
  record.latestTitle?.trim() || record.latestUrl || record.tabSessionId;

export interface InboxCardProps {
  readonly record: TabSessionRecord;
  readonly suggestion?: TabSessionResolutionResult;
  readonly workstreams: readonly TabSessionWorkstreamOption[];
  readonly onAttribute: (tabSessionId: string, workstreamId: string | null) => void;
}

export function InboxCard({ record, suggestion, workstreams, onAttribute }: InboxCardProps) {
  const defaultWorkstreamId = suggestion?.decision.workstreamId ?? workstreams[0]?.bac_id ?? '';
  const [selectedWorkstreamId, setSelectedWorkstreamId] = useState(defaultWorkstreamId);
  const host = hostFor(record);
  const title = titleFor(record);
  const currentWorkstreamId = record.currentAttribution?.workstreamId;
  const canMove = selectedWorkstreamId.length > 0 && selectedWorkstreamId !== currentWorkstreamId;
  const faviconLetter = useMemo(() => host.slice(0, 1).toUpperCase() || '?', [host]);

  return (
    <article
      className="tab-session-card"
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData(TAB_SESSION_DRAG_MIME, record.tabSessionId);
        event.dataTransfer.setData('text/plain', record.tabSessionId);
      }}
      data-testid={`tab-session-card-${record.tabSessionId}`}
    >
      <div className="tab-session-favicon" aria-hidden>
        {faviconLetter}
      </div>
      <div className="tab-session-card-main">
        <div className="tab-session-card-head">
          <span className="tab-session-title">{title}</span>
          <AttributionBadge record={record} suggestion={suggestion} workstreams={workstreams} />
        </div>
        <div className="tab-session-meta mono">
          <span>{host}</span>
          <span>{formatRelative(record.lastActivityAt)}</span>
        </div>
        <AttributionProvenance record={record} suggestion={suggestion} workstreams={workstreams} />
        <div className="tab-session-actions">
          <label className="tab-session-picker">
            <span className="sr-only">Move to</span>
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
            disabled={!canMove}
            onClick={() => {
              onAttribute(record.tabSessionId, selectedWorkstreamId);
            }}
          >
            Move
          </button>
          <button
            type="button"
            className="tab-session-action subtle"
            disabled={currentWorkstreamId === null}
            onClick={() => {
              onAttribute(record.tabSessionId, null);
            }}
          >
            Not in any workstream
          </button>
        </div>
      </div>
    </article>
  );
}
