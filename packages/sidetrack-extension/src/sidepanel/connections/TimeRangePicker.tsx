import { useEffect, useRef, useState, type ReactElement } from 'react';

import type { ConnectionEdge, ConnectionNode } from './types';

// Stage 5 polish — Connections time-range filter. Shortcut pills
// (1h / 24h / 7d / 30d / All) for the common windows, plus a
// "Custom…" popover with start/end `datetime-local` inputs for
// the long tail. Both are client-side over the loaded subgraph;
// no companion route change required.
//
// Range shape:
//   { kind: 'all' }                                       — no filter
//   { kind: 'preset', preset: '1h'|'24h'|'7d'|'30d' }     — rolling window
//   { kind: 'custom', startMs: number, endMs: number }    — absolute span

export type TimeRangePreset = '1h' | '24h' | '7d' | '30d';

export type TimeRangeValue =
  | { readonly kind: 'all' }
  | { readonly kind: 'preset'; readonly preset: TimeRangePreset }
  | { readonly kind: 'custom'; readonly startMs: number; readonly endMs: number };

export const ALL_RANGE: TimeRangeValue = { kind: 'all' };

const PRESET_LABELS: Record<TimeRangePreset, string> = {
  '1h': '1h',
  '24h': '24h',
  '7d': '7d',
  '30d': '30d',
};

const PRESET_MS: Record<TimeRangePreset, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

