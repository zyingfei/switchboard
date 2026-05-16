import { describe, expect, it } from 'vitest';

import {
  InMemoryEventBuffer,
  type BufferedEvent,
  type EventBuffer,
} from '../../../../src/background/storage/in-memory-event-buffer';
import { IndexedDbEventBuffer } from '../../../../src/background/storage/indexeddb-event-buffer';

class MemoryDriver {
  private readonly map = new Map<string, BufferedEvent>();
  private keyOf(e: Pick<BufferedEvent, 'streamName' | 'lamport' | 'replicaId'>): string {
    return `${e.streamName}|${e.lamport}|${e.replicaId}`;
  }
  async put(event: BufferedEvent): Promise<void> {
    this.map.set(this.keyOf(event), event);
  }
  async peek(limit: number): Promise<BufferedEvent[]> {
    return [...this.map.values()]
      .sort((a, b) => a.lamport - b.lamport || a.replicaId.localeCompare(b.replicaId))
      .slice(0, limit);
  }
  async deleteByKey(key: string): Promise<boolean> {
    return this.map.delete(key);
  }
  async count(): Promise<number> {
    return this.map.size;
  }
}

const event = (lamport: number, replicaId = 'r1'): BufferedEvent => ({
  streamName: 'selection.copied',
  lamport,
  replicaId,
  payload: { text: `t-${lamport}` },
  observedAt: '2026-05-08T00:00:00.000Z',
});

const runContract = (name: string, create: () => EventBuffer): void => {
  describe(name, () => {
    it('appends, peeks in order, and counts', async () => {
      const b = create();
      await b.appendMany([event(2), event(1), event(1, 'r0')]);
      const out = await b.peek(10);
      expect(out.map((x) => `${x.lamport}:${x.replicaId}`)).toEqual(['1:r0', '1:r1', '2:r1']);
      expect(await b.count()).toBe(3);
    });

    it('deleteMany removes matching keys only', async () => {
      const b = create();
      await b.appendMany([event(1), event(2)]);
      const removed = await b.deleteMany([
        { streamName: 'selection.copied', lamport: 1, replicaId: 'r1' },
      ]);
      expect(removed).toBe(1);
      expect(await b.count()).toBe(1);
    });
  });
};

runContract('InMemoryEventBuffer contract', () => new InMemoryEventBuffer());
runContract('IndexedDbEventBuffer contract', () => new IndexedDbEventBuffer(new MemoryDriver()));
