import { useMemo } from 'react';

import { Icons } from '../../../entrypoints/sidepanel/components/icons';
import { formatRelative } from '../../util/time';
import type { ConnectionNode } from '../connections/types';
import type { EntityDisplayCtx } from '../entityDisplay/format';
import { AttributionBadge } from './AttributionBadge';
import { AttributionProvenance } from './AttributionProvenance';
import { tabSessionDisplayTitle } from './displayTitle';
import { PageEvidenceBadge } from './PageEvidenceBadge';
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

const isHttpUrl = (value: string): boolean => /^https?:\/\//iu.test(value);

export interface InboxCardProps {
  readonly record: TabSessionRecord;
  readonly suggestion?: TabSessionResolutionResult;
  readonly workstreams: readonly TabSessionWorkstreamOption[];
  readonly onAttribute: (tabSessionId: string, workstreamId: string | null) => void;
  readonly onOpenTab?: (record: TabSessionRecord) => void;
  // Stage 5 polish — aligns InboxCard actions with the Current Tab and
  // SuggestionBanner 4-action flat layout. The picker opens via
  // onPickAnother (parent owns the modal); ignore writes a
  // urls.ignored event. When omitted, the affordance renders disabled.
  readonly onPickAnother?: (tabSessionId: string) => void;
  readonly onIgnore?: (tabSessionId: string, reason: 'noise' | 'duplicate' | 'private') => void;
  // Optional; when present, anchor labels in the provenance row use
  // the live connections snapshot to render human-friendly text.
  readonly nodeById?: ReadonlyMap<string, ConnectionNode>;
  readonly displayCtx?: EntityDisplayCtx;
  // Stage 5 polish — cross-surface jump from an Inbox card into
  // the Connections graph. Wires the URL's canonical timeline-visit
  // node as the new Connections anchor and switches viewMode.
  // When omitted, the affordance isn't rendered.
  readonly onOpenInConnections?: (canonicalUrl: string) => void;
  // 2026-05 cleanup: per-card refresh. The panel used to poll every
  // 4 s; that's gone, so the user needs a way to re-resolve a single
  // suggestion when they suspect it's stale. The list-level refresh
  // (in InboxView's header) re-fetches everything; this is the
  // per-row equivalent that only hits ONE /v1/tabsessions/.../resolve
  // call. When omitted, the affordance isn't rendered.
  readonly onRefreshSuggestion?: (tabSessionId: string) => void;
  // True while the per-card refresh is in flight. Used to dim the
  // button + show a small spinner.
  readonly refreshingSuggestion?: boolean;
}

export function InboxCard({
  record,
  suggestion,
  workstreams,
  onAttribute,
  onOpenTab,
  onPickAnother,
  onIgnore,
  nodeById,
  displayCtx,
  onOpenInConnections,
  onRefreshSuggestion,
  refreshingSuggestion = false,
}: InboxCardProps) {
  const host = hostFor(record);
  const title = tabSessionDisplayTitle(record);
  const suggestedWorkstreamId = suggestion?.decision.workstreamId;
  const canConfirmSuggestion =
    suggestedWorkstreamId !== undefined &&
    record.currentAttribution === undefined &&
    record.currentIgnored === undefined;
  const canOpenTab = onOpenTab !== undefined && record.latestUrl !== undefined;
  const connectionsUrl =
    isHttpUrl(record.tabSessionId) || record.latestUrl === undefined
      ? record.tabSessionId
      : record.latestUrl;
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
          <span className="tab-session-title" title={record.latestUrl ?? title}>
            {title}
          </span>
          <AttributionBadge record={record} suggestion={suggestion} workstreams={workstreams} />
          <PageEvidenceBadge pageEvidence={record.pageEvidence} />
          {canOpenTab ? (
            <button
              type="button"
              className="tab-session-go-to"
              onClick={() => {
                onOpenTab(record);
              }}
              title="Switch to this tab or reopen it"
              aria-label="Go to tab"
              data-testid={`tab-session-go-to-${record.tabSessionId}`}
            >
              <span className="icon-12" aria-hidden>
                {Icons.arrowR}
              </span>
              <span>Go to</span>
            </button>
          ) : null}
          {onOpenInConnections !== undefined && isHttpUrl(connectionsUrl) ? (
            <button
              type="button"
              className="tab-session-go-to"
              onClick={() => {
                // URL Inbox records use the canonical URL as
                // `tabSessionId`; real tab-session records keep a
                // session id there, so fall back to latestUrl.
                onOpenInConnections(connectionsUrl);
              }}
              title="Open this URL in the Connections graph"
              aria-label="Open in Connections"
              data-testid={`tab-session-open-connections-${record.tabSessionId}`}
            >
              <span aria-hidden>⇄</span>
              <span>Graph</span>
            </button>
          ) : null}
          {onRefreshSuggestion !== undefined ? (
            <button
              type="button"
              className="tab-session-go-to"
              onClick={() => {
                onRefreshSuggestion(record.tabSessionId);
              }}
              disabled={refreshingSuggestion}
              title="Re-resolve this URL's suggestion against the latest companion state"
              aria-label="Refresh suggestion"
              data-testid={`tab-session-refresh-${record.tabSessionId}`}
            >
              <span aria-hidden>{refreshingSuggestion ? '…' : '↻'}</span>
            </button>
          ) : null}
        </div>
        <div className="tab-session-meta mono">
          <span>{host}</span>
          <span>{formatRelative(record.lastActivityAt)}</span>
        </div>
        <AttributionProvenance
          record={record}
          suggestion={suggestion}
          workstreams={workstreams}
          {...(nodeById === undefined ? {} : { nodeById })}
          {...(displayCtx === undefined ? {} : { displayCtx })}
        />
        <div className="tab-session-actions">
          {canConfirmSuggestion ? (
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
          ) : null}
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
      </div>
    </article>
  );
}
