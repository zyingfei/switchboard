import type { RecencyWindow } from './model';

const DAY_MS = 86_400_000;

const WEIGHTS: Record<RecencyWindow, [number, number, number, number]> = {
  '3d': [1.24, 1.06, 0.92, 0.8],
  '3w': [1.12, 1.2, 0.98, 0.84],
  '3m': [1.0, 1.1, 1.18, 0.9],
  '3y': [0.94, 1.0, 1.08, 1.14],
};

export const ageDaysFrom = (capturedAt: string, now = new Date()): number =>
  Math.max(0, Math.floor((now.getTime() - new Date(capturedAt).getTime()) / DAY_MS));

export const classifyRecencyBucket = (ageDays: number): string => {
  if (ageDays <= 3) {
    return '0-3d';
  }
  if (ageDays <= 21) {
    return '4-21d';
  }
  if (ageDays <= 90) {
    return '22-90d';
  }
  return '91d+';
};

export const freshnessBoost = (window: RecencyWindow, ageDays: number): number => {
  const [within3d, within3w, within3m, archive] = WEIGHTS[window];
  if (ageDays <= 3) {
    return within3d;
  }
  if (ageDays <= 21) {
    return within3w;
  }
  if (ageDays <= 90) {
    return within3m;
  }
  return archive;
};
