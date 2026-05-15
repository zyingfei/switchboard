import { useCallback, useState } from 'react';

// Stage 5 polish — Connections refactor (Phase C usability).
// Browser-style back/forward navigation across anchor changes so the
// user can drill into a neighbor, then return to the previous
// anchor without re-typing or hunting through the recent-anchor
// quick-pick.
//
// State model: `past` is a stack of older anchors (most recent at
// the end), `current` is what's being viewed, `future` is the
// redo stack populated by back() and consumed by forward().

export interface AnchorHistory {
  readonly current: string;
  readonly canBack: boolean;
  readonly canForward: boolean;
  // Distinct anchors the user has actually navigated to (most recent
  // first, current excluded). This is the *honest* recent-anchor
  // history — driven by clicks/navigation — as opposed to the
  // thread/workstream shortcut list the host passes in as a prop.
  readonly recent: readonly string[];
  readonly navigate: (next: string) => void;
  readonly back: () => void;
  readonly forward: () => void;
}

export const useAnchorHistory = (initial: string): AnchorHistory => {
  const [past, setPast] = useState<readonly string[]>([]);
  const [current, setCurrent] = useState<string>(initial);
  const [future, setFuture] = useState<readonly string[]>([]);

  const navigate = useCallback(
    (next: string): void => {
      if (next === current) return;
      // Pushing a new anchor onto the history wipes the redo stack —
      // mirrors browser semantics. Same-value navigation is treated
      // as a no-op so accidental re-clicks don't pollute history.
      setPast((p) => (current.length === 0 ? p : [...p, current]));
      setFuture([]);
      setCurrent(next);
    },
    [current],
  );

  const back = useCallback((): void => {
    setPast((p) => {
      if (p.length === 0) return p;
      const previous = p[p.length - 1] as string;
      setFuture((f) => (current.length === 0 ? f : [current, ...f]));
      setCurrent(previous);
      return p.slice(0, -1);
    });
  }, [current]);

  const forward = useCallback((): void => {
    setFuture((f) => {
      if (f.length === 0) return f;
      const next = f[0] as string;
      setPast((p) => (current.length === 0 ? p : [...p, current]));
      setCurrent(next);
      return f.slice(1);
    });
  }, [current]);

  // `past` is [oldest … newest-previous]; reverse so the rail shows
  // the most recently visited anchor first. Dedupe and drop the
  // current anchor + empties; cap so the rail stays compact.
  const recent = ((): readonly string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const a of [...past].reverse()) {
      if (a.length === 0 || a === current || seen.has(a)) continue;
      seen.add(a);
      out.push(a);
      if (out.length >= 8) break;
    }
    return out;
  })();

  return {
    current,
    canBack: past.length > 0,
    canForward: future.length > 0,
    recent,
    navigate,
    back,
    forward,
  };
};
