// The single byte-size formatter for the extension UI. Decimal units
// (1 GB = 1e9 bytes) by default — the convention download hosts and
// macOS both report in — with { binary: true } for 1024-based units
// (KiB/MiB/GiB) where a surface genuinely needs them. One shape family:
// values under 10 keep one decimal ("3.3 GB"), larger values round to
// whole units ("819 MB"). Absence policy stays at the call site ('?',
// 'unknown size', …) — this function only formats bytes it is given.

export interface FormatBytesOptions {
  /** Use 1024-based units (KiB/MiB/GiB) instead of the decimal default. */
  readonly binary?: boolean;
}

const DECIMAL_UNITS = ['KB', 'MB', 'GB', 'TB'] as const;
const BINARY_UNITS = ['KiB', 'MiB', 'GiB', 'TiB'] as const;

export const formatBytes = (bytes: number, options?: FormatBytesOptions): string => {
  const binary = options?.binary ?? false;
  const base = binary ? 1024 : 1000;
  const clamped = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (clamped < base) {
    return `${String(Math.round(clamped))} B`;
  }
  const units = binary ? BINARY_UNITS : DECIMAL_UNITS;
  let value = clamped;
  let unit: string = units[0];
  for (const candidate of units) {
    value /= base;
    unit = candidate;
    if (value < base) break;
  }
  const rendered = value < 10 ? value.toFixed(1) : String(Math.round(value));
  return `${rendered} ${unit}`;
};
