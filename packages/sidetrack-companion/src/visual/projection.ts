import type { AcceptedEvent } from '../sync/causal.js';
import { VISUAL_FINGERPRINT_OBSERVED, isVisualFingerprintObservedPayload } from './events.js';

export interface VisualFingerprintProjectionEntry {
  readonly visitId: string;
  readonly domHash: string;
  readonly observedAt: string;
  readonly replicaId: string;
  readonly seq: number;
  readonly acceptedAtMs: number;
}

export interface VisualFingerprintProjection {
  readonly schemaVersion: 1;
  readonly fingerprints: readonly VisualFingerprintProjectionEntry[];
}

const compareString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const compareEntryRecency = (
  left: VisualFingerprintProjectionEntry,
  right: VisualFingerprintProjectionEntry,
): number => {
  const observed = compareString(left.observedAt, right.observedAt);
  if (observed !== 0) return observed;
  if (left.acceptedAtMs !== right.acceptedAtMs) return left.acceptedAtMs - right.acceptedAtMs;
  const replica = compareString(left.replicaId, right.replicaId);
  if (replica !== 0) return replica;
  return left.seq - right.seq;
};

export const projectVisualFingerprints = (
  events: readonly AcceptedEvent[],
): VisualFingerprintProjection => {
  const latestByVisit = new Map<string, VisualFingerprintProjectionEntry>();

  for (const event of events) {
    if (
      event.type !== VISUAL_FINGERPRINT_OBSERVED ||
      !isVisualFingerprintObservedPayload(event.payload)
    ) {
      continue;
    }
    const entry: VisualFingerprintProjectionEntry = {
      visitId: event.payload.visitId,
      domHash: event.payload.domHash,
      observedAt: event.payload.observedAt,
      replicaId: event.dot.replicaId,
      seq: event.dot.seq,
      acceptedAtMs: event.acceptedAtMs,
    };
    const existing = latestByVisit.get(entry.visitId);
    if (existing === undefined || compareEntryRecency(existing, entry) < 0) {
      latestByVisit.set(entry.visitId, entry);
    }
  }

  return {
    schemaVersion: 1,
    fingerprints: [...latestByVisit.values()].sort((left, right) =>
      compareString(left.visitId, right.visitId),
    ),
  };
};
