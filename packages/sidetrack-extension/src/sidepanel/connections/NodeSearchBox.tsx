import { useMemo, useState, type ReactElement } from 'react';

import { formatEntityDisplay, type EntityDisplayCtx } from '../entityDisplay/format';
import { NODE_KIND_DISPLAY } from './edgeKinds';
import { KindIcons } from './icons';
import type { ConnectionNode } from './types';

// Stage 5 polish — find-by-title search. The advanced-anchor input
// only accepts a raw `kind:id` string, which assumes the user
// memorized every node id. This box lets the user type a substring
// of the visible title and pick from a ranked dropdown across:
//   - workstreamAnchors (user's named workstreams)
//   - recentAnchors (last few visited)
//   - the current snapshot's neighbor nodes
//
// Everything is client-side over what's already loaded. The full
// snapshot would be a much larger pool, but fetching it would mean
// shipping ~2 MB across the chrome bridge — left as a follow-up
// behind an explicit "search everywhere" affordance.

export interface SearchableAnchor {
  readonly id: string;
  readonly label: string;
  readonly kind?: string;
  readonly meta?: string;
}

export interface NodeSearchBoxProps {
  readonly nodes: readonly ConnectionNode[];
  readonly extras: readonly SearchableAnchor[];
  readonly ctx: EntityDisplayCtx;
  readonly onPick: (anchorId: string) => void;
  readonly maxResults?: number;
  // Stage 5 polish — backend-graph search hooks. When provided,
  // focusing the input fires `onPrime()` so the parent can load
  // the FULL snapshot in the background. While that fetch is in
  // flight `loading` is true so the box shows a "Searching the
  // whole vault…" hint. Without these props the box still works
  // as a local-pool filter.
  readonly onPrime?: () => void;
  readonly loading?: boolean;
}

interface SearchHit {
  readonly id: string;
  readonly primary: string;
  readonly secondary?: string;
  readonly kind: string;
  readonly score: number;
}

// Lowercase substring match with a small score bias: exact prefix
// matches sort above mid-string matches; shorter primary lines sort
// above longer ones so a hit on "Hacker News" beats a hit on
// "(775) I was laid off… - YouTube" when both match "ne".
const rank = (query: string, primary: string): number => {
  const p = primary.toLowerCase();
  const q = query.toLowerCase();
  const idx = p.indexOf(q);
  if (idx === -1) return -1;
  const prefixBonus = idx === 0 ? 100 : 0;
  const lengthPenalty = Math.min(50, p.length);
  return 200 - lengthPenalty + prefixBonus;
};

export const NodeSearchBox = ({
  nodes,
  extras,
  ctx,
  onPick,
  maxResults = 8,
  onPrime,
  loading,
}: NodeSearchBoxProps): ReactElement => {
  const [query, setQuery] = useState<string>('');
  const [open, setOpen] = useState<boolean>(false);
  const trimmed = query.trim();

  const hits = useMemo<readonly SearchHit[]>(() => {
    if (trimmed.length === 0) return [];
    const byId = new Map<string, SearchHit>();
    for (const node of nodes) {
      const display = formatEntityDisplay(node, ctx);
      const score = rank(trimmed, display.primary);
      if (score < 0) continue;
      byId.set(node.id, {
        id: node.id,
        primary: display.primary,
        ...(display.secondary === undefined ? {} : { secondary: display.secondary }),
        kind: node.kind,
        score,
      });
    }
    for (const extra of extras) {
      if (byId.has(extra.id)) continue;
      const score = rank(trimmed, extra.label);
      if (score < 0) continue;
      byId.set(extra.id, {
        id: extra.id,
        primary: extra.label,
        ...(extra.meta === undefined ? {} : { secondary: extra.meta }),
        kind: extra.kind ?? 'workstream',
        score,
      });
    }
    return [...byId.values()]
      .sort((a, b) => b.score - a.score || a.primary.localeCompare(b.primary))
      .slice(0, maxResults);
  }, [ctx, extras, maxResults, nodes, trimmed]);

  return (
    <div className="cx-search" data-testid="connections-search">
      <label className="cx-input">
        <span className="cx-input-icon" aria-hidden>
          🔍
        </span>
        <input
          type="search"
          className="cx-search-input"
          placeholder="Find by title — type to filter…"
          aria-label="Find an anchor by title"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            setOpen(true);
            onPrime?.();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setQuery('');
              setOpen(false);
            } else if (event.key === 'Enter' && hits[0] !== undefined) {
              onPick(hits[0].id);
              setQuery('');
              setOpen(false);
            }
          }}
          data-testid="connections-search-input"
        />
        {trimmed.length > 0 ? (
          <button
            type="button"
            className="cx-search-clear"
            onClick={() => {
              setQuery('');
            }}
            aria-label="Clear search"
          >
            ×
          </button>
        ) : null}
      </label>
      {open && trimmed.length > 0 ? (
        <div className="cx-search-results" data-testid="connections-search-results">
          {loading === true ? (
            <div
              className="cx-search-loading mono cx-dim"
              data-testid="connections-search-loading"
            >
              Searching the whole vault…
            </div>
          ) : null}
          {hits.length === 0 ? (
            <div className="cx-search-empty">
              {loading === true
                ? 'Hold on — vault fetch in flight.'
                : 'No matches across the full snapshot. Pick a workstream below or paste a node id under '}
              {loading === true ? null : <em>Advanced node anchor</em>}
              {loading === true ? null : '.'}
            </div>
          ) : (
            hits.map((hit) => {
              const tintClass = (NODE_KIND_DISPLAY as Record<string, { tintClass: string }>)[hit.kind]
                ?.tintClass;
              const kindLabel = (NODE_KIND_DISPLAY as Record<string, { label: string }>)[hit.kind]
                ?.label ?? hit.kind;
              const Icon = (KindIcons as Record<string, ReactElement>)[hit.kind];
              return (
                <button
                  key={hit.id}
                  type="button"
                  className="cx-search-hit"
                  onClick={() => {
                    onPick(hit.id);
                    setQuery('');
                    setOpen(false);
                  }}
                  data-testid={`connections-search-hit-${hit.id}`}
                >
                  {tintClass !== undefined ? (
                    <span className={`cx-node-icon ${tintClass}`} aria-hidden>
                      {Icon}
                    </span>
                  ) : null}
                  <span className="cx-search-hit-body">
                    <span className="cx-search-hit-primary">{hit.primary}</span>
                    {hit.secondary !== undefined ? (
                      <span className="cx-search-hit-secondary">{hit.secondary}</span>
                    ) : null}
                  </span>
                  <span className="cx-search-hit-kind">{kindLabel}</span>
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
};