// Lossy ISO ↔ datetime-local string conversion. <input type="datetime-local">
// wants YYYY-MM-DDTHH:MM (no seconds, no Z); the user's input is treated as
// local time, then we convert to UTC ms for the filter.
const isoToInputLocal = (ms: number): string => {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const inputLocalToMs = (value: string): number | null => {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

export interface TimeRangePickerProps {
  readonly value: TimeRangeValue;
  readonly onChange: (next: TimeRangeValue) => void;
  readonly hiddenNodeCount?: number;
  readonly nowMs?: number;
}

export const TimeRangePicker = ({
  value,
  onChange,
  hiddenNodeCount,
  nowMs,
}: TimeRangePickerProps): ReactElement => {
  const [popoverOpen, setPopoverOpen] = useState<boolean>(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const referenceMs = nowMs ?? Date.now();

  // Draft state for the custom popover. Pre-fill from the current
  // value when it's already custom; otherwise default to the last
  // 24h so the user has a sensible starting range.
  const initialDraft = useRef<{ startMs: number; endMs: number }>({
    startMs: value.kind === 'custom' ? value.startMs : referenceMs - PRESET_MS['24h'],
    endMs: value.kind === 'custom' ? value.endMs : referenceMs,
  });
  const [draftStart, setDraftStart] = useState<string>(
    isoToInputLocal(initialDraft.current.startMs),
  );
  const [draftEnd, setDraftEnd] = useState<string>(isoToInputLocal(initialDraft.current.endMs));
  const [draftError, setDraftError] = useState<string | null>(null);

  // Close the popover when the user clicks outside it.
  useEffect(() => {
    if (!popoverOpen) return;
    const handler = (event: MouseEvent): void => {
      if (popoverRef.current === null) return;
      if (event.target instanceof Node && popoverRef.current.contains(event.target)) return;
      setPopoverOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => {
      window.removeEventListener('mousedown', handler);
    };
  }, [popoverOpen]);

  const isCustom = value.kind === 'custom';
  const isAll = value.kind === 'all';
  const activePreset = value.kind === 'preset' ? value.preset : null;

  const applyCustom = (): void => {
    const startMs = inputLocalToMs(draftStart);
    const endMs = inputLocalToMs(draftEnd);
    if (startMs === null || endMs === null) {
      setDraftError('Pick a valid start and end.');
      return;
    }
    if (startMs >= endMs) {
      setDraftError('Start must be before end.');
      return;
    }
    setDraftError(null);
    setPopoverOpen(false);
    onChange({ kind: 'custom', startMs, endMs });
  };

  return (
    <div className="cx-pill-group cx-timerange" role="group" aria-label="Time range">
      <button
        type="button"
        className={`cx-pill ${isAll ? 'is-active' : ''}`}
        onClick={() => {
          onChange(ALL_RANGE);
        }}
        data-testid="connections-timerange-all"
        title="Show everything in the loaded subgraph"
      >
        All
      </button>
      {(['1h', '24h', '7d', '30d'] as readonly TimeRangePreset[]).map((preset) => (
        <button
          key={preset}
          type="button"
          className={`cx-pill ${activePreset === preset ? 'is-active' : ''}`}
          onClick={() => {
            onChange({ kind: 'preset', preset });
          }}
          data-testid={`connections-timerange-${preset}`}
          title={`Hide nodes whose last activity is older than ${PRESET_LABELS[preset]}`}
        >
          {PRESET_LABELS[preset]}
        </button>
      ))}
      <button
        type="button"
        className={`cx-pill ${isCustom ? 'is-active' : ''}`}
        onClick={() => {
          setPopoverOpen((prev) => !prev);
        }}
        aria-haspopup="dialog"
        aria-expanded={popoverOpen}
        data-testid="connections-timerange-custom"
        title="Pick an exact start and end"
      >
        Custom…
      </button>
      {value.kind === 'custom' ? (
        <span className="cx-timerange-active mono" data-testid="connections-timerange-custom-label">
          {isoToInputLocal(value.startMs)} – {isoToInputLocal(value.endMs)}
        </span>
      ) : null}
      {!isAll && hiddenNodeCount !== undefined && hiddenNodeCount > 0 ? (
        <span className="cx-timerange-hidden mono" data-testid="connections-timerange-hidden">
          −{hiddenNodeCount}
        </span>
      ) : null}
      {popoverOpen ? (
        <div
          className="cx-timerange-popover"
          role="dialog"
          aria-label="Custom time range"
          ref={popoverRef}
          data-testid="connections-timerange-popover"
        >
          <label className="cx-timerange-field">
            <span>Start</span>
            <input
              type="datetime-local"
              value={draftStart}
              onChange={(event) => {
                setDraftStart(event.target.value);
                setDraftError(null);
              }}
              data-testid="connections-timerange-start"
            />
          </label>
          <label className="cx-timerange-field">
            <span>End</span>
            <input
              type="datetime-local"
              value={draftEnd}
              onChange={(event) => {
                setDraftEnd(event.target.value);
                setDraftError(null);
              }}
              data-testid="connections-timerange-end"
            />
          </label>
          {draftError !== null ? (
            <div className="cx-timerange-error" data-testid="connections-timerange-error">
              {draftError}
            </div>
          ) : null}
          <div className="cx-timerange-actions">
            <button
              type="button"
              className="cx-pill"
              onClick={() => {
                setPopoverOpen(false);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="cx-pill is-active"
              onClick={applyCustom}
              data-testid="connections-timerange-apply"
            >
              Apply
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
};

// Filter helper — equivalent in spirit to the older
// `filterByTimeRange` but operating on the richer TimeRangeValue.
// Re-exported alongside the new shape so consumers can keep using
// a single import for the filter math.
export interface FilteredSubgraph {
  readonly nodes: readonly ConnectionNode[];
  readonly edges: readonly ConnectionEdge[];
  readonly hiddenNodeCount: number;
  readonly hiddenEdgeCount: number;
}

export const filterByTimeRange = (
  nodes: readonly ConnectionNode[],
  edges: readonly ConnectionEdge[],
  range: TimeRangeValue,
  options: { readonly nowMs?: number; readonly anchorId?: string } = {},
): FilteredSubgraph => {
  if (range.kind === 'all') {
    return { nodes, edges, hiddenNodeCount: 0, hiddenEdgeCount: 0 };
  }
  const now = options.nowMs ?? Date.now();
  const window =
    range.kind === 'preset'
      ? { startMs: now - PRESET_MS[range.preset], endMs: now }
      : { startMs: range.startMs, endMs: range.endMs };
  const kept = new Set<string>();
  if (options.anchorId !== undefined) kept.add(options.anchorId);
  for (const node of nodes) {
    if (node.id === options.anchorId) continue;
    const ts = node.lastSeenAt ?? node.firstSeenAt;
    if (ts === undefined || ts === null) {
      kept.add(node.id);
      continue;
    }
    const parsed = Date.parse(ts);
    if (Number.isFinite(parsed) && parsed >= window.startMs && parsed <= window.endMs) {
      kept.add(node.id);
    }
  }
  const keptNodes = nodes.filter((n) => kept.has(n.id));
  const keptEdges = edges.filter((e) => kept.has(e.fromNodeId) && kept.has(e.toNodeId));
  return {
    nodes: keptNodes,
    edges: keptEdges,
    hiddenNodeCount: nodes.length - keptNodes.length,
    hiddenEdgeCount: edges.length - keptEdges.length,
  };
};
