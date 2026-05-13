import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import type { ConnectionEdge, ConnectionNode } from './types';

// Stage 5 polish — Connections time-range filter. Inline pill bar
// for the common windows + a "Custom…" calendar popover that
// matches the design mockup:
//   - Month calendar with prev/next navigation
//   - Start + End fields (date + time, separate)
//   - Quick-select column (Last 15 min, Last hour, Today,
//     Yesterday, Last 7 days, Last 30 days, All time)
//   - Local timezone indicator
//   - Apply + Cancel
//
// All math is in epoch ms; rendering uses the browser's local
// timezone (we display UTC offset for clarity).

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

const pad2 = (n: number): string => String(n).padStart(2, '0');

const startOfLocalDay = (ms: number): number => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
};

const endOfLocalDay = (ms: number): number => startOfLocalDay(ms) + 24 * 60 * 60 * 1000 - 1;

const isoToInputTime = (ms: number): string => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

const inputTimeToMsOnDate = (date: Date, hhmm: string): number | null => {
  const [hStr, mStr] = hhmm.split(':');
  const h = Number.parseInt(hStr ?? '', 10);
  const m = Number.parseInt(mStr ?? '', 10);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, m, 0, 0).getTime();
};

const localDateLabel = (ms: number): string => {
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
};

const localTimeLabel = (ms: number): string => {
  const d = new Date(ms);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
};

const localTimezoneLabel = (): string => {
  // Resolved IANA name + signed UTC offset for clarity. Example:
  // "Local · Asia/Tokyo (UTC+9)".
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const offset = -new Date().getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '−';
    const hours = Math.floor(Math.abs(offset) / 60);
    const mins = Math.abs(offset) % 60;
    const offsetStr = mins === 0 ? `${sign}${String(hours)}` : `${sign}${String(hours)}:${pad2(mins)}`;
    return `Local · ${tz} (UTC${offsetStr})`;
  } catch {
    return 'Local time';
  }
};

const isSameLocalDay = (a: number, b: number): boolean =>
  startOfLocalDay(a) === startOfLocalDay(b);

interface CalendarMonth {
  readonly year: number;
  readonly month: number; // 0-11
  readonly weeks: readonly (readonly { readonly ms: number; readonly day: number; readonly otherMonth: boolean }[])[];
}

const buildCalendarMonth = (year: number, month: number): CalendarMonth => {
  // Monday-first week (matches the mockup). getDay() returns
  // 0 (Sun) – 6 (Sat); shift so Monday=0.
  const firstOfMonth = new Date(year, month, 1);
  const offsetFromMonday = (firstOfMonth.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - offsetFromMonday);
  const weeks: { ms: number; day: number; otherMonth: boolean }[][] = [];
  for (let w = 0; w < 6; w += 1) {
    const row: { ms: number; day: number; otherMonth: boolean }[] = [];
    for (let d = 0; d < 7; d += 1) {
      const cell = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + d);
      row.push({
        ms: cell.getTime(),
        day: cell.getDate(),
        otherMonth: cell.getMonth() !== month,
      });
    }
    weeks.push(row);
  }
  return { year, month, weeks };
};

export interface TimeRangePickerProps {
  readonly value: TimeRangeValue;
  readonly onChange: (next: TimeRangeValue) => void;
  readonly hiddenNodeCount?: number;
  readonly nowMs?: number;
}

const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

