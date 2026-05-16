export const EVENT_STREAMS = [
  'engagement.interval.observed',
  'selection.copied',
  'selection.pasted',
  'navigation.committed',
  'engagement.session.aggregated',
  'visual.fingerprint.observed',
] as const;

export type EventStreamName = (typeof EVENT_STREAMS)[number];

export interface BufferedEvent {
  readonly streamName: EventStreamName;
  readonly lamport: number;
  readonly replicaId: string;
  readonly payload: unknown;
  readonly observedAt: string;
}

export interface EventBuffer {
  appendMany(events: readonly BufferedEvent[]): Promise<void>;
  peek(limit: number): Promise<BufferedEvent[]>;
  deleteMany(
    keys: readonly Pick<BufferedEvent, 'streamName' | 'lamport' | 'replicaId'>[],
  ): Promise<number>;
  count(): Promise<number>;
}

const keyOf = (e: Pick<BufferedEvent, 'streamName' | 'lamport' | 'replicaId'>): string =>
  `${e.streamName}|${e.lamport}|${e.replicaId}`;

export class InMemoryEventBuffer implements EventBuffer {
  private readonly map = new Map<string, BufferedEvent>();

  async appendMany(events: readonly BufferedEvent[]): Promise<void> {
    for (const event of events) {
      this.map.set(keyOf(event), event);
    }
  }

  async peek(limit: number): Promise<BufferedEvent[]> {
    return [...this.map.values()]
      .sort((a, b) =>
        a.lamport === b.lamport ? a.replicaId.localeCompare(b.replicaId) : a.lamport - b.lamport,
      )
      .slice(0, Math.max(0, limit));
  }

  async deleteMany(
    keys: readonly Pick<BufferedEvent, 'streamName' | 'lamport' | 'replicaId'>[],
  ): Promise<number> {
    let deleted = 0;
    for (const k of keys) {
      if (this.map.delete(keyOf(k))) deleted += 1;
    }
    return deleted;
  }

  async count(): Promise<number> {
    return this.map.size;
  }
}
