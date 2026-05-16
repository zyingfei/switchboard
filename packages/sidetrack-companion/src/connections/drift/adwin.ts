// Connections drift layer — ADWIN (ADaptive WINdowing) change detector.
//
// ADWIN maintains a variable-length window of the most recent stream
// values. After every observation it looks for a split point where the
// means of the two resulting sub-windows differ by more than a
// statistically justified bound (a Hoeffding-style inequality with a
// Bonferroni-style correction for the number of tested cut points). If
// such a split exists the older sub-window is dropped: the window has
// "adapted" to the new regime and a drift is reported.
//
// Reference: Bifet & Gavaldà, "Learning from Time-Changing Data with
// Adaptive Windowing", SDM 2007. This is the bucketed (ADWIN2) variant
// using exponential histograms so memory stays logarithmic in the
// window length. The implementation is pure and deterministic: no
// clocks, no randomness, no I/O. State is fully serializable so the
// monitor can persist/restore detectors across drains.

const DEFAULT_DELTA = 0.002;
// Max buckets per exponential-histogram row before the two oldest are
// merged. 5 is the value used by the reference MOA implementation.
const MAX_BUCKETS = 5;

export interface AdwinResult {
  /** True on the observation that collapsed the window (regime change). */
  readonly drift: boolean;
  /**
   * ADWIN has no separate warning band — it only signals confirmed
   * change. Kept for API symmetry with KSWIN so the monitor can treat
   * detectors uniformly. Always false.
   */
  readonly warning: false;
}

interface Bucket {
  // Sum of the values folded into this bucket.
  sum: number;
  // Sum of squared deviations carried for variance tracking.
  variance: number;
}

interface BucketRow {
  // Buckets in this row, newest last. Every bucket in row `i` covers
  // 2**i original observations.
  buckets: Bucket[];
}

export interface AdwinState {
  readonly delta: number;
  readonly rows: readonly {
    readonly buckets: readonly { readonly sum: number; readonly variance: number }[];
  }[];
  readonly width: number;
  readonly total: number;
  readonly variance: number;
}

const bucketSize = (rowIndex: number): number => 2 ** rowIndex;

export class Adwin {
  private readonly delta: number;
  private rows: BucketRow[] = [];
  private width = 0;
  private total = 0;
  private variance = 0;

  constructor(options: { readonly delta?: number } = {}) {
    const delta = options.delta ?? DEFAULT_DELTA;
    if (!Number.isFinite(delta) || delta <= 0 || delta >= 1) {
      throw new RangeError(`Adwin delta must be in (0, 1), received ${String(delta)}`);
    }
    this.delta = delta;
  }

  /** Number of observations currently retained in the adaptive window. */
  get windowWidth(): number {
    return this.width;
  }

  /** Running mean of the retained window (0 when empty). */
  get mean(): number {
    return this.width === 0 ? 0 : this.total / this.width;
  }

  /**
   * Feed one observation. Returns whether the window collapsed
   * (`drift`) on this step. Non-finite inputs are ignored (treated as a
   * gap) so a single NaN in a diagnostic series can never wedge the
   * detector or fabricate a change.
   */
  update(value: number): AdwinResult {
    if (!Number.isFinite(value)) return { drift: false, warning: false };
    this.insert(value);
    const drift = this.compress();
    return { drift, warning: false };
  }

  private rowAt(rowIndex: number): BucketRow {
    let row = this.rows[rowIndex];
    if (row === undefined) {
      row = { buckets: [] };
      this.rows[rowIndex] = row;
    }
    return row;
  }

  private insert(value: number): void {
    const incrementalVariance =
      this.width === 0
        ? 0
        : (this.width * (value - this.total / this.width) ** 2) / (this.width + 1);
    this.rowAt(0).buckets.push({ sum: value, variance: 0 });
    this.width += 1;
    this.total += value;
    this.variance += incrementalVariance;
    this.compressBuckets();
  }

  // Merge overflowing buckets so each row holds at most MAX_BUCKETS.
  private compressBuckets(): void {
    for (let rowIndex = 0; rowIndex < this.rows.length; rowIndex += 1) {
      const row = this.rowAt(rowIndex);
      if (row.buckets.length <= MAX_BUCKETS) break;
      const left = row.buckets.shift();
      const right = row.buckets.shift();
      if (left === undefined || right === undefined) break;
      const size = bucketSize(rowIndex);
      const meanLeft = left.sum / size;
      const meanRight = right.sum / size;
      const merged: Bucket = {
        sum: left.sum + right.sum,
        variance:
          left.variance +
          right.variance +
          (size * size * (meanLeft - meanRight) ** 2) / (size + size),
      };
      this.rowAt(rowIndex + 1).buckets.push(merged);
    }
  }

