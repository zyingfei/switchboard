import { randomUUID } from 'node:crypto';

import { appendBridgeEvent } from './vault/events';
import { ObservationLog } from './vault/observation';
import type { BridgeEvent, BridgeStatus, WriteOutcome } from './model';
import { compactTimestamp, readErrorMessage } from './model';

export class BridgeRuntime {
  readonly startedAt = new Date();
  readonly runId = compactTimestamp(this.startedAt);
  readonly observations: ObservationLog;
  private tickTimer: NodeJS.Timeout | undefined;
  private tickSequence = 0;
  private lastWrite: WriteOutcome | undefined;

  constructor(readonly vaultPath: string, readonly transport: 'http' | 'nativeMessaging') {
    this.observations = new ObservationLog(vaultPath, this.runId);
  }

  status(): BridgeStatus {
    return {
      ok: true,
      transport: this.transport,
      vaultPath: this.vaultPath,
      startedAt: this.startedAt.toISOString(),
      runId: this.runId,
      tickRunning: this.tickTimer !== undefined,
      tickSequence: this.tickSequence,
      lastWrite: this.lastWrite,
    };
  }

  async writeEvent(event: BridgeEvent): Promise<WriteOutcome> {
    const started = performance.now();
    let outcome: WriteOutcome;
    try {
      const result = await appendBridgeEvent(this.vaultPath, event);
      outcome = {
        at: new Date().toISOString(),
        latencyMs: Math.round((performance.now() - started) * 100) / 100,
        ok: true,
        kind: 'event',
        path: result.path,
      };
    } catch (error) {
      outcome = {
        at: new Date().toISOString(),
        latencyMs: Math.round((performance.now() - started) * 100) / 100,
        ok: false,
        kind: 'event',
        error: readErrorMessage(error),
      };
    }
    this.lastWrite = outcome;
    await this.observations.append(outcome).catch(() => undefined);
    if (!outcome.ok) {
      throw new Error(outcome.error ?? 'Event write failed');
    }
    return outcome;
  }

  startTick(intervalMs = 1_000): void {
    if (this.tickTimer) {
      return;
    }
    this.tickTimer = setInterval(() => {
      this.tickSequence += 1;
      void this.writeEvent({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        sequenceNumber: this.tickSequence,
        payload: 'synthetic',
        source: 'tick',
      });
    }, intervalMs);
  }

  stopTick(): void {
    if (!this.tickTimer) {
      return;
    }
    clearInterval(this.tickTimer);
    this.tickTimer = undefined;
  }
}
