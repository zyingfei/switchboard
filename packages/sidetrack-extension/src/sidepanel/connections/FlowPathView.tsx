import type { ReactElement } from 'react';

import { formatRelative } from '../../util/time';

// Render an ISO timestamp in the user's locale. Used as the absolute
// fallback inside `title=` attributes; the inline display uses the
// shared `formatRelative` helper so the panel stays consistent with
// Inbox cards.
const localTimestamp = (iso: string): string => {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms);
  try {
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
};

// Human-friendly duration. `5_000` -> `5s`, `90_000` -> `1m 30s`,
// `3_900_000` -> `1h 5m`. Empty string when missing/zero so the
// caller doesn't render a blank chip.
const formatDuration = (ms: number | undefined): string => {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return '';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${String(totalSeconds)}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds === 0
      ? `${String(totalMinutes)}m`
      : `${String(totalMinutes)}m ${String(seconds)}s`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${String(hours)}h` : `${String(hours)}h ${String(minutes)}m`;
};

const compactTimestamp = (iso: string): string => {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms);
  try {
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
};

const compareVisit = (left: TimelineVisit, right: TimelineVisit): number =>
  left.commitTimestamp.localeCompare(right.commitTimestamp) || left.id.localeCompare(right.id);

const tabTimeDescription = (
  tabVisits: readonly TimelineVisit[],
  tabInfo: TabSessionInfo | undefined,
): string => {
  const sorted = [...tabVisits].sort(compareVisit);
  const firstIso = tabInfo?.firstSeenAt ?? sorted[0]?.firstSeenAt ?? sorted[0]?.commitTimestamp;
  const lastIso = tabInfo?.lastActivityAt ?? sorted[sorted.length - 1]?.commitTimestamp ?? firstIso;
  const firstMs = firstIso === undefined ? Number.NaN : Date.parse(firstIso);
  const lastMs = lastIso === undefined ? Number.NaN : Date.parse(lastIso);
  const span =
    tabInfo?.lifespanMs ??
    (Number.isFinite(firstMs) && Number.isFinite(lastMs)
      ? Math.max(0, lastMs - firstMs)
      : undefined);
  const timePart =
    firstIso === undefined || lastIso === undefined
      ? ''
      : firstIso === lastIso
        ? compactTimestamp(lastIso)
        : `${compactTimestamp(firstIso)} - ${compactTimestamp(lastIso)}`;
  const duration = formatDuration(span);
  const visitsPart = `${String(tabVisits.length)} ${tabVisits.length === 1 ? 'visit' : 'visits'}`;
  return [timePart, duration.length > 0 ? duration : undefined, visitsPart]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(' · ');
};

export interface TimelineVisit {
  readonly id: string;
  readonly label: string;
  readonly commitTimestamp: string;
  readonly tabSessionIdHash: string;
  readonly engagementClass?: string;
  readonly host?: string;
  readonly url?: string;
  readonly focusedWindowMs?: number;
  // True for the anchor visit (or any visit-instance whose URL
  // matches the anchor URL). Used to highlight where the user is in
  // each tab's chronological chain — "I am here, this is what came
  // before, this is what came after".
  readonly isAnchor?: boolean;
  // Enrichments propagated from snapshot metadata; the Flow Path cell
  // surfaces them as inline chips/prefixes so the user can answer
  // "what kind of visit was this" at a glance.
  readonly provider?: string;
  readonly visitCount?: number;
  readonly searchQuery?: string;
  readonly firstSeenAt?: string;
}

export interface TabSessionInfo {
  readonly label: string;
  readonly host?: string;
  readonly lastActivityAt?: string;
  readonly firstSeenAt?: string;
  readonly lifespanMs?: number;
}

export interface FlowSummary {
  readonly visitCount: number;
  readonly tabCount: number;
  readonly firstSeenAt?: string;
  readonly replicaAliases: readonly string[];
}

export interface NavigationEdge {
  readonly id: string;
  readonly fromVisitId: string;
  readonly toVisitId: string;
  readonly kind: 'previousVisitId' | 'openerVisitId';
}

export interface CrossReplicaEdge {
  readonly id: string;
  readonly fromVisitId: string;
  readonly replicaId: string;
}

export interface FlowPathViewProps {
  readonly visits: readonly TimelineVisit[];
  readonly navigationEdges: readonly NavigationEdge[];
  readonly crossReplicaEdges: readonly CrossReplicaEdge[];
  readonly onNodeClick: (visitId: string) => void;
  // Resolver for replica aliases ("This browser" / "Browser 2"). When
  // omitted, falls back to a placeholder; never displays the raw
  // replicaId as visible text.
  readonly replicaAlias?: (replicaId: string) => string;
  // Tab-session enrichments keyed by the same hash the visits use for
  // grouping. Provides title + host + lifespan for the row header.
  readonly tabSessions?: ReadonlyMap<string, TabSessionInfo>;
  // Anchor lifecycle stats for the strip above the tab rows.
  readonly summary?: FlowSummary;
  // Cross-tab opener chain: destination tab hash → source tab hash.
  // Used in addition to the visit-level opener_visit edges so a tab
  // opened from another tab gets an "opened from" badge even when the
  // specific source visit isn't in scope.
  readonly tabOpenerByDest?: ReadonlyMap<string, string>;
  readonly highlightedVisitId?: string | null;
}

const PROVIDER_LABELS: Record<string, string> = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  gemini: 'Gemini',
  generic: '',
};

const ENGAGEMENT_LABELS: Record<string, string> = {
  engaged_read: 'Read',
  worked_on_reference: 'Worked',
  glanced: 'Glance',
  skimmed: 'Skim',
  source_extracted: 'Source',
  execution_source: 'Execution',
};

const formatProvider = (provider: string | undefined): string | undefined => {
  if (provider === undefined || provider.length === 0) return undefined;
  const known = PROVIDER_LABELS[provider.toLowerCase()];
  if (known !== undefined) return known.length === 0 ? undefined : known;
  return provider.length > 12 ? `${provider.slice(0, 12)}…` : provider;
};

const truncateQuery = (query: string): string =>
  query.length > 40 ? `${query.slice(0, 40)}…` : query;

export const FlowPathView = ({
  visits,
  navigationEdges,
  crossReplicaEdges,
  onNodeClick,
  replicaAlias,
  tabSessions,
  tabOpenerByDest,
  summary,
  highlightedVisitId,
}: FlowPathViewProps): ReactElement => {
  const visitsByTab = new Map<string, TimelineVisit[]>();
  for (const visit of [...visits].sort(compareVisit)) {
    const list = visitsByTab.get(visit.tabSessionIdHash) ?? [];
    list.push(visit);
    visitsByTab.set(visit.tabSessionIdHash, list);
  }
  const visitById = new Map(visits.map((visit) => [visit.id, visit] as const));
  const fallbackTabLabelByHash = new Map(
    [...visitsByTab.keys()].map((tabSessionIdHash, index) => [
      tabSessionIdHash,
      `Tab ${String(index + 1)}`,
    ]),
  );
  // Visit label never falls back to the raw visit id — the upstream
  // derivation (`deriveFlowVisits` in ConnectionsView) already passes
  // a formatted label, so a missing entry means the edge points at a
  // node we couldn't resolve. Use a kind-aware placeholder instead.
  const visitLabel = (visitId: string): string => visitById.get(visitId)?.label ?? '(visit)';
  const replicaName = (replicaId: string): string =>
    replicaAlias !== undefined ? replicaAlias(replicaId) : 'Browser';
  const tabHeaderLabel = (hash: string): string =>
    tabSessions?.get(hash)?.label ?? fallbackTabLabelByHash.get(hash) ?? 'Tab';

  // Map opener edges by destination tab so we can render the
  // "Opened from Tab N" badge next to the tab row that received the
  // navigation. previous_visit_in_tab_session edges stay implicit —
  // the → arrows between visits in the same tab already convey them.
  const openerByDestTab = new Map<string, string>(); // destTab -> sourceTab
  for (const edge of navigationEdges) {
    if (edge.kind !== 'openerVisitId') continue;
    const fromVisit = visitById.get(edge.fromVisitId);
    const toVisit = visitById.get(edge.toVisitId);
    if (fromVisit === undefined || toVisit === undefined) continue;
    if (fromVisit.tabSessionIdHash === toVisit.tabSessionIdHash) continue;
    openerByDestTab.set(toVisit.tabSessionIdHash, fromVisit.tabSessionIdHash);
  }
  // Tab-level opener edges fill the gap when the source visit isn't
  // loaded in the current scope. Visit-level openers win when both
  // are present (more specific).
  if (tabOpenerByDest !== undefined) {
    for (const [dest, src] of tabOpenerByDest) {
      if (!openerByDestTab.has(dest)) openerByDestTab.set(dest, src);
    }
  }
  // Which tabs have an incoming previous_visit_in_tab_session edge
  // pointing at their anchor? Used to suppress the empty-chain
  // placeholder when the chain genuinely exists but the prev visit
  // is outside the loaded subgraph.
  const tabsWithIncomingPrev = new Set<string>();
  for (const edge of navigationEdges) {
    if (edge.kind !== 'previousVisitId') continue;
    const toVisit = visitById.get(edge.toVisitId);
    if (toVisit !== undefined) tabsWithIncomingPrev.add(toVisit.tabSessionIdHash);
  }

  const summaryParts: string[] = [];
  if (summary !== undefined) {
    if (summary.visitCount > 0) {
      summaryParts.push(
        `Visited ${String(summary.visitCount)} ${
          summary.visitCount === 1 ? 'time' : 'times'
        } across ${String(summary.tabCount)} ${summary.tabCount === 1 ? 'tab' : 'tabs'}`,
      );
    }
    if (summary.firstSeenAt !== undefined) {
      summaryParts.push(`first ${formatRelative(summary.firstSeenAt)}`);
    }
    if (summary.replicaAliases.length > 0) {
      summaryParts.push(`also on ${summary.replicaAliases.join(', ')}`);
    }
  }
  const tabEntryGroups = (() => {
    type TabEntry = {
      readonly tabSessionIdHash: string;
      readonly visits: readonly TimelineVisit[];
      readonly label: string;
      readonly host?: string;
      readonly timeDescription: string;
      readonly openedFrom?: string;
      readonly hasAnchor: boolean;
    };
    type TabGroup = {
      readonly key: string;
      readonly label: string;
      readonly host?: string;
      readonly entries: TabEntry[];
      readonly visits: readonly TimelineVisit[];
      readonly hasAnchor: boolean;
      readonly firstIndex: number;
    };
    const groups: TabGroup[] = [];
    const groupByKey = new Map<string, TabGroup>();
    let index = 0;
    for (const [tabSessionIdHash, tabVisits] of visitsByTab.entries()) {
      const tabInfo = tabSessions?.get(tabSessionIdHash);
      const label = tabHeaderLabel(tabSessionIdHash);
      const host = tabInfo?.host;
      const entry: TabEntry = {
        tabSessionIdHash,
        visits: tabVisits,
        label,
        ...(host === undefined ? {} : { host }),
        timeDescription: tabTimeDescription(tabVisits, tabInfo),
        ...(openerByDestTab.get(tabSessionIdHash) === undefined
          ? {}
          : { openedFrom: openerByDestTab.get(tabSessionIdHash) }),
        hasAnchor: tabVisits.some((visit) => visit.isAnchor === true),
      };
      const key = `tab:${tabSessionIdHash}`;
      const existing = groupByKey.get(key);
      if (existing === undefined) {
        const next: TabGroup = {
          key,
          label: entry.label,
          ...(entry.host === undefined ? {} : { host: entry.host }),
          entries: [entry],
          visits: entry.visits,
          hasAnchor: entry.hasAnchor,
          firstIndex: index,
        };
        groupByKey.set(key, next);
        groups.push(next);
      } else {
        const next: TabGroup = {
          ...existing,
          entries: [...existing.entries, entry],
          visits: [...existing.visits, ...entry.visits].sort(compareVisit),
          hasAnchor: existing.hasAnchor || entry.hasAnchor,
        };
        groupByKey.set(key, next);
        const at = groups.findIndex((group) => group.key === key);
        if (at >= 0) groups[at] = next;
      }
      index += 1;
    }
    // Ordering (not styling): the anchor's tab first — its internal
    // prior -> "You are here" -> later segmentation is handled per
    // cell below — then the remaining tab groups by opener
    // relationship to the anchor tab, then recency. Encounter order
    // is only the final stable tie-break.
    const anchorTabHash = visits.find((v) => v.isAnchor === true)?.tabSessionIdHash;
    // Undirected opener adjacency: distance reflects "related to the
    // anchor tab" regardless of which side opened which.
    const openerAdj = new Map<string, Set<string>>();
    const linkTabs = (a: string, b: string): void => {
      (openerAdj.get(a) ?? openerAdj.set(a, new Set()).get(a))?.add(b);
      (openerAdj.get(b) ?? openerAdj.set(b, new Set()).get(b))?.add(a);
    };
    for (const [dest, src] of openerByDestTab) linkTabs(dest, src);
    const openerDistance = new Map<string, number>();
    if (anchorTabHash !== undefined) {
      openerDistance.set(anchorTabHash, 0);
      let frontier: string[] = [anchorTabHash];
      let depth = 0;
      while (frontier.length > 0) {
        const next: string[] = [];
        for (const tab of frontier) {
          for (const neighbor of openerAdj.get(tab) ?? []) {
            if (openerDistance.has(neighbor)) continue;
            openerDistance.set(neighbor, depth + 1);
            next.push(neighbor);
          }
        }
        frontier = next;
        depth += 1;
      }
    }
    const groupTab = (g: TabGroup): string => g.entries[0]?.tabSessionIdHash ?? g.key;
    const recencyOf = (g: TabGroup): string =>
      g.visits.reduce((max, v) => (v.commitTimestamp > max ? v.commitTimestamp : max), '');
    const openerRank = (g: TabGroup): number =>
      g.hasAnchor ? -1 : (openerDistance.get(groupTab(g)) ?? Number.POSITIVE_INFINITY);
    return [...groups].sort((left, right) => {
      const rl = openerRank(left);
      const rr = openerRank(right);
      if (rl !== rr) return rl - rr;
      // Tie-break: more recent activity first, then stable encounter order.
      const recencyCmp = recencyOf(right).localeCompare(recencyOf(left));
      if (recencyCmp !== 0) return recencyCmp;
      return left.firstIndex - right.firstIndex;
    });
  })();

  return (
    <section className="cx-flow" data-testid="flow-path-view">
      {summaryParts.length > 0 ? (
        <header className="cx-flow-summary cx-dim cx-mono" data-testid="flow-path-summary">
          {summaryParts.join(' · ')}
        </header>
      ) : null}
      {tabEntryGroups.map((tabGroup) => {
        const tabVisits = tabGroup.visits;
        const openedFrom =
          tabGroup.entries.length === 1 ? tabGroup.entries[0]?.openedFrom : undefined;
        const tabTime =
          tabGroup.entries.length === 1 ? (tabGroup.entries[0]?.timeDescription ?? '') : '';
        // Empty-chain detection — solo anchor visit, no incoming
        // prev-visit edge AND no inbound opener.
        const soloAnchor =
          tabVisits.length === 1 &&
          tabVisits[0]?.isAnchor === true &&
          !tabsWithIncomingPrev.has(tabVisits[0].tabSessionIdHash) &&
          openedFrom === undefined;
        const anchorIdx = tabVisits.findIndex((v) => v.isAnchor === true);
        return (
          <div className="cx-flow-row" key={tabGroup.key}>
            <div className="cx-flow-tab">
              <div className="cx-flow-tab-name">{tabGroup.label}</div>
              {tabGroup.host !== undefined && tabGroup.host.length > 0 ? (
                <div className="cx-flow-tab-host cx-dim">{tabGroup.host}</div>
              ) : null}
              {tabGroup.entries.length > 1 ? (
                <div className="cx-flow-tab-life cx-dim">
                  {String(tabGroup.entries.length)} tabs aggregated
                </div>
              ) : null}
              {tabTime.length > 0 ? <div className="cx-flow-tab-life cx-dim">{tabTime}</div> : null}
              {openedFrom !== undefined ? (
                <div className="cx-flow-tab-opener">← opened from {tabHeaderLabel(openedFrom)}</div>
              ) : null}
            </div>
            <div className="cx-flow-visits">
              {soloAnchor ? (
                <div
                  className="cx-flow-visit-placeholder cx-dim"
                  data-testid={`flow-tab-placeholder-${tabVisits[0]?.tabSessionIdHash ?? tabGroup.key}`}
                >
                  Direct visit — no prior page in this tab
                </div>
              ) : null}
              {tabVisits.map((visit, idx) => {
                const duration = formatDuration(visit.focusedWindowMs);
                const canOpen = visit.url !== undefined && visit.url.length > 0;
                const cellClasses = [
                  'cx-flow-visit',
                  visit.isAnchor === true ? 'is-anchor' : '',
                  highlightedVisitId === visit.id ? 'is-timeline-hovered' : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                const providerLabel = formatProvider(visit.provider);
                const engagementLabel =
                  visit.engagementClass === undefined
                    ? undefined
                    : ENGAGEMENT_LABELS[visit.engagementClass];
                // Before / After segment label inserted between cells
                // when both sides of the anchor are populated.
                const showBeforeLabel = idx === 0 && anchorIdx > 0 && tabVisits.length > 1;
                const showAfterLabel =
                  anchorIdx >= 0 && anchorIdx < tabVisits.length - 1 && idx === anchorIdx + 1;
                const previousVisit = tabVisits[idx - 1];
                const showArrow =
                  idx > 0 &&
                  !showAfterLabel &&
                  previousVisit?.tabSessionIdHash === visit.tabSessionIdHash;
                return (
                  <div key={visit.id} className="cx-flow-visit-cell">
                    {showBeforeLabel ? <span className="cx-flow-segment-label">Before</span> : null}
                    {showAfterLabel ? <span className="cx-flow-segment-label">After</span> : null}
                    {showArrow ? (
                      <span className="cx-flow-arrow" aria-hidden="true">
                        →
                      </span>
                    ) : null}
                    <div className="cx-flow-visit-wrap">
                      <button
                        type="button"
                        className={cellClasses}
                        title={visit.url}
                        onClick={() => onNodeClick(visit.id)}
                        data-testid={`flow-visit-${visit.id}`}
                      >
                        {visit.isAnchor === true ? (
                          <span className="cx-flow-visit-anchor-mark" aria-hidden="true">
                            You are here
                          </span>
                        ) : null}
                        {visit.searchQuery !== undefined && visit.searchQuery.length > 0 ? (
                          <span className="cx-flow-visit-search-query" title={visit.searchQuery}>
                            q: {truncateQuery(visit.searchQuery)}
                          </span>
                        ) : null}
                        <span className="cx-flow-visit-title">{visit.label}</span>
                        <span className="cx-flow-visit-chips">
                          {visit.host === undefined || visit.host.length === 0 ? null : (
                            <span className="cx-flow-visit-host cx-dim">{visit.host}</span>
                          )}
                          {providerLabel !== undefined ? (
                            <span className="cx-flow-visit-provider">{providerLabel}</span>
                          ) : null}
                          {engagementLabel !== undefined ? (
                            <span
                              className="cx-flow-visit-engagement"
                              title={`Engagement classification: ${visit.engagementClass ?? ''}`}
                            >
                              {engagementLabel}
                            </span>
                          ) : null}
                        </span>
                        <span className="cx-flow-visit-meta">
                          <span className="cx-mono cx-dim" title={visit.commitTimestamp}>
                            {formatRelative(visit.commitTimestamp)}
                          </span>
                          {duration.length > 0 ? (
                            <span
                              className="cx-flow-visit-duration"
                              title={`URL-aggregate focused window — ${String(visit.focusedWindowMs ?? 0)}ms`}
                            >
                              {duration}
                            </span>
                          ) : null}
                          {visit.visitCount !== undefined && visit.visitCount > 1 ? (
                            <span className="cx-flow-visit-count cx-dim">
                              · {String(visit.visitCount)} visits
                            </span>
                          ) : null}
                        </span>
                      </button>
                      {canOpen ? (
                        <a
                          className="cx-flow-visit-open"
                          href={visit.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={`Open ${visit.url ?? ''} in a new tab — absolute: ${localTimestamp(visit.commitTimestamp)}`}
                          aria-label={`Open ${visit.label} in a new tab`}
                          data-testid={`flow-visit-open-${visit.id}`}
                        >
                          ↗
                        </a>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      {crossReplicaEdges.length === 0 ? null : (
        <div className="cx-flow-edges" aria-label="Cross-replica observations">
          {crossReplicaEdges.map((edge) => (
            <span
              key={edge.id}
              className="cx-flow-edge cx-edge-cross-replica"
              data-testid={`flow-cross-replica-edge-${edge.id}`}
            >
              also seen on {replicaName(edge.replicaId)}: {visitLabel(edge.fromVisitId)}
            </span>
          ))}
        </div>
      )}
    </section>
  );
};
