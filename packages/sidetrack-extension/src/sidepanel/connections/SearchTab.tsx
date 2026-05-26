import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import { nodeKindDisplayFor } from './edgeKinds';
import { ExternalLinkIcon, FilterIcon, KindIcons, SearchIcon } from './icons';
import type { RecallSearchHit, SearchableAnchor } from './NodeSearchBox';
import type { ConnectionNode, ConnectionNodeKind } from './types';
import {
  formatEntityDisplay,
  hostOf,
  isInternalIdLike,
  type EntityDisplayCtx,
} from '../entityDisplay/format';
import { rankSubstring } from '../search/ranking';

interface SearchTabProps {
  readonly nodes: readonly ConnectionNode[];
  readonly extras: readonly SearchableAnchor[];
  readonly ctx: EntityDisplayCtx;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly onPick: (anchorId: string, label?: string) => void;
  readonly onPrime?: () => void;
  readonly loading?: boolean;
  readonly recallHits?: readonly RecallSearchHit[];
  readonly recallLoading?: boolean;
  readonly recallError?: string | null;
  readonly onOpenUrl?: (url: string) => void;
  // Pivot to Connections → Déjà-vu submode with the current query
  // text as the selection. Renders a "Déjà-vu this" button in the
  // header when wired (parent owns the actual mode switch + hit
  // population). Hidden when omitted.
  readonly onDejaVuPivot?: (query: string) => void;
}

interface SearchHit {
  readonly id: string;
  readonly primary: string;
  readonly secondary?: string;
  readonly kind: ConnectionNodeKind;
  readonly score: number;
  readonly url?: string;
}

const rank = (query: string, primary: string): number => rankSubstring(query, primary);

// Empty-query browse: when the user has narrowed the kind filter (e.g.
// only "topic"), an empty query lists EVERY object of the visible kinds
// — paginated, since a kind can have hundreds of members.
const BROWSE_PAGE_SIZE = 50;

const isConnectionNodeKind = (value: string | undefined): value is ConnectionNodeKind =>
  value !== undefined && value in KindIcons;

const kindFromAnchorId = (id: string): ConnectionNodeKind => {
  const prefix = id.includes(':') ? id.slice(0, id.indexOf(':')) : id;
  return isConnectionNodeKind(prefix) ? prefix : 'timeline-visit';
};

