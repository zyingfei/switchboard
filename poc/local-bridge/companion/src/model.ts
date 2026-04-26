export interface BridgeEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly sequenceNumber: number;
  readonly payload: 'synthetic';
  readonly source: 'manual' | 'tick' | 'queue-replay';
}

export interface WriteOutcome {
  readonly at: string;
  readonly latencyMs: number;
  readonly ok: boolean;
  readonly kind: 'event' | 'note' | 'frontmatter' | 'track';
  readonly path?: string;
  readonly error?: string;
}

export interface BridgeStatus {
  readonly ok: true;
  readonly transport: 'http' | 'nativeMessaging';
  readonly vaultPath: string;
  readonly startedAt: string;
  readonly runId: string;
  readonly tickRunning: boolean;
  readonly tickSequence: number;
  readonly lastWrite?: WriteOutcome;
}

export interface TransportServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export const dateKey = (date = new Date()): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export const compactTimestamp = (date = new Date()): string =>
  date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/u, 'Z');

export const readErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
