// Connections drift layer — KSWIN (Kolmogorov–Smirnov WINdowing).
//
// KSWIN keeps the last `windowSize` observations. The most recent
// `statSize` of them form the "recent" sample; a `statSize`-sized
// "reference" sample is drawn deterministically from the older part of
// the window. The two-sample Kolmogorov–Smirnov statistic D (the max
// absolute gap between the two empirical CDFs) is compared against the
// critical value derived from `alpha`. When D exceeds the threshold the
// distributions are judged to differ — a drift — and the window is
// reset to the recent sample so detection can continue from the new
// regime.
//
// Reference: Raab, Heusinger & Schleif, "Reactive Soft Prototype
// Computing for Concept Drift Streams", Neurocomputing 2020 (KSWIN).
//
// Determinism note: the reference implementation samples the reference
// window at random. Random sampling is unacceptable here — the drain
// must be reproducible and detector state is persisted/restored. We
// therefore take an evenly-spaced deterministic subsample of the older
// window instead. This keeps the test power of KSWIN (it still sees a
// representative slice of the pre-window distribution) while making the
// detector a pure function of its input sequence.

// Probability of a Type-I error per KS test. The KSWIN paper uses
// alpha in [0.0001, 0.01]; an *evaluation* layer that flags pipeline
// regressions must not cry wolf, so the default sits at the
// low-false-alarm end. Empirically (see drift test suite) alpha=0.0001
// yields zero false drifts on stationary streams while still detecting
// an abrupt shift within ~16 observations. Callers needing more
// sensitivity can raise it per detector.
const DEFAULT_ALPHA = 0.0001;
const DEFAULT_WINDOW_SIZE = 100;
const DEFAULT_STAT_SIZE = 30;

export interface KswinResult {
  /** True when the KS test rejected "same distribution". */
  readonly drift: boolean;
  /**
   * True when D is within `warningFactor` of the critical value but
   * has not crossed it — an early heads-up the monitor surfaces as a
   * `warning` status before a confirmed `drift`.
   */
  readonly warning: boolean;
}

export interface KswinState {
  readonly alpha: number;
  readonly windowSize: number;
  readonly statSize: number;
  readonly warningFactor: number;
  readonly window: readonly number[];
}

export interface KswinOptions {
  readonly alpha?: number;
  readonly windowSize?: number;
  readonly statSize?: number;
  /**
   * Fraction of the critical value at which a `warning` is raised
   * (default 0.8 → warn once D ≥ 80 % of the drift threshold).
   */
  readonly warningFactor?: number;
}

// Two-sample KS critical value: c(alpha) * sqrt((n + m) / (n * m)).
// c(alpha) = sqrt(-ln(alpha / 2) / 2). With equal sample sizes n = m
// this simplifies to c(alpha) * sqrt(2 / n).
const criticalValue = (alpha: number, n: number, m: number): number => {
  const c = Math.sqrt(-Math.log(alpha / 2) / 2);
  return c * Math.sqrt((n + m) / (n * m));
};

// Exact two-sample KS statistic D = max |F_a(x) - F_b(x)| over the
// merged support. O((n + m) log(n + m)) via a sorted merge walk.
const ksStatistic = (a: readonly number[], b: readonly number[]): number => {
  if (a.length === 0 || b.length === 0) return 0;
  const sortedA = [...a].sort((left, right) => left - right);
  const sortedB = [...b].sort((left, right) => left - right);
  let i = 0;
  let j = 0;
  let d = 0;
  while (i < sortedA.length && j < sortedB.length) {
    const av = sortedA[i] ?? Number.POSITIVE_INFINITY;
    const bv = sortedB[j] ?? Number.POSITIVE_INFINITY;
    if (av <= bv) i += 1;
    if (bv <= av) j += 1;
    const fa = i / sortedA.length;
    const fb = j / sortedB.length;
    const gap = Math.abs(fa - fb);
    if (gap > d) d = gap;
  }
  return d;
};

// Evenly-spaced deterministic subsample of `count` elements from
// `source` (the pre-window history). Preserves the head and tail and
// spreads the rest uniformly so the reference sample reflects the older
// distribution without any randomness.
const deterministicSubsample = (source: readonly number[], count: number): number[] => {
  if (source.length <= count) return [...source];
  const out: number[] = [];
  const step = (source.length - 1) / (count - 1);
  for (let k = 0; k < count; k += 1) {
    const index = Math.min(source.length - 1, Math.round(k * step));
    const value = source[index];
    if (value !== undefined) out.push(value);
  }
  return out;
};

