// The single relative-time formatter for the extension UI. One shape
// family, two densities: the default long form ("4 min ago") for prose
// surfaces, and { short: true } ("4m ago") for tight chips and metric
// strips. Thresholds and rounding are identical in both — only the unit
// labels compress — so adjacent surfaces never disagree about how old
// the same timestamp is.

export interface FormatRelativeOptions {
  /** Compact unit labels ("4m ago") for chip-sized surfaces. */
  readonly short?: boolean;
  /** Clock override so callers and tests render deterministically. */
  readonly nowMs?: number;
}

export const formatRelative = (isoDate: string, options?: FormatRelativeOptions): string => {
  const then = Date.parse(isoDate);
  if (Number.isNaN(then)) {
    return 'recently';
  }
  const short = options?.short ?? false;
  const now = options?.nowMs ?? Date.now();
  const seconds = Math.max(1, Math.round((now - then) / 1000));
  if (seconds < 60) {
    return short ? `${String(seconds)}s ago` : `${String(seconds)} sec ago`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return short ? `${String(minutes)}m ago` : `${String(minutes)} min ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return short ? `${String(hours)}h ago` : `${String(hours)} hr ago`;
  }
  const days = Math.round(hours / 24);
  return short ? `${String(days)}d ago` : `${String(days)} days ago`;
};