export const TimeRangePicker = ({
  value,
  onChange,
  hiddenNodeCount,
  nowMs,
}: TimeRangePickerProps): ReactElement => {
  const [popoverOpen, setPopoverOpen] = useState<boolean>(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const referenceMs = nowMs ?? Date.now();

  // Draft state for the custom popover.
  const draftSeed = useMemo(() => {
    if (value.kind === 'custom') {
      return { startMs: value.startMs, endMs: value.endMs };
    }
    return { startMs: referenceMs - PRESET_MS['24h'], endMs: referenceMs };
  }, [referenceMs, value]);
  const [draftStart, setDraftStart] = useState<number>(draftSeed.startMs);
  const [draftEnd, setDraftEnd] = useState<number>(draftSeed.endMs);
  const [draftError, setDraftError] = useState<string | null>(null);
  // Visible month on the calendar — defaults to the end's month.
  const [visibleMonth, setVisibleMonth] = useState<{ year: number; month: number }>(() => {
    const d = new Date(draftSeed.endMs);
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  // Reset drafts every time the popover opens so re-opening after
  // an Apply doesn't carry stale state.
  useEffect(() => {
    if (!popoverOpen) return;
    setDraftStart(draftSeed.startMs);
    setDraftEnd(draftSeed.endMs);
    const d = new Date(draftSeed.endMs);
    setVisibleMonth({ year: d.getFullYear(), month: d.getMonth() });
    setDraftError(null);
  }, [popoverOpen, draftSeed]);

  // Click-outside dismiss.
  useEffect(() => {
    if (!popoverOpen) return;
    const onClick = (event: MouseEvent): void => {
      if (popoverRef.current === null) return;
      if (event.target instanceof Node && popoverRef.current.contains(event.target)) return;
      setPopoverOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('mousedown', onClick);
    };
  }, [popoverOpen]);

  const isCustom = value.kind === 'custom';
  const isAll = value.kind === 'all';
  const activePreset = value.kind === 'preset' ? value.preset : null;

  const month = useMemo(
    () => buildCalendarMonth(visibleMonth.year, visibleMonth.month),
    [visibleMonth.year, visibleMonth.month],
  );

  const stepMonth = (delta: number): void => {
    const d = new Date(visibleMonth.year, visibleMonth.month + delta, 1);
    setVisibleMonth({ year: d.getFullYear(), month: d.getMonth() });
  };

  const handleCellClick = (cellMs: number): void => {
    // Two-click selection: if the user hasn't moved start yet OR
    // the cell is before draftStart, treat as a new start. Otherwise
    // treat as the end.
    const cellStart = startOfLocalDay(cellMs);
    if (draftStart === draftSeed.startMs && draftEnd === draftSeed.endMs) {
      // Fresh range: set start at the cell, keep the current end's
      // time on the same day so a single click means "this day's
      // start to now".
      setDraftStart(cellStart);
      setDraftError(null);
      return;
    }
    if (cellStart < startOfLocalDay(draftStart)) {
      setDraftStart(cellStart);
      setDraftError(null);
      return;
    }
    // Otherwise set end to the cell + the current end time-of-day.
    const endTimeStr = isoToInputTime(draftEnd);
    const cellAsEnd = inputTimeToMsOnDate(new Date(cellMs), endTimeStr) ?? cellStart;
    if (cellAsEnd < draftStart) {
      setDraftStart(cellStart);
    } else {
      setDraftEnd(cellAsEnd);
    }
    setDraftError(null);
  };

  const applyQuickSelect = (kind: 'last-15-min' | 'last-hour' | 'today' | 'yesterday' | 'last-7-days' | 'last-30-days' | 'all-time'): void => {
    if (kind === 'all-time') {
      onChange(ALL_RANGE);
      setPopoverOpen(false);
      return;
    }
    const now = referenceMs;
    let startMs: number;
    let endMs = now;
    switch (kind) {
      case 'last-15-min':
        startMs = now - 15 * 60 * 1000;
        break;
      case 'last-hour':
        startMs = now - 60 * 60 * 1000;
        break;
      case 'today':
        startMs = startOfLocalDay(now);
        break;
      case 'yesterday':
        startMs = startOfLocalDay(now) - 24 * 60 * 60 * 1000;
        endMs = startOfLocalDay(now) - 1;
        break;
      case 'last-7-days':
        startMs = now - 7 * 24 * 60 * 60 * 1000;
        break;
      case 'last-30-days':
        startMs = now - 30 * 24 * 60 * 60 * 1000;
        break;
    }
    onChange({ kind: 'custom', startMs, endMs });
    setPopoverOpen(false);
  };

  const applyCustom = (): void => {
    if (draftStart >= draftEnd) {
      setDraftError('Start must be before end.');
      return;
    }
    setPopoverOpen(false);
    onChange({ kind: 'custom', startMs: draftStart, endMs: draftEnd });
  };

  const startDate = new Date(draftStart);
  const endDate = new Date(draftEnd);

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
          {localDateLabel(value.startMs)} {localTimeLabel(value.startMs)} – {localDateLabel(value.endMs)} {localTimeLabel(value.endMs)}
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
          {/* Left column — calendar */}
          <div className="cx-cal">
            <div className="cx-cal-head">
              <button
                type="button"
                className="cx-cal-nav"
                onClick={() => {
                  stepMonth(-1);
                }}
                aria-label="Previous month"
                data-testid="connections-timerange-prev-month"
              >
                ‹
              </button>
              <div className="cx-cal-title">
                {MONTH_LABELS[month.month]} {String(month.year)}
              </div>
              <button
                type="button"
                className="cx-cal-nav"
                onClick={() => {
                  stepMonth(1);
                }}
                aria-label="Next month"
                data-testid="connections-timerange-next-month"
              >
                ›
              </button>
            </div>
            <div className="cx-cal-weekrow">
              {WEEKDAYS.map((w) => (
                <span key={w} className="cx-cal-weekday">
                  {w}
                </span>
              ))}
            </div>
            <div className="cx-cal-grid">
              {month.weeks.flat().map((cell) => {
                const isStart = isSameLocalDay(cell.ms, draftStart);
                const isEnd = isSameLocalDay(cell.ms, draftEnd);
                const isInRange =
                  cell.ms >= startOfLocalDay(draftStart) &&
                  cell.ms <= startOfLocalDay(draftEnd);
                const isToday = isSameLocalDay(cell.ms, referenceMs);
                const cls = [
                  'cx-cal-cell',
                  cell.otherMonth ? 'is-other-month' : '',
                  isInRange ? 'is-in-range' : '',
                  isStart || isEnd ? 'is-endpoint' : '',
                  isToday ? 'is-today' : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                return (
                  <button
                    key={cell.ms}
                    type="button"
                    className={cls}
                    onClick={() => {
                      handleCellClick(cell.ms);
                    }}
                    data-testid={`connections-timerange-day-${cell.ms}`}
                  >
                    {cell.day}
                  </button>
                );
              })}
            </div>
            <div className="cx-cal-tz mono" data-testid="connections-timerange-tz">
              <span aria-hidden>🕒</span> {localTimezoneLabel()}
            </div>
          </div>
          {/* Right column — start/end + quick select + actions */}
          <div className="cx-cal-side">
            <div className="cx-cal-section">
              <div className="cx-cal-section-head mono">Start</div>
              <div className="cx-cal-row">
                <input
                  type="date"
                  className="cx-cal-input"
                  value={`${String(startDate.getFullYear())}-${pad2(startDate.getMonth() + 1)}-${pad2(startDate.getDate())}`}
                  onChange={(event) => {
                    const next = Date.parse(event.target.value);
                    if (!Number.isFinite(next)) return;
                    // input type=date parses as UTC; rebuild as local
                    // midnight + keep the existing time-of-day.
                    const d = new Date(event.target.value);
                    const local = new Date(
                      d.getUTCFullYear(),
                      d.getUTCMonth(),
                      d.getUTCDate(),
                      startDate.getHours(),
                      startDate.getMinutes(),
                    );
                    setDraftStart(local.getTime());
                    setDraftError(null);
                  }}
                  data-testid="connections-timerange-start-date"
                />
                <input
                  type="time"
                  className="cx-cal-input"
                  value={`${pad2(startDate.getHours())}:${pad2(startDate.getMinutes())}`}
                  onChange={(event) => {
                    const next = inputTimeToMsOnDate(startDate, event.target.value);
                    if (next !== null) setDraftStart(next);
                    setDraftError(null);
                  }}
                  data-testid="connections-timerange-start-time"
                />
              </div>
            </div>
            <div className="cx-cal-section">
              <div className="cx-cal-section-head mono">End</div>
              <div className="cx-cal-row">
                <input
                  type="date"
                  className="cx-cal-input"
                  value={`${String(endDate.getFullYear())}-${pad2(endDate.getMonth() + 1)}-${pad2(endDate.getDate())}`}
                  onChange={(event) => {
                    const next = Date.parse(event.target.value);
                    if (!Number.isFinite(next)) return;
                    const d = new Date(event.target.value);
                    const local = new Date(
                      d.getUTCFullYear(),
                      d.getUTCMonth(),
                      d.getUTCDate(),
                      endDate.getHours(),
                      endDate.getMinutes(),
                    );
                    setDraftEnd(local.getTime());
                    setDraftError(null);
                  }}
                  data-testid="connections-timerange-end-date"
                />
                <input
                  type="time"
                  className="cx-cal-input"
                  value={`${pad2(endDate.getHours())}:${pad2(endDate.getMinutes())}`}
                  onChange={(event) => {
                    const next = inputTimeToMsOnDate(endDate, event.target.value);
                    if (next !== null) setDraftEnd(next);
                    setDraftError(null);
                  }}
                  data-testid="connections-timerange-end-time"
                />
              </div>
            </div>
            <div className="cx-cal-section">
              <div className="cx-cal-section-head mono">Quick select</div>
              <div className="cx-cal-quickgrid">
                <button
                  type="button"
                  className="cx-cal-quick"
                  onClick={() => {
                    applyQuickSelect('last-15-min');
                  }}
                >
                  Last 15 min
                </button>
                <button
                  type="button"
                  className="cx-cal-quick"
                  onClick={() => {
                    applyQuickSelect('last-hour');
                  }}
                >
                  Last hour
                </button>
                <button
                  type="button"
                  className="cx-cal-quick"
                  onClick={() => {
                    applyQuickSelect('today');
                  }}
                >
                  Today
                </button>
                <button
                  type="button"
                  className="cx-cal-quick"
                  onClick={() => {
                    applyQuickSelect('yesterday');
                  }}
                >
                  Yesterday
                </button>
                <button
                  type="button"
                  className="cx-cal-quick"
                  onClick={() => {
                    applyQuickSelect('last-7-days');
                  }}
                >
                  Last 7 days
                </button>
                <button
                  type="button"
                  className="cx-cal-quick"
                  onClick={() => {
                    applyQuickSelect('last-30-days');
                  }}
                >
                  Last 30 days
                </button>
                <button
                  type="button"
                  className="cx-cal-quick cx-cal-quick-wide"
                  onClick={() => {
                    applyQuickSelect('all-time');
                  }}
                >
                  All time
                </button>
              </div>
            </div>
            {draftError !== null ? (
              <div className="cx-cal-error" data-testid="connections-timerange-error">
                {draftError}
              </div>
            ) : null}
            <div className="cx-cal-actions">
              <button
                type="button"
                className="cx-cal-cancel"
                onClick={() => {
                  setPopoverOpen(false);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="cx-cal-apply"
                onClick={applyCustom}
                data-testid="connections-timerange-apply"
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

// Filter helper — unchanged shape from the previous picker.
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