export class Kswin {
  private readonly alpha: number;
  private readonly windowSize: number;
  private readonly statSize: number;
  private readonly warningFactor: number;
  private window: number[] = [];

  constructor(options: KswinOptions = {}) {
    const alpha = options.alpha ?? DEFAULT_ALPHA;
    const windowSize = options.windowSize ?? DEFAULT_WINDOW_SIZE;
    const statSize = options.statSize ?? DEFAULT_STAT_SIZE;
    const warningFactor = options.warningFactor ?? 0.8;
    if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
      throw new RangeError(`Kswin alpha must be in (0, 1), received ${String(alpha)}`);
    }
    if (!Number.isInteger(windowSize) || windowSize <= 0) {
      throw new RangeError(`Kswin windowSize must be a positive integer`);
    }
    if (!Number.isInteger(statSize) || statSize <= 0 || statSize * 2 > windowSize) {
      throw new RangeError(
        `Kswin statSize must be a positive integer with 2*statSize <= windowSize`,
      );
    }
    if (!Number.isFinite(warningFactor) || warningFactor <= 0 || warningFactor >= 1) {
      throw new RangeError(`Kswin warningFactor must be in (0, 1)`);
    }
    this.alpha = alpha;
    this.windowSize = windowSize;
    this.statSize = statSize;
    this.warningFactor = warningFactor;
  }

  /** Observations currently retained. */
  get windowWidth(): number {
    return this.window.length;
  }

  /**
   * Feed one observation. Until the window is full no test is run
   * (`drift` and `warning` both false). Non-finite inputs are skipped
   * so a single NaN cannot corrupt the empirical CDF or trip a change.
   */
  update(value: number): KswinResult {
    if (!Number.isFinite(value)) return { drift: false, warning: false };
    this.window.push(value);
    if (this.window.length > this.windowSize) this.window.shift();
    if (this.window.length < this.windowSize) {
      return { drift: false, warning: false };
    }
    const recent = this.window.slice(this.window.length - this.statSize);
    const older = this.window.slice(0, this.window.length - this.statSize);
    const reference = deterministicSubsample(older, this.statSize);
    const d = ksStatistic(reference, recent);
    const critical = criticalValue(this.alpha, reference.length, recent.length);
    if (d > critical) {
      // Reset to the recent sample: continue detecting from the new
      // regime instead of re-flagging the same shift every step.
      this.window = recent;
      return { drift: true, warning: false };
    }
    return { drift: false, warning: d >= critical * this.warningFactor };
  }

  /** Serialize for cross-drain persistence. */
  toState(): KswinState {
    return {
      alpha: this.alpha,
      windowSize: this.windowSize,
      statSize: this.statSize,
      warningFactor: this.warningFactor,
      window: [...this.window],
    };
  }

  /**
   * Restore from a previously serialized state. Malformed input falls
   * back to a fresh detector so a corrupt persisted blob never throws
   * into the drain.
   */
  static fromState(state: unknown): Kswin {
    if (!isKswinState(state)) return new Kswin();
    const kswin = new Kswin({
      alpha: state.alpha,
      windowSize: state.windowSize,
      statSize: state.statSize,
      warningFactor: state.warningFactor,
    });
    kswin.window = state.window.slice(-state.windowSize);
    return kswin;
  }
}

const isKswinState = (value: unknown): value is KswinState => {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  const alpha = c['alpha'];
  const windowSize = c['windowSize'];
  const statSize = c['statSize'];
  const warningFactor = c['warningFactor'];
  if (
    typeof alpha !== 'number' ||
    typeof windowSize !== 'number' ||
    typeof statSize !== 'number' ||
    typeof warningFactor !== 'number'
  ) {
    return false;
  }
  if (
    !Number.isInteger(windowSize) ||
    windowSize <= 0 ||
    !Number.isInteger(statSize) ||
    statSize <= 0 ||
    statSize * 2 > windowSize ||
    alpha <= 0 ||
    alpha >= 1 ||
    warningFactor <= 0 ||
    warningFactor >= 1
  ) {
    return false;
  }
  const window = c['window'];
  if (!Array.isArray(window)) return false;
  for (const v of window) {
    if (typeof v !== 'number') return false;
  }
  return true;
};
