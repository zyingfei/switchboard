export interface EngagementTotals {
  readonly activeMs: number;
  readonly visibleMs: number;
  readonly focusedWindowMs: number;
  readonly idleMs: number;
  readonly foregroundBursts: number;
  readonly returnCount: number;
  readonly scrollEvents: number;
  readonly maxScrollRatio: number;
  readonly copyCount: number;
  readonly pasteCount: number;
}

export interface EngagementIntervalMessage {
  readonly type: 'sidetrack.engagement.interval';
  readonly version: 1;
  readonly visitId: string;
  readonly intervalStart: number;
  readonly intervalEnd: number;
  readonly final: boolean;
  readonly dimensions: {
    readonly engagement: EngagementTotals;
  };
}

export const emptyEngagementTotals = (): EngagementTotals => ({
  activeMs: 0,
  visibleMs: 0,
  focusedWindowMs: 0,
  idleMs: 0,
  foregroundBursts: 0,
  returnCount: 0,
  scrollEvents: 0,
  maxScrollRatio: 0,
  copyCount: 0,
  pasteCount: 0,
});

const clampRatio = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
};

export const mergeEngagementTotals = (
  left: EngagementTotals,
  right: EngagementTotals,
): EngagementTotals => ({
  activeMs: left.activeMs + right.activeMs,
  visibleMs: left.visibleMs + right.visibleMs,
  focusedWindowMs: left.focusedWindowMs + right.focusedWindowMs,
  idleMs: left.idleMs + right.idleMs,
  foregroundBursts: left.foregroundBursts + right.foregroundBursts,
  returnCount: left.returnCount + right.returnCount,
  scrollEvents: left.scrollEvents + right.scrollEvents,
  maxScrollRatio: Math.max(clampRatio(left.maxScrollRatio), clampRatio(right.maxScrollRatio)),
  copyCount: left.copyCount + right.copyCount,
  pasteCount: left.pasteCount + right.pasteCount,
});

interface AggregatorState {
  intervalStart: number;
  lastTick: number;
  visible: boolean;
  focused: boolean;
  idle: boolean;
  totals: EngagementTotals;
}

export interface EngagementAggregator {
  readonly setVisible: (visible: boolean, atMs?: number) => void;
  readonly setFocused: (focused: boolean, atMs?: number) => void;
  readonly setIdle: (idle: boolean, atMs?: number) => void;
  readonly recordScroll: (ratio: number, atMs?: number) => void;
  readonly recordCopy: (atMs?: number) => void;
  readonly recordPaste: (atMs?: number) => void;
  readonly snapshot: (final: boolean, atMs?: number) => EngagementIntervalMessage;
}

export const createEngagementAggregator = (input: {
  readonly visitId: string;
  readonly now: () => number;
  readonly visible: boolean;
  readonly focused: boolean;
  readonly idle?: boolean;
}): EngagementAggregator => {
  const initialNow = input.now();
  const state: AggregatorState = {
    intervalStart: initialNow,
    lastTick: initialNow,
    visible: input.visible,
    focused: input.focused,
    idle: input.idle ?? false,
    totals: {
      ...emptyEngagementTotals(),
      foregroundBursts: input.visible && input.focused ? 1 : 0,
    },
  };

  const accrue = (atMs = input.now()): void => {
    const delta = Math.max(0, atMs - state.lastTick);
    if (delta === 0) return;
    const active = state.visible && state.focused && !state.idle;
    state.totals = {
      ...state.totals,
      activeMs: state.totals.activeMs + (active ? delta : 0),
      visibleMs: state.totals.visibleMs + (state.visible ? delta : 0),
      focusedWindowMs: state.totals.focusedWindowMs + (state.focused ? delta : 0),
      idleMs: state.totals.idleMs + (state.idle ? delta : 0),
    };
    state.lastTick = atMs;
  };

  const snapshot = (final: boolean, atMs = input.now()): EngagementIntervalMessage => {
    accrue(atMs);
    return {
      type: 'sidetrack.engagement.interval',
      version: 1,
      visitId: input.visitId,
      intervalStart: state.intervalStart,
      intervalEnd: atMs,
      final,
      dimensions: { engagement: state.totals },
    };
  };

  return {
    setVisible(visible, atMs) {
      accrue(atMs);
      if (!state.visible && visible) {
        state.totals = {
          ...state.totals,
          foregroundBursts: state.totals.foregroundBursts + (state.focused ? 1 : 0),
          returnCount: state.totals.returnCount + 1,
        };
      }
      state.visible = visible;
    },
    setFocused(focused, atMs) {
      accrue(atMs);
      if (!state.focused && focused && state.visible) {
        state.totals = {
          ...state.totals,
          foregroundBursts: state.totals.foregroundBursts + 1,
          returnCount: state.totals.returnCount + 1,
        };
      }
      state.focused = focused;
    },
    setIdle(idle, atMs) {
      accrue(atMs);
      state.idle = idle;
    },
    recordScroll(ratio, atMs) {
      accrue(atMs);
      state.totals = {
        ...state.totals,
        scrollEvents: state.totals.scrollEvents + 1,
        maxScrollRatio: Math.max(state.totals.maxScrollRatio, clampRatio(ratio)),
      };
    },
    recordCopy(atMs) {
      accrue(atMs);
      state.totals = { ...state.totals, copyCount: state.totals.copyCount + 1 };
    },
    recordPaste(atMs) {
      accrue(atMs);
      state.totals = { ...state.totals, pasteCount: state.totals.pasteCount + 1 };
    },
    snapshot,
  };
};