const urlFromNodeId = (nodeId: string): string | undefined => {
  if (nodeId.startsWith('timeline-visit:')) {
    const value = nodeId.slice('timeline-visit:'.length);
    return value.length > 0 ? value : undefined;
  }
  if (nodeId.startsWith('visit-instance:')) {
    const tail = nodeId.slice('visit-instance:'.length);
    const httpIdx = tail.indexOf(':http');
    if (httpIdx >= 0) {
      const value = tail.slice(httpIdx + 1);
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
};

const metadataUrl = (metadata: Record<string, unknown>): string | undefined => {
  for (const key of ['canonicalUrl', 'latestUrl', 'url']) {
    const value = metadata[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
};

const urlForNode = (node: ConnectionNode): string | undefined =>
  metadataUrl(node.metadata) ?? urlFromNodeId(node.id);

// Extra strings to rank a query against, beyond the visible `primary`.
// A topic node's `primary` is only its FIRST representative title, so a
// search for a term that lives in any other member title (or the label)
// would miss the whole cluster. Widen topic matching to every
// representative title + the raw label; all other kinds keep matching
// on `primary` alone (no behavior change). Display text is untouched.
const auxSearchTextsFor = (node: ConnectionNode): readonly string[] => {
  if (node.kind !== 'topic') return [];
  const out: string[] = [];
  const titles = node.metadata['representativeTitles'];
  if (Array.isArray(titles)) {
    for (const title of titles) {
      if (typeof title === 'string' && title.trim().length > 0) out.push(title);
    }
  }
  if (typeof node.label === 'string' && node.label.trim().length > 0) out.push(node.label);
  return out;
};

const bestRank = (query: string, texts: readonly string[]): number => {
  let best = -1;
  for (const text of texts) {
    const score = rank(query, text);
    if (score > best) best = score;
  }
  return best;
};

const sourceLabelForRecallHit = (hit: RecallSearchHit): string =>
  hit.sourceKind === 'page-content' ? 'Page' : 'Thread';

// FU3b — align Search row titles with the unified entity display
// contract: never render a raw id (`tses_*`, bare UUIDs, hex
// thread-bac-ids) as a visible title. When the recall hit's own
// title is id-like, fall back to the canonical URL host (e.g.
// "chatgpt.com"), then the kind label as a last resort.
//
// This is the same rule cleanLabel + safeTooltip apply elsewhere;
// inlined here so SearchTab doesn't pull in a snapshot-ctx-shaped
// formatter for what's a flat recall-hit list.
const titleForRecallHit = (hit: RecallSearchHit): string => {
  if (hit.title !== undefined && hit.title.length > 0 && !isInternalIdLike(hit.title)) {
    return hit.title;
  }
  const host = hostOf(hit.canonicalUrl ?? hit.threadUrl);
  if (host !== undefined) return host;
  return sourceLabelForRecallHit(hit);
};

const anchorIdForRecallHit = (hit: RecallSearchHit): string | undefined =>
  hit.anchorNodeId ?? (hit.threadId === undefined ? undefined : `thread:${hit.threadId}`);

const kindForRecallHit = (hit: RecallSearchHit): ConnectionNodeKind => {
  const anchorId = anchorIdForRecallHit(hit);
  if (anchorId !== undefined) return kindFromAnchorId(anchorId);
  return hit.sourceKind === 'page-content' ? 'timeline-visit' : 'thread';
};

const toggleKind = (
  current: ReadonlySet<ConnectionNodeKind>,
  kind: ConnectionNodeKind,
): ReadonlySet<ConnectionNodeKind> => {
  const next = new Set(current);
  if (next.has(kind)) next.delete(kind);
  else next.add(kind);
  return next;
};

const SearchHighlight = ({
  text,
  query,
}: {
  readonly text: string;
  readonly query: string;
}): ReactElement => {
  const q = query.trim();
  if (q.length === 0) return <>{text}</>;
  const index = text.toLowerCase().indexOf(q.toLowerCase());
  if (index < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <mark className="cx-search-mark">{text.slice(index, index + q.length)}</mark>
      {text.slice(index + q.length)}
    </>
  );
};

export const SearchTab = ({
  nodes,
  extras,
  ctx,
  query,
  onQueryChange,
  onPick,
  onPrime,
  loading = false,
  recallHits = [],
  recallLoading = false,
  recallError = null,
  onOpenUrl,
  onDejaVuPivot,
}: SearchTabProps): ReactElement => {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [hiddenKinds, setHiddenKinds] = useState<ReadonlySet<ConnectionNodeKind>>(
    () => new Set<ConnectionNodeKind>(),
  );
  const [browseLimit, setBrowseLimit] = useState<number>(BROWSE_PAGE_SIZE);
  const trimmed = query.trim();

  useEffect(() => {
    onPrime?.();
    inputRef.current?.focus();
    // Prime/focus on tab entry only. The parent hook returns a fresh
    // `prime` closure each render, but the operation itself is idempotent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Restart pagination whenever the browse set changes (a kind toggle or
  // the query going (non-)empty) so "Show more" never strands an offset.
  useEffect(() => {
    setBrowseLimit(BROWSE_PAGE_SIZE);
  }, [hiddenKinds, trimmed]);

  const titleHits = useMemo<readonly SearchHit[]>(() => {
    if (trimmed.length === 0) return [];
    const byId = new Map<string, SearchHit>();
    for (const node of nodes) {
      const display = formatEntityDisplay(node, ctx);
      const score = bestRank(trimmed, [display.primary, ...auxSearchTextsFor(node)]);
      if (score < 0) continue;
      byId.set(node.id, {
        id: node.id,
        primary: display.primary,
        ...(display.secondary === undefined ? {} : { secondary: display.secondary }),
        kind: node.kind,
        score,
        ...(urlForNode(node) === undefined ? {} : { url: urlForNode(node) }),
      });
    }
    for (const extra of extras) {
      if (byId.has(extra.id)) continue;
      const score = rank(trimmed, extra.label);
      if (score < 0) continue;
      const kind = isConnectionNodeKind(extra.kind) ? extra.kind : kindFromAnchorId(extra.id);
      byId.set(extra.id, {
        id: extra.id,
        primary: extra.label,
        ...(extra.meta === undefined ? {} : { secondary: extra.meta }),
        kind,
        score,
        ...(urlFromNodeId(extra.id) === undefined ? {} : { url: urlFromNodeId(extra.id) }),
      });
    }
    return [...byId.values()]
      .sort((left, right) => right.score - left.score || left.primary.localeCompare(right.primary))
      .slice(0, 24);
  }, [ctx, extras, nodes, trimmed]);

  const quickPicks = useMemo<readonly SearchHit[]>(() => {
    const byId = new Map<string, SearchHit>();
    for (const extra of extras.slice(0, 6)) {
      const kind = isConnectionNodeKind(extra.kind) ? extra.kind : kindFromAnchorId(extra.id);
      byId.set(extra.id, {
        id: extra.id,
        primary: extra.label,
        ...(extra.meta === undefined ? {} : { secondary: extra.meta }),
        kind,
        score: 0,
        ...(urlFromNodeId(extra.id) === undefined ? {} : { url: urlFromNodeId(extra.id) }),
      });
    }
    for (const node of nodes.slice(0, 8)) {
      if (byId.has(node.id)) continue;
      const display = formatEntityDisplay(node, ctx);
      byId.set(node.id, {
        id: node.id,
        primary: display.primary,
        ...(display.secondary === undefined ? {} : { secondary: display.secondary }),
        kind: node.kind,
        score: 0,
        ...(urlForNode(node) === undefined ? {} : { url: urlForNode(node) }),
      });
    }
    return [...byId.values()].slice(0, 8);
  }, [ctx, extras, nodes]);

  const kindIndex = useMemo(() => {
    const counts = new Map<ConnectionNodeKind, number>();
    for (const node of nodes) counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
    for (const extra of extras) {
      const kind = isConnectionNodeKind(extra.kind) ? extra.kind : kindFromAnchorId(extra.id);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    for (const hit of recallHits) {
      const kind = kindForRecallHit(hit);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    return [...counts.entries()].sort(
      (left, right) =>
        right[1] - left[1] ||
        nodeKindDisplayFor(left[0]).label.localeCompare(nodeKindDisplayFor(right[0]).label),
    );
  }, [extras, nodes, recallHits]);

  // The checkbox list shows the top kinds only; "Deselect all" must hide
  // EVERY kind present (including ones past the visible cap) so the
  // results truly empty out.
  const kindCounts = useMemo(() => kindIndex.slice(0, 8), [kindIndex]);
  const allKinds = useMemo(() => kindIndex.map(([kind]) => kind), [kindIndex]);
  const allKindsShown = hiddenKinds.size === 0;
  const noKindsShown = allKinds.length > 0 && allKinds.every((kind) => hiddenKinds.has(kind));

  const filteredTitleHits = useMemo(
    () => titleHits.filter((hit) => !hiddenKinds.has(hit.kind)),
    [hiddenKinds, titleHits],
  );

  const filteredQuickPicks = useMemo(
    () => quickPicks.filter((hit) => !hiddenKinds.has(hit.kind)),
    [hiddenKinds, quickPicks],
  );

  const filteredRecallHits = useMemo(
    () => recallHits.filter((hit) => !hiddenKinds.has(kindForRecallHit(hit))),
    [hiddenKinds, recallHits],
  );

  // Every node + named anchor as a hit, sorted by title. Drives the
  // empty-query browse list (e.g. "all 87 topics"). Memoized on the
  // snapshot, not on the kind filter, so toggling kinds is cheap.
  const browseAll = useMemo<readonly SearchHit[]>(() => {
    const byId = new Map<string, SearchHit>();
    for (const node of nodes) {
      const display = formatEntityDisplay(node, ctx);
      byId.set(node.id, {
        id: node.id,
        primary: display.primary,
        ...(display.secondary === undefined ? {} : { secondary: display.secondary }),
        kind: node.kind,
        score: 0,
        ...(urlForNode(node) === undefined ? {} : { url: urlForNode(node) }),
      });
    }
    for (const extra of extras) {
      if (byId.has(extra.id)) continue;
      const kind = isConnectionNodeKind(extra.kind) ? extra.kind : kindFromAnchorId(extra.id);
      byId.set(extra.id, {
        id: extra.id,
        primary: extra.label,
        ...(extra.meta === undefined ? {} : { secondary: extra.meta }),
        kind,
        score: 0,
        ...(urlFromNodeId(extra.id) === undefined ? {} : { url: urlFromNodeId(extra.id) }),
      });
    }
    return [...byId.values()].sort((left, right) => left.primary.localeCompare(right.primary));
  }, [ctx, extras, nodes]);

  const filteredBrowse = useMemo(
    () => browseAll.filter((hit) => !hiddenKinds.has(hit.kind)),
    [browseAll, hiddenKinds],
  );

  // Browse mode = no query AND the kind filter is narrowed. With every
  // kind shown an empty query keeps the small "Quick picks" teaser
  // rather than dumping the entire snapshot.
  const browsing = trimmed.length === 0 && hiddenKinds.size > 0;

  const titleCountLabel = browsing
    ? `Browsing · ${String(filteredBrowse.length)}`
    : trimmed.length === 0
      ? 'Quick picks'
      : `Title matches · ${String(filteredTitleHits.length)}`;
  const recallCountLabel = recallLoading
    ? 'Content matches · searching…'
    : `Content matches · ${String(filteredRecallHits.length)}`;

  const pickTop = (): void => {
    const first = filteredTitleHits[0];
    if (first !== undefined) onPick(first.id, first.primary);
  };

  const renderTitleHit = (hit: SearchHit): ReactElement => {
    const display = nodeKindDisplayFor(hit.kind);
    const Icon = KindIcons[hit.kind];
    const url = hit.url;
    return (
      <div className="cx-search-tab-row" key={hit.id}>
        <button
          type="button"
          className="cx-search-tab-hit"
          onClick={() => {
            onPick(hit.id, hit.primary);
          }}
          data-testid={`connections-search-tab-hit-${hit.id}`}
        >
          <span className={`cx-node-icon ${display.tintClass}`} aria-hidden>
            {Icon}
          </span>
          <span className="cx-search-tab-hit-body">
            <span className="cx-search-tab-hit-title">
              <SearchHighlight text={hit.primary} query={trimmed} />
            </span>
            <span className="cx-search-tab-hit-meta">
              <span>{display.label}</span>
              {hit.secondary === undefined ? null : (
                <>
                  <span>·</span>
                  <span>{hit.secondary}</span>
                </>
              )}
            </span>
          </span>
        </button>
        {onOpenUrl !== undefined && url !== undefined ? (
          <button
            type="button"
            className="cx-search-tab-open"
            onClick={() => {
              onOpenUrl(url);
            }}
            title={`Open ${url}`}
            aria-label={`Open ${hit.primary}`}
            data-testid={`connections-search-tab-open-${hit.id}`}
          >
            {ExternalLinkIcon}
          </button>
        ) : null}
      </div>
    );
  };

  return (
    <section className="cx-search-tab" data-testid="connections-search-tab">
      <div className="cx-search-tab-opbar">
        <span className="cx-search-tab-label">Search</span>
        {onDejaVuPivot !== undefined && trimmed.length > 0 ? (
          <button
            type="button"
            className="cx-search-dejavu-pivot"
            data-testid="connections-search-dejavu-pivot"
            onClick={() => onDejaVuPivot(trimmed)}
            title="Open this query in the Déjà-vu submode (chips, actions, prior matches)"
          >
            ⇄ Déjà-vu
          </button>
        ) : null}
        <label className="cx-search-tab-input">
          <span className="cx-search-tab-input-icon" aria-hidden>
            {SearchIcon}
          </span>
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => {
              onQueryChange(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                onQueryChange('');
              } else if (event.key === 'Enter') {
                pickTop();
              }
            }}
            placeholder="Search the graph by title…"
            aria-label="Search connections"
            data-testid="connections-search-tab-input"
          />
          {trimmed.length > 0 ? (
            <button
              type="button"
              className="cx-search-tab-clear"
              onClick={() => {
                onQueryChange('');
              }}
              aria-label="Clear search"
            >
              ×
            </button>
          ) : null}
        </label>
        {loading || recallLoading ? (
          <span className="cx-search-tab-status cx-mono cx-dim">
            <span className="cx-search-tab-pulse" aria-hidden />
            {loading ? 'Searching…' : 'Searching…'}
          </span>
        ) : null}
        <span className="cx-grow" />
        <span className="cx-search-tab-hint cx-mono cx-dim">Esc clears · Enter anchors top</span>
      </div>
      <div className="cx-search-tab-grid">
        <aside className="cx-search-tab-side">
          <div className="cx-section">
            <h4>Scope</h4>
            <div className="cx-search-tab-scope">
              <span>Loaded snapshot</span>
              <span className="cx-mono cx-dim">{String(nodes.length)} nodes</span>
              <span>Named anchors</span>
              <span className="cx-mono cx-dim">{String(extras.length)} saved</span>
              <span>Content index</span>
              <span className="cx-mono cx-dim">{recallError === null ? 'available' : 'error'}</span>
            </div>
          </div>
          <div className="cx-section cx-section-last">
            <h4>Object kind</h4>
            <div className="cx-search-tab-kind-controls">
              <button
                type="button"
                className="cx-search-tab-kind-toggle"
                onClick={() => {
                  setHiddenKinds(new Set<ConnectionNodeKind>());
                }}
                disabled={allKindsShown}
                data-testid="connections-search-kind-select-all"
              >
                Select all
              </button>
              <span aria-hidden>·</span>
              <button
                type="button"
                className="cx-search-tab-kind-toggle"
                onClick={() => {
                  setHiddenKinds(new Set<ConnectionNodeKind>(allKinds));
                }}
                disabled={noKindsShown}
                data-testid="connections-search-kind-deselect-all"
              >
                Deselect all
              </button>
            </div>
            <div className="cx-search-tab-kind-list">
              {kindCounts.map(([kind, count]) => {
                const display = nodeKindDisplayFor(kind);
                const checked = !hiddenKinds.has(kind);
                return (
                  <label className="cx-search-tab-kind" key={kind}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        setHiddenKinds((current) => toggleKind(current, kind));
                      }}
                      data-testid={`connections-search-kind-filter-${kind}`}
                    />
                    <span className={`cx-node-icon ${display.tintClass}`} aria-hidden>
                      {KindIcons[kind]}
                    </span>
                    <span>{display.label}</span>
                    <span className="cx-mono cx-dim">{String(count)}</span>
                  </label>
                );
              })}
            </div>
          </div>
        </aside>
        <div className="cx-search-tab-results">
          {trimmed.length === 0 ? (
            <div className="cx-search-tab-callout">
              Search titles from the loaded graph and full vault snapshot. Content matches come from
              indexed page text and captured chat turns.
            </div>
          ) : null}
          <section className="cx-search-tab-section">
            <div className="cx-search-tab-section-head">
              <h3>{titleCountLabel}</h3>
              {trimmed.length > 0 || browsing ? (
                <span className="cx-mono cx-dim">
                  {String(searchNodesDescription(nodes.length, extras.length))}
                </span>
              ) : null}
            </div>
            <div className="cx-search-tab-list">
              {(browsing
                ? filteredBrowse.slice(0, browseLimit)
                : trimmed.length === 0
                  ? filteredQuickPicks
                  : filteredTitleHits
              ).map(renderTitleHit)}
              {browsing && filteredBrowse.length === 0 ? (
                <div
                  className="cx-search-tab-empty"
                  data-testid="connections-search-tab-browse-empty"
                >
                  No objects of the selected kind in the loaded snapshot.
                </div>
              ) : null}
              {trimmed.length > 0 && filteredTitleHits.length === 0 ? (
                <div
                  className="cx-search-tab-empty"
                  data-testid="connections-search-tab-title-empty"
                >
                  No title matches in the loaded snapshot. Try content terms, or keep typing while
                  the full snapshot primes.
                </div>
              ) : null}
            </div>
            {browsing && filteredBrowse.length > browseLimit ? (
              <button
                type="button"
                className="cx-search-tab-more"
                onClick={() => {
                  setBrowseLimit((current) => current + BROWSE_PAGE_SIZE);
                }}
                data-testid="connections-search-tab-show-more"
              >
                Show {String(Math.min(BROWSE_PAGE_SIZE, filteredBrowse.length - browseLimit))} more
                · {String(filteredBrowse.length - browseLimit)} remaining
              </button>
            ) : null}
          </section>
          <section className="cx-search-tab-section">
            <div className="cx-search-tab-section-head">
              <h3>{recallCountLabel}</h3>
              <span className="cx-search-tab-section-icon" aria-hidden>
                {FilterIcon}
              </span>
            </div>
            {recallError !== null && recallHits.length === 0 ? (
              <div
                className="cx-search-tab-empty warn"
                data-testid="connections-search-tab-recall-error"
              >
                {recallError}
              </div>
            ) : null}
            {trimmed.length > 0 &&
            filteredRecallHits.length === 0 &&
            !recallLoading &&
            recallError === null ? (
              <div className="cx-search-tab-empty">
                No content matches for <em>{query}</em>.
              </div>
            ) : null}
            <div className="cx-search-tab-list">
              {filteredRecallHits.map((hit) => {
                const anchorId = anchorIdForRecallHit(hit);
                if (anchorId === undefined) return null;
                const url = hit.canonicalUrl ?? hit.threadUrl;
                const title = titleForRecallHit(hit);
                return (
                  <div
                    className="cx-search-tab-row"
                    key={`recall:${anchorId}:${hit.title ?? hit.canonicalUrl ?? hit.threadUrl ?? hit.score}`}
                  >
                    <button
                      type="button"
                      className="cx-search-tab-hit cx-search-tab-hit-recall"
                      onClick={() => {
                        onPick(anchorId, title);
                      }}
                      data-testid={`connections-search-tab-recall-${anchorId}`}
                    >
                      <span className="cx-search-tab-recall-kind">
                        {sourceLabelForRecallHit(hit)}
                      </span>
                      <span className="cx-search-tab-hit-body">
                        <span className="cx-search-tab-hit-title">
                          <SearchHighlight text={title} query={trimmed} />
                        </span>
                        {hit.snippet !== undefined && hit.snippet.length > 0 ? (
                          <span className="cx-search-tab-hit-snippet">
                            <SearchHighlight text={hit.snippet} query={trimmed} />
                          </span>
                        ) : url !== undefined ? (
                          <span className="cx-search-tab-hit-meta">{url}</span>
                        ) : null}
                      </span>
                      <span className="cx-search-tab-score">{hit.score.toFixed(2)}</span>
                    </button>
                    {onOpenUrl !== undefined && url !== undefined ? (
                      <button
                        type="button"
                        className="cx-search-tab-open"
                        onClick={() => {
                          onOpenUrl(url);
                        }}
                        title={`Open ${url}`}
                        aria-label={`Open ${title}`}
                        data-testid={`connections-search-tab-open-${anchorId}`}
                      >
                        {ExternalLinkIcon}
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>
        </div>
        <aside className="cx-search-tab-preview">
          <div className="cx-section cx-section-last">
            <h4>Preview</h4>
            <div className="cx-search-tab-callout">
              Pick a result to anchor Connections on it. Use the external-link icon when you only
              want to open the underlying page.
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
};

const searchNodesDescription = (nodeCount: number, extraCount: number): string =>
  `${String(nodeCount)} graph · ${String(extraCount)} saved`;
