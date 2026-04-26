const pad2 = (value: number): string => String(value).padStart(2, '0');

export const dateKey = (date = new Date()): string =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

export const compactTimestamp = (date = new Date()): string =>
  date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/u, 'Z');

export const toJsonLine = (value: unknown): string => `${JSON.stringify(value)}\n`;

export const readErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export interface SyntheticEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly sequenceNumber: number;
  readonly payload: 'synthetic';
  readonly source: 'manual' | 'tick';
}

export const buildSyntheticEvent = (
  sequenceNumber: number,
  source: SyntheticEvent['source'],
  now = new Date(),
): SyntheticEvent => ({
  id: typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${now.getTime()}-${sequenceNumber}`,
  timestamp: now.toISOString(),
  sequenceNumber,
  payload: 'synthetic',
  source,
});