  // Hoeffding-with-variance bound (the "ADWIN2" cut test). `n0`/`n1`
  // are the sub-window widths, `u0`/`u1` their sums.
  private cutExpression(n0: number, n1: number, u0: number, u1: number): boolean {
    const n = this.width;
    const diff = u0 / n0 - u1 / n1;
    // Harmonic window size with the +1 guard from the reference impl.
    const m = 1 / (n0 - 1 + 1) + 1 / (n1 - 1 + 1);
    // Bonferroni-style correction: log over the total window.
    const deltaPrime = Math.log((2 * Math.log(n)) / this.delta);
    const v = this.variance / n;
    const epsilon = Math.sqrt(2 * m * v * deltaPrime) + (2 / 3) * deltaPrime * m;
    return Math.abs(diff) > epsilon;
  }

  // Walk every bucket boundary from the oldest side; if any boundary is
  // a valid cut, drop the older partition and report a change. Repeats
  // until no further cut is found (a single observation can invalidate
  // more than one stale bucket).
  private compress(): boolean {
    let changed = false;
    let reduced = true;
    while (reduced) {
      reduced = false;
      let n0 = 0;
      let u0 = 0;
      // Iterate buckets oldest -> newest across all rows.
      outer: for (let rowIndex = this.rows.length - 1; rowIndex >= 0; rowIndex -= 1) {
        const row = this.rowAt(rowIndex);
        const size = bucketSize(rowIndex);
        for (const bucket of row.buckets) {
          n0 += size;
          u0 += bucket.sum;
          const n1 = this.width - n0;
          const u1 = this.total - u0;
          if (n0 === 0 || n1 === 0) continue;
          if (this.cutExpression(n0, n1, u0, u1)) {
            changed = true;
            reduced = true;
            this.dropOldest();
            break outer;
          }
        }
      }
    }
    return changed;
  }

  // Remove the single oldest bucket (drops 2**rowIndex observations).
  private dropOldest(): void {
    for (let rowIndex = this.rows.length - 1; rowIndex >= 0; rowIndex -= 1) {
      const row = this.rowAt(rowIndex);
      const bucket = row.buckets.shift();
      if (bucket === undefined) continue;
      const size = bucketSize(rowIndex);
      const meanBucket = bucket.sum / size;
      const remainingWidth = this.width - size;
      const meanRemaining = remainingWidth === 0 ? 0 : (this.total - bucket.sum) / remainingWidth;
      this.width -= size;
      this.total -= bucket.sum;
      this.variance -=
        bucket.variance +
        (remainingWidth === 0
          ? 0
          : (size * remainingWidth * (meanBucket - meanRemaining) ** 2) / (size + remainingWidth));
      if (this.variance < 0) this.variance = 0;
      return;
    }
  }

  /** Serialize for cross-drain persistence. */
  toState(): AdwinState {
    return {
      delta: this.delta,
      rows: this.rows.map((row) => ({
        buckets: row.buckets.map((bucket) => ({
          sum: bucket.sum,
          variance: bucket.variance,
        })),
      })),
      width: this.width,
      total: this.total,
      variance: this.variance,
    };
  }

  /**
   * Restore from a previously serialized state. Unknown / malformed
   * input falls back to a fresh detector with the supplied delta so a
   * corrupt persisted blob never throws into the drain.
   */
  static fromState(state: unknown): Adwin {
    if (!isAdwinState(state)) return new Adwin();
    const adwin = new Adwin({ delta: state.delta });
    adwin.rows = state.rows.map((row) => ({
      buckets: row.buckets.map((bucket) => ({
        sum: bucket.sum,
        variance: bucket.variance,
      })),
    }));
    adwin.width = state.width;
    adwin.total = state.total;
    adwin.variance = state.variance;
    return adwin;
  }
}

const isAdwinState = (value: unknown): value is AdwinState => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate['delta'] !== 'number' ||
    !Number.isFinite(candidate['delta']) ||
    candidate['delta'] <= 0 ||
    candidate['delta'] >= 1
  ) {
    return false;
  }
  if (
    typeof candidate['width'] !== 'number' ||
    typeof candidate['total'] !== 'number' ||
    typeof candidate['variance'] !== 'number'
  ) {
    return false;
  }
  const rows = candidate['rows'];
  if (!Array.isArray(rows)) return false;
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) return false;
    const buckets = (row as Record<string, unknown>)['buckets'];
    if (!Array.isArray(buckets)) return false;
    for (const bucket of buckets) {
      if (typeof bucket !== 'object' || bucket === null) return false;
      const b = bucket as Record<string, unknown>;
      if (typeof b['sum'] !== 'number' || typeof b['variance'] !== 'number') return false;
    }
  }
  return true;
};
